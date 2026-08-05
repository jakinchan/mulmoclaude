// The presentDocument source editor's bookmark scanner
// (`findDocumentBookmarks` / `compileBookmarkPattern` in
// `@mulmoclaude/markdown-plugin`).
//
// The pattern is a user-supplied regular expression from a hand-edited config
// file, so the rules worth pinning down are the ones that keep a typo from
// taking the editor down: a pattern that does not compile must degrade to "no
// markers", and a pattern that matches the empty string must not spin the scan
// loop forever.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_DOCUMENT_BOOKMARK_PATTERN, MAX_DOCUMENT_BOOKMARKS, compileBookmarkPattern, findDocumentBookmarks } from "@mulmoclaude/markdown-plugin";

const compile = (source: string) => {
  const pattern = compileBookmarkPattern(source);
  assert.ok(pattern, `expected ${source} to compile`);
  return pattern;
};

describe("compileBookmarkPattern", () => {
  it("compiles with multiline + global so ^ means line start and every match is found", () => {
    const pattern = compile("^x");
    assert.equal(pattern.flags.includes("m"), true);
    assert.equal(pattern.flags.includes("g"), true);
  });

  it("returns null for a pattern that does not compile", () => {
    assert.equal(compileBookmarkPattern("^([a-z"), null);
  });
});

describe("findDocumentBookmarks", () => {
  it("finds the default `...` marker on each line that starts with it", () => {
    const text = ["# Title", "...intro", "body text", "...part two", "more"].join("\n");
    const found = findDocumentBookmarks(text, compile(DEFAULT_DOCUMENT_BOOKMARK_PATTERN));
    assert.deepEqual(
      found.map((bookmark) => bookmark.label),
      ["...intro", "...part two"],
    );
    assert.deepEqual(
      found.map((bookmark) => bookmark.offset),
      [text.indexOf("...intro"), text.indexOf("...part two")],
    );
  });

  it("does not match `...` in the middle of a line", () => {
    assert.deepEqual(findDocumentBookmarks("wait ... for it", compile(DEFAULT_DOCUMENT_BOOKMARK_PATTERN)), []);
  });

  it("reports each match's position as a 0..1 fraction of the whole document", () => {
    const text = `${"a\n".repeat(10)}...here${"\nb".repeat(10)}`;
    const [bookmark] = findDocumentBookmarks(text, compile(DEFAULT_DOCUMENT_BOOKMARK_PATTERN));
    assert.ok(bookmark);
    assert.equal(bookmark.fraction, text.indexOf("...here") / text.length);
    assert.ok(bookmark.fraction > 0 && bookmark.fraction < 1);
  });

  it("returns nothing when the pattern failed to compile", () => {
    assert.deepEqual(findDocumentBookmarks("...anything", null), []);
  });

  it("returns nothing for an empty document", () => {
    assert.deepEqual(findDocumentBookmarks("", compile(DEFAULT_DOCUMENT_BOOKMARK_PATTERN)), []);
  });

  it("terminates on a zero-length match instead of looping forever", () => {
    // `^` matches the empty string at every line start; without the lastIndex
    // guard `exec` would return the same match indefinitely.
    const found = findDocumentBookmarks("one\ntwo\nthree", compile("^"));
    assert.deepEqual(
      found.map((bookmark) => bookmark.offset),
      [0, 4, 8],
    );
  });

  it("caps the number of markers so an over-broad pattern cannot flood the rail", () => {
    const found = findDocumentBookmarks("x\n".repeat(MAX_DOCUMENT_BOOKMARKS * 2), compile("^x"));
    assert.equal(found.length, MAX_DOCUMENT_BOOKMARKS);
  });

  it("does not carry lastIndex across scans of the same compiled pattern", () => {
    const pattern = compile(DEFAULT_DOCUMENT_BOOKMARK_PATTERN);
    const text = "...one\nfiller\n...two";
    assert.deepEqual(findDocumentBookmarks(text, pattern).length, 2);
    assert.deepEqual(findDocumentBookmarks(text, pattern).length, 2);
  });

  it("finds bookmarks in a CRLF document (the View normalises before scanning)", () => {
    // The View hands this function LF-normalised text — a textarea normalises
    // its own value, so an offset taken over CRLF would drift a character per
    // preceding line and land `setSelectionRange` on the wrong line. Pinned
    // here so the normalisation cannot quietly move back out of the View.
    const crlf = ["# Title", "", "...mark", "body"].join("\r\n");
    const normalised = crlf.replace(/\r\n/g, "\n");
    const [bookmark] = findDocumentBookmarks(normalised, compile(DEFAULT_DOCUMENT_BOOKMARK_PATTERN));
    assert.ok(bookmark);
    assert.equal(bookmark.offset, normalised.indexOf("...mark"));
    assert.equal(normalised.slice(bookmark.offset, bookmark.offset + 7), "...mark");
    // The raw CRLF offset is NOT the same number — that is the drift.
    assert.notEqual(bookmark.offset, crlf.indexOf("...mark"));
  });

  it("clips a long marked line for the tooltip", () => {
    const [bookmark] = findDocumentBookmarks(`...${"long ".repeat(60)}`, compile(DEFAULT_DOCUMENT_BOOKMARK_PATTERN));
    assert.ok(bookmark);
    assert.ok(bookmark.label.length <= 80);
    assert.ok(bookmark.label.endsWith("…"));
  });
});
