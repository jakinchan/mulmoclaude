// Regression guard for the re-render fix in #2809: SessionHistoryPanel
// must hand SessionHistoryRow *method references*, never inline arrows
// closing over the `v-for` variable. An arrow is a fresh function on
// every render of the list, so every row's props compare fails and Vue
// re-renders all of them — which is the entire cost the child component
// was extracted to avoid. Reverting to a closure looks harmless in
// review and leaves every behavioural test green, so the invariant is
// pinned here instead.
//
// The repo has no Vue component unit-test infrastructure (e2e/ covers
// that surface), so this parses the source the same way
// test_stackview_googlemap_wiring.ts does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

function readSource(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), "utf-8");
}

function sessionHistoryRowTag(): string {
  const src = readSource("src/components/SessionHistoryPanel.vue");
  const tag = /<SessionHistoryRow[\s\S]*?\/>/.exec(src)?.[0];
  assert.ok(tag, "SessionHistoryPanel must render the list through <SessionHistoryRow ... />");
  return tag;
}

test("SessionHistoryPanel binds SessionHistoryRow handlers as method references", () => {
  const handlers = [...sessionHistoryRowTag().matchAll(/@[\w-]+="([^"]*)"/g)].map((match) => match[1] ?? "");
  assert.ok(handlers.length > 0, "expected at least one @event binding on <SessionHistoryRow>");
  handlers.forEach((handler) => {
    // A bare identifier is the only form Vue passes through as-is. Both
    // `(id) => onSelect(id)` and `onSelect($event)` compile to a fresh
    // closure per render, so matching on `=>` alone would let the second
    // one through.
    assert.match(
      handler,
      /^[A-Za-z_$][\w$]*$/,
      `@-binding "${handler}" must be a bare method reference — anything Vue has to wrap is a new function on every render. Return the session through the emit payload instead; see the comment above <SessionHistoryRow>.`,
    );
  });
});

test("SessionHistoryRow derives its per-row strings as computeds", () => {
  // formatDate() and t() ran once per row on every list render before
  // #2809. As computeds they survive a re-render of the row; calling
  // them straight from the template would put them back in the click path.
  const src = readSource("src/components/SessionHistoryRow.vue");
  const template = /<template>([\s\S]*?)<\/template>/.exec(src)?.[1];
  assert.ok(template, "SessionHistoryRow must have a <template> block");
  assert.doesNotMatch(template, /formatDate\(/, "call formatDate() in a computed, not from the template");
  assert.match(src, /const formattedDate = computed\(/, "SessionHistoryRow must expose the row timestamp as a computed");
  assert.match(src, /const primaryText = computed\(/, "SessionHistoryRow must expose the primary line as a computed");
});
