// Field projection over records — the ONE implementation behind both the
// server store layer (`server/storePage.ts#projectItemFields`) and the
// remote-view page builder (`remote-view#projectItems`). Isomorphic and
// dependency-free so either side can import it; extracted to kill the
// jscpd duplicate the two copies were.

/** Keep only `fields` (+ `primaryKey`, always) on each record. No `fields`
 *  ⇒ records pass through untouched. */
export function projectRecordFields<T extends Record<string, unknown>>(items: T[], fields: readonly string[] | undefined, primaryKey: string): T[] {
  if (!fields) return items;
  const keep = new Set([primaryKey, ...fields]);
  return items.map((item) => Object.fromEntries(Object.entries(item).filter(([key]) => keep.has(key))) as T);
}

/** Retrieved values laid over whatever the record already holds.
 *
 *  A record file is written whole (`writeItem`), so writing the retrieved item
 *  alone would drop every column the retrieval does not produce — a collection
 *  could not then carry a local note beside a mirrored item, because the next
 *  refresh that touched it would silently delete the note. The retrieved values
 *  still win on the fields they cover: those belong to the source.
 *
 *  Shared by the Google Calendar pull (#2620) and the feeds ingest (#2696),
 *  which had the same bug and only one of the fixes. */
//  Deliberately NOT generic over the record shape: inferring one type from
//  `retrieved` would force `existing` to match it, and "the stored record has
//  keys the retrieval does not" is the entire case this exists for.
export function mergeIntoExisting(existing: Record<string, unknown> | null, retrieved: Record<string, unknown>): Record<string, unknown> {
  return { ...(existing ?? {}), ...retrieved };
}
