// Deciding what a Collection → Google push should do to each record (#2598).
//
// Pure: the whole diff rule is expressed against three plain values — the local
// record, the baseline Google last reported (`calendarPushState.ts`), and
// Google's value right now — so it is testable without a workspace or a grant.
import type { CollectionFieldSpec, CollectionItem } from "../collection/core/schema.js";
import type { CalendarEventSummary } from "./calendar.js";
import type { ShadowEvent } from "./calendarPushState.js";
import { toCollectionRecord } from "./collectionSync.js";

/** The event fields Google lets a caller write. `htmlLink` and `status` are
 *  read-only, so a record column mapped to either is ignored here rather than
 *  rejected — the mapping was authored for the pull, and a push has no business
 *  invalidating it. */
export const PUSHABLE_SOURCE_FIELDS = ["summary", "start", "end", "colorId"] as const;

export type PushableSourceField = (typeof PUSHABLE_SOURCE_FIELDS)[number];

const isPushableSource = (source: string): source is PushableSourceField => (PUSHABLE_SOURCE_FIELDS as readonly string[]).includes(source);

/** The subset of a schema's `map` a push can act on: collection field → event field. */
export function pushableMap(map: Record<string, string>): Record<string, PushableSourceField> {
  return Object.fromEntries(Object.entries(map).filter((entry): entry is [string, PushableSourceField] => isPushableSource(entry[1])));
}

/** Event field → the record column feeding it. The schema authors the map the
 *  other way round (for the pull); a push looks up by event field. Two columns
 *  mapped to one event field is already ambiguous for the pull — last wins. */
export function bySourceField(map: Record<string, PushableSourceField>): Partial<Record<PushableSourceField, string>> {
  return Object.fromEntries(Object.entries(map).map(([field, source]) => [source, field]));
}

/** Google accepts a caller-chosen event id of 5-1024 base32hex characters. A
 *  record id outside that (a semantic id like `team-standup`) cannot be used,
 *  and v1 reports it instead of re-keying the record — see the plan. */
const CLIENT_EVENT_ID_RE = /^[0-9a-v]{5,1024}$/;

export const isClientSettableEventId = (eventId: string): boolean => CLIENT_EVENT_ID_RE.test(eventId);

/** A field's value as comparable/sendable text.
 *
 *  Absent, null and `""` all collapse to `""`: Google reports an inherited colour
 *  as `""` while the record file may omit the key entirely, and treating those as
 *  different would report a local edit on every single push.
 *
 *  A non-primitive is JSON-encoded rather than left to `String`, whose
 *  `[object Object]` would make two DIFFERENT objects compare equal — a
 *  silently-skipped edit. */
export const fieldText = (value: unknown): string => {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  // `JSON.stringify` answers undefined for a function or symbol — neither is a
  // field value any schema produces, and "" keeps them comparing as absent.
  return JSON.stringify(value) ?? "";
};

/** A stored datetime with no seconds — what the collection's own date-time input
 *  produces. Google's values always carry seconds, so the pull writes them and a
 *  hand-typed value does not. */
const SECONDLESS_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const WHOLE_MINUTE = ":00";

/** Field text with `…T09:30` and `…T09:30:00` collapsed to one spelling.
 *
 *  Without this, a record the user typed a time into never stops looking edited:
 *  the push writes it, Google answers with seconds, the baseline projection keeps
 *  them, and the seconds-less record then differs from its own baseline on every
 *  later push — re-PATCHing the same event on every click, forever.
 *
 *  A value that carries a zone offset (a `start` mapped onto a `string` field) is
 *  left alone: it is Google's own text on both sides already. */
const comparableText = (value: unknown): string => {
  const text = fieldText(value);
  return SECONDLESS_DATETIME_RE.test(text) ? `${text}${WHOLE_MINUTE}` : text;
};

/** A baseline shaped as the event it came from, so the comparison can run
 *  through the very projection that wrote the record. `htmlLink`/`status` are
 *  never pushable, so their absence from the baseline cannot matter. */
const asEventSummary = (eventId: string, shadow: ShadowEvent): CalendarEventSummary => ({ id: eventId, htmlLink: "", status: "", ...shadow });

/** What the record WOULD hold if nobody had edited it since the baseline.
 *
 *  Deliberately `toCollectionRecord` — the same function the pull writes with —
 *  so "unchanged" here means exactly "the pull would produce this". A private
 *  re-implementation would drift from it and report phantom edits. */
export function baselineRecord(
  eventId: string,
  shadow: ShadowEvent,
  map: Record<string, PushableSourceField>,
  primaryKey: string,
  fields: Record<string, CollectionFieldSpec>,
): CollectionItem {
  return toCollectionRecord(asEventSummary(eventId, shadow), map, primaryKey, fields);
}

/** The mapped fields whose local value no longer matches the baseline. */
export function locallyChangedFields(record: CollectionItem, baseline: CollectionItem, map: Record<string, PushableSourceField>): PushableSourceField[] {
  return Object.entries(map)
    .filter(([field]) => comparableText(record[field]) !== comparableText(baseline[field]))
    .map(([, source]) => source);
}

/** The fields Google changed since the baseline, restricted to the ones the
 *  local edit touches.
 *
 *  Field-level on purpose: Google moving an event the user retitled locally is
 *  not a conflict, because the patch only carries the title. Comparing whole
 *  events would refuse those pushes for no reason. */
export function conflictingFields(shadow: ShadowEvent, current: ShadowEvent, changed: readonly PushableSourceField[]): PushableSourceField[] {
  return changed.filter((source) => comparableText(shadow[source]) !== comparableText(current[source]));
}

export type RecordPlan =
  | { kind: "create" }
  | { kind: "unchanged" }
  /** Locally edited; `fields` is what to PATCH, pending the conflict check. */
  | { kind: "changed"; fields: PushableSourceField[] };

/** Classify one record against its baseline, before Google is consulted.
 *
 *  No baseline means the record never came from a sync, so it is local-only and
 *  has to be created. Google is queried ONLY for a `changed` record, which is
 *  what keeps a push over a large collection cheap. */
export function planRecord(
  eventId: string,
  record: CollectionItem,
  shadow: ShadowEvent | undefined,
  map: Record<string, PushableSourceField>,
  primaryKey: string,
  fields: Record<string, CollectionFieldSpec>,
): RecordPlan {
  if (shadow === undefined) return { kind: "create" };
  const changed = locallyChangedFields(record, baselineRecord(eventId, shadow, map, primaryKey, fields), map);
  return changed.length === 0 ? { kind: "unchanged" } : { kind: "changed", fields: changed };
}

/** Record ids the baseline knows but the collection no longer holds — deleted
 *  locally. v1 reports the count and pushes nothing: `calendarDeleteEvent`
 *  removes the event for every attendee and cannot be undone. */
export function locallyDeletedIds(shadow: Record<string, ShadowEvent>, presentIds: readonly string[]): string[] {
  const present = new Set(presentIds);
  return Object.keys(shadow).filter((eventId) => !present.has(eventId));
}
