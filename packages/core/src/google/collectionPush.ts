// Collection → Google Calendar push, on demand (#2598).
//
// The mirror of `collectionSync.ts`, and deliberately NOT its automatic twin:
// this runs only when the user clicks, because a push writes to a calendar other
// people may be reading. v1 creates and updates; it never deletes (a Google
// delete removes the event for every attendee and cannot be undone).
//
// Both directions share `withCalendarLock`, so a push can never interleave with
// the pull whose baseline it depends on.
import { discoverCollections } from "../collection/server/discovery.js";
import type { LoadedCollection } from "../collection/server/discoveredCollection.js";
import { storeFor } from "../collection/server/store.js";
import type { CollectionFieldSpec, CollectionItem } from "../collection/core/schema.js";
import { getGoogleAccessToken } from "./auth.js";
import { isGoogleApiError, HTTP_FORBIDDEN } from "./apiClient.js";
import {
  canonicalCalendarId,
  createCalendarEvent,
  getCalendar,
  getCalendarEvent,
  listCalendars,
  updateCalendarEvent,
  CANCELLED_EVENT_STATUS,
  HTTP_CONFLICT,
  HTTP_PRECONDITION_FAILED,
  type CalendarEventSummary,
  type CalendarEventTime,
  type UpdateCalendarEventInput,
} from "./calendar.js";
import { loadCalendarShadow, saveCalendarShadow, toShadowEvent, type ShadowEvent } from "./calendarPushState.js";
import { withCalendarLock } from "./collectionSync.js";
import { toGoogleEventTime } from "./pushDateTime.js";
import {
  bySourceField,
  conflictingFields,
  fieldText,
  isClientSettableEventId,
  locallyDeletedIds,
  mayAdoptExisting,
  planRecord,
  pushableMap,
  type PushableSourceField,
} from "./pushPlan.js";
import { loadGoogleTokens } from "./tokenStore.js";
import { log } from "./host.js";

/** Access roles that may write events. `reader` / `freeBusyReader` cannot, and a
 *  push under them fails per event with an opaque 403 — checked once up front so
 *  the user is told the real reason. */
const WRITABLE_ACCESS_ROLES: readonly string[] = ["owner", "writer"];

/** What the up-front writability gate knows about the target calendar. */
export interface CalendarWriteTarget {
  /** The role from the user's calendar LIST, or null when the calendar is not in
   *  it. Null means unknown, never read-only: `calendarList` holds only the
   *  calendars the user has added, so one shared with write access can be absent
   *  from it (Codex review). */
  accessRole: string | null;
  /** IANA zone for rebuilding a zone-less stored clock, `""` when unreported. */
  timeZone: string;
}

/** Whether to refuse the whole push before touching a single event.
 *
 *  Only on POSITIVE evidence of a non-writable role. An unlisted calendar is
 *  unknown and must fall through: hard-denying it would block the feature
 *  outright for a calendar the user can in fact write to. Those attempts surface
 *  Google's own 403 per record if the write really is not allowed. */
export const isDeniedAccessRole = (accessRole: string | null): boolean => accessRole !== null && !WRITABLE_ACCESS_ROLES.includes(accessRole);

export interface CalendarCollectionPushResult {
  slug: string;
  created: number;
  updated: number;
  /** Edited on both sides; skipped so neither version is destroyed. */
  conflicts: number;
  /** Records deleted locally. Reported only — v1 never deletes in Google. */
  localDeletes: number;
  /** Records that cannot be pushed as they stand, each with the reason. */
  skipped: string[];
  errors: string[];
}

export type CalendarPushOutcome =
  | { kind: "pushed"; result: CalendarCollectionPushResult }
  | { kind: "not-a-calendar" }
  | { kind: "not-linked" }
  | { kind: "read-only"; accessRole: string }
  /** The push never got as far as a record: a revoked grant, an unreachable
   *  Calendar API, a workspace read failure. Typed rather than left to throw so
   *  the route answers in the same shape as the other setup problems instead of
   *  an opaque 500. */
  | { kind: "failed"; message: string };

/** The I/O a push crosses, injected so every outcome can be exercised with fakes
 *  instead of a workspace on disk and a live Google grant. */
export interface CalendarPushDeps {
  findCollection: (slug: string, workspaceRoot: string) => Promise<LoadedCollection | null>;
  isLinked: () => Promise<boolean>;
  accessToken: () => Promise<string>;
  calendarMeta: (accessToken: string, calendarId: string | undefined) => Promise<CalendarWriteTarget>;
}

/** Resolve the calendar a schema names, for its writability and its timezone.
 *
 *  The list is consulted first because only it reports `accessRole`, which is
 *  what lets a read-only calendar be refused with the real reason instead of an
 *  opaque per-event 403. `"primary"` is matched on the `primary` flag, not the
 *  id — the primary calendar's own id is the account's email address, which never
 *  equals the literal the schema declares.
 *
 *  A calendar absent from the list is NOT denied: it is fetched by id for its
 *  timezone and its role left unknown. A 404 there means the calendar really is
 *  unreachable, and propagates as a `failed` outcome. */
async function liveCalendarMeta(accessToken: string, calendarId: string | undefined): Promise<CalendarWriteTarget> {
  const key = canonicalCalendarId(calendarId);
  const calendars = await listCalendars(accessToken);
  const listed = key === "primary" ? calendars.find((calendar) => calendar.primary) : calendars.find((calendar) => calendar.id === key);
  if (listed) return { accessRole: listed.accessRole, timeZone: listed.timeZone };
  const direct = await getCalendar(accessToken, calendarId);
  log.info("google", "calendar is not in the user's list — pushing without an up-front role check", { calendarId: key });
  return { accessRole: null, timeZone: direct.timeZone };
}

async function findCalendarCollection(slug: string, workspaceRoot: string): Promise<LoadedCollection | null> {
  const all = await discoverCollections({ workspaceRoot });
  return all.find((collection) => collection.slug === slug && collection.schema.googleCalendar) ?? null;
}

const liveDeps: CalendarPushDeps = {
  findCollection: findCalendarCollection,
  isLinked: async () => Boolean((await loadGoogleTokens())?.refresh_token),
  accessToken: getGoogleAccessToken,
  calendarMeta: liveCalendarMeta,
};

/** Everything one record's push needs, resolved once for the whole run. */
interface PushContext {
  accessToken: string;
  calendarId: string | undefined;
  /** The calendar's IANA zone, `""` when Google did not report one. */
  timeZone: string;
  map: Record<string, PushableSourceField>;
  bySource: Partial<Record<PushableSourceField, string>>;
  primaryKey: string;
  fields: Record<string, CollectionFieldSpec>;
  shadow: Record<string, ShadowEvent>;
}

type PushOutcome =
  | { kind: "created"; event: CalendarEventSummary }
  | { kind: "updated"; event: CalendarEventSummary }
  | { kind: "conflict" }
  /** `event` present only when this record's baseline had to be repaired (an
   *  event that already existed in Google), so the write path can persist it. */
  | { kind: "unchanged"; event?: CalendarEventSummary }
  | { kind: "skipped"; message: string }
  | { kind: "error"; message: string };

const localValue = (ctx: PushContext, record: CollectionItem, source: PushableSourceField): unknown => {
  const field = ctx.bySource[source];
  return field === undefined ? undefined : record[field];
};

type TimeResult = { ok: true; time: CalendarEventTime } | { ok: false; reason: string };

/** One end of the span, rebuilt from the stored clock plus whatever the baseline
 *  remembers about the original (zone, all-day). */
function eventTime(ctx: PushContext, record: CollectionItem, source: "start" | "end", previous: string | undefined): TimeResult {
  const value = localValue(ctx, record, source);
  if (value === undefined) return { ok: false, reason: `no \`${source}\` field is mapped` };
  const time = toGoogleEventTime(value, previous, ctx.timeZone);
  if (time === null) return { ok: false, reason: `\`${source}\` is not a date-time Google accepts (got ${JSON.stringify(value)})` };
  // A zone-less dateTime needs `timeZone`; without one Google answers an opaque 400.
  if ("dateTime" in time && time.timeZone === "") return { ok: false, reason: `the calendar reports no timezone, so \`${source}\` cannot be sent without one` };
  return { ok: true, time };
}

async function createFromRecord(ctx: PushContext, eventId: string, record: CollectionItem): Promise<PushOutcome> {
  if (!isClientSettableEventId(eventId)) {
    return { kind: "skipped", message: `${eventId}: the record id cannot be used as a Google event id (needs 5-1024 characters from 0-9a-v)` };
  }
  const start = eventTime(ctx, record, "start", undefined);
  const end = eventTime(ctx, record, "end", undefined);
  if (!start.ok) return { kind: "skipped", message: `${eventId}: ${start.reason}` };
  if (!end.ok) return { kind: "skipped", message: `${eventId}: ${end.reason}` };
  const colorId = fieldText(localValue(ctx, record, "colorId"));
  const event = await createCalendarEvent(ctx.accessToken, {
    eventId,
    calendarId: ctx.calendarId,
    summary: fieldText(localValue(ctx, record, "summary")),
    start: start.time,
    end: end.time,
    ...(colorId ? { colorId } : {}),
  });
  return { kind: "created", event };
}

type EventPatch = Pick<UpdateCalendarEventInput, "summary" | "colorId" | "start" | "end">;
type PatchResult = { ok: true; patch: EventPatch } | { ok: false; reason: string };

/** Only the fields the local edit touched — PATCH semantics, so an untouched
 *  attendee list / recurrence rule is left alone. */
function buildPatch(ctx: PushContext, record: CollectionItem, changed: readonly PushableSourceField[], shadow: ShadowEvent): PatchResult {
  const resolved = (["start", "end"] as const)
    .filter((source) => changed.includes(source))
    .map((source) => ({ source, result: eventTime(ctx, record, source, shadow[source]) }));
  const [failure] = resolved.flatMap((entry) => (entry.result.ok ? [] : [entry.result.reason]));
  if (failure !== undefined) return { ok: false, reason: failure };
  const colorId = fieldText(localValue(ctx, record, "colorId"));
  // Calendar rejects "" as a palette id, so a cleared colour cannot be sent.
  // Reported rather than dropped: a silently dropped field leaves the record
  // looking edited forever, re-pushing it on every click.
  if (changed.includes("colorId") && colorId === "") return { ok: false, reason: "Google cannot clear an event colour once set" };
  return {
    ok: true,
    patch: {
      ...(changed.includes("summary") ? { summary: fieldText(localValue(ctx, record, "summary")) } : {}),
      ...(changed.includes("colorId") ? { colorId } : {}),
      ...Object.fromEntries(resolved.flatMap((entry) => (entry.result.ok ? [[entry.source, entry.result.time]] : []))),
    },
  };
}

async function updateFromRecord(
  ctx: PushContext,
  eventId: string,
  record: CollectionItem,
  changed: readonly PushableSourceField[],
  shadow: ShadowEvent,
): Promise<PushOutcome> {
  const fetched = await getCalendarEvent(ctx.accessToken, { calendarId: ctx.calendarId, eventId });
  if (fetched === null || fetched.event.status === CANCELLED_EVENT_STATUS) {
    return { kind: "skipped", message: `${eventId}: the event no longer exists in Google — sync first, then re-create it` };
  }
  if (conflictingFields(shadow, toShadowEvent(fetched.event), changed).length > 0) return { kind: "conflict" };
  const built = buildPatch(ctx, record, changed, shadow);
  if (!built.ok) return { kind: "skipped", message: `${eventId}: ${built.reason}` };
  try {
    // `If-Match` closes the window between the read above and this write: without
    // it a change landing in between is silently overwritten, which is exactly
    // what the conflict check exists to prevent.
    const event = await updateCalendarEvent(ctx.accessToken, { eventId, calendarId: ctx.calendarId, ifMatch: fetched.etag, ...built.patch });
    return { kind: "updated", event };
  } catch (error) {
    if (isGoogleApiError(error) && error.status === HTTP_PRECONDITION_FAILED) return { kind: "conflict" };
    throw error;
  }
}

/** Create, recovering from the one 409 that is provably safe to recover from.
 *
 *  A 409 means the id is taken, which is USUALLY a previous push whose baseline
 *  never landed. It can also be an unrelated event that happens to hold this id,
 *  so the recovery never writes: it adopts the baseline only when the remote
 *  event already equals what this record would write, and otherwise reports the
 *  fix. Patching whatever answered the 409 would let a push modify a stranger's
 *  event (Codex review).
 *
 *  Refusal is not a dead end — a Sync writes both the record and its baseline,
 *  after which the record pushes normally. */
async function createOrAdopt(ctx: PushContext, eventId: string, record: CollectionItem): Promise<PushOutcome> {
  try {
    return await createFromRecord(ctx, eventId, record);
  } catch (error) {
    if (!isGoogleApiError(error) || error.status !== HTTP_CONFLICT) throw error;
    const fetched = await getCalendarEvent(ctx.accessToken, { calendarId: ctx.calendarId, eventId });
    if (fetched === null) throw error;
    if (mayAdoptExisting(eventId, record, toShadowEvent(fetched.event), ctx.map, ctx.primaryKey, ctx.fields)) {
      return { kind: "unchanged", event: fetched.event };
    }
    return {
      kind: "skipped",
      message: `${eventId}: an event with this id already exists in Google and differs from this record — press Sync to adopt it, then push again`,
    };
  }
}

/** A 403 on a write is a permissions answer, but `googleApiError` appends the
 *  "is the API enabled for the Cloud project?" hint to every 403 — true for a
 *  disabled API, misleading here. Reached when the up-front role check could not
 *  run because the calendar is not in the user's list, which is exactly when the
 *  user needs the real reason. */
function writeFailure(eventId: string, error: unknown): PushOutcome {
  if (isGoogleApiError(error) && error.status === HTTP_FORBIDDEN) {
    return { kind: "skipped", message: `${eventId}: Google refused the write — you may not have permission to change events on this calendar` };
  }
  return { kind: "error", message: `${eventId}: ${String(error)}` };
}

async function pushRecord(ctx: PushContext, eventId: string, record: CollectionItem): Promise<PushOutcome> {
  try {
    const shadow = ctx.shadow[eventId];
    const plan = planRecord(eventId, record, shadow, ctx.map, ctx.primaryKey, ctx.fields);
    if (plan.kind === "unchanged") return { kind: "unchanged" };
    if (plan.kind === "create" || shadow === undefined) return await createOrAdopt(ctx, eventId, record);
    return await updateFromRecord(ctx, eventId, record, plan.fields, shadow);
  } catch (error) {
    // One rejected event must not abandon the rest of the collection.
    return writeFailure(eventId, error);
  }
}

/** The baseline an outcome establishes, so the next push sees the record as
 *  unchanged instead of pushing it again. Empty for anything that wrote nothing
 *  and had no baseline to repair. */
function pushedShadow(outcomes: readonly PushOutcome[]): Record<string, ShadowEvent> {
  const written = outcomes.flatMap((outcome) => ("event" in outcome && outcome.event !== undefined ? [outcome.event] : []));
  return Object.fromEntries(written.map((event) => [event.id, toShadowEvent(event)]));
}

function tally(slug: string, outcomes: readonly PushOutcome[], localDeletes: number): CalendarCollectionPushResult {
  const count = (kind: PushOutcome["kind"]): number => outcomes.filter((outcome) => outcome.kind === kind).length;
  return {
    slug,
    created: count("created"),
    updated: count("updated"),
    conflicts: count("conflict"),
    localDeletes,
    skipped: outcomes.flatMap((outcome) => (outcome.kind === "skipped" ? [outcome.message] : [])),
    errors: outcomes.flatMap((outcome) => (outcome.kind === "error" ? [outcome.message] : [])),
  };
}

async function pushNow(collection: LoadedCollection, workspaceRoot: string, deps: CalendarPushDeps): Promise<CalendarPushOutcome> {
  const { schema, slug } = collection;
  const calendarId = schema.googleCalendar?.calendarId;
  const accessToken = await deps.accessToken();
  const meta = await deps.calendarMeta(accessToken, calendarId);
  if (isDeniedAccessRole(meta.accessRole)) return { kind: "read-only", accessRole: meta.accessRole ?? "" };

  const map = pushableMap(schema.googleCalendar?.map ?? {});
  const shadow = await loadCalendarShadow(calendarId, workspaceRoot);
  const records = await storeFor(collection, { workspaceRoot }).list();
  const ctx: PushContext = {
    accessToken,
    calendarId,
    timeZone: meta.timeZone,
    map,
    bySource: bySourceField(map),
    primaryKey: schema.primaryKey,
    fields: schema.fields,
    shadow,
  };

  const outcomes: PushOutcome[] = [];
  for (const record of records) {
    const outcome = await pushRecord(ctx, fieldText(record[schema.primaryKey]), record);
    outcomes.push(outcome);
    // Persisted per record, not once at the end: an interruption after a
    // successful write would otherwise leave that event with no baseline, and
    // the next push would retry it as a create and hit Google's duplicate-id
    // 409. Costs nothing for a record that wrote nothing (empty batch).
    await saveCalendarShadow(calendarId, pushedShadow([outcome]), workspaceRoot);
  }
  const deletes = locallyDeletedIds(
    shadow,
    records.map((record) => fieldText(record[schema.primaryKey])),
  );
  const result = tally(slug, outcomes, deletes.length);
  if (result.errors.length > 0) log.warn("google", "calendar push finished with errors", { slug, errors: result.errors.length });
  return { kind: "pushed", result };
}

/** Push ONE collection's records to the calendar it declares.
 *
 *  "Does this collection sync at all" is answered before "is Google linked", for
 *  the reason `syncCalendarForCollection` gives: telling someone to link their
 *  account for a collection that never declared a calendar sends them fixing the
 *  wrong thing. */
export async function pushCalendarForCollection(slug: string, workspaceRoot: string, deps: CalendarPushDeps = liveDeps): Promise<CalendarPushOutcome> {
  try {
    const collection = await deps.findCollection(slug, workspaceRoot);
    if (collection === null) return { kind: "not-a-calendar" };
    if (!(await deps.isLinked())) return { kind: "not-linked" };
    return await withCalendarLock(collection.schema.googleCalendar?.calendarId, () => pushNow(collection, workspaceRoot, deps));
  } catch (error) {
    // A throw here is a setup failure (revoked grant, Calendar API unreachable,
    // unreadable workspace), not a per-record one. Reported in the same typed
    // shape as the other setup problems so the route need not guess.
    log.warn("google", "calendar push could not start", { slug, error: String(error) });
    return { kind: "failed", message: String(error) };
  }
}
