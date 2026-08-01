// Retrieval engine: fetch a feed, upsert its records into the
// collection's data dir (keyed by primaryKey, so re-fetches replace in
// place / accumulate by id), and persist per-feed state. Per-feed
// failures are isolated — `refreshOne` never throws; `refreshDue`
// processes feeds sequentially to stay gentle on remote hosts (the
// fetch client does no rate-limiting yet).

import { discoverCollections, storeFor, type CollectionStore, type LoadedCollection } from "../../collection/server/index.js";
import type { CollectionItem, CollectionSchema } from "../../collection/index.js";
import { mergeIntoExisting } from "../../collection/core/project.js";
import { log, requireFeedsHost } from "./host.js";
import { getRetriever } from "./retrievers/index.js";
import "./retrievers/registerAll.js";
import { readFeedState, writeFeedState, type FeedState } from "./state.js";
import { DEFAULT_FEED_MAX_ITEMS, AGENT_INGEST_KIND, type FeedSchedule, type IngestSpec } from "../ingestTypes.js";
import { refreshViaAgent } from "./agentIngest.js";
import type { RefreshResult } from "./refreshResult.js";

export type { RefreshResult } from "./refreshResult.js";

// Refresh cadence anchors (ms). Inlined — the engine needs only these two and
// must stay free of host-side time-constant modules.
const ONE_HOUR_MS = 3_600_000;
const ONE_DAY_MS = 86_400_000;

/** Feed schemas carry the rich `IngestSpec` (validated at discovery —
 *  `source === "feed"` requires `ingest`), but the canonical
 *  `CollectionSchema.ingest` only promises the minimal `CollectionIngest`.
 *  Narrow here so the engine can read the retrieval fields type-safely. */
function feedIngest(schema: CollectionSchema): IngestSpec | undefined {
  return schema.ingest as IngestSpec | undefined;
}

/** A feed's store. `write`/`delete` are always present (discovery rejects
 *  `ingest` on read-only dataSource schemas); null only as defense in depth. */
function writableFeedStore(
  workspaceRoot: string,
  feed: LoadedCollection,
): (CollectionStore & { write: NonNullable<CollectionStore["write"]>; delete: NonNullable<CollectionStore["delete"]> }) | null {
  const store = storeFor(feed, { workspaceRoot });
  const { write, delete: remove } = store;
  if (!write || !remove) {
    log.warn("feeds", "feed store is read-only — refresh skipped", { slug: feed.slug });
    return null;
  }
  return { ...store, write, delete: remove };
}

/** Fields the feed itself produces: what it actually returned this run, the
 *  declared map's targets, and the primary key the retriever derives. Anything
 *  else on a record got there some other way — the user.
 *
 *  Both sources, because neither alone is enough. The in-tree retrievers project
 *  through `map`, so it describes them exactly — but `registerRetriever` lets a
 *  host add one that returns whatever it likes, and only the observed keys catch
 *  that. Conversely a run that fetched nothing has no keys to observe, and only
 *  `map` keeps the cap working through it. */
export const ingestedFields = (items: readonly CollectionItem[], mappedTargets: readonly string[], primaryKey: string): ReadonlySet<string> =>
  new Set([primaryKey, ...mappedTargets, ...items.flatMap((item) => Object.keys(item))]);

/** The collection fields a declarative `map` names. Read as `unknown` and
 *  narrowed here rather than through the zod-derived union, whose `map` does not
 *  survive the `kind` narrowing well enough to index safely. Only the keys are
 *  wanted, so the value type never has to be reconstructed. */
export function mappedTargetsOf(ingest: IngestSpec | undefined): string[] {
  const map: unknown = ingest === undefined || ingest.kind === AGENT_INGEST_KIND ? undefined : ingest.map;
  return typeof map === "object" && map !== null ? Object.keys(map) : [];
}

/** Whether a record carries content the feed did not put there.
 *
 *  Only a NON-EMPTY value counts. A record saved through the UI can carry every
 *  declared field as an empty string, and treating those as local content would
 *  make every touched record un-prunable — the cap would quietly stop working.
 *
 *  An edit to a MAPPED field deliberately does not count: a feed is
 *  one-directional, so the next refresh writes over it by design. The local
 *  COLUMN is the durable half, and the half worth protecting. */
export function hasLocalContent(item: CollectionItem, ingested: ReadonlySet<string>): boolean {
  return Object.entries(item).some(([field, value]) => !ingested.has(field) && value !== undefined && value !== null && value !== "");
}

/** The stored record, or null when it cannot be read.
 *
 *  `readItem` answers null for a MISSING record but THROWS on unparsable JSON
 *  or an IO error. Letting that escape would fail the whole refresh over one bad
 *  file — and write nothing at all, since the loop aborts partway. Before the
 *  merge landed, the ingest simply overwrote such a file and the feed healed
 *  itself; treating "unreadable" as "absent" keeps that. (Observed during Claude
 *  review; both review bots were rate-limited on this PR.) */
async function readableRecord(store: { read: CollectionStore["read"] }, feed: LoadedCollection, itemId: string): Promise<CollectionItem | null> {
  try {
    return await store.read(itemId);
  } catch (error) {
    log.warn("feeds", "unreadable feed record — the retrieved item will replace it", { slug: feed.slug, itemId, error: String(error) });
    return null;
  }
}

async function upsertItems(workspaceRoot: string, feed: LoadedCollection, items: CollectionItem[]): Promise<number> {
  const store = writableFeedStore(workspaceRoot, feed);
  if (!store) return 0;
  let written = 0;
  for (const item of items) {
    const itemId = item[feed.schema.primaryKey];
    if (typeof itemId !== "string" || itemId.length === 0) continue;
    // Laid OVER the record rather than replacing it. `writeItem` writes the
    // whole file, so writing the retrieved item alone deletes every column the
    // ingest does not produce — the note the user put beside the article. The
    // Google Calendar pull learned this in #2620; the feeds ingest never did
    // (#2696).
    const result = await store.write(itemId, mergeIntoExisting(await readableRecord(store, feed, itemId), item));
    if (result.kind === "ok") written += 1;
    else log.warn("feeds", "feed item write skipped", { slug: feed.slug, itemId, kind: result.kind });
  }
  return written;
}

/** The schema's first `date` field, used to order records for the
 *  maxItems cap. Null when the schema declares none. */
function firstDateField(schema: CollectionSchema): string | null {
  for (const [key, spec] of Object.entries(schema.fields)) {
    if (spec.type === "date") return key;
  }
  return null;
}

// Epoch ms for a record's date value; missing / unparseable sorts oldest.
function recordTime(item: CollectionItem, field: string): number {
  const value = item[field];
  const millis = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(millis) ? millis : Number.NEGATIVE_INFINITY;
}

/** Enforce `ingest.maxItems` (default 100): keep the newest N records by
 *  the schema's date field, delete the rest. No-op when the cap is 0/absent
 *  of a date field, or when under the cap. Returns the number deleted. */
async function pruneFeed(workspaceRoot: string, feed: LoadedCollection, fetched: readonly CollectionItem[]): Promise<number> {
  const ingest = feedIngest(feed.schema);
  // maxItems is a declarative-feed concept; agent ingest manages its own record
  // set, so it's never pruned here (and `refreshOne` never calls pruneFeed for it).
  const cap = (ingest && ingest.kind !== AGENT_INGEST_KIND ? ingest.maxItems : undefined) ?? DEFAULT_FEED_MAX_ITEMS;
  if (cap <= 0) return 0;
  const dateField = firstDateField(feed.schema);
  if (!dateField) {
    log.warn("feeds", "maxItems prune skipped: schema has no date field to order by", { slug: feed.slug });
    return 0;
  }
  const store = writableFeedStore(workspaceRoot, feed);
  if (!store) return 0;
  const items = await store.list();
  if (items.length <= cap) return 0;
  const ingested = ingestedFields(fetched, mappedTargetsOf(ingest), feed.schema.primaryKey);
  const aged = [...items].sort((left, right) => recordTime(right, dateField) - recordTime(left, dateField)).slice(cap);
  // Deleting a record the user annotated is the same silent loss the merge above
  // prevents, one step later: the note survives every refresh and then goes when
  // the article ages out. Kept records can push a feed past its cap, so say so
  // rather than letting the number drift unexplained (#2696).
  const stale = aged.filter((item) => !hasLocalContent(item, ingested));
  const kept = aged.length - stale.length;
  if (kept > 0) log.info("feeds", "keeping aged-out records that carry local content", { slug: feed.slug, kept, cap });
  let removed = 0;
  for (const item of stale) {
    const itemId = item[feed.schema.primaryKey];
    if (typeof itemId !== "string" || itemId.length === 0) continue;
    if ((await store.delete(itemId)).kind === "ok") removed += 1;
  }
  if (removed > 0) log.info("feeds", "pruned old feed records", { slug: feed.slug, removed, cap });
  return removed;
}

/** Fetch one feed now, upsert its records, then enforce the maxItems cap.
 *  Failure-isolated: returns an errors array rather than throwing. */
export async function refreshOne(workspaceRoot: string, feed: LoadedCollection, opts?: { hidden?: boolean }): Promise<RefreshResult> {
  const { slug } = feed;
  const ingest = feedIngest(feed.schema);
  if (!ingest) return { slug, written: 0, removed: 0, errors: ["collection has no ingest config"] };
  // `agent` ingest dispatches a worker instead of fetching: branch off BEFORE
  // the retriever registry (which only knows declarative kinds). `opts.hidden`
  // (manual Refresh passes false) only affects the agent path; declarative
  // feeds ignore it.
  if (ingest.kind === AGENT_INGEST_KIND) return refreshViaAgent(workspaceRoot, feed, opts);
  const retriever = getRetriever(ingest.kind);
  if (!retriever) return { slug, written: 0, removed: 0, errors: [`no retriever registered for kind '${ingest.kind}'`] };
  const state = await readFeedState(workspaceRoot, feed);
  try {
    const result = await retriever(ingest, feed.schema, state);
    const written = await upsertItems(workspaceRoot, feed, result.items);
    await writeFeedState(workspaceRoot, feed, { ...state, lastFetchedAt: new Date().toISOString(), cursor: result.cursor, consecutiveFailures: 0 });
    const removed = await pruneFeed(workspaceRoot, feed, result.items);
    log.info("feeds", "feed refreshed", { slug, written, removed, fetched: result.items.length });
    return { slug, written, removed, errors: [] };
  } catch (error) {
    await writeFeedState(workspaceRoot, feed, { ...state, consecutiveFailures: state.consecutiveFailures + 1 });
    const message = String(error);
    log.warn("feeds", "feed refresh failed", { slug, error: message });
    return { slug, written: 0, removed: 0, errors: [message] };
  }
}

function dueIntervalMs(schedule: FeedSchedule): number {
  switch (schedule) {
    case "daily":
      return ONE_DAY_MS;
    case "weekly":
      return 7 * ONE_DAY_MS;
    default:
      return ONE_HOUR_MS;
  }
}

/** True iff a `daily` schedule with a UTC `atHour` anchor is due. The system
 *  task ticks hourly, so "due" means: we're in the anchor hour AND we haven't
 *  already run in roughly the last day. The 23 h floor (not 24 h) tolerates the
 *  tick landing a few minutes earlier than the previous run, while staying well
 *  above 1 h so a second tick in the same anchor hour can't double-fire. */
function isDailyAtHourDue(now: Date, atHour: number, lastFetchedAt: string | null): boolean {
  if (now.getUTCHours() !== atHour) return false;
  if (!lastFetchedAt) return true;
  const elapsed = now.getTime() - Date.parse(lastFetchedAt);
  if (!Number.isFinite(elapsed)) return true;
  return elapsed >= 23 * ONE_HOUR_MS;
}

/** True iff a collection is due to refresh given its schedule + last run.
 *  `on-demand` is never auto-due; a `daily` schedule with `atHour` anchors to
 *  that UTC hour, otherwise cadence is elapsed-based. */
function isFeedDue(feed: LoadedCollection, state: FeedState): boolean {
  const ingest = feedIngest(feed.schema);
  const schedule = ingest?.schedule;
  if (!schedule || schedule === "on-demand") return false;
  if (schedule === "daily" && typeof ingest?.atHour === "number") {
    return isDailyAtHourDue(new Date(), ingest.atHour, state.lastFetchedAt);
  }
  if (!state.lastFetchedAt) return true;
  const elapsed = Date.now() - Date.parse(state.lastFetchedAt);
  if (!Number.isFinite(elapsed)) return true;
  return elapsed >= dueIntervalMs(schedule);
}

/** Refresh every collection whose ingest schedule says it's due — declarative
 *  feeds AND skill-backed collections with `ingest.kind: "agent"`. Called by the
 *  hourly system task. Sequential + failure-isolated. */
export async function refreshDue(workspaceRoot: string = requireFeedsHost().workspaceRoot): Promise<RefreshResult[]> {
  const all = await discoverCollections({ workspaceRoot });
  const withIngest = all.filter((collection) => collection.schema.ingest);
  const results: RefreshResult[] = [];
  for (const collection of withIngest) {
    // Isolate per-collection failures: `readFeedState`/`refreshOne` (esp. the
    // agent path) can throw, and one bad collection must not abort the whole
    // due-loop. Capture it as an errors result and move on.
    try {
      const state = await readFeedState(workspaceRoot, collection);
      if (!isFeedDue(collection, state)) continue;
      results.push(await refreshOne(workspaceRoot, collection));
    } catch (error) {
      log.warn("feeds", "scheduled refresh failed for collection", { slug: collection.slug, error: String(error) });
      results.push({ slug: collection.slug, written: 0, removed: 0, errors: [String(error)] });
    }
  }
  return results;
}
