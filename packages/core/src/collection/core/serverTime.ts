// The one shape a server-stamped instant takes, and the codec that keeps it
// that way.
//
// A shared (firestore) collection can pin a field to the SERVER's clock:
// `public.submit.<cid>.stampField` makes the rules require
// `request.resource.data[field] == request.time` on create and freeze it
// afterwards. What is stored is therefore a Firestore `Timestamp`, and that is
// not negotiable — it is what stops somebody writing yesterday into the field
// that decides who was first.
//
// Everything ABOVE the database wants a string. Two reasons, and the second is
// the one that bites:
//
//   1. The collection DSL's `datetime` means a string; the record lint, the
//      table and the calendar all read one.
//   2. A `Timestamp` does not survive the trip to a page. Structured clone
//      (mulmoserver's view channel) drops the CLASS and leaves
//      `{ seconds, nanoseconds }`; JSON (MulmoTerminal's preview, over HTTP,
//      and the headless run) leaves `{ type: "firestore/timestamp/1.0", … }`.
//      `String()` of either is `"[object Object]"`, so a page that sorts by
//      the field — which is exactly what a first-come app does — compares
//      every row equal and falls back to whatever order it was handed. The
//      bundled gym template shipped that sort, and its queue was ordered by
//      document id rather than by time. Nothing errored; the ranks looked
//      plausible.
//
// So the value is normalized ONCE, at the boundary, and the string is the only
// thing anything above ever sees.
//
// THE FORM IS LOAD-BEARING, not cosmetic:
//
//   2026-08-15T01:45:54.605987654Z
//
//   - UTC, `Z`, and nothing else. RFC3339 allows `+09:00`, and two strings
//     with different offsets do not sort in time order — which would give back
//     the bug this module exists to remove.
//   - NINE fractional digits, always. A `Timestamp` carries nanoseconds and
//     Firestore's own order is (seconds, nanoseconds); rounding to
//     milliseconds makes two submissions in the same millisecond compare
//     equal, and same-millisecond is precisely the burst a first-come app is
//     for. Fixed WIDTH matters as much as the precision, for a reason that is
//     easy to get backwards: trimming TRAILING ZEROS is order-preserving
//     (`.605` < `.61` either way), but MIXING widths is not — `…605Z` and
//     `…605987654Z` compare at the fourth fraction character, where `Z` (90)
//     is greater than any digit, so the millisecond value sorts AFTER a
//     nanosecond value it is earlier than or equal to. One width, always.
//   - Lexicographic order is therefore chronological order, which is what lets
//     an author's page sort with a plain string compare and be right.
//
// TIES. Two records can still carry the same instant. The tie-break is the
// DOCUMENT ID, and it comes for free rather than from code here: every read of
// a shared collection is ordered by `__name__` (core's `firestoreDocs.list`
// and mulmoserver's own reader both do it), and `Array.prototype.sort` is
// stable, so equal keys keep that order in every host. Do not "improve" either
// read into a field ordering without replacing this sentence.
//
// Design: mulmoterminal `plans/fix-shared-app-server-time.md` (D2/D3).

/** The canonical instant, exactly: UTC, nine fractional digits, `Z`. */
const CANONICAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}Z$/;

const NANOS_PER_SECOND = 1_000_000_000;
const MILLIS_PER_SECOND = 1000;
const NANOS_PER_MILLI = 1_000_000;

/** What a Firestore `Timestamp` looks like once it is only data. Duck-typed on
 *  purpose: this module is pure and imports no SDK, because it runs where the
 *  class is already gone — a page's payload, a JSON body, a test. */
export interface ServerTimeParts {
  seconds: number;
  nanoseconds: number;
}

const isFiniteInteger = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** Carries the two numbers, whatever else it is. A guard rather than a cast:
 *  what arrives here is genuinely unknown — a page's payload, a JSON body, a
 *  document another client wrote. */
const isTimestampLike = (value: unknown): value is ServerTimeParts => isRecord(value) && isFiniteInteger(value.seconds) && isFiniteInteger(value.nanoseconds);

/** Is this the canonical form? Used by the record lint, so it must not accept
 *  anything a plain string compare would order wrongly. */
export const isCanonicalServerTime = (value: unknown): value is string => typeof value === "string" && CANONICAL_RE.test(value);

/** The canonical string for a (seconds, nanoseconds) pair, or null when the
 *  pair is not a real instant.
 *
 *  Built from the SECONDS through `Date` and the nanoseconds as text, never by
 *  turning nanoseconds into a float — `605987654 / 1e9` cannot be represented
 *  exactly, and a rounding error here is a rank in the wrong place. */
export function serverTimeOf(parts: ServerTimeParts): string | null {
  const { seconds, nanoseconds } = parts;
  if (!isFiniteInteger(seconds) || !isFiniteInteger(nanoseconds)) return null;
  if (nanoseconds < 0 || nanoseconds >= NANOS_PER_SECOND) return null;
  const whole = new Date(seconds * MILLIS_PER_SECOND);
  if (Number.isNaN(whole.getTime())) return null;
  return `${whole.toISOString().slice(0, 19)}.${String(nanoseconds).padStart(9, "0")}Z`;
}

/** A stored server time in any of the shapes it reaches us in, as the
 *  canonical string — or null when the value is not one at all.
 *
 *  The three shapes are the three trips a `Timestamp` can make: still an SDK
 *  instance (a host reading Firestore directly), structured-cloned (a page's
 *  payload), or JSON (`Timestamp.toJSON`, which tags itself). All three carry
 *  `seconds` and `nanoseconds`; the tag is not required, because the clone
 *  drops it. */
export function decodeServerTime(value: unknown): string | null {
  if (!isTimestampLike(value)) return null;
  return serverTimeOf(value);
}

/** The inverse: the parts a canonical string stands for, or null for anything
 *  else.
 *
 *  This is what closes the write-back hole. A record is read (decoded), edited,
 *  and written back WHOLE — `putItems`' upsert replaces the document — so
 *  without an encode the stamp would go back as a string. The rules freeze that
 *  field by comparing `diff().affectedKeys()`, so the write is refused and the
 *  record can never be updated again. Dropping the field instead does not help:
 *  a removed key is an affected key too.
 *
 *  Deliberately narrow. Only the EXACT canonical form is encoded, and that form
 *  is only ever produced by `decodeServerTime` — a human or an agent authoring
 *  a `datetime` writes the civil shape, which passes through as the string it
 *  is. So the codec is closed over its own output and cannot re-type somebody
 *  else's data. */
export function encodeServerTime(value: unknown): ServerTimeParts | null {
  if (!isCanonicalServerTime(value)) return null;
  const millis = Date.parse(`${value.slice(0, 19)}Z`);
  if (Number.isNaN(millis)) return null;
  const nanoseconds = Number(value.slice(20, 29));
  return { seconds: Math.floor(millis / MILLIS_PER_SECOND), nanoseconds };
}

/** Epoch milliseconds for a canonical instant, for the places that can only
 *  hold a number (a sort key, a civil placement). LOSSY below the millisecond
 *  and knowingly so: whoever needs the full order compares the strings. */
export function serverTimeMillis(value: unknown): number | null {
  const parts = encodeServerTime(value);
  if (parts === null) return null;
  return parts.seconds * MILLIS_PER_SECOND + Math.floor(parts.nanoseconds / NANOS_PER_MILLI);
}

/** Every canonical instant in a record, replaced by its string; everything else
 *  untouched. One level deep, which is where a stamped field lives — a `table`
 *  row cannot hold one, because nothing writes a server time into an array. */
export function decodeRecordTimes(record: Record<string, unknown>): Record<string, unknown> {
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const decoded = decodeServerTime(value);
    if (decoded !== null) changed = true;
    out[key] = decoded ?? value;
  }
  // The SAME object when nothing was stamped, so a reference comparison
  // upstream keeps meaning what it meant.
  return changed ? out : record;
}
