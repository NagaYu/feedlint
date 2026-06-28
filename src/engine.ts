/**
 * FeedLint — Core engine.
 *
 * Responsibilities:
 *   1. Read the input feed from disk (JSON or XML) with robust error handling.
 *   2. Normalize every input dialect (Shopify, WooCommerce, Magento, generic
 *      JSON array, Google RSS XML) into the canonical product shape.
 *   3. Run the platform rule set over each product, applying auto-fixes.
 *   4. Drop unrecoverable products when requested.
 *   5. Serialize the cleansed feed back to disk (JSON or XML).
 *   6. Return a structured {@link CleanseReport} for the CLI to render.
 */

import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname } from "node:path";
import { Parser as XmlParser, Builder as XmlBuilder } from "xml2js";

import {
  type CanonicalProduct,
  type CleanseReport,
  type EngineOptions,
  type Finding,
  type ProductReport,
  type RuleContext,
  type RuleResult,
  FeedLintError,
} from "./types.js";
import { getRulesFor, isImageReachable, isValidUrl, normalizeUrl } from "./rules.js";

/* -------------------------------------------------------------------------- */
/*  Public entry point                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Run the full validate → cleanse → write pipeline.
 *
 * Throws {@link FeedLintError} for fatal, user-actionable problems (missing
 * input, parse failure, empty feed, write failure). Per-product issues are
 * captured in the returned report rather than thrown.
 */
export async function runEngine(options: EngineOptions): Promise<CleanseReport> {
  const rawText = await readInput(options.inputPath);
  const rawProducts = parseFeed(rawText, options.inputPath);

  if (rawProducts.length === 0) {
    throw new FeedLintError("EMPTY_FEED", `No products found in \`${options.inputPath}\`.`);
  }

  // Normalize every input dialect up front so we can batch-probe image URLs
  // before any rule runs.
  const products = rawProducts.map((raw, index) =>
    normalizeProduct(raw as Record<string, unknown>, index),
  );

  // When liveness checking is enabled, probe every unique (normalized) image
  // URL through a bounded-concurrency pool and cache the results. Duplicate
  // URLs across variants are probed once, and the pool keeps large feeds from
  // opening thousands of sockets at once.
  const imageReachability = options.checkImages
    ? await probeImages(products, options.imageConcurrency)
    : new Map<string, boolean>();

  let imagesUnreachable = 0;
  for (const reachable of imageReachability.values()) {
    if (!reachable) {
      imagesUnreachable += 1;
    }
  }

  const ctx: RuleContext = {
    platform: options.platform,
    autofix: options.autofix,
    checkImages: options.checkImages,
    imageReachability,
  };
  const rules = getRulesFor(options.platform);

  const productReports: ProductReport[] = [];
  const output: CanonicalProduct[] = [];

  let totalClean = 0;
  let totalFixed = 0;
  let totalErrors = 0;
  let totalErrorsInOutput = 0;
  let totalWarnings = 0;
  let totalDropped = 0;
  let totalFixOperations = 0;

  for (let index = 0; index < products.length; index += 1) {
    const product = products[index] as CanonicalProduct;
    const findings: Finding[] = [];
    let fixedThisProduct = false;
    let hardErrors = 0;

    // Apply each rule in order, threading auto-fix patches into the product.
    for (const rule of rules) {
      let result: RuleResult;
      try {
        result = await rule.apply(product, ctx);
      } catch (error: unknown) {
        // A misbehaving rule must never crash the run; record and continue.
        result = {
          status: "error",
          message: `Rule \`${rule.id}\` threw: ${describeError(error)}`,
        };
      }

      switch (result.status) {
        case "ok":
          break;
        case "fixed": {
          if (result.patch) {
            Object.assign(product, result.patch);
          }
          fixedThisProduct = true;
          totalFixOperations += 1;
          findings.push(toFinding(rule.id, rule.field, result, "info"));
          break;
        }
        case "warning": {
          totalWarnings += 1;
          findings.push(toFinding(rule.id, rule.field, result, "warning"));
          break;
        }
        case "error": {
          hardErrors += 1;
          totalErrors += 1;
          findings.push(toFinding(rule.id, rule.field, result, "error"));
          break;
        }
        case "dropped": {
          hardErrors += 1;
          totalErrors += 1;
          findings.push(toFinding(rule.id, rule.field, result, "error"));
          break;
        }
        default: {
          // Exhaustiveness guard — should be unreachable.
          const _never: never = result.status;
          void _never;
          break;
        }
      }
    }

    const dropped = options.dropInvalid && hardErrors > 0;
    if (dropped) {
      totalDropped += 1;
    } else {
      output.push(product);
      // Errors on kept products are the ones that actually ship.
      totalErrorsInOutput += hardErrors;
      if (hardErrors === 0 && !fixedThisProduct) {
        totalClean += 1;
      }
    }

    if (fixedThisProduct) {
      totalFixed += 1;
    }

    productReports.push({
      index,
      id: product.id,
      findings,
      fixed: fixedThisProduct,
      dropped,
    });
  }

  // Serialize the surviving, cleansed feed.
  await writeOutput(output, options);

  return {
    platform: options.platform,
    inputPath: options.inputPath,
    outputPath: options.outputPath,
    finishedAt: new Date().toISOString(),
    totalScanned: products.length,
    totalClean,
    totalFixed,
    totalErrors,
    totalErrorsInOutput,
    totalWarnings,
    totalDropped,
    totalFixOperations,
    imagesProbed: imageReachability.size,
    imagesUnreachable,
    products: productReports,
    output,
  };
}

/* -------------------------------------------------------------------------- */
/*  Bounded-concurrency image probing                                         */
/* -------------------------------------------------------------------------- */

/**
 * Collect every unique, normalized image URL across the feed and probe each one
 * for liveness through a bounded worker pool. Returns a map keyed by the
 * normalized URL. Probing happens at most `concurrency` requests at a time.
 */
async function probeImages(
  products: readonly CanonicalProduct[],
  concurrency: number,
): Promise<Map<string, boolean>> {
  // Deduplicate URLs so repeated variants/images cost a single request.
  const urls = new Set<string>();
  for (const product of products) {
    const primary = product.image_link.trim();
    if (primary.length > 0 && isValidUrl(primary)) {
      urls.add(normalizeUrl(primary));
    }
    if (product.additional_image_link) {
      for (const extra of product.additional_image_link) {
        const trimmed = extra.trim();
        if (trimmed.length > 0 && isValidUrl(trimmed)) {
          urls.add(normalizeUrl(trimmed));
        }
      }
    }
  }

  const results = new Map<string, boolean>();
  await mapWithConcurrency(Array.from(urls), concurrency, async (url) => {
    const reachable = await isImageReachable(url);
    results.set(url, reachable);
  });
  return results;
}

/**
 * Run `worker` over `items` with at most `limit` promises in flight at once.
 *
 * This is a classic fixed-size worker pool: `limit` workers pull from a shared
 * cursor until the list is exhausted. A worker that throws is swallowed per
 * item (the caller's worker is expected to capture its own result) so one bad
 * URL never aborts the whole batch. Order of completion is not preserved.
 */
export async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) {
    return;
  }
  const poolSize = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let cursor = 0;

  const runWorker = async (): Promise<void> => {
    while (cursor < items.length) {
      const current = cursor;
      cursor += 1;
      try {
        await worker(items[current] as T, current);
      } catch {
        // Worker is responsible for recording its own outcome; never abort the
        // batch because a single item failed.
      }
    }
  };

  const workers: Promise<void>[] = [];
  for (let i = 0; i < poolSize; i += 1) {
    workers.push(runWorker());
  }
  await Promise.all(workers);
}

/* -------------------------------------------------------------------------- */
/*  Input reading                                                             */
/* -------------------------------------------------------------------------- */

/** Read the input file, translating fs errors into typed FeedLintErrors. */
async function readInput(path: string): Promise<string> {
  try {
    await access(path, fsConstants.R_OK);
  } catch {
    throw new FeedLintError("INPUT_NOT_FOUND", `Input file not found or unreadable: \`${path}\`.`);
  }

  try {
    return await readFile(path, "utf8");
  } catch (error: unknown) {
    throw new FeedLintError(
      "INPUT_UNREADABLE",
      `Failed to read \`${path}\`: ${describeError(error)}`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/*  Feed parsing & dialect detection                                          */
/* -------------------------------------------------------------------------- */

/**
 * Parse the raw feed text into a flat array of raw product records. Detects
 * JSON vs XML by content sniffing (with the file extension as a tie-breaker).
 */
export function parseFeed(rawText: string, path: string): Record<string, unknown>[] {
  const trimmed = rawText.trim();
  if (trimmed.length === 0) {
    throw new FeedLintError("EMPTY_FEED", `Input file \`${path}\` is empty.`);
  }

  const looksXml = trimmed.startsWith("<") || /\.xml$/i.test(path);
  const looksJson = trimmed.startsWith("{") || trimmed.startsWith("[") || /\.json$/i.test(path);

  if (looksJson && !looksXml) {
    return parseJsonFeed(trimmed, path);
  }
  if (looksXml) {
    return parseXmlFeed(trimmed, path);
  }
  // Last-ditch: try JSON, then XML.
  try {
    return parseJsonFeed(trimmed, path);
  } catch {
    return parseXmlFeed(trimmed, path);
  }
}

/** Parse a JSON feed of any of the supported shapes. */
function parseJsonFeed(text: string, path: string): Record<string, unknown>[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error: unknown) {
    throw new FeedLintError("PARSE_ERROR", `Invalid JSON in \`${path}\`: ${describeError(error)}`);
  }
  return extractProductArray(data);
}

/**
 * Walk a parsed JSON value and locate the product array. Supports:
 *   - a bare array `[ {...}, {...} ]`
 *   - Shopify `{ "products": [ ... ] }`
 *   - WooCommerce/Magento `{ "data": [ ... ] }` / `{ "items": [ ... ] }`
 *   - a single product object `{ ... }`
 */
function extractProductArray(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) {
    return data.filter(isRecord);
  }
  if (isRecord(data)) {
    for (const key of ["products", "items", "data", "entries", "feed"]) {
      const value = data[key];
      if (Array.isArray(value)) {
        return value.filter(isRecord);
      }
    }
    // A single product object.
    return [data];
  }
  throw new FeedLintError("PARSE_ERROR", "JSON root is neither an array nor an object.");
}

/** Parse a Google RSS / Atom-style XML feed synchronously. */
function parseXmlFeed(text: string, path: string): Record<string, unknown>[] {
  let parsed: unknown;
  let parseError: unknown = null;

  const parser = new XmlParser({
    explicitArray: false,
    trim: true,
    // Strip the `g:` namespace prefix from Google feed attributes.
    tagNameProcessors: [(name: string): string => name.replace(/^.*:/, "")],
    attrNameProcessors: [(name: string): string => name.replace(/^.*:/, "")],
    explicitRoot: true,
    mergeAttrs: true,
  });

  // xml2js's parseString is callback-based but synchronous for string input.
  parser.parseString(text, (err: Error | null, result: unknown) => {
    if (err) {
      parseError = err;
    } else {
      parsed = result;
    }
  });

  if (parseError) {
    throw new FeedLintError("PARSE_ERROR", `Invalid XML in \`${path}\`: ${describeError(parseError)}`);
  }

  const items = locateXmlItems(parsed);
  if (items.length === 0) {
    throw new FeedLintError("EMPTY_FEED", `No <item>/<entry> elements found in \`${path}\`.`);
  }
  return items;
}

/** Locate the repeated item/entry nodes in a parsed XML tree. */
function locateXmlItems(parsed: unknown): Record<string, unknown>[] {
  if (!isRecord(parsed)) {
    return [];
  }

  // Typical Google feed: rss > channel > item[]
  const rss = parsed["rss"];
  if (isRecord(rss)) {
    const channel = rss["channel"];
    if (isRecord(channel)) {
      return collectNodes(channel["item"]);
    }
  }

  // Atom feed: feed > entry[]
  const feed = parsed["feed"];
  if (isRecord(feed)) {
    return collectNodes(feed["entry"]);
  }

  // Fallback: search one level down for the first array of records.
  for (const value of Object.values(parsed)) {
    if (isRecord(value)) {
      for (const inner of Object.values(value)) {
        const nodes = collectNodes(inner);
        if (nodes.length > 0) {
          return nodes;
        }
      }
    }
  }
  return [];
}

/** Coerce a possibly-single XML node into an array of records. */
function collectNodes(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter(isRecord);
  }
  if (isRecord(value)) {
    return [value];
  }
  return [];
}

/* -------------------------------------------------------------------------- */
/*  Normalization                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Map a raw product record (any supported dialect) onto a {@link CanonicalProduct}.
 *
 * Field resolution is alias-driven: each canonical field has an ordered list of
 * source keys, and the first non-empty match wins. Shopify's nested `variants`
 * and `images` arrays are flattened. Anything not explicitly mapped is preserved
 * in `extra` so a round-trip never silently loses data.
 */
export function normalizeProduct(raw: Record<string, unknown>, index: number): CanonicalProduct {
  // Flatten the first Shopify variant/image into the top-level lookup space.
  const flat = flattenSourceRecord(raw);

  const product: CanonicalProduct = {
    id: firstString(flat, ["id", "g:id", "sku", "variant_id", "item_id", "offer_id"]) || `feedlint-${index + 1}`,
    title: firstString(flat, ["title", "g:title", "name", "product_title"]),
    description: firstString(flat, ["description", "g:description", "body_html", "body", "summary", "content"]),
    availability: firstString(flat, ["availability", "g:availability", "stock_status", "inventory_status"]),
    condition: firstString(flat, ["condition", "g:condition", "item_condition"]),
    price: firstString(flat, ["price", "g:price", "amount", "regular_price"]),
    link: firstString(flat, ["link", "g:link", "url", "product_url", "permalink", "handle_url"]),
    image_link: firstString(flat, ["image_link", "g:image_link", "image", "image_url", "featured_image", "image_src"]),
    brand: firstString(flat, ["brand", "g:brand", "vendor", "manufacturer", "make"]),
    extra: {},
  };

  // Optional fields — only set when present (respecting exactOptionalPropertyTypes).
  const salePrice = firstString(flat, ["sale_price", "g:sale_price", "special_price", "discount_price"]);
  if (salePrice) {
    product.sale_price = salePrice;
  }
  const gtin = firstString(flat, ["gtin", "g:gtin", "upc", "ean", "barcode", "isbn"]);
  if (gtin) {
    product.gtin = gtin;
  }
  const mpn = firstString(flat, ["mpn", "g:mpn", "model", "model_number"]);
  if (mpn) {
    product.mpn = mpn;
  }
  const gpc = firstString(flat, ["google_product_category", "g:google_product_category"]);
  if (gpc) {
    product.google_product_category = gpc;
  }
  const productType = firstString(flat, ["product_type", "g:product_type", "category", "categories"]);
  if (productType) {
    product.product_type = productType;
  }
  const itemGroupId = firstString(flat, ["item_group_id", "g:item_group_id", "group_id", "parent_id"]);
  if (itemGroupId) {
    product.item_group_id = itemGroupId;
  }
  const color = firstString(flat, ["color", "g:color", "colour", "option_color"]);
  if (color) {
    product.color = color;
  }
  const size = firstString(flat, ["size", "g:size", "option_size"]);
  if (size) {
    product.size = size;
  }
  const gender = firstString(flat, ["gender", "g:gender"]);
  if (gender) {
    product.gender = gender;
  }
  const ageGroup = firstString(flat, ["age_group", "g:age_group"]);
  if (ageGroup) {
    product.age_group = ageGroup;
  }
  const material = firstString(flat, ["material", "g:material"]);
  if (material) {
    product.material = material;
  }
  const pattern = firstString(flat, ["pattern", "g:pattern"]);
  if (pattern) {
    product.pattern = pattern;
  }

  // Additional images (Shopify `images[].src`, Google `additional_image_link`).
  const additional = collectAdditionalImages(raw, flat, product.image_link);
  if (additional.length > 0) {
    product.additional_image_link = additional;
  }

  // Preserve unmapped scalar fields in `extra`.
  const claimed = new Set<string>([
    "id", "g:id", "sku", "variant_id", "item_id", "offer_id",
    "title", "g:title", "name", "product_title",
    "description", "g:description", "body_html", "body", "summary", "content",
    "availability", "g:availability", "stock_status", "inventory_status",
    "condition", "g:condition", "item_condition",
    "price", "g:price", "amount", "regular_price",
    "link", "g:link", "url", "product_url", "permalink", "handle_url",
    "image_link", "g:image_link", "image", "image_url", "featured_image", "image_src",
    "brand", "g:brand", "vendor", "manufacturer", "make",
    "sale_price", "g:sale_price", "special_price", "discount_price",
    "gtin", "g:gtin", "upc", "ean", "barcode", "isbn",
    "mpn", "g:mpn", "model", "model_number",
    "google_product_category", "g:google_product_category",
    "product_type", "g:product_type", "category", "categories",
    "item_group_id", "g:item_group_id", "group_id", "parent_id",
    "color", "g:color", "colour", "option_color",
    "size", "g:size", "option_size",
    "gender", "g:gender", "age_group", "g:age_group",
    "material", "g:material", "pattern", "g:pattern",
    "variants", "images",
  ]);
  for (const [key, value] of Object.entries(flat)) {
    if (claimed.has(key)) {
      continue;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      product.extra[key] = String(value);
    }
  }

  return product;
}

/**
 * Flatten Shopify-style nested structures so alias lookups can see them:
 *   - `variants[0]` keys become top-level (price, sku, …)
 *   - `images[0].src` becomes `image_src`
 */
function flattenSourceRecord(raw: Record<string, unknown>): Record<string, unknown> {
  const flat: Record<string, unknown> = { ...raw };

  const variants = raw["variants"];
  if (Array.isArray(variants) && variants.length > 0 && isRecord(variants[0])) {
    const variant = variants[0];
    for (const [key, value] of Object.entries(variant)) {
      if (!(key in flat) || flat[key] === undefined || flat[key] === "") {
        flat[key] = value;
      }
    }
  }

  const images = raw["images"];
  if (Array.isArray(images) && images.length > 0) {
    const first = images[0];
    if (isRecord(first) && typeof first["src"] === "string") {
      flat["image_src"] = first["src"];
    } else if (typeof first === "string") {
      flat["image_src"] = first;
    }
  }

  // Shopify `image` object with a `.src`.
  const imageObj = raw["image"];
  if (isRecord(imageObj) && typeof imageObj["src"] === "string") {
    flat["featured_image"] = imageObj["src"];
  }

  return flat;
}

/** Gather additional image URLs from common shapes, excluding the primary. */
function collectAdditionalImages(
  raw: Record<string, unknown>,
  flat: Record<string, unknown>,
  primary: string,
): string[] {
  const urls: string[] = [];

  const images = raw["images"];
  if (Array.isArray(images)) {
    for (const img of images) {
      if (isRecord(img) && typeof img["src"] === "string") {
        urls.push(img["src"]);
      } else if (typeof img === "string") {
        urls.push(img);
      }
    }
  }

  const additional = flat["additional_image_link"] ?? flat["g:additional_image_link"];
  if (typeof additional === "string") {
    urls.push(...additional.split(",").map((s) => s.trim()));
  } else if (Array.isArray(additional)) {
    for (const a of additional) {
      if (typeof a === "string") {
        urls.push(a);
      }
    }
  }

  // Deduplicate, drop the primary, cap at 10 (platform maximum).
  const seen = new Set<string>([primary]);
  const result: string[] = [];
  for (const url of urls) {
    const trimmed = url.trim();
    if (trimmed.length > 0 && !seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
      if (result.length >= 10) {
        break;
      }
    }
  }
  return result;
}

/** Return the first non-empty string value among a list of candidate keys. */
function firstString(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return "";
}

/* -------------------------------------------------------------------------- */
/*  Output serialization                                                      */
/* -------------------------------------------------------------------------- */

/** Serialize and write the cleansed feed, creating parent dirs as needed. */
async function writeOutput(products: CanonicalProduct[], options: EngineOptions): Promise<void> {
  const serialized =
    options.format === "xml" ? serializeXml(products) : serializeJson(products);

  try {
    const dir = dirname(options.outputPath);
    await mkdir(dir, { recursive: true });
    await writeFile(options.outputPath, serialized, "utf8");
  } catch (error: unknown) {
    throw new FeedLintError(
      "OUTPUT_WRITE_ERROR",
      `Failed to write \`${options.outputPath}\`: ${describeError(error)}`,
    );
  }
}

/** Render the cleansed feed as pretty-printed JSON. */
function serializeJson(products: CanonicalProduct[]): string {
  const flattened = products.map(toFlatOutputRecord);
  return `${JSON.stringify({ products: flattened }, null, 2)}\n`;
}

/** Render the cleansed feed as a Google-compatible RSS 2.0 XML document. */
function serializeXml(products: CanonicalProduct[]): string {
  const items = products.map((product) => {
    const flat = toFlatOutputRecord(product);
    const item: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(flat)) {
      // Google feed attributes live under the `g:` namespace.
      const isCore = key === "title" || key === "description" || key === "link";
      item[isCore ? key : `g:${key}`] = value;
    }
    return item;
  });

  const builder = new XmlBuilder({
    rootName: "rss",
    xmldec: { version: "1.0", encoding: "UTF-8", standalone: undefined },
    renderOpts: { pretty: true, indent: "  ", newline: "\n" },
    cdata: false,
  });

  const doc = {
    $: { version: "2.0", "xmlns:g": "http://base.google.com/ns/1.0" },
    channel: {
      title: "FeedLint cleansed feed",
      link: "https://github.com/NagaYu/feedlint",
      description: "Auto-cleansed product feed generated by FeedLint.",
      item: items,
    },
  };

  return `${builder.buildObject(doc)}\n`;
}

/** Flatten a canonical product into a plain string-keyed output record. */
function toFlatOutputRecord(product: CanonicalProduct): Record<string, string> {
  const out: Record<string, string> = {};

  const put = (key: string, value: string | undefined): void => {
    if (value !== undefined && value !== null && value !== "") {
      out[key] = value;
    }
  };

  put("id", product.id);
  put("title", product.title);
  put("description", product.description);
  put("availability", product.availability);
  put("condition", product.condition);
  put("price", product.price);
  put("sale_price", product.sale_price);
  put("link", product.link);
  put("image_link", product.image_link);
  if (product.additional_image_link && product.additional_image_link.length > 0) {
    put("additional_image_link", product.additional_image_link.join(","));
  }
  put("brand", product.brand);
  put("gtin", product.gtin);
  put("mpn", product.mpn);
  put("google_product_category", product.google_product_category);
  put("product_type", product.product_type);
  put("item_group_id", product.item_group_id);
  put("color", product.color);
  put("size", product.size);
  put("gender", product.gender);
  put("age_group", product.age_group);
  put("material", product.material);
  put("pattern", product.pattern);

  for (const [key, value] of Object.entries(product.extra)) {
    if (!(key in out)) {
      put(key, value);
    }
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/*  Small internal helpers                                                    */
/* -------------------------------------------------------------------------- */

/** Narrow an unknown value to a plain object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Build a Finding from a rule result, mapping status → severity. */
function toFinding(
  ruleId: string,
  field: string,
  result: RuleResult,
  severity: Finding["severity"],
): Finding {
  return {
    ruleId,
    field,
    status: result.status,
    severity,
    message: result.message ?? "",
  };
}

/** Produce a readable message from an unknown thrown value. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
