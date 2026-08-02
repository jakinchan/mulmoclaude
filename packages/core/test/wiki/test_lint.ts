// Unit tests for the pure wiki lint rules.
//
// Tests focus on the rule semantics — fixtures are plain strings
// and Sets, no filesystem. The interesting cases:
//
//   - findBrokenLinksInPage handles `[[slug|alias]]` correctly
//     (was the false-positive engine pre-#1297)
//   - empty-target `[[|alias]]` surfaces its own diagnostic
//     (not "broken link to empty slug")
//   - findOrphanPages / findMissingFiles symmetry — every file
//     not in index AND every index entry not in files

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findBrokenLinksInPage, findMissingFiles, findOrphanPages, findTagDrift, formatLintReport } from "../../src/wiki/lint.ts";
import type { WikiPageEntry } from "../../src/wiki/index-parse.ts";

describe("findBrokenLinksInPage — [[slug|alias]] regression", () => {
  it("uses the TARGET (left of pipe) for slug comparison, not the full body", () => {
    // Pre-#1297 the lint slugified the entire bracket content,
    // so `[[keith-rabois-ai-pm-end|キース…]]` collapsed to
    // `-ai-pm-` and missed. With parseWikiLink the slug being
    // looked up is `keith-rabois-ai-pm-end` and the existing
    // file matches.
    const content = "see [[keith-rabois-ai-pm-end|キース・ラボイス]] for context";
    const fileSlugs = new Set(["keith-rabois-ai-pm-end"]);
    assert.deepEqual(findBrokenLinksInPage("anchor.md", content, fileSlugs), []);
  });

  it("still flags genuine broken links", () => {
    const content = "see [[does-not-exist|alias]] for context";
    const fileSlugs = new Set(["other-page"]);
    const issues = findBrokenLinksInPage("anchor.md", content, fileSlugs);
    assert.equal(issues.length, 1);
    const [issue] = issues;
    assert.ok(issue);
    assert.match(issue, /Broken link.*anchor\.md.*does-not-exist/);
  });

  it("emits a dedicated 'empty target' diagnostic for `[[|alias]]`", () => {
    // `[[|alias]]` slugifies to "", which would otherwise be
    // indistinguishable from a real broken link. Flag it
    // separately so authors can grep.
    const content = "see [[|orphan alias]] for context";
    const fileSlugs = new Set<string>();
    const issues = findBrokenLinksInPage("a.md", content, fileSlugs);
    assert.equal(issues.length, 1);
    const [issue] = issues;
    assert.ok(issue);
    assert.match(issue, /empty target/);
  });

  it("flags links whose plain target slugifies to empty (e.g. pure non-ASCII)", () => {
    // `[[キース]]` has no pipe; slugify strips every character.
    // Treated as empty-target since the user has no slug to
    // resolve against.
    const content = "see [[キース・ラボイス]] for context";
    const fileSlugs = new Set<string>();
    const issues = findBrokenLinksInPage("a.md", content, fileSlugs);
    assert.equal(issues.length, 1);
    const [issue] = issues;
    assert.ok(issue);
    assert.match(issue, /empty target/);
  });
});

describe("findOrphanPages / findMissingFiles", () => {
  it("flags files missing from index", () => {
    const fileSlugs = new Set(["a", "b", "c"]);
    const indexedSlugs = new Set(["a", "b"]);
    assert.deepEqual(findOrphanPages(fileSlugs, indexedSlugs), ["- **Orphan page**: `c.md` exists but is missing from index.md"]);
  });

  it("flags index entries with no file", () => {
    const entries: WikiPageEntry[] = [
      { slug: "a", title: "A", description: "", tags: [] },
      { slug: "b", title: "B", description: "", tags: [] },
    ];
    const fileSlugs = new Set(["a"]);
    assert.deepEqual(findMissingFiles(entries, fileSlugs), ["- **Missing file**: index.md references `b` but the file does not exist"]);
  });
});

describe("findTagDrift", () => {
  it("flags slugs whose index tags disagree with frontmatter tags", () => {
    const entries: WikiPageEntry[] = [
      { slug: "a", title: "A", description: "", tags: ["x", "y"] },
      { slug: "b", title: "B", description: "", tags: ["k"] },
    ];
    const frontmatter = new Map<string, readonly string[]>([
      ["a", ["x", "z"]], // drift
      ["b", ["k"]], // match
    ]);
    const issues = findTagDrift(entries, frontmatter);
    assert.equal(issues.length, 1);
    const [issue] = issues;
    assert.ok(issue);
    assert.match(issue, /Tag drift.*a\.md/);
  });

  it("ignores entries with no frontmatter map (covered by findMissingFiles)", () => {
    const entries: WikiPageEntry[] = [{ slug: "a", title: "A", description: "", tags: ["x"] }];
    const frontmatter = new Map<string, readonly string[]>();
    assert.deepEqual(findTagDrift(entries, frontmatter), []);
  });
});

describe("formatLintReport", () => {
  it("emits the success sentinel for an empty list", () => {
    assert.match(formatLintReport([]), /No issues found/);
  });

  it("counts singular vs plural correctly", () => {
    assert.match(formatLintReport(["one"]), /1 issue found/);
    assert.match(formatLintReport(["one", "two"]), /2 issues found/);
  });
});
