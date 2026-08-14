import { itemMatchesQuery, type CollectionSummary } from "@mulmoclaude/core/collection";

/** Editable / Data facet over the installed list. */
export const INDEX_FILTER_CHIPS = ["all", "editable", "data"] as const;
export type CollectionIndexFilter = (typeof INDEX_FILTER_CHIPS)[number];

function matchesChip(collection: CollectionSummary, filter: CollectionIndexFilter): boolean {
  if (filter === "editable") return collection.readonly !== true;
  if (filter === "data") return collection.readonly === true;
  return true;
}

/** Search matches only what the card SHOWS — title and slug. Running the record
 *  matcher over the whole summary would also read `source` / `readonly`, so
 *  "project" or "true" would silently select rows the reader never typed for.
 *  Takes the raw input: `itemMatchesQuery` lowercases the value but not the
 *  needle, and a blank query matches everything. */
export function collectionMatchesQuery(collection: CollectionSummary, query: string): boolean {
  return itemMatchesQuery({ title: collection.title, slug: collection.slug }, query.trim().toLowerCase());
}

/** The installed list as rendered: the chip facet AND the search box. */
export function filterIndexCollections(collections: CollectionSummary[], filter: CollectionIndexFilter, query: string): CollectionSummary[] {
  return collections.filter((collection) => matchesChip(collection, filter) && collectionMatchesQuery(collection, query));
}
