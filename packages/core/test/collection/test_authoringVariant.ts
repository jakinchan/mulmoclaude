// The authoring reference tells the agent WHERE to write a collection skill,
// and the right answer depends on the root. A managed workspace gates writes
// into `.claude/` and mirrors `data/skills/<slug>/` across with a bridge hook;
// a plain project root has neither, so the same instruction produces a tree
// nothing ever discovers — silently, with no error anywhere. `schemaDocs`
// therefore picks a variant, and the staged one must stay exactly what a
// single-workspace host already serves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { applyAuthoringVariant, renderSchemaDocs } from "../../src/collection/server/schemaDocs.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_DOC = readFileSync(path.join(here, "..", "..", "assets", "helps", "collection-skills.md"), "utf-8");

const DOC = [
  "# Guide",
  "shared intro",
  "<!-- authoring:staged -->",
  "write under `data/skills/<slug>/`",
  "<!-- /authoring:staged -->",
  "<!-- authoring:direct -->",
  "write under `.claude/skills/<slug>/`",
  "<!-- /authoring:direct -->",
  "shared outro",
].join("\n");

test("each variant keeps its own body, the shared text, and no fence markers", () => {
  assert.equal(applyAuthoringVariant(DOC, "staged"), "# Guide\nshared intro\nwrite under `data/skills/<slug>/`\nshared outro");
  assert.equal(applyAuthoringVariant(DOC, "direct"), "# Guide\nshared intro\nwrite under `.claude/skills/<slug>/`\nshared outro");
});

test("a doc with no fences passes through untouched — user-authored workspace copies", () => {
  const plain = "# Guide\nno variants here\n";
  assert.equal(applyAuthoringVariant(plain, "staged"), plain);
  assert.equal(applyAuthoringVariant(plain, "direct"), plain);
});

test("the staged render is the default, byte for byte", () => {
  // This is what protects the single-workspace host: a host that never passes
  // the flag must see exactly the reply it saw before variants existed.
  assert.equal(renderSchemaDocs(BUNDLED_DOC), renderSchemaDocs(BUNDLED_DOC, undefined, "staged"));
  assert.equal(renderSchemaDocs(BUNDLED_DOC, "anatomy"), renderSchemaDocs(BUNDLED_DOC, "anatomy", "staged"));
  assert.equal(renderSchemaDocs(BUNDLED_DOC, "all"), applyAuthoringVariant(BUNDLED_DOC, "staged"));
});

test("no rendered reply ever leaks a fence marker", () => {
  for (const variant of ["staged", "direct"] as const) {
    for (const topic of [undefined, "anatomy", "end-to-end", "all"]) {
      assert.doesNotMatch(renderSchemaDocs(BUNDLED_DOC, topic, variant), /<!-- \/?authoring:/, `${variant} / ${String(topic)}`);
    }
  }
});

test("the staged reference still tells the agent to author under data/skills", () => {
  const staged = renderSchemaDocs(BUNDLED_DOC, "anatomy", "staged");
  assert.match(staged, /Author under `data\/skills\/<slug>\/`, NEVER/);
});

test("the direct reference NEVER tells the agent to write under data/skills", () => {
  // The whole point of §1: under a bridge-less root that instruction produces
  // nothing. Every surviving `data/skills` mention must be a "do not write
  // there" warning, so assert on the instruction, not on the substring.
  const direct = renderSchemaDocs(BUNDLED_DOC, "anatomy", "direct");
  assert.match(direct, /Author under `\.claude\/skills\/<slug>\/`, NEVER `data\/skills/);
  assert.doesNotMatch(direct, /Author under `data\/skills/);

  const walkthrough = renderSchemaDocs(BUNDLED_DOC, "end-to-end", "direct");
  assert.match(walkthrough, /Write `\.claude\/skills\/<slug>\/schema\.json`/);
  assert.doesNotMatch(walkthrough, /Write `data\/skills\/<slug>\/schema\.json`/);
});
