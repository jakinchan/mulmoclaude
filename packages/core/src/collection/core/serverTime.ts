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

/** Is this the canonical form, and a real instant?
 *
 *  The shape check alone is not enough, and the gap is not theoretical: with it,
 *  `2026-02-30T00:00:00.000000000Z` passes, the record lint reports nothing, and
 *  `Date.parse` then normalises it to March 2 — so a write/read round trip
 *  silently moves the value. The round trip below is the check: a string is
 *  canonical only when re-formatting what it parses to gives it back. */
export const isCanonicalServerTime = (value: unknown): value is string => {
  if (typeof value !== "string" || !CANONICAL_RE.test(value)) return false;
  // Firestore's own range starts at 0001-01-01; the four digits above already
  // bound the other end. Year zero parses in JS and would only fail later, when
  // the SDK is handed it — an exception at the write instead of a refusal here.
  if (value.startsWith("0000-")) return false;
  const millis = Date.parse(`${value.slice(0, 19)}Z`);
  if (Number.isNaN(millis)) return false;
  return new Date(millis).toISOString().slice(0, 19) === value.slice(0, 19);
};

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
  const formatted = `${whole.toISOString().slice(0, 19)}.${String(nanoseconds).padStart(9, "0")}Z`;
  // A year outside the four-digit range formats as `+275760-…`, which is not
  // this form. Checked rather than assumed, because a caller that stored the
  // result would be storing something nothing downstream recognises.
  return isCanonicalServerTime(formatted) ? formatted : null;
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

/** The only part of a schema this codec reads.
 *
 *  Structural rather than `CollectionSchema`, because the OTHER host has its own
 *  type for the same document (mulmoserver reads these records without going
 *  through this package's store) and neither side should have to adopt the
 *  other's declaration to call one function. */
export interface DeclaredFields {
  fields: Record<string, { type: string } | undefined>;
}

/** Which fields of a record may hold an instant: the ones the SCHEMA calls
 *  `datetime`, and no others.
 *
 *  DECLARATION, not shape. Recognising `{ seconds, nanoseconds }` wherever it
 *  appears would rewrite an ordinary value that happens to have those two keys
 *  — a duration, an offset, somebody's own metadata — into a datetime string,
 *  and then into a Firestore timestamp on the next whole-record write. Records
 *  are allowed to carry keys the schema never mentions, so that is live user
 *  data being re-typed on a guess. The same argument runs the other way on the
 *  write: a `string` field whose value happens to look canonical must stay a
 *  string.
 *
 *  A `datetime` field is the one place where both readings mean the same
 *  thing, which is what makes this scope the honest one.
 *
 *  WHY NOT NARROWER STILL — scoped to the app's `stampField`, the one field the
 *  rules pin. It was asked for, and it is not reachable from here: that name
 *  lives in `app.json` under `public.submit.<cid>`, which core reads only for
 *  `aid` (see `../server/appManifest`, "SCOPE") and which is the AUTHORED file
 *  rather than the published document the rules actually read. Getting it would
 *  mean a file read per write and crossing a boundary that module states
 *  deliberately.
 *
 *  And the narrower scope buys less than it looks. Within this backend a
 *  `datetime` field's canonical instant has ONE storage form — a timestamp —
 *  and the pair above is exact, so the value re-reads as the identical string
 *  for every reader. What changes for a non-stamped field is the stored TYPE,
 *  which matters only to a rule comparing it as a string; the rules that touch
 *  a datetime compare it to `request.time`, which is the stamped case and needs
 *  the timestamp. A field that must stay a string is declared `string`. */
const isDateTimeField = (schema: DeclaredFields, key: string): boolean => schema.fields[key]?.type === "datetime";

/** Every stored instant in a `datetime` field, as its canonical string; every
 *  other value untouched. One level deep, which is where a stamped field
 *  lives — the rules stamp a top-level key and nothing writes a server time
 *  into a table row. */
export function decodeRecordTimes(record: Record<string, unknown>, schema: DeclaredFields): Record<string, unknown> {
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const decoded = isDateTimeField(schema, key) ? decodeServerTime(value) : null;
    if (decoded !== null) changed = true;
    out[key] = decoded ?? value;
  }
  // The SAME object when nothing was stamped, so a reference comparison
  // upstream keeps meaning what it meant.
  return changed ? out : record;
}

/** The write half. `toStored` builds whatever the backend wants for an instant
 *  — a Firestore `Timestamp` — and is injected so this module stays free of the
 *  SDK: it also runs in a browser, where importing that would be a bundle. */
export function encodeRecordTimes(
  record: Record<string, unknown>,
  schema: DeclaredFields,
  toStored: (parts: ServerTimeParts) => unknown,
): Record<string, unknown> {
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const parts = isDateTimeField(schema, key) ? encodeServerTime(value) : null;
    if (parts !== null) changed = true;
    out[key] = parts === null ? value : toStored(parts);
  }
  return changed ? out : record;
}
