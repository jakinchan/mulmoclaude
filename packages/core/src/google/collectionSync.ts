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
import { getGoogleAccessToken } from "./auth.js";
import { canonicalCalendarId, syncCalendarEvents, CANCELLED_EVENT_STATUS, type CalendarEventSummary } from "./calendar.js";
import { withCalendarLock } from "./calendarLock.js";
import { mergeIntoExisting, toCollectionRecord } from "./collectionProjection.js";
import { pushCollectionNow, unsentLocalEdits, type CalendarCollectionPushResult } from "./collectionPush.js";
import { clearCalendarSyncToken, loadCalendarSyncToken, saveCalendarSyncToken } from "./calendarSyncStore.js";
import { clearCalendarShadow, saveCalendarShadow, toShadowEvent, type ShadowEvent } from "./calendarPushState.js";
import { loadGoogleTokens } from "./tokenStore.js";
import { log } from "./host.js";

export const GOOGLE_CALENDAR_SYNC_TASK_ID = "system:google-calendar-sync";
const DEFAULT_SYNC_INTERVAL_MS = 60 * 60 * 1000;

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
    if (event.status === CANCELLED_EVENT_STATUS) {
      const deleted = await store.delete(event.id);
      return classifyDelete(event.id, deleted.kind);
    }
    const record = toCollectionRecord(event, schema.googleCalendar?.map ?? {}, schema.primaryKey, schema.fields);
    const written = await store.write(event.id, mergeIntoExisting(await store.read(event.id), record));
    return classifyWrite(event.id, written.kind);
  } catch (error) {
    // A thrown IO error (EACCES, ENOSPC, …) must not abort the remaining events
    // or the other collections on this calendar — record it as retryable so the
    // token holds and the next run retries only what failed (CodeRabbit #2184).
    return { kind: "error", message: `apply ${event.id}: ${String(error)}` };
  }
}

/** The events of a window a pull may act on.
 *
 *  A record the push just refused to send is edited on BOTH sides. Writing
 *  Google's value over it destroys the local edit the push declined to resolve,
 *  so the local one stands. Single-sourced because the record write and the
 *  baseline write must agree exactly on which events they skip — disagreeing is
 *  what would silently overwrite Google on the next push (#2620). */
export function pullableEvents(events: readonly CalendarEventSummary[], unpushed: ReadonlySet<string>): CalendarEventSummary[] {
  return events.filter((event) => !unpushed.has(event.id));
}

/** Report what an automatic push did, since nobody is watching a scheduled run.
 *  A conflict or an error means that record now diverges from Google until
 *  someone resolves it, which must not be silent. */
function reportAutoPush(slug: string, result: CalendarCollectionPushResult): void {
  const { created, updated, conflicts, skipped, errors, unpushedIds } = result;
  if (created + updated > 0) log.info("google", "auto-pushed local calendar edits", { slug, created, updated });
  if (unpushedIds.length > 0) {
    log.warn("google", "records the auto push could not send — the pull will leave them alone", { slug, conflicts, unpushedIds });
  }
  if (skipped.length > 0) log.warn("google", "records the auto push skipped", { slug, skipped });
  if (errors.length > 0) log.warn("google", "auto push errors", { slug, errors });
}

/** What an automatic push protected, per collection slug. `null` means it could
 *  not be worked out at all — see `PROTECTION_UNKNOWN`. */
export type UnpushedBySlug = ReadonlyMap<string, ReadonlySet<string> | null>;

const NOTHING_UNPUSHED: ReadonlySet<string> = new Set();

/** A collection whose protection is unknown must not be pulled this run.
 *
 *  Reported through the retryable `errors` channel rather than as a special case:
 *  that already holds the sync token AND skips the baseline save, so the window
 *  simply replays next run with nothing lost. Failing OPEN here — pulling with no
 *  protection — would overwrite the very edits this exists to protect; the read
 *  that failed is no evidence that the pull's own writes would fail too, so they
 *  would land (CodeRabbit review #2666). */
export const PROTECTION_UNKNOWN = "could not work out which records to protect after a failed push";

/** What ONE collection's pull must leave alone: only what ITS OWN push failed to
 *  send.
 *
 *  Scoped per collection because a calendar can back several of them, and a
 *  conflict in one says nothing about the others. Sharing one set across the
 *  group starved a collection that never even declares `autoPush`: it cannot
 *  conflict, yet a neighbour's conflict froze its records — and the sync token
 *  still advanced, so Google never resent them (Codex review #2666). */
export const unpushedFor = (unpushed: UnpushedBySlug, slug: string): ReadonlySet<string> | null => {
  const protection = unpushed.get(slug);
  return protection === undefined ? NOTHING_UNPUSHED : protection;
};

/** What the calendar's BASELINE must leave alone: the union over every
 *  collection.
 *
 *  Deliberately not per collection, unlike the records above. `.push-state.json`
 *  holds ONE baseline per calendar, shared by every collection on it, so there is
 *  no per-collection baseline to hold back. Advancing it while any collection
 *  still has an unresolved conflict is the failure that silently overwrites
 *  Google on the next push, and holding it back only ever means "keep reporting
 *  the conflict" — so the union is the safe side of an asymmetry the shared
 *  storage forces.
 *
 *  A `null` (unknown) entry contributes nothing, because that collection reports
 *  a retryable error instead — which stops the baseline being saved at all. */
export const allUnpushed = (unpushed: UnpushedBySlug): ReadonlySet<string> => new Set([...unpushed.values()].flatMap((ids) => (ids === null ? [] : [...ids])));

/** What a collection's pull must protect when its push did not run AT ALL.
 *
 *  Registering nothing here was a silent data loss of exactly the kind this
 *  feature exists to prevent: a calendar whose role degrades to reader refuses
 *  the whole push, yet the pull still runs — reading needs no write access — and
 *  overwrote every unsent local edit while advancing its baseline past it, so the
 *  next push could not even report the conflict (CodeRabbit review #2666).
 *
 *  Protects the edited records rather than all of them, so an unchanged record
 *  keeps syncing normally. `null` when even that could not be worked out — the
 *  caller then refuses to pull the collection at all, because failing open here
 *  destroys exactly what this protects. */
async function protectUnsentEdits(collection: LoadedCollection, workspaceRoot: string): Promise<ReadonlySet<string> | null> {
  try {
    const edited = await unsentLocalEdits(collection, workspaceRoot);
    if (edited.length > 0) log.warn("google", "protecting local edits a failed push could not send", { slug: collection.slug, edited });
    return new Set(edited);
  } catch (error) {
    log.warn("google", PROTECTION_UNKNOWN, { slug: collection.slug, error: String(error) });
    return null;
  }
}

/** Push every `autoPush` collection in this group, and answer with the records
 *  whose local edit did not reach Google, keyed by collection.
 *
 *  MUST run inside the calendar lock the caller already holds — hence
 *  `pushCollectionNow` rather than `pushCalendarForCollection`, which would take
 *  the same non-reentrant lock and wait on itself forever.
 *
 *  A failed push must not stop the pull: the pull is what keeps the collection
 *  fresh, and a revoked write grant is no reason to freeze reading. */
async function pushAutoCollections(collections: readonly LoadedCollection[], workspaceRoot: string): Promise<UnpushedBySlug> {
  const unpushed = new Map<string, ReadonlySet<string> | null>();
  for (const collection of collections.filter((entry) => entry.schema.googleCalendar?.autoPush)) {
    try {
      const outcome = await pushCollectionNow(collection, workspaceRoot);
      if (outcome.kind === "pushed") {
        reportAutoPush(collection.slug, outcome.result);
        unpushed.set(collection.slug, new Set(outcome.result.unpushedIds));
        continue;
      }
      log.warn("google", "auto push did not run", { slug: collection.slug, reason: outcome.kind });
      unpushed.set(collection.slug, await protectUnsentEdits(collection, workspaceRoot));
    } catch (error) {
      log.warn("google", "auto push failed — pulling anyway", { slug: collection.slug, error: String(error) });
      unpushed.set(collection.slug, await protectUnsentEdits(collection, workspaceRoot));
    }
  }
  return unpushed;
}

async function restartFullSync(accessToken: string, calendarId: string | undefined, workspaceRoot: string) {
  await clearCalendarSyncToken(calendarId, workspaceRoot);
  // The push baseline describes the records the consumed token accounted for, so
  // it must not outlive that token — a full re-walk rewrites it from scratch.
  await clearCalendarShadow(calendarId, workspaceRoot);
  return await syncCalendarEvents(accessToken, { calendarId });
}

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
  // Push BEFORE the window is fetched, so a local edit is already in Google when
  // the pull reads it: the record then comes back holding Google's own canonical
  // value, and the baseline agrees with both. Pulling first would overwrite the
  // very edit that was waiting to go up (#2620).
  const unpushed = await pushAutoCollections(collections, workspaceRoot);

  const accessToken = await getGoogleAccessToken();
  const storedToken = await loadCalendarSyncToken(calendarId, workspaceRoot);
  const first = await syncCalendarEvents(accessToken, { calendarId, syncToken: storedToken ?? undefined });
  const result = first.fullResyncRequired ? await restartFullSync(accessToken, calendarId, workspaceRoot) : first;

  const results = await applyWindowToGroup(collections, result.events, workspaceRoot, unpushed);
  if (windowFullyLanded(calendarId, results)) {
    // Gated with the token, for the same reason: a baseline recorded for a window
    // the records never received would make the next push read a local edit where
    // there was only a failed write.
    await saveCalendarShadow(calendarId, shadowUpdates(result.events, allUnpushed(unpushed)), workspaceRoot);
    if (result.nextSyncToken) await advanceToken(calendarId, result.nextSyncToken, collections, workspaceRoot);
  }
  return results;
}

/** Apply one window to every collection on the calendar, honouring what each
 *  one's own push protected. A collection whose protection could not be worked
 *  out is not pulled at all — it reports a retryable error instead, which holds
 *  the token and the baseline back for the whole group. */
async function applyWindowToGroup(
  collections: readonly LoadedCollection[],
  events: readonly CalendarEventSummary[],
  workspaceRoot: string,
  unpushed: UnpushedBySlug,
): Promise<CalendarCollectionSyncResult[]> {
  const results: CalendarCollectionSyncResult[] = [];
  for (const collection of collections) {
    const protection = unpushedFor(unpushed, collection.slug);
    results.push(
      protection === null
        ? { slug: collection.slug, written: 0, removed: 0, unwritable: [], errors: [PROTECTION_UNKNOWN] }
        : await applyEventsToCollection(collection, events, workspaceRoot, protection),
    );
  }
  return results;
}

/** Whether the token and baseline may advance past this window.
 *
 *  Google never resends a window, so advancing past a failed write would lose
 *  those events for good; holding the token back just replays them next run
 *  (writes are idempotent). An `unwritable` event can never succeed, so it does
 *  NOT hold the token — but it is logged loudly, since it will silently never
 *  appear in the collection. */
function windowFullyLanded(calendarId: string | undefined, results: readonly CalendarCollectionSyncResult[]): boolean {
  // Logged per collection, not flattened across the group: a calendar can back
  // several, and "one of them is stuck" is unactionable without the slug — the
  // more so now that `autoPush` runs this unattended (CodeRabbit review #2666).
  results
    .filter((entry) => entry.unwritable.length > 0)
    .forEach((entry) =>
      log.warn("google", "skipping calendar events that can never be stored", { calendarId, slug: entry.slug, unwritable: entry.unwritable }),
    );
  const failed = results.filter((entry) => entry.errors.length > 0);
  failed.forEach((entry) => log.warn("google", "holding back calendar sync token after failed writes", { calendarId, slug: entry.slug, errors: entry.errors }));
  return failed.length === 0;
}

/** The baseline this window establishes: what Google now says per event, and
 *  `null` for a cancelled one so a recreate cannot resume from a dead baseline.
 *
 *  An event whose record the push could not send is left OUT, and that omission
 *  is load-bearing. Advancing its baseline to Google's new value while the record
 *  keeps the local one would make the next push read a plain one-sided edit —
 *  no conflict to detect any more — and quietly overwrite Google. Held back, the
 *  baseline stays older than both sides, so the conflict keeps being reported
 *  until someone resolves it (#2620). */
export function shadowUpdates(events: readonly CalendarEventSummary[], unpushed: ReadonlySet<string> = new Set()): Record<string, ShadowEvent | null> {
  const carried = pullableEvents(events, unpushed);
  return Object.fromEntries(carried.map((event) => [event.id, event.status === CANCELLED_EVENT_STATUS ? null : toShadowEvent(event)]));
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
  unpushed: ReadonlySet<string>,
): Promise<CalendarCollectionSyncResult> {
  const outcomes: ApplyOutcome[] = [];
  for (const event of pullableEvents(events, unpushed)) {
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
