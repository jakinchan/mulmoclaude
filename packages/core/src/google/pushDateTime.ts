// Collection `datetime` value → the Google Calendar event time to push (#2598).
//
// The inverse of `toCollectionDateTime`, which is deliberately LOSSY: it drops
// the RFC3339 zone designator (so the stored clock stays the one the user reads
// off Google, independent of the machine that synced) and flattens an all-day
// `YYYY-MM-DD` into `…T00:00`. Neither the zone nor the all-day-ness survives in
// the stored value, so they cannot be derived from it.
//
// What Google last reported for the event carries both, so a push that has that
// value reuses it. Only a locally-created record has no such history, and it
// falls back to the calendar's own timezone — never the host's, which is the
// machine-dependence `collectionDateTime.ts` exists to avoid.
//
// Pure: no I/O, no clock, no locale.
import { parseIsoDate, parseIsoDateTime } from "../collection/core/calendarGrid.js";
import type { CalendarEventTime } from "./calendar.js";

/** RFC3339 zone designator: `Z`, `+09:00`, `-0500`. */
const ZONE_SUFFIX_RE = /(?:Z|[+-]\d{2}:?\d{2})$/;
const FRACTIONAL_SECONDS_RE = /\.\d+$/;
const TWO_DIGITS_RE = /^\d{2}$/;
const CLOCK_SEPARATOR = ":";
const DATE_TIME_SEPARATOR = "T";
const MIN_CLOCK_SEGMENTS = 2;
const MAX_CLOCK_SEGMENTS = 3;
const WHOLE_MINUTE_SECONDS = "00";
const MAX_SECONDS = 59;

/** Whether `value` is a real calendar day (`2026-02-30` is not).
 *
 *  Delegated to the parser the record lint, the calendar grid and the day view
 *  already share, so the push agrees with the rest of the app on what a valid
 *  stored date IS — and rejects an impossible one here instead of turning it
 *  into an opaque Google 400. */
const isCalendarDate = (value: string): boolean => parseIsoDate(value) !== null;

/** A value Google already accepts verbatim, as the event time to send, or null.
 *
 *  Reached when the schema maps `start` onto a `string` field: `projectValue`
 *  normalises only `datetime` fields, so that column holds Google's own text,
 *  zone and all. The civil part is still validated — matching a trailing `Z` is
 *  not evidence that the rest is a date-time. */
function rawGoogleTime(value: string): CalendarEventTime | null {
  if (isCalendarDate(value)) return { date: value };
  const zone = value.match(ZONE_SUFFIX_RE)?.[0];
  if (zone === undefined) return null;
  // Google may answer fractional seconds, which the shared parser rejects.
  // Validate without them, then send the original — Calendar accepts them.
  const civil = value.slice(0, value.length - zone.length).replace(FRACTIONAL_SECONDS_RE, "");
  return parseIsoDateTime(civil) === null ? null : { dateTime: value };
}

/** Google's own all-day `end` is EXCLUSIVE — a single day on the 12th ends on
 *  the 13th. The pull stores that as `2026-05-13T00:00` and this takes the date
 *  part straight back, so the exclusive end round-trips untouched. Looks
 *  off-by-one; adjusting it would shorten every all-day event by a day. */
function allDayFrom(datePart: string): CalendarEventTime {
  return { date: datePart };
}

/** Split `HH:MM[:SS]` into RFC3339's always-three segments, or null.
 *
 *  Split rather than one regex: expressing the optional seconds as `(?::(\d{2}))?`
 *  nests a quantifier inside a quantified group, which the ReDoS lint rejects. */
function clockSegments(clockPart: string): string | null {
  const segments = clockPart.split(CLOCK_SEPARATOR);
  if (segments.length < MIN_CLOCK_SEGMENTS || segments.length > MAX_CLOCK_SEGMENTS) return null;
  if (!segments.every((segment) => TWO_DIGITS_RE.test(segment))) return null;
  const [hours, minutes, seconds] = segments;
  // `parseIsoDateTime` validated the hours and minutes but ignores seconds.
  if (seconds !== undefined && Number(seconds) > MAX_SECONDS) return null;
  return [hours, minutes, seconds ?? WHOLE_MINUTE_SECONDS].join(CLOCK_SEPARATOR);
}

/** `YYYY-MM-DDTHH:MM[:SS]` → its date and its RFC3339 clock, or null.
 *
 *  Validity comes from the shared strict parser, so an out-of-range clock or an
 *  impossible day is refused here rather than sent to Google. */
function parseStoredDateTime(value: string): { datePart: string; clock: string } | null {
  if (parseIsoDateTime(value) === null) return null;
  const [datePart, clockPart, ...extra] = value.split(DATE_TIME_SEPARATOR);
  if (datePart === undefined || clockPart === undefined || extra.length > 0) return null;
  const clock = clockSegments(clockPart);
  return clock === null ? null : { datePart, clock };
}

/** The zone designator to re-attach, or null when `previous` carries none. */
export function zoneSuffixOf(previous: string | undefined): string | null {
  if (previous === undefined) return null;
  return previous.match(ZONE_SUFFIX_RE)?.[0] ?? null;
}

/** Build the event time to send for one field.
 *
 *  `previous` is the value Google last reported for this event, absent for a
 *  locally-created record. Returns null when `local` is neither a stored
 *  datetime nor a raw Google value — the caller reports that record rather than
 *  letting this invent a time Google would silently accept. */
export function toGoogleEventTime(local: unknown, previous: string | undefined, calendarTimeZone: string): CalendarEventTime | null {
  if (typeof local !== "string") return null;
  const trimmed = local.trim();
  if (trimmed.length === 0) return null;
  const raw = rawGoogleTime(trimmed);
  if (raw !== null) return raw;
  const parts = parseStoredDateTime(trimmed);
  if (parts === null) return null;
  // An all-day event stays all-day even when its date moves: the user edited a
  // date in a collection, not the event's kind.
  if (previous !== undefined && isCalendarDate(previous)) return allDayFrom(parts.datePart);
  const zone = zoneSuffixOf(previous);
  const dateTime = `${parts.datePart}${DATE_TIME_SEPARATOR}${parts.clock}`;
  return zone === null ? { dateTime, timeZone: calendarTimeZone } : { dateTime: `${dateTime}${zone}` };
}
