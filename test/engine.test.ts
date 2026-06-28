/**
 * Tests for the engine: feed parsing, dialect normalization, the concurrency
 * pool, and a full end-to-end runEngine pass over temp files.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseFeed,
  normalizeProduct,
  mapWithConcurrency,
  runEngine,
} from "../src/engine.js";
import type { EngineOptions } from "../src/types.js";

/** Create a unique temp directory for a test and return its path. */
async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "feedlint-test-"));
}

describe("parseFeed", () => {
  it("parses a bare JSON array", () => {
    const products = parseFeed('[{"id":"1"},{"id":"2"}]', "feed.json");
    expect(products).toHaveLength(2);
  });

  it("parses a Shopify { products: [...] } wrapper", () => {
    const products = parseFeed('{"products":[{"id":"1"}]}', "products.json");
    expect(products).toHaveLength(1);
  });

  it("parses { items: [...] } and { data: [...] } wrappers", () => {
    expect(parseFeed('{"items":[{"id":"1"}]}', "f.json")).toHaveLength(1);
    expect(parseFeed('{"data":[{"id":"1"},{"id":"2"}]}', "f.json")).toHaveLength(2);
  });

  it("treats a single object as a one-product feed", () => {
    expect(parseFeed('{"id":"only"}', "f.json")).toHaveLength(1);
  });

  it("parses a Google RSS XML feed and strips the g: namespace", () => {
    const xml = `<?xml version="1.0"?>
      <rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
        <channel>
          <title>Feed</title>
          <item>
            <g:id>X1</g:id>
            <title>Item one</title>
            <g:price>10.00 USD</g:price>
          </item>
          <item>
            <g:id>X2</g:id>
            <title>Item two</title>
          </item>
        </channel>
      </rss>`;
    const products = parseFeed(xml, "feed.xml");
    expect(products).toHaveLength(2);
    expect(products[0]?.["id"]).toBe("X1");
    expect(products[0]?.["title"]).toBe("Item one");
  });

  it("throws a typed PARSE_ERROR on invalid JSON", () => {
    expect(() => parseFeed("{not json", "feed.json")).toThrowError(/Invalid JSON/);
  });

  it("throws on empty input", () => {
    expect(() => parseFeed("   ", "feed.json")).toThrowError();
  });
});

describe("normalizeProduct", () => {
  it("flattens Shopify variants and images", () => {
    const raw = {
      id: 1001,
      title: "Shopify Product",
      body_html: "<p>Body</p>",
      vendor: "AcmeAudio",
      product_type: "Electronics",
      variants: [{ price: "$1,299.00", sku: "ACM-1001" }],
      images: [{ src: "http://cdn.example.com/a.jpg" }, { src: "https://cdn.example.com/b.jpg" }],
    };
    const p = normalizeProduct(raw, 0);
    expect(p.id).toBe("1001");
    expect(p.title).toBe("Shopify Product");
    expect(p.description).toBe("<p>Body</p>"); // raw — cleansing happens in rules
    expect(p.brand).toBe("AcmeAudio");
    expect(p.price).toBe("$1,299.00");
    expect(p.image_link).toBe("http://cdn.example.com/a.jpg");
    expect(p.additional_image_link).toContain("https://cdn.example.com/b.jpg");
  });

  it("synthesizes an id when none is present", () => {
    const p = normalizeProduct({ title: "No id" }, 4);
    expect(p.id).toBe("feedlint-5");
  });

  it("maps Google g: aliases", () => {
    const raw = {
      "g:id": "G1",
      "g:title": "Google Title",
      "g:price": "9.99 USD",
      "g:image_link": "https://cdn.example.com/g.jpg",
    };
    const p = normalizeProduct(raw, 0);
    expect(p.id).toBe("G1");
    expect(p.title).toBe("Google Title");
    expect(p.price).toBe("9.99 USD");
  });

  it("preserves unmapped scalar fields in extra", () => {
    const p = normalizeProduct({ id: "1", custom_label_0: "promo" }, 0);
    expect(p.extra["custom_label_0"]).toBe("promo");
  });
});

describe("mapWithConcurrency", () => {
  it("processes every item exactly once", async () => {
    const seen: number[] = [];
    await mapWithConcurrency([0, 1, 2, 3, 4], 2, async (item) => {
      seen.push(item);
    });
    expect(seen.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });

  it("never exceeds the concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;
    const items = Array.from({ length: 12 }, (_v, i) => i);
    await mapWithConcurrency(items, 3, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    });
    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it("does not abort the batch when a worker throws", async () => {
    const ok: number[] = [];
    await mapWithConcurrency([1, 2, 3], 2, async (item) => {
      if (item === 2) {
        throw new Error("boom");
      }
      ok.push(item);
    });
    expect(ok.sort()).toEqual([1, 3]);
  });

  it("is a no-op for an empty list", async () => {
    await expect(mapWithConcurrency([], 4, async () => undefined)).resolves.toBeUndefined();
  });
});

describe("runEngine (end-to-end)", () => {
  it("cleanses a mixed feed and writes valid JSON output", async () => {
    const dir = await makeTmpDir();
    try {
      const inputPath = join(dir, "in.json");
      const outputPath = join(dir, "out.json");
      await writeFile(
        inputPath,
        JSON.stringify({
          products: [
            {
              id: "clean",
              title: "Clean Product",
              description: "All good here.",
              availability: "in stock",
              condition: "new",
              price: "19.99 USD",
              link: "https://example.com/clean",
              image_link: "https://cdn.example.com/clean.jpg",
              brand: "Acme",
            },
            {
              id: "dirty",
              title: "<b>Dirty Product</b>",
              body_html: "<p>Has &amp; html</p>",
              vendor: "Acme",
              variants: [{ price: "$1,299" }],
              images: [{ src: "http://cdn.example.com/dirty.jpg" }],
              availability: "sold out",
              condition: "Brand New",
              url: "http://example.com/dirty",
            },
          ],
        }),
        "utf8",
      );

      const options: EngineOptions = {
        inputPath,
        outputPath,
        platform: "meta",
        autofix: true,
        checkImages: false,
        imageConcurrency: 8,
        dropInvalid: false,
        format: "json",
      };

      const report = await runEngine(options);

      expect(report.totalScanned).toBe(2);
      expect(report.totalFixed).toBe(1); // the dirty product
      expect(report.totalClean).toBe(1); // the clean product
      expect(report.output).toHaveLength(2);

      // The written file must be valid JSON with the cleansed values.
      const written = JSON.parse(await readFile(outputPath, "utf8")) as {
        products: Array<Record<string, string>>;
      };
      const dirty = written.products.find((p) => p.id === "dirty");
      expect(dirty?.title).toBe("Dirty Product");
      expect(dirty?.price).toBe("1299.00 USD");
      expect(dirty?.availability).toBe("out of stock");
      expect(dirty?.condition).toBe("new");
      expect(dirty?.image_link).toBe("https://cdn.example.com/dirty.jpg");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("drops invalid products and ships a clean feed with --drop-invalid", async () => {
    const dir = await makeTmpDir();
    try {
      const inputPath = join(dir, "in.json");
      const outputPath = join(dir, "out.json");
      await writeFile(
        inputPath,
        JSON.stringify([
          {
            id: "good",
            title: "Good",
            description: "ok",
            price: "5 USD",
            link: "https://example.com/g",
            image_link: "https://cdn.example.com/g.jpg",
            brand: "Acme",
          },
          { id: "bad", title: "Bad" }, // missing many required fields
        ]),
        "utf8",
      );

      const report = await runEngine({
        inputPath,
        outputPath,
        platform: "meta",
        autofix: true,
        checkImages: false,
        imageConcurrency: 8,
        dropInvalid: true,
        format: "json",
      });

      expect(report.totalScanned).toBe(2);
      expect(report.totalDropped).toBe(1);
      expect(report.totalErrorsInOutput).toBe(0); // clean output ships
      expect(report.output).toHaveLength(1);
      expect(report.output[0]?.id).toBe("good");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("serializes XML output with the g: namespace", async () => {
    const dir = await makeTmpDir();
    try {
      const inputPath = join(dir, "in.json");
      const outputPath = join(dir, "out.xml");
      await writeFile(
        inputPath,
        JSON.stringify([
          {
            id: "x1",
            title: "XML Product",
            description: "desc",
            availability: "in stock",
            condition: "new",
            price: "9.99 USD",
            link: "https://example.com/x",
            image_link: "https://cdn.example.com/x.jpg",
            brand: "Acme",
          },
        ]),
        "utf8",
      );

      await runEngine({
        inputPath,
        outputPath,
        platform: "google",
        autofix: true,
        checkImages: false,
        imageConcurrency: 8,
        dropInvalid: false,
        format: "xml",
      });

      const xml = await readFile(outputPath, "utf8");
      expect(xml).toContain('xmlns:g="http://base.google.com/ns/1.0"');
      expect(xml).toContain("<g:id>x1</g:id>");
      expect(xml).toContain("<title>XML Product</title>");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws on a missing input file", async () => {
    await expect(
      runEngine({
        inputPath: join(tmpdir(), "definitely-missing-feedlint.json"),
        outputPath: join(tmpdir(), "out.json"),
        platform: "meta",
        autofix: true,
        checkImages: false,
        imageConcurrency: 8,
        dropInvalid: false,
        format: "json",
      }),
    ).rejects.toThrowError();
  });
});
