/**
 * FeedLint — Rule sets and cleansing primitives.
 *
 * This module encodes the 2026 specifications of Meta Catalog, Google Merchant
 * Center, and TikTok Catalog as a list of declarative {@link RuleDefinition}s
 * per platform, plus the pure helper functions (HTML stripping, smart title
 * truncation, price normalization, URL validation, …) that the rules use to
 * cleanse data.
 *
 * Every rule is a pure function of `(product, ctx)` returning a {@link RuleResult}.
 * When `ctx.autofix` is enabled and a problem is repairable, the rule returns a
 * `patch` that the engine merges into the working copy.
 */

import type {
  CanonicalProduct,
  PlatformSpec,
  Platform,
  RuleContext,
  RuleDefinition,
  RuleResult,
} from "./types.js";

/* -------------------------------------------------------------------------- */
/*  Platform specifications                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Declarative limits per platform. These numbers reflect the publicly
 * documented 2026 feed specs. They are referenced both by the rules below and
 * by the CLI `--explain` output.
 */
export const PLATFORM_SPECS: Readonly<Record<Platform, PlatformSpec>> = {
  meta: {
    platform: "meta",
    label: "Meta Catalog",
    titleMaxLength: 200,
    descriptionMaxLength: 9999,
    defaultCurrency: "USD",
    requiredFields: [
      "id",
      "title",
      "description",
      "availability",
      "condition",
      "price",
      "link",
      "image_link",
      "brand",
    ],
    allowedAvailability: ["in stock", "out of stock", "preorder", "available for order", "discontinued"],
    allowedCondition: ["new", "refurbished", "used"],
  },
  google: {
    platform: "google",
    label: "Google Merchant Center",
    titleMaxLength: 150,
    descriptionMaxLength: 5000,
    defaultCurrency: "USD",
    requiredFields: [
      "id",
      "title",
      "description",
      "availability",
      "condition",
      "price",
      "link",
      "image_link",
      "brand",
    ],
    allowedAvailability: ["in stock", "out of stock", "preorder", "backorder"],
    allowedCondition: ["new", "refurbished", "used"],
  },
  tiktok: {
    platform: "tiktok",
    label: "TikTok Catalog",
    titleMaxLength: 100,
    descriptionMaxLength: 10000,
    defaultCurrency: "USD",
    requiredFields: [
      "id",
      "title",
      "description",
      "availability",
      "condition",
      "price",
      "link",
      "image_link",
    ],
    allowedAvailability: ["in stock", "out of stock", "preorder", "available for order"],
    allowedCondition: ["new", "refurbished", "used"],
  },
};

/* -------------------------------------------------------------------------- */
/*  Cleansing primitives (pure, individually unit-testable)                   */
/* -------------------------------------------------------------------------- */

/** A short, well-known list of HTML entities we decode after tag stripping. */
const HTML_ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
  "&#x27;": "'",
  "&nbsp;": " ",
  "&hellip;": "…",
  "&mdash;": "—",
  "&ndash;": "–",
  "&copy;": "©",
  "&reg;": "®",
  "&trade;": "™",
  "&euro;": "€",
  "&pound;": "£",
  "&yen;": "¥",
};

/**
 * Remove HTML markup from a string and collapse whitespace.
 *
 * Handles tags, `<script>`/`<style>` blocks (content removed entirely),
 * numeric & named entities, and runaway whitespace produced by block tags.
 */
export function stripHtml(input: string): string {
  if (input.length === 0) {
    return "";
  }

  let text = input;

  // 1. Drop the full contents of script/style blocks.
  text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");

  // 2. Turn block-level closers and <br> into spaces so words don't fuse.
  text = text.replace(/<\s*br\s*\/?\s*>/gi, " ");
  text = text.replace(/<\s*\/?\s*(p|div|li|ul|ol|tr|td|th|h[1-6]|section|article)\b[^>]*>/gi, " ");

  // 3. Strip every remaining tag.
  text = text.replace(/<[^>]*>/g, "");

  // 4. Decode known named/simple entities.
  for (const [entity, replacement] of Object.entries(HTML_ENTITIES)) {
    text = text.split(entity).join(replacement);
  }

  // 5. Decode decimal numeric entities (&#1234;).
  text = text.replace(/&#(\d+);/g, (_match, dec: string) => {
    const code = Number.parseInt(dec, 10);
    return Number.isFinite(code) ? safeFromCodePoint(code) : "";
  });

  // 6. Decode hexadecimal numeric entities (&#x1F600;).
  text = text.replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) => {
    const code = Number.parseInt(hex, 16);
    return Number.isFinite(code) ? safeFromCodePoint(code) : "";
  });

  // 7. Collapse whitespace runs and trim.
  text = text.replace(/\s+/g, " ").trim();

  return text;
}

/** Guarded `String.fromCodePoint` that never throws on invalid input. */
function safeFromCodePoint(code: number): string {
  try {
    if (code < 0 || code > 0x10ffff) {
      return "";
    }
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/** True when a string still contains HTML-looking markup. */
export function containsHtml(input: string): boolean {
  return /<[a-z!/][^>]*>/i.test(input) || /&[a-z]+;|&#\d+;|&#x[0-9a-f]+;/i.test(input);
}

/**
 * Truncate a title to `max` characters without cutting a word in half.
 *
 * The result always fits within `max` (including the trailing ellipsis). If the
 * input already fits, it is returned unchanged. The function is grapheme-naive
 * but surrogate-safe: it never splits a UTF-16 surrogate pair.
 */
export function smartTruncate(input: string, max: number): string {
  const chars = Array.from(input); // splits by code point, not UTF-16 unit
  if (chars.length <= max) {
    return input;
  }
  if (max <= 1) {
    return chars.slice(0, Math.max(0, max)).join("");
  }

  const ellipsis = "…";
  const budget = max - ellipsis.length;
  const slice = chars.slice(0, budget).join("");

  // Prefer cutting at the last word boundary inside the budget.
  const lastSpace = slice.lastIndexOf(" ");
  const trimmed =
    lastSpace > budget * 0.5 ? slice.slice(0, lastSpace) : slice;

  return `${trimmed.replace(/[\s.,;:!\-]+$/u, "")}${ellipsis}`;
}

/** Collapse internal whitespace and trim a free-text field. */
export function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

/** Result of parsing a raw price string. */
export interface ParsedPrice {
  amount: number;
  currency: string | null;
  /** The canonical `"19.99 USD"` rendering. */
  formatted: string;
}

/** Common currency symbols mapped to ISO-4217 codes. */
const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
  $: "USD",
  "€": "EUR",
  "£": "GBP",
  "¥": "JPY",
  "₩": "KRW",
  "₹": "INR",
  "₽": "RUB",
  "R$": "BRL",
  "A$": "AUD",
  "C$": "CAD",
};

/** ISO-4217 codes that conventionally carry zero decimal places. */
const ZERO_DECIMAL_CURRENCIES = new Set<string>(["JPY", "KRW", "VND", "CLP", "ISK"]);

/**
 * Parse a messy price string into a normalized amount + currency.
 *
 * Accepts inputs such as `"$1,299.00"`, `"1299"`, `"19,99 EUR"`, `"USD 49.50"`,
 * `"49.50 usd"`, `"¥1980"`. Returns `null` when no numeric amount can be found.
 *
 * @param raw            The source price string.
 * @param defaultCurrency Currency assumed when none is present in `raw`.
 */
export function parsePrice(raw: string, defaultCurrency: string): ParsedPrice | null {
  const original = raw.trim();
  if (original.length === 0) {
    return null;
  }

  // 1. Detect a 3-letter ISO currency code anywhere in the string.
  let currency: string | null = null;
  const isoMatch = original.match(/\b([A-Za-z]{3})\b/);
  if (isoMatch && isoMatch[1]) {
    const candidate = isoMatch[1].toUpperCase();
    if (KNOWN_ISO_CODES.has(candidate)) {
      currency = candidate;
    }
  }

  // 2. Otherwise detect a currency symbol.
  if (currency === null) {
    for (const [symbol, code] of Object.entries(CURRENCY_SYMBOLS)) {
      if (original.includes(symbol)) {
        currency = code;
        break;
      }
    }
  }

  // 3. Extract the numeric portion. Strip letters and symbols first.
  const numericPart = original.replace(/[^0-9.,\s-]/g, " ").trim();
  const amount = parseLocaleNumber(numericPart);
  if (amount === null || !Number.isFinite(amount) || amount < 0) {
    return null;
  }

  const resolvedCurrency = currency ?? defaultCurrency;
  const decimals = ZERO_DECIMAL_CURRENCIES.has(resolvedCurrency) ? 0 : 2;
  const formattedAmount = amount.toFixed(decimals);

  return {
    amount,
    currency,
    formatted: `${formattedAmount} ${resolvedCurrency}`,
  };
}

/**
 * Parse a number that may use either `.` or `,` as the decimal separator, and
 * may contain thousands separators. Returns `null` if nothing parses.
 */
function parseLocaleNumber(input: string): number | null {
  const cleaned = input.replace(/\s+/g, "");
  if (cleaned.length === 0) {
    return null;
  }

  const hasComma = cleaned.includes(",");
  const hasDot = cleaned.includes(".");

  let normalized = cleaned;

  if (hasComma && hasDot) {
    // The right-most separator is the decimal separator.
    if (cleaned.lastIndexOf(",") > cleaned.lastIndexOf(".")) {
      // European style: 1.299,00 -> 1299.00
      normalized = cleaned.replace(/\./g, "").replace(",", ".");
    } else {
      // US style: 1,299.00 -> 1299.00
      normalized = cleaned.replace(/,/g, "");
    }
  } else if (hasComma) {
    // Ambiguous: "1,299" (thousands) vs "19,99" (decimal).
    const parts = cleaned.split(",");
    const last = parts[parts.length - 1] ?? "";
    if (parts.length === 2 && last.length !== 3) {
      normalized = cleaned.replace(",", "."); // decimal comma
    } else {
      normalized = cleaned.replace(/,/g, ""); // thousands comma
    }
  }
  // else: only dots (or plain integer) — already JS-parseable.

  const value = Number.parseFloat(normalized);
  return Number.isNaN(value) ? null : value;
}

/** The set of ISO-4217 codes we recognize without an accompanying symbol. */
const KNOWN_ISO_CODES = new Set<string>([
  "USD", "EUR", "GBP", "JPY", "CNY", "KRW", "INR", "RUB", "BRL", "AUD", "CAD",
  "CHF", "SEK", "NOK", "DKK", "PLN", "TRY", "MXN", "ZAR", "SGD", "HKD", "NZD",
  "THB", "IDR", "MYR", "PHP", "VND", "AED", "SAR", "ILS", "CZK", "HUF", "RON",
  "CLP", "COP", "ARS", "TWD", "ISK",
]);

/** Strict-ish HTTP(S) URL validation. */
export function isValidUrl(input: string): boolean {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return false;
  }
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Upgrade `http://` URLs to `https://` and trim surrounding whitespace. */
export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  try {
    const url = new URL(trimmed);
    if (url.protocol === "http:") {
      url.protocol = "https:";
    }
    return url.toString();
  } catch {
    return trimmed;
  }
}

/** True when a string looks like a plausible image URL by extension or host. */
export function looksLikeImageUrl(input: string): boolean {
  if (!isValidUrl(input)) {
    return false;
  }
  return (
    /\.(jpe?g|png|webp|gif|bmp|tiff?)(\?|#|$)/i.test(input) ||
    /(cdn|images?|img|media|assets|static)\b/i.test(input)
  );
}

/**
 * Perform a best-effort liveness probe of an image URL.
 *
 * Uses a `HEAD` request first and falls back to a ranged `GET` for servers that
 * reject HEAD. Network failures resolve to `false` rather than throwing, so a
 * dead image becomes a finding, never a crash. A short timeout keeps large
 * feeds responsive.
 */
export async function isImageReachable(url: string, timeoutMs = 6000): Promise<boolean> {
  if (!isValidUrl(url)) {
    return false;
  }

  const probe = async (method: "HEAD" | "GET"): Promise<boolean> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const init: RequestInit = {
        method,
        redirect: "follow",
        signal: controller.signal,
        headers:
          method === "GET"
            ? { Range: "bytes=0-0", "User-Agent": "FeedLint/1.0 (+image-check)" }
            : { "User-Agent": "FeedLint/1.0 (+image-check)" },
      };
      const res = await fetch(url, init);
      return res.ok || res.status === 206;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };

  if (await probe("HEAD")) {
    return true;
  }
  return probe("GET");
}

/* -------------------------------------------------------------------------- */
/*  Shared rule builders                                                      */
/* -------------------------------------------------------------------------- */

/** Read a canonical field as a trimmed string (never undefined). */
function readField(product: CanonicalProduct, field: string): string {
  const value = (product as unknown as Record<string, unknown>)[field];
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined || value === null) {
    return "";
  }
  return String(value);
}

/** Build a "required field must be present" rule. */
function requiredFieldRule(field: string): RuleDefinition {
  return {
    id: `${field}.required`,
    field,
    description: `\`${field}\` is required and must not be empty.`,
    severity: "error",
    apply: (product): RuleResult => {
      const value = readField(product, field).trim();
      if (value.length > 0) {
        return { status: "ok" };
      }
      return {
        status: "error",
        message: `Missing required field \`${field}\`.`,
      };
    },
  };
}

/** Build the title length + whitespace + HTML rule for a platform. */
function titleRule(spec: PlatformSpec): RuleDefinition {
  return {
    id: "title.cleanse",
    field: "title",
    description: `Title must be plain text, trimmed, and ≤ ${spec.titleMaxLength} chars.`,
    severity: "warning",
    apply: (product, ctx): RuleResult => {
      const original = readField(product, "title");
      if (original.trim().length === 0) {
        return { status: "ok" }; // handled by the required-field rule
      }

      let working = original;
      const reasons: string[] = [];

      if (containsHtml(working)) {
        working = stripHtml(working);
        reasons.push("removed HTML");
      }

      const collapsed = normalizeWhitespace(working);
      if (collapsed !== working) {
        working = collapsed;
        reasons.push("collapsed whitespace");
      }

      if (Array.from(working).length > spec.titleMaxLength) {
        working = smartTruncate(working, spec.titleMaxLength);
        reasons.push(`truncated to ${spec.titleMaxLength} chars`);
      }

      if (working === original) {
        return { status: "ok" };
      }

      if (!ctx.autofix) {
        return {
          status: "warning",
          message: `Title needs cleansing (${reasons.join(", ")}).`,
        };
      }

      return {
        status: "fixed",
        message: `Title cleansed: ${reasons.join(", ")}.`,
        patch: { title: working },
      };
    },
  };
}

/** Build the description HTML/length rule for a platform. */
function descriptionRule(spec: PlatformSpec): RuleDefinition {
  return {
    id: "description.cleanse",
    field: "description",
    description: `Description must be HTML-free and ≤ ${spec.descriptionMaxLength} chars.`,
    severity: "warning",
    apply: (product, ctx): RuleResult => {
      const original = readField(product, "description");
      if (original.trim().length === 0) {
        return { status: "ok" };
      }

      let working = original;
      const reasons: string[] = [];

      if (containsHtml(working)) {
        working = stripHtml(working);
        reasons.push("stripped HTML");
      } else {
        const collapsed = normalizeWhitespace(working);
        if (collapsed !== working) {
          working = collapsed;
          reasons.push("collapsed whitespace");
        }
      }

      if (Array.from(working).length > spec.descriptionMaxLength) {
        working = smartTruncate(working, spec.descriptionMaxLength);
        reasons.push(`truncated to ${spec.descriptionMaxLength} chars`);
      }

      if (working === original) {
        return { status: "ok" };
      }

      if (!ctx.autofix) {
        return {
          status: "warning",
          message: `Description needs cleansing (${reasons.join(", ")}).`,
        };
      }

      return {
        status: "fixed",
        message: `Description cleansed: ${reasons.join(", ")}.`,
        patch: { description: working },
      };
    },
  };
}

/** Build the price-normalization rule for a platform. */
function priceRule(spec: PlatformSpec): RuleDefinition {
  return {
    id: "price.normalize",
    field: "price",
    description: `Price must be \`<amount> <CURRENCY>\` (default ${spec.defaultCurrency}).`,
    severity: "error",
    apply: (product, ctx): RuleResult => {
      const original = readField(product, "price");
      if (original.trim().length === 0) {
        return { status: "ok" }; // required-field rule reports the absence
      }

      const parsed = parsePrice(original, spec.defaultCurrency);
      if (parsed === null) {
        return {
          status: "error",
          message: `Unparseable price \`${original}\`.`,
        };
      }

      if (parsed.amount <= 0) {
        return {
          status: "error",
          message: `Price must be greater than zero (got \`${original}\`).`,
        };
      }

      if (parsed.formatted === original) {
        return { status: "ok" };
      }

      const reason =
        parsed.currency === null
          ? `added default currency ${spec.defaultCurrency} and normalized format`
          : "normalized amount/currency format";

      if (!ctx.autofix) {
        return {
          status: "warning",
          message: `Price \`${original}\` should be \`${parsed.formatted}\` (${reason}).`,
        };
      }

      return {
        status: "fixed",
        message: `Price normalized \`${original}\` → \`${parsed.formatted}\` (${reason}).`,
        patch: { price: parsed.formatted },
      };
    },
  };
}

/** Build the optional sale_price-normalization rule for a platform. */
function salePriceRule(spec: PlatformSpec): RuleDefinition {
  return {
    id: "sale_price.normalize",
    field: "sale_price",
    description: `Sale price, when present, must use the same \`<amount> <CURRENCY>\` format.`,
    severity: "warning",
    apply: (product, ctx): RuleResult => {
      const original = readField(product, "sale_price");
      if (original.trim().length === 0) {
        return { status: "ok" };
      }

      const parsed = parsePrice(original, spec.defaultCurrency);
      if (parsed === null || parsed.amount <= 0) {
        return {
          status: "warning",
          message: `Unparseable sale_price \`${original}\` (left as-is).`,
        };
      }

      if (parsed.formatted === original) {
        return { status: "ok" };
      }

      if (!ctx.autofix) {
        return {
          status: "warning",
          message: `sale_price \`${original}\` should be \`${parsed.formatted}\`.`,
        };
      }

      return {
        status: "fixed",
        message: `sale_price normalized \`${original}\` → \`${parsed.formatted}\`.`,
        patch: { sale_price: parsed.formatted },
      };
    },
  };
}

/** Build the availability-token rule for a platform. */
function availabilityRule(spec: PlatformSpec): RuleDefinition {
  // Common source variants mapped to canonical tokens.
  const synonyms: Readonly<Record<string, string>> = {
    instock: "in stock",
    "in-stock": "in stock",
    in_stock: "in stock",
    available: "in stock",
    active: "in stock",
    outofstock: "out of stock",
    "out-of-stock": "out of stock",
    out_of_stock: "out of stock",
    soldout: "out of stock",
    "sold-out": "out of stock",
    unavailable: "out of stock",
    pre_order: "preorder",
    "pre-order": "preorder",
    preorder: "preorder",
    back_order: "backorder",
    "back-order": "backorder",
    backorder: "backorder",
  };

  return {
    id: "availability.normalize",
    field: "availability",
    description: `Availability must be one of: ${spec.allowedAvailability.join(", ")}.`,
    severity: "error",
    apply: (product, ctx): RuleResult => {
      const original = readField(product, "availability");
      if (original.trim().length === 0) {
        return ctx.autofix
          ? {
              status: "fixed",
              message: "Missing availability defaulted to `in stock`.",
              patch: { availability: "in stock" },
            }
          : { status: "warning", message: "Missing availability; would default to `in stock`." };
      }

      const lowered = original.trim().toLowerCase();
      if (spec.allowedAvailability.includes(lowered)) {
        if (lowered === original) {
          return { status: "ok" };
        }
        return ctx.autofix
          ? {
              status: "fixed",
              message: `Availability lower-cased to \`${lowered}\`.`,
              patch: { availability: lowered },
            }
          : { status: "warning", message: `Availability should be lower-cased to \`${lowered}\`.` };
      }

      const mapped = synonyms[lowered.replace(/\s+/g, " ")] ?? synonyms[lowered.replace(/\s+/g, "")];
      if (mapped && spec.allowedAvailability.includes(mapped)) {
        if (!ctx.autofix) {
          return {
            status: "warning",
            message: `Availability \`${original}\` should map to \`${mapped}\`.`,
          };
        }
        return {
          status: "fixed",
          message: `Availability \`${original}\` → \`${mapped}\`.`,
          patch: { availability: mapped },
        };
      }

      return {
        status: "error",
        message: `Invalid availability \`${original}\` (allowed: ${spec.allowedAvailability.join(", ")}).`,
      };
    },
  };
}

/** Build the condition-token rule for a platform. */
function conditionRule(spec: PlatformSpec): RuleDefinition {
  const synonyms: Readonly<Record<string, string>> = {
    brand_new: "new",
    "brand-new": "new",
    brandnew: "new",
    refurb: "refurbished",
    refurbished: "refurbished",
    renewed: "refurbished",
    "pre-owned": "used",
    preowned: "used",
    secondhand: "used",
    "second-hand": "used",
  };

  return {
    id: "condition.normalize",
    field: "condition",
    description: `Condition must be one of: ${spec.allowedCondition.join(", ")}.`,
    severity: "warning",
    apply: (product, ctx): RuleResult => {
      const original = readField(product, "condition");
      if (original.trim().length === 0) {
        return ctx.autofix
          ? {
              status: "fixed",
              message: "Missing condition defaulted to `new`.",
              patch: { condition: "new" },
            }
          : { status: "warning", message: "Missing condition; would default to `new`." };
      }

      const lowered = original.trim().toLowerCase();
      if (spec.allowedCondition.includes(lowered)) {
        return lowered === original
          ? { status: "ok" }
          : ctx.autofix
            ? {
                status: "fixed",
                message: `Condition lower-cased to \`${lowered}\`.`,
                patch: { condition: lowered },
              }
            : { status: "warning", message: `Condition should be lower-cased to \`${lowered}\`.` };
      }

      const mapped = synonyms[lowered.replace(/\s+/g, "_")] ?? synonyms[lowered.replace(/\s+/g, "-")];
      if (mapped) {
        return ctx.autofix
          ? {
              status: "fixed",
              message: `Condition \`${original}\` → \`${mapped}\`.`,
              patch: { condition: mapped },
            }
          : { status: "warning", message: `Condition \`${original}\` should map to \`${mapped}\`.` };
      }

      return ctx.autofix
        ? {
            status: "fixed",
            message: `Unrecognized condition \`${original}\` defaulted to \`new\`.`,
            patch: { condition: "new" },
          }
        : { status: "warning", message: `Unrecognized condition \`${original}\`; would default to \`new\`.` };
    },
  };
}

/** Build the landing-page URL rule for a platform. */
function linkRule(): RuleDefinition {
  return {
    id: "link.validate",
    field: "link",
    description: "Landing-page link must be a valid http(s) URL.",
    severity: "error",
    apply: (product, ctx): RuleResult => {
      const original = readField(product, "link");
      if (original.trim().length === 0) {
        return { status: "ok" }; // required-field rule reports absence
      }

      if (!isValidUrl(original)) {
        return {
          status: "error",
          message: `Invalid landing-page URL \`${original}\`.`,
        };
      }

      const normalized = normalizeUrl(original);
      if (normalized === original) {
        return { status: "ok" };
      }

      return ctx.autofix
        ? {
            status: "fixed",
            message: `Landing-page URL upgraded to HTTPS.`,
            patch: { link: normalized },
          }
        : { status: "warning", message: `Landing-page URL should be HTTPS: \`${normalized}\`.` };
    },
  };
}

/** Build the image URL rule (format + optional liveness). */
function imageRule(): RuleDefinition {
  return {
    id: "image_link.validate",
    field: "image_link",
    description: "Primary image must be a valid http(s) URL (optionally reachable).",
    severity: "error",
    apply: async (product, ctx): Promise<RuleResult> => {
      const original = readField(product, "image_link");
      if (original.trim().length === 0) {
        return { status: "ok" }; // required-field rule reports absence
      }

      if (!isValidUrl(original)) {
        return {
          status: "error",
          message: `Invalid image URL \`${original}\`.`,
        };
      }

      const normalized = normalizeUrl(original);
      let patch: Partial<CanonicalProduct> | undefined;
      const reasons: string[] = [];

      if (normalized !== original && ctx.autofix) {
        patch = { image_link: normalized };
        reasons.push("upgraded to HTTPS");
      }

      if (ctx.checkImages) {
        // Prefer the engine's pre-computed pool result; fall back to a live
        // probe only on a cache miss (e.g. when the rule runs standalone).
        const cached = ctx.imageReachability.get(normalized);
        const reachable = cached !== undefined ? cached : await isImageReachable(normalized);
        if (!reachable) {
          return {
            status: "error",
            message: `Image URL is unreachable: \`${normalized}\`.`,
          };
        }
      } else if (!looksLikeImageUrl(normalized)) {
        return {
          status: "warning",
          message: `Image URL does not look like an image: \`${normalized}\`.`,
        };
      }

      if (patch) {
        return {
          status: "fixed",
          message: `Image URL ${reasons.join(", ")}.`,
          patch,
        };
      }
      return { status: "ok" };
    },
  };
}

/** Build the brand presence rule (only where the platform requires it). */
function brandRule(): RuleDefinition {
  return {
    id: "brand.cleanse",
    field: "brand",
    description: "Brand should be trimmed plain text.",
    severity: "warning",
    apply: (product, ctx): RuleResult => {
      const original = readField(product, "brand");
      if (original.trim().length === 0) {
        return { status: "ok" };
      }
      const cleaned = normalizeWhitespace(stripHtml(original));
      if (cleaned === original) {
        return { status: "ok" };
      }
      return ctx.autofix
        ? { status: "fixed", message: "Brand trimmed/cleaned.", patch: { brand: cleaned } }
        : { status: "warning", message: "Brand should be trimmed/cleaned." };
    },
  };
}

/**
 * GTIN sanity rule. GTINs must be 8/12/13/14 numeric digits. When present and
 * malformed, we surface a warning (we never fabricate identifiers).
 */
function gtinRule(): RuleDefinition {
  return {
    id: "gtin.validate",
    field: "gtin",
    description: "GTIN, when present, must be 8/12/13/14 numeric digits with a valid checksum.",
    severity: "warning",
    apply: (product, ctx): RuleResult => {
      const original = readField(product, "gtin");
      if (original.trim().length === 0) {
        return { status: "ok" };
      }

      const digits = original.replace(/[\s-]/g, "");
      if (!/^\d+$/.test(digits)) {
        return {
          status: "warning",
          message: `GTIN \`${original}\` contains non-numeric characters.`,
        };
      }
      if (![8, 12, 13, 14].includes(digits.length)) {
        return {
          status: "warning",
          message: `GTIN \`${original}\` has invalid length ${digits.length} (expected 8/12/13/14).`,
        };
      }
      if (!isValidGtinChecksum(digits)) {
        return {
          status: "warning",
          message: `GTIN \`${original}\` fails its check-digit validation.`,
        };
      }

      // Normalize away separators when auto-fixing.
      if (digits !== original && ctx.autofix) {
        return {
          status: "fixed",
          message: "GTIN separators removed.",
          patch: { gtin: digits },
        };
      }
      return { status: "ok" };
    },
  };
}

/** Standard GS1 modulo-10 check-digit validation for GTIN-8/12/13/14. */
export function isValidGtinChecksum(digits: string): boolean {
  if (!/^\d{8}$|^\d{12}$|^\d{13}$|^\d{14}$/.test(digits)) {
    return false;
  }
  const nums = digits.split("").map((d) => Number.parseInt(d, 10));
  const check = nums.pop() as number;
  let sum = 0;
  // Weights alternate 3,1,3,1… counting from the right-most data digit.
  for (let i = nums.length - 1, position = 1; i >= 0; i -= 1, position += 1) {
    const weight = position % 2 === 1 ? 3 : 1;
    sum += (nums[i] as number) * weight;
  }
  const computed = (10 - (sum % 10)) % 10;
  return computed === check;
}

/* -------------------------------------------------------------------------- */
/*  Assembled per-platform rule sets                                          */
/* -------------------------------------------------------------------------- */

/** Assemble the ordered rule list for a single platform. */
function buildRules(spec: PlatformSpec): RuleDefinition[] {
  const rules: RuleDefinition[] = [];

  // 1. Required-field presence checks come first.
  //
  //    `availability` and `condition` are intentionally excluded here: their
  //    normalize rules guarantee a safe default when the source omits them, so
  //    treating them as hard, unresolvable errors would double-count a problem
  //    the engine already repairs. Every other required field has no safe
  //    default and so remains a true presence requirement.
  const autoDefaulted = new Set<string>(["availability", "condition"]);
  for (const field of spec.requiredFields) {
    if (autoDefaulted.has(field)) {
      continue;
    }
    rules.push(requiredFieldRule(field));
  }

  // 2. Field-level normalization / cleansing.
  rules.push(titleRule(spec));
  rules.push(descriptionRule(spec));
  rules.push(priceRule(spec));
  rules.push(salePriceRule(spec));
  rules.push(availabilityRule(spec));
  rules.push(conditionRule(spec));
  rules.push(linkRule());
  rules.push(imageRule());
  rules.push(gtinRule());

  // 3. Brand cleansing only where brand is part of the spec.
  if (spec.requiredFields.includes("brand")) {
    rules.push(brandRule());
  }

  return rules;
}

/** The fully assembled, ordered rule set for each platform. */
export const PLATFORM_RULES: Readonly<Record<Platform, readonly RuleDefinition[]>> = {
  meta: buildRules(PLATFORM_SPECS.meta),
  google: buildRules(PLATFORM_SPECS.google),
  tiktok: buildRules(PLATFORM_SPECS.tiktok),
};

/** Convenience accessor used by the engine. */
export function getRulesFor(platform: Platform): readonly RuleDefinition[] {
  return PLATFORM_RULES[platform];
}

/** Convenience accessor for the static spec, used by `--explain`. */
export function getSpecFor(platform: Platform): PlatformSpec {
  return PLATFORM_SPECS[platform];
}

export { type RuleContext };
