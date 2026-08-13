import { relative, sep } from "node:path";

/**
 * Turn eslint results into a markdown report — a pie by area, a rule x area
 * table, and the directories holding the most.
 *
 *   yarn lint:summary
 *   npx eslint . --format json | node scripts/lint-summary.mjs
 *
 * `eslint-formatter-summary.mjs` imports `renderReport`, so the lint run that
 * has already happened produces this without a second one.
 */

// The directories `yarn lint` is pointed at (see docs/developer.md for the
// layout), ordered biggest first so the table's columns read in the order the
// findings usually arrive. `areaOf` matches a whole first segment, so `e2e` does
// not swallow `e2e-live`.
//
// `packages` stays ONE area on purpose though it holds ~50 workspaces: a pie of
// 50 slices is unreadable, and the directory table below already breaks it down
// to `packages/core/src` / `packages/plugins/collection-plugin`.
const AREAS = ["packages", "test", "src", "server", "e2e", "e2e-live", "scripts", "config", "batch"];
const OTHER_AREA = "other";

const BAR_WIDTH = 24;
const TOP_DIRECTORIES = 15;
const DIRECTORY_DEPTH = 3;

function areaOf(relativePath) {
  const [top] = relativePath.split("/");
  return AREAS.includes(top) ? top : OTHER_AREA;
}

/** The directory a finding is in, three levels deep — `server/api/routes`. */
function directoryOf(relativePath) {
  const parts = relativePath.split("/");
  parts.pop();
  return parts.slice(0, DIRECTORY_DEPTH).join("/") || ".";
}

/**
 * A value safe to put in a table cell. A rule id comes from a plugin and a
 * directory from the filesystem, so either can hold a `|`, which ends the cell,
 * or a backtick, which ends the code span around it.
 *
 * `\r` counts as a line ending in CommonMark just as `\n` does, so a lone one
 * ends the row mid-cell — and a POSIX filename may hold either.
 */
function cell(value) {
  return `\`${value.replaceAll("`", "'").replaceAll("|", "\\|").replaceAll("\n", " ").replaceAll("\r", " ")}\``;
}

function bar(count, max) {
  if (max === 0) return "";
  const filled = Math.max(1, Math.round((count / max) * BAR_WIDTH));
  return "\u2588".repeat(filled);
}

function tally(counts, key) {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/** Nested rather than a composite key: a delimiter is one more thing to get wrong. */
function tallyPair(counts, outer, inner) {
  if (!counts.has(outer)) counts.set(outer, new Map());
  tally(counts.get(outer), inner);
}

function descending(counts) {
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * Exactly what `renderReport` dereferences on every element. Checking the shape
 * here turns a `TypeError` thrown deep inside the renderer — where the message
 * names an internal variable — into one that names the input. The fields of a
 * `message` are deliberately not checked: the renderer reads them null-safely,
 * so only the two below can crash it.
 */
const isEslintResult = (value) => typeof value === "object" && value !== null && typeof value.filePath === "string" && Array.isArray(value.messages);

/**
 * Parse what eslint piped over. EMPTY IS AN ERROR, not an empty run: eslint
 * writes `[]` for a clean one, and produces nothing at all when it dies before
 * linting (an unreadable config, a plugin that will not load) — where it exits
 * non-zero with an empty stdout. Reading that as "no findings" reported a broken
 * lint as a passing one, and the pipeline hid eslint's own status behind this
 * process's.
 */
export function parseEslintJson(text) {
  if (text.trim() === "") {
    throw new Error("eslint wrote no output — it failed before linting (a clean run emits `[]`)");
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`stdin was not eslint --format json output: ${err.message}`, { cause: err });
  }
  if (!Array.isArray(parsed) || !parsed.every(isEslintResult)) {
    throw new Error("stdin was not eslint --format json output: expected an array of {filePath, messages}");
  }
  return parsed;
}

function readJson(stream) {
  return new Promise((resolve, reject) => {
    let text = "";
    stream.on("data", (chunk) => (text += chunk));
    stream.on("error", reject);
    stream.on("end", () => {
      try {
        resolve(parseEslintJson(text));
      } catch (err) {
        reject(err);
      }
    });
  });
}

/** One row per rule, one column per area, so a rule's spread is visible. */
function ruleTable(byRule, byRuleArea, areasPresent) {
  const header = `| rule | ${areasPresent.join(" | ")} | total | |`;
  const divider = `|---|${areasPresent.map(() => "--:").join("|")}|--:|---|`;
  const max = byRule.size ? Math.max(...byRule.values()) : 0;
  const rows = descending(byRule).map(([rule, total]) => {
    const perArea = byRuleArea.get(rule) ?? new Map();
    const cells = areasPresent.map((area) => perArea.get(area) ?? 0);
    return `| ${cell(rule)} | ${cells.join(" | ")} | **${total}** | ${bar(total, max)} |`;
  });
  return [header, divider, ...rows].join("\n");
}

function areaPie(byArea) {
  // Every label here is one of this file's own constants, so nothing from a
  // rule id or a path reaches the mermaid block.
  const slices = descending(byArea).map(([area, count]) => `  "${area}" : ${count}`);
  return ["```mermaid", "pie showData title Findings by area", ...slices, "```"].join("\n");
}

function directoryTable(byDirectory) {
  const ranked = descending(byDirectory);
  const max = ranked.length ? ranked[0][1] : 0;
  const rows = ranked.slice(0, TOP_DIRECTORIES).map(([dir, count]) => `| ${cell(dir)} | ${count} | ${bar(count, max)} |`);
  const hidden = ranked.length - rows.length;
  const note = hidden > 0 ? [`\n${hidden} more directories not shown.`] : [];
  return ["| directory | findings | |", "|---|--:|---|", ...rows, ...note].join("\n");
}

const plural = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;

export function renderReport(results, cwd = process.cwd()) {
  const from = cwd ?? process.cwd();
  const byRule = new Map();
  const byArea = new Map();
  const byDirectory = new Map();
  const byRuleArea = new Map();
  let errors = 0;
  let warnings = 0;

  for (const result of results) {
    // `relative`, not a prefix strip: eslint reports absolute paths, and a run
    // whose cwd is not the repo root would otherwise leave every path absolute,
    // dropping every finding into `other`.
    //
    // Split on the PLATFORM separator and rejoin with `/`: on Windows `relative`
    // answers `server\session\x.ts`, which every helper below — all of which split
    // on `/` — reads as one path segment, so every finding lands in `other`.
    // `lint_test_windows.yaml` runs `yarn lint` on Windows daily, so this path is
    // live. Splitting on `sep` rather than replacing `\` leaves a POSIX filename
    // that legitimately contains a backslash alone.
    const path = relative(from, result.filePath).split(sep).join("/");
    const area = areaOf(path);
    for (const message of result.messages) {
      const rule = message.ruleId ?? "(no rule)";
      if (message.severity === 2) errors += 1;
      else warnings += 1;
      tally(byRule, rule);
      tally(byArea, area);
      tally(byDirectory, directoryOf(path));
      tallyPair(byRuleArea, rule, area);
    }
  }

  const total = errors + warnings;
  const areasPresent = [...AREAS, OTHER_AREA].filter((area) => byArea.has(area));
  const report = [`## Lint findings — ${total} (${plural(errors, "error")}, ${plural(warnings, "warning")})`];

  if (total === 0) {
    report.push("\nNothing reported.");
  } else {
    report.push(
      "",
      areaPie(byArea),
      "",
      `### By rule — ${byRule.size} rules`,
      "",
      ruleTable(byRule, byRuleArea, areasPresent),
      "",
      "### By directory",
      "",
      directoryTable(byDirectory),
    );
  }

  return `${report.join("\n")}\n`;
}

// Entry point: `eslint --format json | node scripts/lint-summary.mjs`.
//
// Exits 1 when the report contains an error, because a pipeline reports the
// LAST command's status: eslint's own exit code is lost the moment it is piped
// here, and `set -o pipefail` is not available in every shell that runs an npm
// script. Warnings alone exit 0, as eslint does.
if (import.meta.filename === process.argv[1]) {
  // One line on stderr rather than a stack trace: every throw here is about what
  // arrived on stdin, so the trace through this file's own frames says nothing a
  // reader of `yarn lint:summary` can act on.
  try {
    const results = await readJson(process.stdin);
    process.stdout.write(renderReport(results));
    const errors = results.some((r) => r.messages.some((m) => m.severity === 2));
    if (errors) process.exitCode = 1;
  } catch (err) {
    process.stderr.write(`lint:summary — ${err.message}\n`);
    process.exitCode = 1;
  }
}
