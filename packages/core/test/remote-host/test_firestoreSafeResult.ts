// Unit tests for the guard that keeps one `undefined` from costing a whole reply
// (#2634). Firestore rejects `undefined` at any depth, so a single stray value in
// a handler's return made `updateDoc` throw — `status: "done"` never landed and
// the remote waited out its timeout.
//
//   - every offending path is reported, nested, in `a.b.0.c` form
//   - a SPARSE array's holes are reported too: `flatMap`/`map` skip them, so the
//     naive walk called `[1, , 3]` clean and then Firestore refused it
//   - the reply being `undefined` ITSELF is reported and becomes `null`
//   - stripping drops object keys but turns array holes into `null`, so the
//     indexes the sender meant still line up
//   - declared paths (`sessions.*.work`) are stripped SILENTLY — reporting the
//     expected ones on every reply is how a warning stops being read
//   - a value with nothing wrong is reported empty and passes through unchanged
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ROOT_PATH, matchesPathPattern, stripUndefined, undefinedPaths, unexpectedPaths } from "../../src/remote-host/server/firestoreSafeResult.js";

// A genuinely SPARSE array — holes, not `undefined` values. Built rather than
// written as `[1, , 3]` so the shape is unambiguous at a glance.
const withHole = (): unknown[] => {
  const items: unknown[] = new Array(3);
  items[0] = 1;
  items[2] = 3;
  return items;
};

describe("undefinedPaths", () => {
  it("finds nothing in a value that is safe to write", () => {
    assert.deepEqual(undefinedPaths({ sessions: [{ title: "a", work: null }], count: 0, ok: false }), []);
  });

  it("names a nested path the way Firestore's own error would", () => {
    assert.deepEqual(undefinedPaths({ sessions: [{ title: "a" }, { title: "b", work: undefined }] }), ["sessions.1.work"]);
  });

  it("reports every offending path, not just the first", () => {
    assert.deepEqual(undefinedPaths({ one: undefined, nested: { two: undefined } }), ["one", "nested.two"]);
  });

  // The trap: flatMap/map skip holes, so this walked clean and the write was
  // refused anyway (CodeRabbit, receptron/mulmoterminal#1044).
  it("reports a SPARSE array's holes", () => {
    assert.deepEqual(undefinedPaths({ items: withHole() }), ["items.1"]);
  });

  it("reports the reply being undefined itself", () => {
    assert.deepEqual(undefinedPaths(undefined), [ROOT_PATH]);
  });

  it("walks into arrays of arrays", () => {
    assert.deepEqual(undefinedPaths([[{ deep: undefined }]]), ["0.0.deep"]);
  });

  it("treats null and primitives as safe (null is a value Firestore accepts)", () => {
    assert.deepEqual(undefinedPaths(null), []);
    assert.deepEqual(undefinedPaths(0), []);
    assert.deepEqual(undefinedPaths(""), []);
  });
});

describe("stripUndefined", () => {
  it("drops the offending key and leaves the rest untouched", () => {
    assert.deepEqual(stripUndefined({ title: "a", work: undefined, count: 0 }), { title: "a", count: 0 });
  });

  it("keeps array indexes lined up by writing null into a hole", () => {
    assert.deepEqual(stripUndefined(withHole()), [1, null, 3]);
    assert.deepEqual(stripUndefined([undefined, "b"]), [null, "b"]);
  });

  it("turns a reply that is itself undefined into null", () => {
    // Warning about it and then returning it unchanged left the write just as
    // broken; null is what the runner already substitutes for a missing result.
    assert.equal(stripUndefined(undefined), null);
  });

  it("strips at depth", () => {
    assert.deepEqual(stripUndefined({ sessions: [{ title: "a", work: undefined }] }), { sessions: [{ title: "a" }] });
  });

  it("passes a clean value through with the same shape", () => {
    const clean = { sessions: [{ title: "a", work: null }], count: 2 };
    assert.deepEqual(stripUndefined(clean), clean);
  });

  // Firestore accepts Date / Timestamp / GeoPoint / DocumentReference as VALUES,
  // and rebuilding one from its entries produces `{}`. Turning a timestamp into an
  // empty object because some unrelated field was undefined would be a worse bug
  // than the one this guard exists to fix (CodeRabbit, #2638).
  it("leaves a Date intact when a sibling key is stripped", () => {
    const createdAt = new Date("2026-07-29T00:00:00.000Z");
    const stripped = stripUndefined({ createdAt, work: undefined });
    assert.deepEqual(stripped, { createdAt });
    assert.ok(Reflect.get(Object(stripped), "createdAt") instanceof Date);
  });

  it("leaves a class instance (Timestamp-like) intact", () => {
    class Timestamp {
      constructor(readonly seconds: number) {}
      toMillis(): number {
        return this.seconds * 1_000;
      }
    }
    const stamp = new Timestamp(5);
    const stripped = stripUndefined({ stamp, gone: undefined });
    assert.equal(Reflect.get(Object(stripped), "stamp"), stamp);
  });

  it("does not report paths inside a class instance it will not rewrite", () => {
    // Reporting a path the strip cannot reach would promise a fix that never
    // happens — Firestore refuses a custom object outright, which is its own error.
    class Holder {
      readonly missing: undefined = undefined;
    }
    assert.deepEqual(undefinedPaths({ held: new Holder() }), []);
  });
});

describe("matchesPathPattern", () => {
  it("matches a literal path", () => {
    assert.equal(matchesPathPattern("sessions.1.work", "sessions.1.work"), true);
  });

  it("lets `*` stand for exactly one segment", () => {
    assert.equal(matchesPathPattern("sessions.11.work", "sessions.*.work"), true);
    assert.equal(matchesPathPattern("sessions.11.deep.work", "sessions.*.work"), false);
  });

  it("does not match a different depth or a different key", () => {
    assert.equal(matchesPathPattern("sessions.1", "sessions.*.work"), false);
    assert.equal(matchesPathPattern("sessions.1.title", "sessions.*.work"), false);
  });

  it("treats a dot in the pattern as a separator, never as a regex wildcard", () => {
    assert.equal(matchesPathPattern("sessionsXwork", "sessions.work"), false);
  });
});

describe("unexpectedPaths", () => {
  it("reports everything when nothing is declared", () => {
    assert.deepEqual(unexpectedPaths(undefinedPaths({ sessions: [{ work: undefined }] })), ["sessions.0.work"]);
  });

  it("stays silent about a declared optional path", () => {
    assert.deepEqual(unexpectedPaths(undefinedPaths({ sessions: [{ work: undefined }] }), ["sessions.*.work"]), []);
  });

  it("still reports the undeclared ones alongside a declared one", () => {
    const reply = { sessions: [{ work: undefined, title: undefined }] };
    assert.deepEqual(unexpectedPaths(undefinedPaths(reply), ["sessions.*.work"]), ["sessions.0.title"]);
  });

  // Declaring a path silences the REPORT, never the strip — Firestore's rule is
  // not negotiable, so the value has to go either way.
  it("declaring a path does not keep it out of the strip", () => {
    assert.deepEqual(stripUndefined({ sessions: [{ work: undefined }] }), { sessions: [{}] });
  });
});
