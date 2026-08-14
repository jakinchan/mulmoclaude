// Display order for the collections index (#2836), persisted to localStorage.
//
// The server's `discoverCollections()` order (slug ascending) stays the
// canonical one — it is shared with the watchers, the ontology and the mobile
// remote — so the user's choice is applied here, over the fetched list, and
// never pushed down into discovery.

export const INDEX_SORT_KEYS = ["slug", "title"] as const;
export type CollectionIndexSort = (typeof INDEX_SORT_KEYS)[number];

export const DEFAULT_INDEX_SORT: CollectionIndexSort = "slug";

/** Minimal shape the order depends on — keeps the comparator usable from a
 *  test without constructing a whole `CollectionSummary`. */
export interface SortableCollection {
  slug: string;
  title: string;
}

export function isCollectionIndexSort(value: unknown): value is CollectionIndexSort {
  return typeof value === "string" && INDEX_SORT_KEYS.some((key) => key === value);
}

/** Order the index list by the chosen key. Titles are compared with the UI
 *  locale's collator — the browser default varies by OS, so the same workspace
 *  would otherwise sort differently per machine. Ties break on slug, which is
 *  unique, so two collections sharing a title keep a stable order instead of
 *  swapping places on every re-render. */
export function sortCollectionsForIndex<T extends SortableCollection>(list: readonly T[], key: CollectionIndexSort, locale: string): T[] {
  const collator = new Intl.Collator(locale, { numeric: true });
  return [...list].sort((left, right) => {
    const byKey = key === "title" ? collator.compare(left.title, right.title) : collator.compare(left.slug, right.slug);
    return byKey !== 0 ? byKey : collator.compare(left.slug, right.slug);
  });
}

const STORAGE_KEY = "collection_index_sort";

export function readCollectionIndexSort(): CollectionIndexSort {
  try {
    const raw: unknown = localStorage.getItem(STORAGE_KEY);
    return isCollectionIndexSort(raw) ? raw : DEFAULT_INDEX_SORT;
  } catch {
    // localStorage unavailable (private mode / disabled) — fall back to the
    // default rather than breaking the index.
    return DEFAULT_INDEX_SORT;
  }
}

export function writeCollectionIndexSort(key: CollectionIndexSort): void {
  try {
    localStorage.setItem(STORAGE_KEY, key);
  } catch {
    // Best-effort preference: quota / disabled storage must not break the view.
  }
}
