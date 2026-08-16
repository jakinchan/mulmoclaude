// The server-time codec: what a shared collection's stamped field becomes above
// the database, and why the exact form matters.
//
// The bug these pin is not a crash. A Firestore `Timestamp` does not survive
// the trip to a page — structured clone drops the class, JSON tags it — and
// `String()` of what arrives is `"[object Object]"`, so a page sorting by the
// field compares every row equal and keeps whatever order it was handed. The
// bundled first-come template shipped exactly that sort, and its queue was
// ordered by document id. Nothing errored.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  decodeRecordTimes,
  decodeServerTime,
  encodeServerTime,
  isCanonicalServerTime,
  serverTimeMillis,
  serverTimeOf,
} from "../../src/collection/core/serverTime.ts";
import { dateOf } from "../../src/collection/core/calendarGrid.ts";
import { recordFieldProblem } from "../../src/collection/core/recordZ.ts";

// The instant observed in a real app, and one 987654 nanoseconds later inside
// the SAME millisecond — the pair that a millisecond-precision form collapses.
const SECONDS = 1786835154;
const EARLY = { seconds: SECONDS, nanoseconds: 605000000 };
const SAME_MS = { seconds: SECONDS, nanoseconds: 605987654 };
const LATER = { seconds: SECONDS + 6, nanoseconds: 0 };

test("the canonical form is UTC, nine digits, Z", () => {
  assert.equal(serverTimeOf(EARLY), "2026-08-15T23:05:54.605000000Z");
  assert.equal(serverTimeOf(SAME_MS), "2026-08-15T23:05:54.605987654Z");
  assert.ok(isCanonicalServerTime(serverTimeOf(EARLY)));
});

test("two instants in the same millisecond stay distinguishable, and sort", () => {
  const early = serverTimeOf(EARLY) ?? "";
  const sameMs = serverTimeOf(SAME_MS) ?? "";
  assert.notEqual(early, sameMs);
  // A plain string compare — what an author's page writes — is chronological.
  assert.ok(early < sameMs);
  assert.ok(sameMs < (serverTimeOf(LATER) ?? ""));
  // And the millisecond form, which is what a `Date`/`toISOString()` round trip
  // gives, does NOT: this is the reason for the nine digits.
  assert.equal(new Date(serverTimeMillis(early) ?? 0).toISOString(), new Date(serverTimeMillis(sameMs) ?? 0).toISOString());
});

test("one width, always — a mixed-precision producer sorts wrongly", () => {
  const nanos = serverTimeOf(SAME_MS) ?? "";
  // The same instant truncated to milliseconds, which is what a `Date` /
  // `toISOString()` round trip produces if anyone reaches for one.
  const millis = `${nanos.slice(0, 23)}Z`;
  assert.equal(millis, "2026-08-15T23:05:54.605Z");
  // It names an instant earlier than (or equal to) `nanos`, and it sorts AFTER
  // it: the compare reaches `Z` where the other has a digit, and `Z` is
  // greater. Trimming trailing zeros would be harmless; mixing widths is not.
  assert.ok(millis > nanos);
  assert.ok(Date.parse(millis) <= Date.parse(nanos));
  // Which is why nothing above the boundary ever sees anything else.
  assert.equal(isCanonicalServerTime(millis), false);
});

test("decodes all three shapes one value can arrive in", () => {
  const canonical = serverTimeOf(EARLY);
  // 1. Still an SDK instance (a host reading Firestore in-process). Duck-typed
  //    here, which is the point: this module imports no SDK.
  assert.equal(decodeServerTime({ seconds: EARLY.seconds, nanoseconds: EARLY.nanoseconds }), canonical);
  // 2. Structured-cloned — mulmoserver's view channel, class gone.
  assert.equal(decodeServerTime(structuredClone({ seconds: EARLY.seconds, nanoseconds: EARLY.nanoseconds })), canonical);
  // 3. JSON, as `Timestamp.toJSON` writes it — MulmoTerminal's preview over
  //    HTTP and the headless run.
  assert.equal(decodeServerTime({ type: "firestore/timestamp/1.0", seconds: EARLY.seconds, nanoseconds: EARLY.nanoseconds }), canonical);
});

test("decodes nothing else", () => {
  for (const value of [null, undefined, "2026-08-15T10:00", 17, { seconds: "1", nanoseconds: 0 }, { seconds: 1 }, {}, [1, 2]]) {
    assert.equal(decodeServerTime(value), null);
  }
  // Out of range nanoseconds are not an instant.
  assert.equal(decodeServerTime({ seconds: SECONDS, nanoseconds: 1_000_000_000 }), null);
});

test("encode is the exact inverse, and only of its own output", () => {
  const canonical = serverTimeOf(SAME_MS) ?? "";
  assert.deepEqual(encodeServerTime(canonical), SAME_MS);
  // What closes the write-back hole: a record read, edited and written back
  // WHOLE puts the same instant back, so the rules see an unchanged field.
  assert.deepEqual(encodeServerTime(serverTimeOf(encodeServerTime(canonical) ?? EARLY) ?? ""), SAME_MS);
  // A civil datetime an author typed is NOT re-typed into a timestamp.
  assert.equal(encodeServerTime("2026-08-15T10:00"), null);
  assert.equal(encodeServerTime("2026-08-15T10:00:00Z"), null);
  // RFC3339 with an offset is refused: two offsets do not sort in time order.
  assert.equal(encodeServerTime("2026-08-15T23:05:54.605987654+09:00"), null);
  assert.equal(isCanonicalServerTime("2026-08-15T23:05:54.605987654+09:00"), false);
});

test("a record is decoded field by field, and untouched when nothing is stamped", () => {
  const row = { id: "r1", submittedAt: { seconds: EARLY.seconds, nanoseconds: EARLY.nanoseconds }, note: "hello", count: 3 };
  assert.deepEqual(decodeRecordTimes(row), { id: "r1", submittedAt: serverTimeOf(EARLY), note: "hello", count: 3 });
  const plain = { id: "r2", note: "hello" };
  // The SAME object, so a reference comparison upstream keeps its meaning.
  assert.equal(decodeRecordTimes(plain), plain);
});

test("the record lint accepts a stamped instant, and still refuses a stray offset", () => {
  const spec = { type: "datetime", label: "When" } as const;
  const problem = (value: unknown): string | null => recordFieldProblem("when", spec, value, "strict");
  assert.equal(problem(serverTimeOf(EARLY)), null);
  assert.equal(problem("2026-08-15T10:00"), null);
  // RFC3339 in general is NOT accepted: an offset breaks the string order.
  assert.notEqual(problem("2026-08-15T23:05:54.605987654+09:00"), null);
  assert.notEqual(problem("nonsense"), null);
});

test("the calendar places a stamped instant on the reader's own day", () => {
  // TZ is pinned by the runner (see the note in `calendarGrid`'s header): this
  // is the one function there whose answer depends on the environment, because
  // an instant's day is a question about the reader.
  const canonical = serverTimeOf({ seconds: Date.UTC(2026, 7, 15, 23, 5, 54) / 1000, nanoseconds: 0 });
  const placed = dateOf(canonical);
  assert.notEqual(placed, null);
  const local = new Date(Date.UTC(2026, 7, 15, 23, 5, 54));
  assert.deepEqual(placed, { year: local.getFullYear(), month: local.getMonth() + 1, day: local.getDate() });
  // A civil value is unaffected — it means the same wall clock everywhere.
  assert.deepEqual(dateOf("2026-08-15T10:00"), { year: 2026, month: 8, day: 15 });
});
