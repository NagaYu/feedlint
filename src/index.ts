#!/usr/bin/env node
/**
 * FeedLint — CLI entry point.
 *
 * Parses command-line arguments with commander, validates them, runs the
 * engine, and renders a colorful, human-friendly summary with colorette.
 *
 * Exit codes:
 *   0  success (no errors, or errors fully auto-fixed / dropped as requested)
 *   1  completed but unresolved errors remain in the output feed
 *   2  fatal error (bad input, parse failure, write failure, bad arguments)
 */

import { resolve, basename, extname } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import {
  bold,
  dim,
  red,
  green,
  yellow,
  cyan,
  magenta,
  blue,
  gray,
  white,
  bgRed,
  bgGreen,
  bgYellow,
  underline,
  isColorSupported,
} from "colorette";

import {
  type CleanseReport,
  type EngineOptions,
  type OutputFormat,
  type Platform,
  PLATFORMS,
  FeedLintError,
} from "./types.js";
import { runEngine, describeError } from "./engine.js";
import { getSpecFor } from "./rules.js";

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

const VERSION = "1.0.1";

/** Box-drawing characters for the summary panel. */
const BOX = {
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  horizontal: "─",
  vertical: "│",
} as const;

/* -------------------------------------------------------------------------- */
/*  Argument parsing helpers                                                  */
/* -------------------------------------------------------------------------- */

/** Validate the `--platform` value. */
function parsePlatform(value: string): Platform {
  const lowered = value.trim().toLowerCase();
  if ((PLATFORMS as readonly string[]).includes(lowered)) {
    return lowered as Platform;
  }
  throw new InvalidArgumentError(
    `Unsupported platform "${value}". Choose one of: ${PLATFORMS.join(", ")}.`,
  );
}

/** Validate the `--format` value. */
function parseFormat(value: string): OutputFormat {
  const lowered = value.trim().toLowerCase();
  if (lowered === "json" || lowered === "xml") {
    return lowered;
  }
  throw new InvalidArgumentError(`Unsupported format "${value}". Choose "json" or "xml".`);
}

/** Validate and clamp the `--concurrency` value to a sane range. */
function parseConcurrency(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new InvalidArgumentError(`--concurrency must be a positive integer (got "${value}").`);
  }
  // Cap to avoid exhausting sockets / file descriptors on pathological input.
  return Math.min(parsed, 64);
}

/** Derive a sensible default output path next to the input file. */
function defaultOutputPath(inputPath: string, format: OutputFormat): string {
  const dir = inputPath.includes("/") ? inputPath.slice(0, inputPath.lastIndexOf("/")) : ".";
  const ext = extname(inputPath);
  const stem = basename(inputPath, ext);
  return `${dir}/${stem}.feedlint.${format}`;
}

/* -------------------------------------------------------------------------- */
/*  Rendering helpers                                                         */
/* -------------------------------------------------------------------------- */

/** Visible (non-ANSI) length of a string, for box alignment. */
function visibleLength(input: string): number {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Pad a (possibly colored) string to a target visible width. */
function padVisible(input: string, width: number): string {
  const len = visibleLength(input);
  return len >= width ? input : input + " ".repeat(width - len);
}

/** Print the FeedLint banner. */
function renderBanner(): void {
  const title = bold(cyan("FeedLint"));
  const tag = dim("· product-feed validator & auto-cleanser · v" + VERSION);
  process.stdout.write(`\n${title} ${tag}\n`);
}

/** Render the run configuration line. */
function renderConfig(opts: EngineOptions): void {
  const platformLabel = getSpecFor(opts.platform).label;
  const lines = [
    `${gray("platform")}  ${bold(magenta(platformLabel))} ${dim(`(${opts.platform})`)}`,
    `${gray("input   ")}  ${white(opts.inputPath)}`,
    `${gray("output  ")}  ${white(opts.outputPath)} ${dim(`(${opts.format})`)}`,
    `${gray("autofix ")}  ${opts.autofix ? green("on") : yellow("off")}` +
      `   ${gray("check-images")} ${opts.checkImages ? green("on") : dim("off")}` +
      (opts.checkImages ? `   ${gray("concurrency")} ${cyan(String(opts.imageConcurrency))}` : "") +
      `   ${gray("drop-invalid")} ${opts.dropInvalid ? yellow("on") : dim("off")}`,
  ];
  process.stdout.write("\n" + lines.map((l) => `  ${l}`).join("\n") + "\n");
}

/** Draw a horizontal box border of a given inner width. */
function boxBorder(width: number, left: string, right: string): string {
  return left + BOX.horizontal.repeat(width) + right;
}

/** Render the headline summary panel. */
function renderSummaryPanel(report: CleanseReport): void {
  const innerWidth = 52;
  const pad = (s: string): string => `${BOX.vertical} ${padVisible(s, innerWidth - 2)} ${BOX.vertical}`;

  const rows: string[] = [];
  rows.push(bold(white("Scan Summary")));
  rows.push(gray(BOX.horizontal.repeat(innerWidth - 2)));
  rows.push(`${gray("Products scanned")}      ${bold(white(String(report.totalScanned)))}`);
  rows.push(`${gray("Clean (untouched)")}     ${bold(green(String(report.totalClean)))}`);
  rows.push(`${gray("Auto-fixed")}            ${bold(cyan(String(report.totalFixed)))}`);
  rows.push(`${gray("Fix operations")}        ${bold(blue(String(report.totalFixOperations)))}`);
  rows.push(`${gray("Warnings")}              ${bold(yellow(String(report.totalWarnings)))}`);
  rows.push(`${gray("Errors detected")}       ${bold(report.totalErrors > 0 ? yellow(String(report.totalErrors)) : green("0"))}`);
  rows.push(`${gray("Unresolved in output")}  ${bold(report.totalErrorsInOutput > 0 ? red(String(report.totalErrorsInOutput)) : green("0"))}`);
  rows.push(`${gray("Dropped")}               ${bold(report.totalDropped > 0 ? yellow(String(report.totalDropped)) : dim("0"))}`);
  if (report.imagesProbed > 0) {
    rows.push(`${gray("Images probed")}         ${bold(white(String(report.imagesProbed)))}`);
    rows.push(`${gray("Images unreachable")}    ${bold(report.imagesUnreachable > 0 ? red(String(report.imagesUnreachable)) : green("0"))}`);
  }
  rows.push(`${gray("Written to output")}     ${bold(white(String(report.output.length)))}`);

  process.stdout.write("\n");
  process.stdout.write("  " + boxBorder(innerWidth, BOX.topLeft, BOX.topRight) + "\n");
  for (const row of rows) {
    process.stdout.write("  " + pad(row) + "\n");
  }
  process.stdout.write("  " + boxBorder(innerWidth, BOX.bottomLeft, BOX.bottomRight) + "\n");
}

/**
 * Render a detailed, per-product breakdown of findings. Only products that had
 * at least one finding are shown. Output is capped to keep huge feeds readable.
 */
function renderDetails(report: CleanseReport, maxProducts: number): void {
  const withFindings = report.products.filter((p) => p.findings.length > 0);
  if (withFindings.length === 0) {
    process.stdout.write("\n  " + green("✔ Every product passed cleanly — nothing to report.") + "\n");
    return;
  }

  process.stdout.write("\n  " + bold(underline(white("Findings"))) + "\n");

  const shown = withFindings.slice(0, maxProducts);
  for (const product of shown) {
    const header =
      `  ${dim(`#${product.index + 1}`)} ${bold(white(product.id))}` +
      (product.dropped ? `  ${bgRed(white(" DROPPED "))}` : "") +
      (product.fixed && !product.dropped ? `  ${bgGreen(white(" FIXED "))}` : "");
    process.stdout.write("\n" + header + "\n");

    for (const finding of product.findings) {
      let marker: string;
      switch (finding.status) {
        case "fixed":
          marker = green("  ✚ fix    ");
          break;
        case "warning":
          marker = yellow("  ▲ warn   ");
          break;
        case "error":
        case "dropped":
          marker = red("  ✖ error  ");
          break;
        default:
          marker = dim("  • info   ");
          break;
      }
      const rule = dim(`[${finding.ruleId}]`);
      process.stdout.write(`${marker} ${finding.message} ${rule}\n`);
    }
  }

  const remaining = withFindings.length - shown.length;
  if (remaining > 0) {
    process.stdout.write(
      "\n  " + dim(`… and ${remaining} more product(s) with findings (raise --max-detail to see them).`) + "\n",
    );
  }
}

/** Render the closing status line and return the process exit code. */
function renderClosing(report: CleanseReport): number {
  process.stdout.write("\n");

  // The exit code reflects the WRITTEN feed: if every invalid product was
  // dropped, the output ships clean even though errors were detected.
  if (report.totalErrorsInOutput > 0) {
    const badge = bgYellow(white(bold(" DONE WITH ISSUES ")));
    process.stdout.write(
      `  ${badge} ${yellow(`${report.totalErrorsInOutput} unresolved error(s) remain in the output feed.`)}\n`,
    );
    process.stdout.write(
      `  ${dim("Tip: re-run with")} ${cyan("--drop-invalid")} ${dim("to exclude them, or fix the source data.")}\n\n`,
    );
    return 1;
  }

  if (report.totalDropped > 0) {
    const badge = bgGreen(white(bold(" SUCCESS ")));
    process.stdout.write(
      `  ${badge} ${green(`Clean feed written to`)} ${bold(white(report.outputPath))} ` +
        `${dim(`(${report.totalDropped} invalid product(s) dropped)`)}\n\n`,
    );
    return 0;
  }

  const badge = bgGreen(white(bold(" SUCCESS ")));
  process.stdout.write(
    `  ${badge} ${green(`Clean feed written to`)} ${bold(white(report.outputPath))}\n\n`,
  );
  return 0;
}

/** Render a fatal error and return the process exit code. */
function renderFatal(error: unknown): number {
  const message = error instanceof FeedLintError ? error.message : describeError(error);
  const code = error instanceof FeedLintError ? error.code : "UNEXPECTED";
  process.stderr.write("\n  " + bgRed(white(bold(" ERROR "))) + ` ${red(message)}\n`);
  process.stderr.write("  " + dim(`(${code})`) + "\n\n");
  return 2;
}

/** Render the `--explain` static spec view for a platform. */
function renderExplain(platform: Platform): void {
  const spec = getSpecFor(platform);
  renderBanner();
  process.stdout.write("\n  " + bold(magenta(spec.label)) + dim(` — 2026 feed spec (${platform})`) + "\n\n");
  const row = (k: string, v: string): void => {
    process.stdout.write(`  ${gray(padVisible(k, 26))} ${white(v)}\n`);
  };
  row("Title max length", `${spec.titleMaxLength} chars`);
  row("Description max length", `${spec.descriptionMaxLength} chars`);
  row("Default currency", spec.defaultCurrency);
  row("Required fields", spec.requiredFields.join(", "));
  row("Allowed availability", spec.allowedAvailability.join(", "));
  row("Allowed condition", spec.allowedCondition.join(", "));
  process.stdout.write("\n");
}

/* -------------------------------------------------------------------------- */
/*  Main                                                                      */
/* -------------------------------------------------------------------------- */

interface RawCliOptions {
  input?: string;
  output?: string;
  platform: Platform;
  format: OutputFormat;
  autofix: boolean;
  checkImages: boolean;
  concurrency: number;
  dropInvalid: boolean;
  details: boolean;
  maxDetail: string;
  explain: boolean;
}

async function main(argv: readonly string[]): Promise<number> {
  const program = new Command();

  program
    .name("feedlint")
    .description(
      "Validate and auto-cleanse e-commerce product feeds against the 2026 specs of\n" +
        "Meta Catalog, Google Merchant Center, and TikTok Catalog.",
    )
    .version(VERSION, "-v, --version", "print the FeedLint version")
    .helpOption("-h, --help", "display help for FeedLint")
    .option("-i, --input <path>", "path to the source feed (.json or .xml)")
    .option("-o, --output <path>", "path for the cleansed feed (defaults next to input)")
    .requiredOption(
      "-p, --platform <name>",
      `target platform: ${PLATFORMS.join(" | ")}`,
      parsePlatform,
    )
    .option("-f, --format <type>", "output format: json | xml", parseFormat, "json")
    .option("--no-autofix", "report problems but do not modify the feed")
    .option("--check-images", "perform live reachability checks on image URLs", false)
    .option(
      "--concurrency <n>",
      "max simultaneous image probes when --check-images is set (1-64)",
      parseConcurrency,
      8,
    )
    .option("--drop-invalid", "exclude products with unresolved errors from the output", false)
    .option("--no-details", "suppress the per-product findings breakdown")
    .option("--max-detail <n>", "max products to show in the findings breakdown", "25")
    .option("--explain", "print the platform spec and exit (no processing)", false)
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  $ feedlint --input shopify_products.json --platform meta",
        "  $ feedlint -i feed.xml -p google -o clean_feed.xml -f xml --check-images",
        "  $ feedlint -i big_feed.json -p meta --check-images --concurrency 24",
        "  $ feedlint -i feed.json -p tiktok --drop-invalid",
        "  $ feedlint --platform google --explain",
        "",
      ].join("\n"),
    );

  program.allowExcessArguments(false);

  let parsed: RawCliOptions;
  try {
    program.parse(argv as string[]);
    parsed = program.opts<RawCliOptions>();
  } catch (error: unknown) {
    // commander already printed its own message for known errors.
    return renderFatal(error);
  }

  // `--explain` is a short-circuit that needs no input file.
  if (parsed.explain) {
    renderExplain(parsed.platform);
    return 0;
  }

  if (!parsed.input) {
    return renderFatal(new FeedLintError("INPUT_NOT_FOUND", "Missing required option --input."));
  }

  const maxDetail = Number.parseInt(parsed.maxDetail, 10);
  const safeMaxDetail = Number.isFinite(maxDetail) && maxDetail > 0 ? maxDetail : 25;

  const inputPath = resolve(parsed.input);
  const outputPath = resolve(parsed.output ?? defaultOutputPath(parsed.input, parsed.format));

  const engineOptions: EngineOptions = {
    inputPath,
    outputPath,
    platform: parsed.platform,
    autofix: parsed.autofix,
    checkImages: parsed.checkImages,
    imageConcurrency: parsed.concurrency,
    dropInvalid: parsed.dropInvalid,
    format: parsed.format,
  };

  renderBanner();
  renderConfig(engineOptions);

  if (!isColorSupported) {
    process.stdout.write("\n" + dim("  (color disabled: set FORCE_COLOR=1 to enable)") + "\n");
  }

  let report: CleanseReport;
  try {
    const loadingNote = engineOptions.checkImages
      ? `⏳ probing images (concurrency ${engineOptions.imageConcurrency}) & cleansing…`
      : "⏳ scanning & cleansing…";
    process.stdout.write("\n  " + dim(loadingNote) + "\n");
    report = await runEngine(engineOptions);
  } catch (error: unknown) {
    return renderFatal(error);
  }

  renderSummaryPanel(report);
  if (parsed.details) {
    renderDetails(report, safeMaxDetail);
  }
  return renderClosing(report);
}

/* -------------------------------------------------------------------------- */
/*  Process bootstrap                                                         */
/* -------------------------------------------------------------------------- */

main(process.argv)
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // Final safety net — should never be reached because main() catches.
    process.stderr.write("\n" + red("Fatal: " + describeError(error)) + "\n");
    process.exitCode = 2;
  });
