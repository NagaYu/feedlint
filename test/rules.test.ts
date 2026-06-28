/**
 * Unit tests for the per-platform rule sets in src/rules.ts.
 *
 * Each rule is located by id, applied to a crafted product, and its
 * {@link RuleResult} asserted — both in autofix and dry-run modes.
 */

import { describe, it, expect } from "vitest";
import { getRulesFor, getSpecFor, PLATFORM_SPECS } from "../src/rules.js";
import type {
  CanonicalProduct,
  Platform,
  RuleContext,
  RuleDefinition,
  RuleResult,
} from "../src/types.js";

/** Build a fully-valid canonical product, overridable per test. */
function makeProduct(overrides: Partial<CanonicalProduct> = {}): CanonicalProduct {
  return {
    id: "SKU-1",
    title: "A perfectly fine title",
    description: "A perfectly fine description.",
    availability: "in stock",
    condition: "new",
    price: "19.99 USD",
    link: "https://example.com/p",
    image_link: "https://cdn.example.com/p.jpg",
    brand: "Acme",
    extra: {},
    ...overrides,
  };
}

/** Build a rule context. */
function makeCtx(overrides: Partial<RuleContext> = {}): RuleContext {
  return {
    platform: "meta",
    autofix: true,
    checkImages: false,
    imageReachability: new Map(),
    ...overrides,
  };
}

/** Locate a rule by id for a platform, failing loudly if missing. */
function rule(platform: Platform, id: string): RuleDefinition {
  const found = getRulesFor(platform).find((r) => r.id === id);
  if (!found) {
    throw new Error(`rule ${id} not found for ${platform}`);
  }
  return found;
}

/** Apply a rule and await the (possibly async) result. */
async function apply(
  platform: Platform,
  id: string,
  product: CanonicalProduct,
  ctx: RuleContext,
): Promise<RuleResult> {
  return rule(platform, id).apply(product, ctx);
}

describe("required-field rules", () => {
  it("flags a missing required field as an error", async () => {
    const res = await apply("meta", "title.required", makeProduct({ title: "" }), makeCtx());
    expect(res.status).toBe("error");
  });

  it("passes when present", async () => {
    const res = await apply("meta", "title.required", makeProduct(), makeCtx());
    expect(res.status).toBe("ok");
  });

  it("does NOT create hard required rules for availability/condition", () => {
    const ids = getRulesFor("meta").map((r) => r.id);
    expect(ids).not.toContain("availability.required");
    expect(ids).not.toContain("condition.required");
  });
});

describe("title.cleanse", () => {
  it("strips HTML when autofix is on", async () => {
    const res = await apply("meta", "title.cleanse", makeProduct({ title: "<b>Hi</b>" }), makeCtx());
    expect(res.status).toBe("fixed");
    expect(res.patch?.title).toBe("Hi");
  });

  it("truncates over-length titles to the platform limit", async () => {
    const long = "word ".repeat(60).trim(); // 300+ chars
    const res = await apply("tiktok", "title.cleanse", makeProduct({ title: long }), makeCtx());
    expect(res.status).toBe("fixed");
    expect(Array.from(res.patch!.title as string).length).toBeLessThanOrEqual(
      PLATFORM_SPECS.tiktok.titleMaxLength,
    );
  });

  it("reports a warning instead of fixing in dry-run mode", async () => {
    const res = await apply(
      "meta",
      "title.cleanse",
      makeProduct({ title: "<b>Hi</b>" }),
      makeCtx({ autofix: false }),
    );
    expect(res.status).toBe("warning");
    expect(res.patch).toBeUndefined();
  });

  it("leaves a clean title untouched", async () => {
    const res = await apply("meta", "title.cleanse", makeProduct(), makeCtx());
    expect(res.status).toBe("ok");
  });
});

describe("description.cleanse", () => {
  it("strips HTML", async () => {
    const res = await apply(
      "google",
      "description.cleanse",
      makeProduct({ description: "<p>Nice &amp; clean</p>" }),
      makeCtx(),
    );
    expect(res.status).toBe("fixed");
    expect(res.patch?.description).toBe("Nice & clean");
  });
});

describe("price.normalize", () => {
  it("normalizes a messy price", async () => {
    const res = await apply("meta", "price.normalize", makeProduct({ price: "$1,299" }), makeCtx());
    expect(res.status).toBe("fixed");
    expect(res.patch?.price).toBe("1299.00 USD");
  });

  it("errors on an unparseable price", async () => {
    const res = await apply("meta", "price.normalize", makeProduct({ price: "free" }), makeCtx());
    expect(res.status).toBe("error");
  });

  it("errors on a zero price", async () => {
    const res = await apply("meta", "price.normalize", makeProduct({ price: "0" }), makeCtx());
    expect(res.status).toBe("error");
  });

  it("leaves an already-normalized price untouched", async () => {
    const res = await apply("meta", "price.normalize", makeProduct({ price: "19.99 USD" }), makeCtx());
    expect(res.status).toBe("ok");
  });
});

describe("availability.normalize", () => {
  it("maps a synonym to the canonical token", async () => {
    const res = await apply(
      "meta",
      "availability.normalize",
      makeProduct({ availability: "sold out" }),
      makeCtx(),
    );
    expect(res.status).toBe("fixed");
    expect(res.patch?.availability).toBe("out of stock");
  });

  it("defaults missing availability to in stock when autofix on", async () => {
    const res = await apply(
      "meta",
      "availability.normalize",
      makeProduct({ availability: "" }),
      makeCtx(),
    );
    expect(res.status).toBe("fixed");
    expect(res.patch?.availability).toBe("in stock");
  });

  it("warns (does not fix) for missing availability in dry-run", async () => {
    const res = await apply(
      "meta",
      "availability.normalize",
      makeProduct({ availability: "" }),
      makeCtx({ autofix: false }),
    );
    expect(res.status).toBe("warning");
    expect(res.patch).toBeUndefined();
  });

  it("errors on a truly invalid availability token", async () => {
    const res = await apply(
      "meta",
      "availability.normalize",
      makeProduct({ availability: "maybe-later" }),
      makeCtx(),
    );
    expect(res.status).toBe("error");
  });
});

describe("condition.normalize", () => {
  it("maps 'Brand New' to 'new'", async () => {
    const res = await apply(
      "meta",
      "condition.normalize",
      makeProduct({ condition: "Brand New" }),
      makeCtx(),
    );
    expect(res.status).toBe("fixed");
    expect(res.patch?.condition).toBe("new");
  });

  it("defaults an unrecognized condition to 'new'", async () => {
    const res = await apply(
      "meta",
      "condition.normalize",
      makeProduct({ condition: "sparkly" }),
      makeCtx(),
    );
    expect(res.status).toBe("fixed");
    expect(res.patch?.condition).toBe("new");
  });
});

describe("link.validate & image_link.validate", () => {
  it("upgrades an http link to https", async () => {
    const res = await apply(
      "meta",
      "link.validate",
      makeProduct({ link: "http://example.com/p" }),
      makeCtx(),
    );
    expect(res.status).toBe("fixed");
    expect(res.patch?.link).toBe("https://example.com/p");
  });

  it("errors on an invalid link", async () => {
    const res = await apply("meta", "link.validate", makeProduct({ link: "not-a-url" }), makeCtx());
    expect(res.status).toBe("error");
  });

  it("reads image reachability from the context cache", async () => {
    const cache = new Map<string, boolean>([["https://cdn.example.com/p.jpg", false]]);
    const res = await apply(
      "meta",
      "image_link.validate",
      makeProduct(),
      makeCtx({ checkImages: true, imageReachability: cache }),
    );
    expect(res.status).toBe("error");
    expect(res.message).toContain("unreachable");
  });

  it("passes when the cached image is reachable", async () => {
    const cache = new Map<string, boolean>([["https://cdn.example.com/p.jpg", true]]);
    const res = await apply(
      "meta",
      "image_link.validate",
      makeProduct(),
      makeCtx({ checkImages: true, imageReachability: cache }),
    );
    expect(res.status).toBe("ok");
  });
});

describe("gtin.validate", () => {
  it("strips separators on a valid GTIN when autofix on", async () => {
    const res = await apply(
      "meta",
      "gtin.validate",
      makeProduct({ gtin: "4006381-333931" }),
      makeCtx(),
    );
    expect(res.status).toBe("fixed");
    expect(res.patch?.gtin).toBe("4006381333931");
  });

  it("warns on a bad check digit", async () => {
    const res = await apply(
      "meta",
      "gtin.validate",
      makeProduct({ gtin: "4006381333930" }),
      makeCtx(),
    );
    expect(res.status).toBe("warning");
  });

  it("is a no-op when gtin is absent", async () => {
    const res = await apply("meta", "gtin.validate", makeProduct(), makeCtx());
    expect(res.status).toBe("ok");
  });
});

describe("platform specs", () => {
  it("exposes the documented title limits", () => {
    expect(getSpecFor("meta").titleMaxLength).toBe(200);
    expect(getSpecFor("google").titleMaxLength).toBe(150);
    expect(getSpecFor("tiktok").titleMaxLength).toBe(100);
  });

  it("requires brand for meta and google but not tiktok", () => {
    expect(getSpecFor("meta").requiredFields).toContain("brand");
    expect(getSpecFor("google").requiredFields).toContain("brand");
    expect(getSpecFor("tiktok").requiredFields).not.toContain("brand");
  });
});
