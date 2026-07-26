// LLM-free Google Calendar → collection sync (#2095).
//
// The whole point of #2095 is that syncing must not cost tokens: this path
// runs on the scheduler, calls the Calendar REST API directly, and writes
// records itself. No chat, no agent, no MCP round-trip.
//
// Destination is not hardcoded — a collection opts in by declaring
// `googleCalendar` in its schema, exactly the way a feed opts in by declaring
// `ingest`. There is no preset calendar collection (the standalone Calendar
// view was removed in 0.7.0); the user asks for one and the agent authors it.
import { stat } from "node:fs/promises";
import { MISSED_RUN_POLICIES, SCHEDULE_TYPES } from "@receptron/task-scheduler";
import type { SystemTaskDef } from "../scheduler/adapter.js";
import { discoverCollections } from "../collection/server/discovery.js";
import { getWorkspaceRoot } from "../collection/server/host.js";
import type { LoadedCollection } from "../collection/server/discoveredCollection.js";
import type { DeleteItemResult, WriteItemResult } from "../collection/server/io.js";
import { storeFor } from "../collection/server/store.js";
import type { CollectionFieldSpec, CollectionItem } from "../collection/core/schema.js";
import type { GOOGLE_CALENDAR_SOURCE_FIELDS } from "../collection/core/schemaZ.js";
import { getGoogleAccessToken } from "./auth.js";
import { canonicalCalendarId, syncCalendarEvents, type CalendarEventSummary } from "./calendar.js";
import { toCollectionDateTime } from "./collectionDateTime.js";
import { clearCalendarSyncToken, loadCalendarSyncToken, saveCalendarSyncToken } from "./calendarSyncStore.js";
import { clearCalendarShadow, saveCalendarShadow, toShadowEvent, type ShadowEvent } from "./calendarPushState.js";
import { loadGoogleTokens } from "./tokenStore.js";
import { log } from "./host.js";

export const GOOGLE_CALENDAR_SYNC_TASK_ID = "system:google-calendar-sync";
const DEFAULT_SYNC_INTERVAL_MS = 60 * 60 * 1000;
const CANCELLED_STATUS = "cancelled";

export interface CalendarCollectionSyncResult {
  slug: string;
  written: number;
  removed: number;
  /** Events that can NEVER be stored — e.g. an id the record-file sanitiser
   *  rejects. Reported and skipped rather than retried; see `classifyWrite`. */
  unwritable: string[];
  /** Retryable failures. Any of these hold the sync token back. */
  errors: string[];
}

/** The event fields a schema may map from — narrowed to real keys of
 *  `CalendarEventSummary` so the projection below needs no cast. */
type GoogleCalendarSourceField = (typeof GOOGLE_CALENDAR_SOURCE_FIELDS)[number];

const DATETIME_FIELD_TYPE = "datetime";

/** Own-property lookup, mirroring what the record lint reads: a spec reachable
 *  only through the prototype chain is not a DECLARED field, so it must not
 *  decide how a value is stored. */
function declaredSpec(fields: Record<string, CollectionFieldSpec>, field: string): CollectionFieldSpec | undefined {
  return Object.hasOwn(fields, field) ? fields[field] : undefined;
}

/** Google's raw value is normalised only into a field the schema declares as
 *  `datetime` — that is the type whose stored shape the record lint, the
 *  calendar grid and the day view all parse (#2310). A user who maps `start`
 *  onto a `string` field asked for Google's value verbatim and keeps it. */
function projectValue(fields: Record<string, CollectionFieldSpec>, field: string, value: string): unknown {
  return declaredSpec(fields, field)?.type === DATETIME_FIELD_TYPE ? toCollectionDateTime(value) : value;
}

/** Project one Google event onto the collection's own field names. The
 *  primary field always takes the event id — upsert-by-id is what keeps the
 *  sync idempotent, so it is deliberately not remappable. */
export function toCollectionRecord(
  event: CalendarEventSummary,
  map: Record<string, GoogleCalendarSourceField>,
  primaryKey: string,
  fields: Record<string, CollectionFieldSpec>,
): CollectionItem {
  const mapped = Object.entries(map).map(([field, source]) => [field, projectValue(fields, field, event[source])]);
  return { ...Object.fromEntries(mapped), [primaryKey]: event.id };
}

/** `skipped` is a benign no-op; `unwritable` can never succeed so it must NOT
 *  hold the token; `error` is retryable and does hold it. */
type ApplyOutcome =
  { kind: "written" } | { kind: "removed" } | { kind: "skipped" } | { kind: "unwritable"; message: string } | { kind: "error"; message: string };

// `writeItem` / `deleteItem` report most failures by RETURNING a non-`ok` kind
// rather than throwing. Ignoring that would let the token advance past events
// that never landed, and Google never resends them (Codex review #2184).
//
// But not every failure is worth retrying: an id the record-file sanitiser
// rejects can never become valid, so holding the token for it would re-fetch
// the same window forever and permanently kill that calendar's sync — far
// worse than dropping the one event. Google's own ids are base32hex and pass,
// but an imported/client-set id may contain characters the sanitiser refuses.
// (Observed during Claude review, not flagged by a bot.)
export function classifyWrite(eventId: string, kind: WriteItemResult["kind"]): ApplyOutcome {
  if (kind === "ok") return { kind: "written" };
  if (kind === "invalid-id") return { kind: "unwritable", message: `write ${eventId}: invalid-id` };
  return { kind: "error", message: `write ${eventId}: ${kind}` };
}

export function classifyDelete(eventId: string, kind: DeleteItemResult["kind"]): ApplyOutcome {
  if (kind === "ok") return { kind: "removed" };
  // Cancelling an event we never stored is normal, not a failure.
  if (kind === "not-found") return { kind: "skipped" };
  if (kind === "invalid-id") return { kind: "unwritable", message: `delete ${eventId}: invalid-id` };
  return { kind: "error", message: `delete ${eventId}: ${kind}` };
}

async function applyEvent(collection: LoadedCollection, event: CalendarEventSummary, workspaceRoot: string): Promise<ApplyOutcome> {
  const { schema } = collection;
  try {
    // Discovery rejects googleCalendar on a read-only (dataSource) schema,
    // so absent write/delete is defense in depth, not a live path. The store
    // threads the slug into the change publish, so an open view updates live.
    const store = storeFor(collection, { workspaceRoot });
    if (!store.write || !store.delete) return { kind: "unwritable", message: `collection '${collection.slug}' is read-only` };
    if (event.status === CANCELLED_STATUS) {
      const deleted = await store.delete(event.id);
      return classifyDelete(event.id, deleted.kind);
    }
    const record = toCollectionRecord(event, schema.googleCalendar?.map ?? {}, schema.primaryKey, schema.fields);
    const written = await store.write(event.id, record);
    return classifyWrite(event.id, written.kind);
  } catch (error) {
    // A thrown IO error (EACCES, ENOSPC, …) must not abort the remaining events
    // or the other collections on this calendar — record it as retryable so the
    // token holds and the next run retries only what failed (CodeRabbit #2184).
    return { kind: "error", message: `apply ${event.id}: ${String(error)}` };
  }
}

async function restartFullSync(accessToken: string, calendarId: string | undefined, workspaceRoot: string) {
  await clearCalendarSyncToken(calendarId, workspaceRoot);
  // The push baseline describes the records the consumed token accounted for, so
  // it must not outlive that token — a full re-walk rewrites it from scratch.
  await clearCalendarShadow(calendarId, workspaceRoot);
  return await syncCalendarEvents(accessToken, { calendarId });
}

/** Serialise `run` against whatever is already running for `key`.
 *
 *  `locks` is passed in so the queuing rule is testable without module state;
 *  the key is dropped once nothing is queued behind it, so the map cannot grow
 *  an entry per calendar forever. A failed predecessor still releases the
 *  queue — `then(run, run)`. */
export async function withKeyedLock<T>(locks: Map<string, Promise<unknown>>, key: string, run: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const result = previous.then(run, run);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  locks.set(key, tail);
  try {
    return await result;
  } finally {
    if (locks.get(key) === tail) locks.delete(key);
  }
}

/** In-flight sync per canonical calendar id. Module state on purpose: the
 *  scheduler, the create trigger and the Refresh button are three doors into
 *  the same calendar (CodeRabbit review #2566). */
const calendarLocks = new Map<string, Promise<unknown>>();

/** Sync ONE calendar and fan its events out to every collection bound to it.
 *
 *  The fan-out is not an optimisation, it is correctness: the sync token is
 *  keyed by `calendarId`, so syncing collection-by-collection would let the
 *  first collection advance the shared token and leave every later collection
 *  on the same calendar reading an already-consumed window — silently missing
 *  those events forever. Fetch once, apply to all, then advance the token.
 *  (Codex + CodeRabbit review on #2184.)
 *
 *  Queued per calendar for the same reason the fan-out exists: two passes over
 *  one calendar (a Refresh click landing during the scheduled run) would each
 *  load the SAME stored token and walk the same window. That is idempotent —
 *  writes are upserts by event id — but it is a wasted full walk. Queued, the
 *  second pass resumes from the token the first just stored and fetches only
 *  what is genuinely new. */
/** Serialise anything that touches ONE calendar's sync state.
 *
 *  Shared with the push path (#2598), not only the pull doors: a push that
 *  overtakes an in-flight pull would record a baseline for events the pull is
 *  still writing, so the next push would diff against a future it never saw. */
export async function withCalendarLock<T>(calendarId: string | undefined, run: () => Promise<T>): Promise<T> {
  return await withKeyedLock(calendarLocks, canonicalCalendarId(calendarId), run);
}

export async function syncCalendarGroup(
  calendarId: string | undefined,
  collections: readonly LoadedCollection[],
  workspaceRoot: string,
): Promise<CalendarCollectionSyncResult[]> {
  return await withCalendarLock(calendarId, () => syncCalendarGroupNow(calendarId, collections, workspaceRoot));
}

async function syncCalendarGroupNow(
  calendarId: string | undefined,
  collections: readonly LoadedCollection[],
  workspaceRoot: string,
): Promise<CalendarCollectionSyncResult[]> {
  const accessToken = await getGoogleAccessToken();
  const storedToken = await loadCalendarSyncToken(calendarId, workspaceRoot);
  const first = await syncCalendarEvents(accessToken, { calendarId, syncToken: storedToken ?? undefined });
  const result = first.fullResyncRequired ? await restartFullSync(accessToken, calendarId, workspaceRoot) : first;

  const results: CalendarCollectionSyncResult[] = [];
  for (const collection of collections) {
    results.push(await applyEventsToCollection(collection, result.events, workspaceRoot));
  }
  // Advance the token only after every collection in the group consumed the
  // window AND every record actually landed. Google never resends a window, so
  // advancing past a failed write would lose those events for good; holding the
  // token back just replays them next run (writes are idempotent).
  const unwritable = results.flatMap((entry) => entry.unwritable);
  if (unwritable.length > 0) {
    // Never retryable, so the token still advances — but say so loudly, since
    // these events will silently never appear in the collection.
    log.warn("google", "skipping calendar events that can never be stored", { calendarId, unwritable });
  }
  const failed = results.flatMap((entry) => entry.errors);
  if (failed.length > 0) {
    log.warn("google", "holding back calendar sync token after failed writes", { calendarId, failed: failed.length });
    return results;
  }
  // Gated with the token, for the same reason: a baseline recorded for a window
  // the records never received would make the next push read a local edit where
  // there was only a failed write.
  await saveCalendarShadow(calendarId, shadowUpdates(result.events), workspaceRoot);
  if (result.nextSyncToken) await advanceToken(calendarId, result.nextSyncToken, collections, workspaceRoot);
  return results;
}

/** The baseline this window establishes: what Google now says per event, and
 *  `null` for a cancelled one so a recreate cannot resume from a dead baseline. */
export function shadowUpdates(events: readonly CalendarEventSummary[]): Record<string, ShadowEvent | null> {
  return Object.fromEntries(events.map((event) => [event.id, event.status === CANCELLED_STATUS ? null : toShadowEvent(event)]));
}

/** Save the window's token unless every collection that consumed it was deleted
 *  while the sync was in flight.
 *
 *  The sync opens with a `discoverCollections()` snapshot, so a delete landing
 *  mid-run has already cleared this calendar's token by the time we get here
 *  (`releaseOrphanedCalendarToken`). Saving anyway would resurrect exactly the
 *  orphan the delete removed, and the next collection on this calendar would
 *  resume from a token describing records it never received (#2428).
 *
 *  One survivor is enough: it still needs the incremental position. */
async function advanceToken(
  calendarId: string | undefined,
  nextSyncToken: string,
  collections: readonly LoadedCollection[],
  workspaceRoot: string,
): Promise<void> {
  if (!(await anySyncedCollectionSurvives(collections))) {
    log.info("google", "not advancing the sync token — every collection on this calendar was deleted mid-sync", { calendarId });
    return;
  }
  await saveCalendarSyncToken(calendarId, nextSyncToken, workspaceRoot);
}

async function pathExists(absPath: string): Promise<boolean> {
  try {
    await stat(absPath);
    return true;
  } catch {
    return false;
  }
}

/** Liveness of the collections a sync just wrote to, checked against the skill
 *  dir `deleteCollection` removes. `exists` is injected so the rule is testable
 *  without a filesystem. An empty group has no survivor by definition. */
export async function anySyncedCollectionSurvives(
  collections: readonly Pick<LoadedCollection, "skillDir">[],
  exists: (absPath: string) => Promise<boolean> = pathExists,
): Promise<boolean> {
  const alive = await Promise.all(collections.map((collection) => exists(collection.skillDir)));
  return alive.some(Boolean);
}

async function applyEventsToCollection(
  collection: LoadedCollection,
  events: readonly CalendarEventSummary[],
  workspaceRoot: string,
): Promise<CalendarCollectionSyncResult> {
  const outcomes: ApplyOutcome[] = [];
  for (const event of events) {
    outcomes.push(await applyEvent(collection, event, workspaceRoot));
  }
  return {
    slug: collection.slug,
    written: outcomes.filter((outcome) => outcome.kind === "written").length,
    removed: outcomes.filter((outcome) => outcome.kind === "removed").length,
    unwritable: outcomes.flatMap((outcome) => (outcome.kind === "unwritable" ? [outcome.message] : [])),
    errors: outcomes.flatMap((outcome) => (outcome.kind === "error" ? [outcome.message] : [])),
  };
}

/** A refresh token is what lets the scheduler run unattended; without one
 *  there is nothing to sync with. */
async function isGoogleLinked(): Promise<boolean> {
  return Boolean((await loadGoogleTokens())?.refresh_token);
}

/** Group the declaring collections by the calendar they read, so each calendar
 *  is fetched exactly once.
 *
 *  Keyed by the CANONICAL id, not the declared one: an omitted `calendarId` and
 *  an explicit `"primary"` address the same calendar and therefore share one
 *  sync token, so grouping them apart would let one group advance the token out
 *  from under the other — the very loss this grouping exists to prevent
 *  (Codex review #2184). */
export function groupByCalendar(collections: readonly LoadedCollection[]): Map<string, LoadedCollection[]> {
  const groups = new Map<string, LoadedCollection[]>();
  for (const collection of collections) {
    const key = canonicalCalendarId(collection.schema.googleCalendar?.calendarId);
    groups.set(key, [...(groups.get(key) ?? []), collection]);
  }
  return groups;
}

/** The minimum a value needs for the orphan check: just the calendar it reads.
 *  Structural so the rule can be exercised without building a LoadedCollection. */
export interface CalendarDeclaring {
  googleCalendar?: { calendarId?: string };
}

/** The canonical calendar whose sync token nothing needs any more, or null.
 *
 *  Sync tokens are keyed by calendar, NOT by collection, so a deleted
 *  collection's token outlives it. Recreating a collection on the same calendar
 *  then resumes from that token and receives only the delta — the new
 *  collection never gets the history (#2428).
 *
 *  Returns null while ANY remaining collection still reads that calendar:
 *  clearing a live calendar's token costs a full re-walk on the next sync. The
 *  comparison is on the CANONICAL id for the same reason `groupByCalendar` is —
 *  an omitted `calendarId` and an explicit `"primary"` are one calendar. */
export function orphanedCalendarId(deleted: CalendarDeclaring, remaining: readonly CalendarDeclaring[]): string | null {
  if (!deleted.googleCalendar) return null;
  const key = canonicalCalendarId(deleted.googleCalendar.calendarId);
  const stillRead = remaining.some((other) => other.googleCalendar && canonicalCalendarId(other.googleCalendar.calendarId) === key);
  return stillRead ? null : key;
}

/** Drop the sync token of a just-deleted collection's calendar, unless another
 *  collection still reads it. Call AFTER the delete lands — the check reads the
 *  collections that survive it.
 *
 *  Returns the cleared calendar id, or null when nothing was cleared. Never
 *  throws: a failed cleanup must not fail the delete it follows. */
export async function releaseOrphanedCalendarToken(deleted: CalendarDeclaring, workspaceRoot: string): Promise<string | null> {
  try {
    if (!deleted.googleCalendar) return null;
    const remaining = await discoverCollections({ workspaceRoot });
    const orphaned = orphanedCalendarId(
      deleted,
      remaining.map((collection) => collection.schema),
    );
    if (orphaned === null) return null;
    await clearCalendarSyncToken(orphaned, workspaceRoot);
    await clearCalendarShadow(orphaned, workspaceRoot);
    log.info("google", "cleared the sync token of a calendar no collection reads any more", { calendarId: orphaned });
    return orphaned;
  } catch (error) {
    log.warn("google", "could not release the deleted collection's calendar sync token", { error: String(error) });
    return null;
  }
}

/** Every declaring collection, grouped by the calendar it reads. */
async function declaringGroups(workspaceRoot: string): Promise<Map<string, LoadedCollection[]>> {
  const all = await discoverCollections({ workspaceRoot });
  return groupByCalendar(all.filter((collection) => collection.schema.googleCalendar));
}

/** Whether a background sync of these groups may run at all.
 *
 *  Authoring the collection before linking the account is an expected state,
 *  not a failure. Checking once here keeps it a quiet skip instead of an
 *  access-token throw per calendar, every hour, until the user links (#2188).
 *  A user-triggered sync answers differently — it says so out loud. */
async function backgroundSyncAllowed(groups: Map<string, LoadedCollection[]>): Promise<boolean> {
  if (groups.size === 0) return false;
  if (await isGoogleLinked()) return true;
  log.info("google", "skipping calendar sync — no Google account linked on this host", { calendars: groups.size });
  return false;
}

/** Run each group, isolating failures per calendar — one unreachable calendar
 *  (or a revoked grant) must not stop the others. */
async function runCalendarGroups(groups: Map<string, LoadedCollection[]>, workspaceRoot: string): Promise<CalendarCollectionSyncResult[]> {
  const results: CalendarCollectionSyncResult[] = [];
  for (const [calendarId, collections] of groups) {
    try {
      results.push(...(await syncCalendarGroup(calendarId, collections, workspaceRoot)));
    } catch (error) {
      log.warn("google", "calendar sync failed", { calendarId, error: String(error) });
      results.push(...collections.map((collection) => ({ slug: collection.slug, written: 0, removed: 0, unwritable: [], errors: [String(error)] })));
    }
  }
  return results;
}

/** Sync every collection that declares `googleCalendar`. */
export async function syncDueCalendarCollections(workspaceRoot: string): Promise<CalendarCollectionSyncResult[]> {
  const groups = await declaringGroups(workspaceRoot);
  return (await backgroundSyncAllowed(groups)) ? await runCalendarGroups(groups, workspaceRoot) : [];
}

/** The groups whose calendar has never synced. A missing token IS the "created
 *  since the last sync" signal — nothing else distinguishes a new collection
 *  from an edited one on the write path this feeds (#2427).
 *
 *  Self-silencing by construction: the first sync stores a token, so a calendar
 *  matches at most once. `loadToken` is injected so the rule is testable without
 *  a workspace on disk. */
export async function unsyncedGroups<T>(groups: Map<string, T>, loadToken: (calendarId: string) => Promise<string | null>): Promise<Map<string, T>> {
  const checked = await Promise.all([...groups].map(async (entry) => ((await loadToken(entry[0])) === null ? entry : null)));
  return new Map(checked.filter((entry): entry is [string, T] => entry !== null));
}

/** Sync only the calendars that have never synced — the first sync for a
 *  just-created collection, which otherwise stays empty until the hourly
 *  scheduler run (#2427). Cheap and safe to call on every config write. */
export async function syncNewCalendarCollections(workspaceRoot: string): Promise<CalendarCollectionSyncResult[]> {
  const groups = await declaringGroups(workspaceRoot);
  const pending = await unsyncedGroups(groups, (calendarId) => loadCalendarSyncToken(calendarId, workspaceRoot));
  if (!(await backgroundSyncAllowed(pending))) return [];
  log.info("google", "running the first sync for newly declared calendars", { calendars: [...pending.keys()] });
  return await runCalendarGroups(pending, workspaceRoot);
}

/** A user-triggered sync's outcome. `not-a-calendar` and `not-linked` are
 *  states the caller must report rather than swallow: a Refresh click that
 *  quietly returns "0 written" reads as an empty calendar, not as a setup gap. */
export type ManualCalendarSyncOutcome = { kind: "synced"; results: CalendarCollectionSyncResult[] } | { kind: "not-a-calendar" } | { kind: "not-linked" };

/** The I/O a manual sync crosses, injectable so the three outcomes can be
 *  exercised with fakes instead of a workspace on disk and a live Google grant
 *  (CodeRabbit review #2566). */
export interface ManualCalendarSyncDeps {
  loadGroups: (workspaceRoot: string) => Promise<Map<string, LoadedCollection[]>>;
  isLinked: () => Promise<boolean>;
  runGroups: (groups: Map<string, LoadedCollection[]>, workspaceRoot: string) => Promise<CalendarCollectionSyncResult[]>;
}

const liveManualSyncDeps: ManualCalendarSyncDeps = { loadGroups: declaringGroups, isLinked: isGoogleLinked, runGroups: runCalendarGroups };

/** Sync the calendar ONE collection reads, on demand (the Refresh button).
 *
 *  Deliberately syncs the whole group, not just `slug`: the sync token is keyed
 *  by calendar, so consuming a window for one collection would leave the others
 *  on that calendar reading an already-consumed one. Returns every result of the
 *  group so the caller can report the requested slug's own counts.
 *
 *  "Does this collection sync at all" is answered BEFORE "is Google linked":
 *  telling someone to link their account for a collection that never declared a
 *  calendar sends them fixing the wrong thing. */
export async function syncCalendarForCollection(
  slug: string,
  workspaceRoot: string,
  deps: ManualCalendarSyncDeps = liveManualSyncDeps,
): Promise<ManualCalendarSyncOutcome> {
  const groups = await deps.loadGroups(workspaceRoot);
  const owning = [...groups].filter(([, collections]) => collections.some((collection) => collection.slug === slug));
  if (owning.length === 0) return { kind: "not-a-calendar" };
  if (!(await deps.isLinked())) return { kind: "not-linked" };
  return { kind: "synced", results: await deps.runGroups(new Map(owning), workspaceRoot) };
}

/** Scheduler registration, shaped like `feedRefreshTaskDef` so hosts wire it
 *  with a single line. */
export function googleCalendarSyncTaskDef(opts?: { workspaceRoot?: string; intervalMs?: number }): SystemTaskDef {
  return {
    id: GOOGLE_CALENDAR_SYNC_TASK_ID,
    name: "Google Calendar sync",
    description: "Pulls changed Google Calendar events into any collection declaring `googleCalendar`, without invoking the LLM.",
    schedule: { type: SCHEDULE_TYPES.interval, intervalMs: opts?.intervalMs ?? DEFAULT_SYNC_INTERVAL_MS },
    missedRunPolicy: MISSED_RUN_POLICIES.runOnce,
    run: () => syncDueCalendarCollections(opts?.workspaceRoot ?? getWorkspaceRoot()).then(() => {}),
  };
}
