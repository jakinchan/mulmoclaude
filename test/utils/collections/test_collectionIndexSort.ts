// Unit tests for the collections-index display order
// (packages/plugins/collection-plugin/src/vue/collectionIndexSort.ts) — the pure
// comparator behind the "Slug / Name" toggle (#2836). Pinned here so the view
// stays a thin reactive shell, and so the tie-break (the part a re-render would
// otherwise expose as flicker) has a test that does not need a browser.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_INDEX_SORT,
  INDEX_SORT_KEYS,
  isCollectionIndexSort,
  sortCollectionsForIndex,
  type SortableCollection,
} from "../../../packages/plugins/collection-plugin/src/vue/collectionIndexSort";

const slugsOf = (list: readonly SortableCollection[]): string[] => list.map((entry) => entry.slug);

// Titles deliberately disagree with the slugs, so a comparator that ignored the
// key and always fell back to slug would fail the title case.
const SAMPLE: SortableCollection[] = [
  { slug: "reading-list", title: "Zebra" },
  { slug: "budget", title: "Mango" },
  { slug: "memo", title: "Apple" },
];

describe("sortCollectionsForIndex", () => {
  it("orders by slug when the key is slug, whatever the input order", () => {
    assert.deepEqual(slugsOf(sortCollectionsForIndex(SAMPLE, "slug", "en")), ["budget", "memo", "reading-list"]);
  });

  it("orders by title when the key is title", () => {
    assert.deepEqual(slugsOf(sortCollectionsForIndex(SAMPLE, "title", "en")), ["memo", "budget", "reading-list"]);
  });

  it("breaks a title tie on slug so equal titles keep a stable order", () => {
    const tied: SortableCollection[] = [
      { slug: "zebra", title: "Notes" },
      { slug: "alpha", title: "Notes" },
    ];
    assert.deepEqual(slugsOf(sortCollectionsForIndex(tied, "title", "en")), ["alpha", "zebra"]);
    // Re-sorting an already-sorted list must not swap the pair back.
    assert.deepEqual(slugsOf(sortCollectionsForIndex(sortCollectionsForIndex(tied, "title", "en"), "title", "en")), ["alpha", "zebra"]);
  });

  it("does not mutate the input list", () => {
    const input: SortableCollection[] = [
      { slug: "b", title: "B" },
      { slug: "a", title: "A" },
    ];
    sortCollectionsForIndex(input, "title", "en");
    assert.deepEqual(slugsOf(input), ["b", "a"]);
  });

  it("sorts embedded numbers naturally, not as text", () => {
    const numbered: SortableCollection[] = [
      { slug: "s10", title: "Sprint 10" },
      { slug: "s2", title: "Sprint 2" },
    ];
    assert.deepEqual(slugsOf(sortCollectionsForIndex(numbered, "title", "en")), ["s2", "s10"]);
  });

  it("uses the locale's collator for Japanese titles — kana ahead of kanji, and kanji NOT by reading", () => {
    // The order the issue documents and accepts (#2836): dictionary order, the
    // same a file manager shows, NOT 五十音順 — 家計簿 sorts by code point, so it
    // lands after the kana titles rather than under か.
    const japanese: SortableCollection[] = [
      { slug: "budget", title: "家計簿" },
      { slug: "reading-list", title: "読書リスト" },
      { slug: "calendar", title: "カレンダー" },
    ];
    assert.deepEqual(slugsOf(sortCollectionsForIndex(japanese, "title", "ja")), ["calendar", "budget", "reading-list"]);
  });

  it("returns an empty list unchanged", () => {
    assert.deepEqual(sortCollectionsForIndex([], "title", "en"), []);
  });
});

describe("isCollectionIndexSort", () => {
  it("accepts every declared key", () => {
    for (const key of INDEX_SORT_KEYS) assert.equal(isCollectionIndexSort(key), true);
  });

  it("rejects anything else, including non-strings a corrupted store could hold", () => {
    for (const value of ["", "name", "Slug", null, undefined, 3, {}, ["slug"]]) {
      assert.equal(isCollectionIndexSort(value), false);
    }
  });

  it("has slug as the default, matching the server's discovery order", () => {
    assert.equal(DEFAULT_INDEX_SORT, "slug");
    assert.equal(isCollectionIndexSort(DEFAULT_INDEX_SORT), true);
  });
});
