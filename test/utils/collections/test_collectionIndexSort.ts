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

// What `discoverCollections()` does before the list ever reaches the browser
// (packages/core/src/collection/server/discovery.ts). Written out rather than
// imported so the expectation is pinned to the RULE, not to a fixture that
// would drift with it.
const inDiscoveryOrder = <T extends SortableCollection>(list: readonly T[]): T[] => [...list].sort((left, right) => left.slug.localeCompare(right.slug));

describe("sortCollectionsForIndex", () => {
  it("hands back the server's order untouched in slug mode", () => {
    const discovered = inDiscoveryOrder(SAMPLE);
    assert.deepEqual(slugsOf(sortCollectionsForIndex(discovered, "slug", "en")), slugsOf(discovered));
  });

  it("does not reorder digit-bearing slugs in slug mode", () => {
    // Regression (Codex + Sourcery on #2896): a `numeric: true` collator puts
    // `s2` ahead of `s10`, while discovery's `slug.localeCompare` puts `s10`
    // first. Sorting again on the client moved cards for users who never open
    // the toggle — the one thing the default mode must never do.
    const discovered = inDiscoveryOrder([
      { slug: "s2", title: "Sprint 2" },
      { slug: "s10", title: "Sprint 10" },
      { slug: "x1", title: "X 1" },
      { slug: "x02", title: "X 02" },
    ]);
    assert.deepEqual(slugsOf(discovered), ["s10", "s2", "x02", "x1"]);
    assert.deepEqual(slugsOf(sortCollectionsForIndex(discovered, "slug", "en")), slugsOf(discovered));
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

  it("uses the locale's collator for Japanese titles — kana ahead of kanji, and kanji NOT by reading", (ctx) => {
    // A small-icu runtime has no `ja` collation data and resolves the request
    // down to root, where this order does not hold. Skip rather than assert an
    // order the runtime cannot produce — and rather than mock `Intl.Collator`,
    // which would only assert the mock (Sourcery's suggestion on #2896).
    if (new Intl.Collator("ja").resolvedOptions().locale !== "ja") {
      ctx.skip("runtime lacks ja collation data (small-icu)");
      return;
    }
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
