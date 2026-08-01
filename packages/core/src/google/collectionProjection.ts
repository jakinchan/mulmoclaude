// Google event → collection record. Pure: no I/O, no clock, no workspace.
//
// A leaf on purpose. The pull writes records with it and the push rebuilds its
// baseline with it (`pushPlan.ts`), which is what makes "unchanged" mean exactly
// "the pull would produce this". Leaving it inside the pull would make the push
// import the pull, and the pull now drives the push.
import type { CollectionFieldSpec, CollectionItem } from "../collection/core/schema.js";
import type { GOOGLE_CALENDAR_SOURCE_FIELDS } from "../collection/core/schemaZ.js";
import type { CalendarEventSummary } from "./calendar.js";
import { toCollectionDateTime } from "./collectionDateTime.js";

/** The event fields a schema may map from — narrowed to real keys of
 *  `CalendarEventSummary` so the projection below needs no cast. */
export type GoogleCalendarSourceField = (typeof GOOGLE_CALENDAR_SOURCE_FIELDS)[number];

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
  const mapped = Object.entries(map).map(([field, source]): [string, unknown] => [field, projectValue(fields, field, event[source])]);
  return { ...Object.fromEntries(mapped), [primaryKey]: event.id };
}
