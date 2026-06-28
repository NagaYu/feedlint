/**
 * FeedLint — Type definitions.
 *
 * This module is the single source of truth for every data structure that
 * flows through the tool: the raw/normalized product shapes, the rule-engine
 * contracts, and the report structures rendered to the terminal and written
 * to disk.
 *
 * Everything here is intentionally explicit. We never rely on `any`; unknown
 * input is typed as `unknown` and narrowed at the boundary (see engine.ts).
 */

/**
 * The advertising destinations FeedLint knows how to lint against. Each value
 * maps to a dedicated rule set in `rules.ts`.
 */
export type Platform = "meta" | "google" | "tiktok";

/** All platforms, for iteration and CLI validation. */
export const PLATFORMS: readonly Platform[] = ["meta", "google", "tiktok"] as const;

/**
 * Severity of a single finding.
 *  - `error`   : the feed item violates a hard requirement of the platform.
 *  - `warning` : the item is accepted but degraded (lower delivery / quality).
 *  - `info`    : an informational, non-blocking observation.
 */
export type Severity = "error" | "warning" | "info";

/**
 * Outcome of applying a single rule to a single product field.
 *  - `ok`      : nothing wrong.
 *  - `fixed`   : a problem was found and automatically cleansed.
 *  - `error`   : a hard violation that was NOT (or could not be) auto-fixed.
 *  - `warning` : a soft violation that was NOT auto-fixed.
 *  - `dropped` : the product is unrecoverable and must be excluded from output.
 */
export type RuleStatus = "ok" | "fixed" | "error" | "warning" | "dropped";

/**
 * The canonical, normalized product shape. Every input dialect (Shopify JSON,
 * generic JSON arrays, Google RSS XML, WooCommerce/Magento exports) is mapped
 * onto this single structure before any rule runs.
 *
 * Field names follow the Google Merchant Center / Meta attribute vocabulary,
 * which is the de-facto lingua franca of the three target platforms.
 */
export interface CanonicalProduct {
  /** Stable unique identifier (Shopify variant id, SKU, `g:id`, …). */
  id: string;
  /** Product title shown in ads. */
  title: string;
  /** Long-form description. Cleansed of HTML before output. */
  description: string;
  /** Availability token: `in stock` | `out of stock` | `preorder` | `backorder`. */
  availability: string;
  /** Item condition: `new` | `refurbished` | `used`. */
  condition: string;
  /** Price as a normalized `"<amount> <CURRENCY>"` string, e.g. `"19.99 USD"`. */
  price: string;
  /** Optional discounted price, same format as `price`. */
  sale_price?: string;
  /** Canonical landing-page URL. */
  link: string;
  /** Primary image URL. */
  image_link: string;
  /** Up to 10 additional image URLs (comma joined on output). */
  additional_image_link?: string[];
  /** Brand / manufacturer. */
  brand: string;
  /** Global Trade Item Number (UPC/EAN/ISBN). */
  gtin?: string;
  /** Manufacturer Part Number. */
  mpn?: string;
  /** Google product taxonomy id or full path. */
  google_product_category?: string;
  /** Merchant-defined category path. */
  product_type?: string;
  /** Variant grouping key (color/size variants of one product). */
  item_group_id?: string;
  /** Free-form attributes used by some platforms. */
  color?: string;
  size?: string;
  gender?: string;
  age_group?: string;
  material?: string;
  pattern?: string;
  /**
   * Carries any source field we did not explicitly map, so nothing is lost on
   * round-trip. Values are always strings after normalization.
   */
  extra: Record<string, string>;
}

/** Keys of {@link CanonicalProduct} that hold simple string values. */
export type CanonicalStringField =
  | "id"
  | "title"
  | "description"
  | "availability"
  | "condition"
  | "price"
  | "sale_price"
  | "link"
  | "image_link"
  | "brand"
  | "gtin"
  | "mpn"
  | "google_product_category"
  | "product_type"
  | "item_group_id"
  | "color"
  | "size"
  | "gender"
  | "age_group"
  | "material"
  | "pattern";

/**
 * Context handed to every rule. Rules are pure functions of `(product, ctx)`
 * and never mutate the product directly — they return a patch instead.
 */
export interface RuleContext {
  /** The platform currently being linted. */
  platform: Platform;
  /** When false, problems are reported but never auto-cleansed. */
  autofix: boolean;
  /** When true, image rules perform a live network reachability check. */
  checkImages: boolean;
  /**
   * Pre-computed image reachability, keyed by the *normalized* image URL.
   *
   * When `checkImages` is enabled, the engine probes every unique image URL up
   * front through a bounded-concurrency pool and populates this map. The image
   * rule reads from it instead of issuing its own request, which keeps large
   * feeds fast and avoids re-fetching duplicate image URLs. A cache miss falls
   * back to a live probe so the rule remains correct when invoked standalone.
   */
  imageReachability: ReadonlyMap<string, boolean>;
}

/**
 * The result of running one rule against one product.
 */
export interface RuleResult {
  status: RuleStatus;
  /** Human-readable explanation (required for everything except `ok`). */
  message?: string;
  /**
   * Partial product to merge back into the working copy when `status` is
   * `fixed`. Ignored for every other status.
   */
  patch?: Partial<CanonicalProduct>;
}

/**
 * A rule definition: metadata plus the pure validation/cleansing function.
 */
export interface RuleDefinition {
  /** Stable machine id, e.g. `"title.max-length"`. */
  id: string;
  /** The primary product field this rule governs (for reporting). */
  field: string;
  /** One-line human description. */
  description: string;
  /** Severity used when the rule fails and cannot be auto-fixed. */
  severity: Severity;
  /**
   * Apply the rule. May be async because image-liveness checks hit the network.
   */
  apply: (product: CanonicalProduct, ctx: RuleContext) => RuleResult | Promise<RuleResult>;
}

/**
 * Static, declarative description of a platform's limits. Used both by the
 * rules and by the human-readable `--explain` output.
 */
export interface PlatformSpec {
  platform: Platform;
  label: string;
  /** Maximum allowed title length (characters). */
  titleMaxLength: number;
  /** Maximum allowed description length (characters). */
  descriptionMaxLength: number;
  /** Default ISO-4217 currency assumed when a price omits one. */
  defaultCurrency: string;
  /** Fields that must be present and non-empty after cleansing. */
  requiredFields: readonly string[];
  /** Allowed `availability` tokens. */
  allowedAvailability: readonly string[];
  /** Allowed `condition` tokens. */
  allowedCondition: readonly string[];
}

/** A single recorded finding for one product. */
export interface Finding {
  ruleId: string;
  field: string;
  status: RuleStatus;
  severity: Severity;
  message: string;
}

/** Per-product report. */
export interface ProductReport {
  /** Position in the source feed (0-based). */
  index: number;
  /** Resolved product id (or a synthetic placeholder). */
  id: string;
  findings: Finding[];
  /** True if at least one field was auto-cleansed. */
  fixed: boolean;
  /** True if the product was dropped from the clean output. */
  dropped: boolean;
}

/** The aggregate report returned by the engine after a full run. */
export interface CleanseReport {
  platform: Platform;
  inputPath: string;
  outputPath: string;
  /** ISO timestamp of when processing finished. */
  finishedAt: string;
  totalScanned: number;
  totalClean: number;
  totalFixed: number;
  /** Hard errors detected across the whole feed (including dropped products). */
  totalErrors: number;
  /**
   * Hard errors that remain in the *written* output — i.e. errors on products
   * that were kept. This is what determines the process exit code: a feed whose
   * invalid products were all dropped ships clean and exits 0.
   */
  totalErrorsInOutput: number;
  totalWarnings: number;
  totalDropped: number;
  /** Total number of individual auto-fix operations applied. */
  totalFixOperations: number;
  /** Count of unique image URLs probed for liveness (0 unless `--check-images`). */
  imagesProbed: number;
  /** Count of probed image URLs that were unreachable. */
  imagesUnreachable: number;
  products: ProductReport[];
  /** The cleansed products that survived (written to disk). */
  output: CanonicalProduct[];
}

/** Options that drive a single engine run. */
export interface EngineOptions {
  inputPath: string;
  outputPath: string;
  platform: Platform;
  autofix: boolean;
  checkImages: boolean;
  /** Max simultaneous image-liveness probes (only used when `checkImages`). */
  imageConcurrency: number;
  /** Drop products that still hold an unrecoverable error after cleansing. */
  dropInvalid: boolean;
  /** Output format for the cleansed feed. */
  format: OutputFormat;
}

/** Supported output serializations for the cleansed feed. */
export type OutputFormat = "json" | "xml";

/** A typed error raised by FeedLint, carrying an exit-code-friendly category. */
export class FeedLintError extends Error {
  public readonly code: FeedLintErrorCode;

  constructor(code: FeedLintErrorCode, message: string) {
    super(message);
    this.name = "FeedLintError";
    this.code = code;
    // Restore prototype chain for instanceof across compilation targets.
    Object.setPrototypeOf(this, FeedLintError.prototype);
  }
}

/** Categories of fatal error, surfaced to the shell as distinct exit codes. */
export type FeedLintErrorCode =
  | "INPUT_NOT_FOUND"
  | "INPUT_UNREADABLE"
  | "PARSE_ERROR"
  | "EMPTY_FEED"
  | "UNSUPPORTED_FORMAT"
  | "OUTPUT_WRITE_ERROR"
  | "INVALID_PLATFORM";
