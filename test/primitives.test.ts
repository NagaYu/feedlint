/**
 * Unit tests for the pure cleansing primitives in src/rules.ts.
 *
 * These functions are the backbone of every auto-fix, so they get exhaustive,
 * edge-case-driven coverage.
 */

import { describe, it, expect } from "vitest";
import {
  stripHtml,
  containsHtml,
  smartTruncate,
  normalizeWhitespace,
  parsePrice,
  isValidUrl,
  normalizeUrl,
  looksLikeImageUrl,
  isValidGtinChecksum,
} from "../src/rules.js";

describe("stripHtml", () => {
  it("returns empty string for empty input", () => {
    expect(stripHtml("")).toBe("");
  });

  it("removes simple tags", () => {
    expect(stripHtml("<b>Hello</b> <i>World</i>")).toBe("Hello World");
  });

  it("drops script and style block contents entirely", () => {
    expect(stripHtml("Keep<script>alert('x')</script>Me")).toBe("Keep Me");
    expect(stripHtml("A<style>.x{color:red}</style>B")).toBe("A B");
  });

  it("turns block-level tags and <br> into spaces", () => {
    expect(stripHtml("<p>One</p><p>Two</p>")).toBe("One Two");
    expect(stripHtml("Line1<br>Line2")).toBe("Line1 Line2");
    expect(stripHtml("Line1<br/>Line2")).toBe("Line1 Line2");
  });

  it("decodes named entities", () => {
    expect(stripHtml("Tom &amp; Jerry")).toBe("Tom & Jerry");
    expect(stripHtml("a&nbsp;b")).toBe("a b");
    expect(stripHtml("&copy;2026 &mdash; done")).toBe("©2026 — done");
  });

  it("decodes decimal and hex numeric entities", () => {
    expect(stripHtml("&#65;&#66;&#67;")).toBe("ABC");
    expect(stripHtml("&#x41;&#x42;")).toBe("AB");
  });

  it("ignores out-of-range numeric entities without throwing", () => {
    expect(stripHtml("X&#99999999999;Y")).toBe("XY");
  });

  it("collapses runaway whitespace", () => {
    expect(stripHtml("  a\n\n   b\t c  ")).toBe("a b c");
  });
});

describe("containsHtml", () => {
  it("detects tags", () => {
    expect(containsHtml("<p>hi</p>")).toBe(true);
    expect(containsHtml("plain text")).toBe(false);
  });

  it("detects entities", () => {
    expect(containsHtml("a &amp; b")).toBe(true);
    expect(containsHtml("a &#39; b")).toBe(true);
  });
});

describe("smartTruncate", () => {
  it("returns the input unchanged when within budget", () => {
    expect(smartTruncate("short", 10)).toBe("short");
    expect(smartTruncate("exactly-ten", "exactly-ten".length)).toBe("exactly-ten");
  });

  it("never exceeds the max length (including ellipsis)", () => {
    const out = smartTruncate("The quick brown fox jumps over the lazy dog", 20);
    expect(Array.from(out).length).toBeLessThanOrEqual(20);
  });

  it("cuts on a word boundary and appends an ellipsis", () => {
    const out = smartTruncate("The quick brown fox jumps", 16);
    expect(out.endsWith("…")).toBe(true);
    // Should not cut mid-word: the char before the ellipsis is a full word.
    expect(out).toBe("The quick brown…");
  });

  it("is surrogate-safe for emoji / astral characters", () => {
    const emoji = "😀😀😀😀😀";
    const out = smartTruncate(emoji, 3);
    // 2 emoji + ellipsis = 3 code points, and no broken surrogate halves.
    expect(Array.from(out).length).toBeLessThanOrEqual(3);
    expect(out).not.toContain("�");
  });

  it("handles tiny max values without crashing", () => {
    expect(Array.from(smartTruncate("hello", 1)).length).toBeLessThanOrEqual(1);
    expect(smartTruncate("hello", 0)).toBe("");
  });
});

describe("normalizeWhitespace", () => {
  it("collapses and trims", () => {
    expect(normalizeWhitespace("  a   b\t\nc ")).toBe("a b c");
  });
});

describe("parsePrice", () => {
  it("parses a plain integer and applies the default currency", () => {
    expect(parsePrice("1299", "USD")).toEqual({
      amount: 1299,
      currency: null,
      formatted: "1299.00 USD",
    });
  });

  it("parses a US-formatted price with symbol and thousands separators", () => {
    const p = parsePrice("$1,299.00", "USD");
    expect(p?.formatted).toBe("1299.00 USD");
    expect(p?.currency).toBe("USD");
  });

  it("parses a European decimal comma", () => {
    const p = parsePrice("19,99 EUR", "USD");
    expect(p?.formatted).toBe("19.99 EUR");
    expect(p?.currency).toBe("EUR");
  });

  it("parses European thousands + decimal (1.299,00)", () => {
    const p = parsePrice("1.299,00 EUR", "USD");
    expect(p?.formatted).toBe("1299.00 EUR");
  });

  it("detects an ISO code in any position", () => {
    expect(parsePrice("USD 49.50", "EUR")?.formatted).toBe("49.50 USD");
    expect(parsePrice("49.50 usd", "EUR")?.formatted).toBe("49.50 USD");
  });

  it("detects currency symbols", () => {
    expect(parsePrice("£10", "USD")?.currency).toBe("GBP");
    expect(parsePrice("¥1980", "USD")?.currency).toBe("JPY");
  });

  it("uses zero decimals for zero-decimal currencies", () => {
    expect(parsePrice("1980 JPY", "USD")?.formatted).toBe("1980 JPY");
  });

  it("treats a 3-digit comma group as thousands, not decimal", () => {
    expect(parsePrice("1,299", "USD")?.formatted).toBe("1299.00 USD");
  });

  it("returns null for unparseable or empty input", () => {
    expect(parsePrice("", "USD")).toBeNull();
    expect(parsePrice("free", "USD")).toBeNull();
    expect(parsePrice("   ", "USD")).toBeNull();
  });

  it("rejects negative amounts", () => {
    expect(parsePrice("-5", "USD")).toBeNull();
  });
});

describe("isValidUrl", () => {
  it("accepts http and https", () => {
    expect(isValidUrl("https://example.com")).toBe(true);
    expect(isValidUrl("http://example.com/a?b=1")).toBe(true);
  });

  it("rejects non-http(s) schemes and garbage", () => {
    expect(isValidUrl("ftp://example.com")).toBe(false);
    expect(isValidUrl("javascript:alert(1)")).toBe(false);
    expect(isValidUrl("not a url")).toBe(false);
    expect(isValidUrl("")).toBe(false);
  });
});

describe("normalizeUrl", () => {
  it("upgrades http to https", () => {
    expect(normalizeUrl("http://example.com/x")).toBe("https://example.com/x");
  });

  it("leaves https untouched (modulo URL canonicalization) and trims", () => {
    expect(normalizeUrl("  https://example.com/x  ")).toBe("https://example.com/x");
  });

  it("returns the trimmed original when not a valid URL", () => {
    expect(normalizeUrl("  not a url  ")).toBe("not a url");
  });
});

describe("looksLikeImageUrl", () => {
  it("accepts known image extensions", () => {
    expect(looksLikeImageUrl("https://cdn.example.com/a.jpg")).toBe(true);
    expect(looksLikeImageUrl("https://cdn.example.com/a.png?v=2")).toBe(true);
  });

  it("accepts CDN/media-style hosts without an extension", () => {
    expect(looksLikeImageUrl("https://images.example.com/p/1001")).toBe(true);
  });

  it("rejects invalid URLs", () => {
    expect(looksLikeImageUrl("nope")).toBe(false);
  });
});

describe("isValidGtinChecksum", () => {
  it("accepts valid GTIN-13 and GTIN-12 codes", () => {
    expect(isValidGtinChecksum("4006381333931")).toBe(true); // GTIN-13
    expect(isValidGtinChecksum("036000291452")).toBe(true); // UPC-A / GTIN-12
  });

  it("accepts a valid GTIN-8", () => {
    expect(isValidGtinChecksum("73513537")).toBe(true);
  });

  it("rejects a bad check digit", () => {
    expect(isValidGtinChecksum("4006381333930")).toBe(false);
  });

  it("rejects wrong lengths and non-digits", () => {
    expect(isValidGtinChecksum("12345")).toBe(false);
    expect(isValidGtinChecksum("abcdefgh")).toBe(false);
  });
});
