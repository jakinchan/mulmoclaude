// Regression guard for #2605 — an icon name must be drawn with the font
// that actually has it.
//
// Both icon fonts resolve a glyph from the element's text via a ligature.
// A name the font doesn't know forms no ligature, so the letters are
// typeset instead: invisible, but full width, and one unbreakable word.
// `progress_activity` in a `.material-icons` element measures 408px
// rather than 24px, which is what flattened the record-detail header.
//
// SCOPE, so nobody reads this as more than it is: this pins the exact
// regression #2605 traced, not the general problem. A general check would
// need every name in each font, and neither package ships a list that
// matches its own font — `material-icons`'s `_data/versions.json` omits
// names that render (`sunny`), and `material-symbols`'s `index.d.ts` omits
// `smartphone`, which renders fine. Both lists fail in both directions;
// only rendering settles it, and rendering belongs in `yarn test:e2e`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { findIconElements } from "../helpers/iconFontProbe.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

const SCANNED_ROOTS = ["src", "packages/plugins"];
const SKIPPED_DIRS = new Set(["node_modules", "dist", ".git"]);

// Names verified in a browser to resolve ONLY in Material Symbols — each
// one measured far wider than a single em under `.material-icons`. Add to
// this list when another turns up; do not add a name without measuring it.
const SYMBOLS_ONLY_ICON_NAMES = new Set(["progress_activity"]);

function vueFilesUnder(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) vueFilesUnder(full, found);
    } else if (entry.name.endsWith(".vue")) {
      found.push(full);
    }
  }
  return found;
}

test("no .material-icons element renders a Symbols-only name", () => {
  const files = SCANNED_ROOTS.flatMap((rel) => vueFilesUnder(path.join(REPO_ROOT, rel)));
  assert.ok(files.length > 0, "found no .vue files to scan — the scan roots are wrong");

  const offenders = files.flatMap((file) =>
    findIconElements(readFileSync(file, "utf-8"))
      .filter((icon) => icon.fontClass === "material-icons" && icon.name !== null && SYMBOLS_ONLY_ICON_NAMES.has(icon.name))
      .map((icon) => `${path.relative(REPO_ROOT, file)} → "${icon.name}"`),
  );

  assert.deepEqual(
    offenders,
    [],
    `These names exist only in Material Symbols, so \`.material-icons\` typesets them as text instead of drawing a glyph — an invisible element hundreds of pixels wide that flattens whatever shares its row (#2605). Use \`material-symbols-outlined\` here:\n  ${offenders.join("\n  ")}`,
  );
});
