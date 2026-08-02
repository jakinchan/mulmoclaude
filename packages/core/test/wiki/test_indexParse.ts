// Unit tests for the pure index.md parser.
//
// Coverage:
//   - All three row shapes (table / bullet link / bullet [[wiki]])
//   - Tag extraction from `#tag` tokens (Unicode-aware)
//   - Column-by-name header lookup (4 / 5-column tables)
//   - extractSlugFromBulletHref's three href shapes

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTableColumnMap, extractHashTags, extractSlugFromBulletHref, parseIndexEntries, parseTagsCell } from "../../src/wiki/index-parse.ts";

describe("extractHashTags", () => {
  it("pulls `#tag` tokens and returns them sorted/deduped/lowercased", () => {
    const out = extractHashTags("foo #Bar #baz #bar end");
    assert.deepEqual(out.tags, ["bar", "baz"]);
    assert.equal(out.description, "foo end");
  });

  it("supports Unicode tag bodies (Japanese / Chinese / Korean)", () => {
    const out = extractHashTags("#クラウド と #可視化 の話");
    assert.deepEqual(out.tags, ["クラウド", "可視化"]);
    assert.equal(out.description, "と の話");
  });

  it("ignores mid-word `#` (e.g. anchor URLs in href)", () => {
    const out = extractHashTags("see https://example.com#fragment");
    assert.deepEqual(out.tags, []);
    assert.equal(out.description, "see https://example.com#fragment");
  });
});

describe("parseTagsCell", () => {
  it("splits on commas and whitespace, strips `#` prefix", () => {
    assert.deepEqual(parseTagsCell("#tech, #ai #ml"), ["ai", "ml", "tech"]);
  });

  it("empty cell yields []", () => {
    assert.deepEqual(parseTagsCell(""), []);
    assert.deepEqual(parseTagsCell("   "), []);
  });
});

describe("buildTableColumnMap", () => {
  it("maps cell names to indices, case- and whitespace-tolerant", () => {
    const map = buildTableColumnMap("| Slug | Title | Summary | Tags |");
    assert.equal(map.get("slug"), 0);
    assert.equal(map.get("title"), 1);
    assert.equal(map.get("summary"), 2);
    assert.equal(map.get("tags"), 3);
  });

  it("strips surrounding backticks from header cell values", () => {
    // Without this stripping the lookup `columnMap.get("tags")` would
    // silently miss when the header is `\`tags\``, falling back to
    // `tags: []` for every row.
    const map = buildTableColumnMap("| `slug` | Title | `tags` |");
    assert.equal(map.get("slug"), 0);
    assert.equal(map.get("tags"), 2);
  });
});

describe("extractSlugFromBulletHref", () => {
  it("accepts canonical `pages/<slug>.md`", () => {
    assert.equal(extractSlugFromBulletHref("pages/foo.md"), "foo");
  });

  it("accepts bare `<slug>.md`", () => {
    assert.equal(extractSlugFromBulletHref("foo.md"), "foo");
  });

  it("accepts bare `<slug>`", () => {
    assert.equal(extractSlugFromBulletHref("foo"), "foo");
  });

  it("rejects external URLs (returns empty so caller slugifies the title)", () => {
    assert.equal(extractSlugFromBulletHref("https://example.com/foo"), "");
    assert.equal(extractSlugFromBulletHref("http://example.com/foo.md"), "");
  });
});

describe("parseIndexEntries — table format", () => {
  it("parses a 4-column table with named header", () => {
    const markdown = [
      "| Slug | Title | Summary | Tags |",
      "|------|-------|---------|------|",
      "| foo | Foo | first | #tech |",
      "| bar | Bar | second | #ai, #ml |",
    ].join("\n");
    const entries = parseIndexEntries(markdown);
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0], { slug: "foo", title: "Foo", description: "first", tags: ["tech"] });
    assert.deepEqual(entries[1], { slug: "bar", title: "Bar", description: "second", tags: ["ai", "ml"] });
  });

  it("falls back to positional columns when no header", () => {
    // A legacy 3-column table without a header row still parses as
    // (slug, title, summary) because the column map is unset.
    const markdown = ["|------|-------|---------|", "| foo | Foo | first |"].join("\n");
    const entries = parseIndexEntries(markdown);
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0], { slug: "foo", title: "Foo", description: "first", tags: [] });
  });
});

describe("parseIndexEntries — bullet formats", () => {
  it("parses `- [Title](pages/slug.md) — description #tag`", () => {
    const entries = parseIndexEntries("- [Foo](pages/foo.md) — first #tech");
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0], { slug: "foo", title: "Foo", description: "first", tags: ["tech"] });
  });

  it("parses `- [[Title]] — description`", () => {
    const entries = parseIndexEntries("- [[Foo Bar]] — first");
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0], { slug: "foo-bar", title: "Foo Bar", description: "first", tags: [] });
  });

  it("splits `- [[slug|display]] — description` via parseWikiLink", () => {
    // Codex regression on PR #1312: the bullet [[…]] parser used
    // to slugify the full `target|display` body, which collapses
    // `|` and produces a wrong slug (and a fake "Orphan page" or
    // "Missing file" diagnostic downstream).
    const entries = parseIndexEntries("- [[keith-rabois-ai-pm-end|キース・ラボイス]] — first");
    assert.equal(entries.length, 1);
    const [entry] = entries;
    assert.ok(entry);
    assert.equal(entry.slug, "keith-rabois-ai-pm-end", "slug must come from the target half");
    assert.equal(entry.title, "キース・ラボイス", "title must come from the display half");
    assert.equal(entry.description, "first");
  });

  it("prefers slug from href when title is non-ASCII", () => {
    // wikiSlugify strips non-ASCII to "", so without the href fall-
    // back the slug would be lost. The bullet parser keeps the slug
    // from `pages/sakura-net.md` even though the title slugifies to
    // empty.
    const entries = parseIndexEntries("- [さくらインターネット](pages/sakura-net.md) — note");
    assert.equal(entries.length, 1);
    const [entry] = entries;
    assert.ok(entry);
    assert.equal(entry.slug, "sakura-net");
    assert.equal(entry.title, "さくらインターネット");
  });
});
