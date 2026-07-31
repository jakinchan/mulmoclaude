// Unit tests for the Collection → Google push diff (#2598).
//
// The rule that matters most is the NEGATIVE one: a record nobody touched must
// classify as `unchanged`. Get that wrong and every click re-pushes the whole
// collection, bumping every event's `updated` timestamp and dragging the next
// pull through a full rewrite. The traps are the values where "equal" is not
// textual equality — an inherited colour Google reports as `""` versus a record
// file that simply omits the key, and an all-day date stored as `…T00:00`.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  baselineRecord,
  bySourceField,
  conflictingFields,
  isClientSettableEventId,
  locallyChangedFields,
  locallyDeletedIds,
  locallyEditedIds,
  mayAdoptExisting,
  mergeShadow,
  planRecord,
  pushableMap,
  type PushableSourceField,
  type ShadowEvent,
} from "@mulmoclaude/core/google";
import type { CollectionFieldSpec } from "@mulmoclaude/core/collection";

const PRIMARY_KEY = "gid";

const fields: Record<string, CollectionFieldSpec> = {
  gid: { type: "string", label: "ID", primary: true },
  title: { type: "string", label: "Event" },
  on: { type: "datetime", label: "Start" },
  until: { type: "datetime", label: "End" },
  colour: { type: "string", label: "Colour" },
};

const MAP: Record<string, PushableSourceField> = { title: "summary", on: "start", until: "end", colour: "colorId" };

const shadow = (overrides: Partial<ShadowEvent> = {}): ShadowEvent => ({
  summary: "Standup",
  start: "2026-07-19T09:00:00+09:00",
  end: "2026-07-19T09:15:00+09:00",
  colorId: "7",
  description: "",
  location: "",
  ...overrides,
});

/** The record the pull would have written for `base` — the honest "untouched". */
const syncedRecord = (eventId: string, base: ShadowEvent) => baselineRecord(eventId, base, MAP, PRIMARY_KEY, fields);

describe("pushableMap", () => {
  it("keeps the writable event fields", () => {
    assert.deepEqual(pushableMap({ title: "summary", on: "start", until: "end", colour: "colorId" }), MAP);
  });

  // Pull and push must agree on what a field is, or a mirrored calendar loses
  // whichever side the two disagree about (#2620).
  it("keeps description and location, which the pull can now read", () => {
    assert.deepEqual(pushableMap({ body: "description", where: "location" }), { body: "description", where: "location" });
  });

  it("drops htmlLink and status, which Google will not accept a write for", () => {
    assert.deepEqual(pushableMap({ title: "summary", link: "htmlLink", state: "status" }), { title: "summary" });
  });

  it("is empty when a schema maps only read-only fields", () => {
    assert.deepEqual(pushableMap({ link: "htmlLink" }), {});
  });
});

// When a push cannot run AT ALL (a calendar whose role degraded to reader, a
// revoked grant), the pull still runs — reading needs no write access — and
// would overwrite every unsent local edit while advancing its baseline past it.
// This is the set the pull has to protect in that case (CodeRabbit review #2666).
describe("locallyEditedIds (#2620 protection when the push never ran)", () => {
  const base = shadow();
  const untouched = { ...syncedRecord("ev1", base), gid: "ev1" };
  const edited = { ...syncedRecord("ev2", base), gid: "ev2", title: "Renamed locally" };
  const stored = { ev1: base, ev2: base };

  it("names only the records that differ from their baseline", () => {
    assert.deepEqual(locallyEditedIds([untouched, edited], stored, MAP, PRIMARY_KEY, fields), ["ev2"]);
  });

  it("protects nothing when every record matches its baseline", () => {
    assert.deepEqual(locallyEditedIds([untouched], stored, MAP, PRIMARY_KEY, fields), []);
  });

  // No baseline means the record never came from a sync, so it is local-only —
  // there is nothing in Google for the pull to overwrite it with, but including
  // it is harmless and keeps this in step with `planRecord`.
  it("includes a locally created record that has no baseline yet", () => {
    assert.deepEqual(locallyEditedIds([{ gid: "brand-new", title: "New" }], {}, MAP, PRIMARY_KEY, fields), ["brand-new"]);
  });

  it("protects nothing for an empty collection", () => {
    assert.deepEqual(locallyEditedIds([], stored, MAP, PRIMARY_KEY, fields), []);
  });
});

describe("bySourceField", () => {
  it("inverts the schema's collectionField → eventField map", () => {
    assert.deepEqual(bySourceField(MAP), { summary: "title", start: "on", end: "until", colorId: "colour" });
  });
});

describe("planRecord — nothing to do", () => {
  it("classifies a record the pull just wrote as unchanged", () => {
    const base = shadow();
    const plan = planRecord("ev1", syncedRecord("ev1", base), base, MAP, PRIMARY_KEY, fields);
    assert.deepEqual(plan, { kind: "unchanged" });
  });

  // A `.push-state.json` written before `description` / `location` became
  // pushable carries neither key. If an absent baseline field read as a local
  // edit, the first push after the upgrade would re-PATCH the whole collection
  // — so this pins the "absent and empty compare alike" rule that makes the
  // widened baseline need no migration (#2620).
  it("does not read a baseline written before description/location existed as edited", () => {
    // `readJsonOrNull` annotates rather than validates, so this is exactly the
    // value an older state file yields at runtime.
    const legacy: ShadowEvent = JSON.parse('{"summary":"Standup","start":"2026-07-19T09:00:00+09:00","end":"2026-07-19T09:15:00+09:00","colorId":"7"}');
    const mapWithBody: Record<string, PushableSourceField> = { ...MAP, body: "description", where: "location" };
    const record = baselineRecord("ev1", legacy, mapWithBody, PRIMARY_KEY, fields);
    assert.deepEqual(planRecord("ev1", record, legacy, mapWithBody, PRIMARY_KEY, fields), { kind: "unchanged" });
  });

  it("does not read an all-day event as edited (stored `…T00:00` vs Google's date)", () => {
    const base = shadow({ start: "2026-07-19", end: "2026-07-20" });
    const plan = planRecord("ev1", syncedRecord("ev1", base), base, MAP, PRIMARY_KEY, fields);
    assert.deepEqual(plan, { kind: "unchanged" });
  });

  it("does not read an inherited colour as edited when the record omits the key", () => {
    const base = shadow({ colorId: "" });
    const record = syncedRecord("ev1", base);
    // A record file written without the empty column at all — the shape the
    // store actually round-trips.
    const withoutColour = Object.fromEntries(Object.entries(record).filter(([field]) => field !== "colour"));
    assert.deepEqual(planRecord("ev1", withoutColour, base, MAP, PRIMARY_KEY, fields), { kind: "unchanged" });
  });

  // Regression: the seconds-less clock the collection's own date-time input
  // produces. Google always answers WITH seconds, so after one push the baseline
  // carries them and a text comparison would report this record as edited on
  // every later click — re-PATCHing the same event forever.
  // (Observed during Claude review, not flagged by a bot.)
  it("treats a hand-typed `09:30` as unchanged against a baseline of `09:30:00`", () => {
    const base = shadow({ start: "2026-07-19T09:30:00+09:00", end: "2026-07-19T10:00:00+09:00" });
    const typed = { ...syncedRecord("ev1", base), on: "2026-07-19T09:30", until: "2026-07-19T10:00" };
    assert.deepEqual(planRecord("ev1", typed, base, MAP, PRIMARY_KEY, fields), { kind: "unchanged" });
  });

  it("still sees a real edit on a seconds-less field", () => {
    const base = shadow({ start: "2026-07-19T09:30:00+09:00" });
    const typed = { ...syncedRecord("ev1", base), on: "2026-07-19T11:00" };
    assert.deepEqual(planRecord("ev1", typed, base, MAP, PRIMARY_KEY, fields), { kind: "changed", fields: ["start"] });
  });

  it("does not collapse seconds that actually differ", () => {
    const base = shadow({ start: "2026-07-19T09:30:45+09:00" });
    const typed = { ...syncedRecord("ev1", base), on: "2026-07-19T09:30" };
    assert.deepEqual(planRecord("ev1", typed, base, MAP, PRIMARY_KEY, fields), { kind: "changed", fields: ["start"] });
  });

  it("ignores a locally edited column that maps to a read-only event field", () => {
    const base = shadow();
    // `status` is not pushable, so a schema mapping it contributes no diff.
    const mapWithStatus = pushableMap({ title: "summary", on: "start", until: "end", colour: "colorId", state: "status" });
    const record = { ...syncedRecord("ev1", base), state: "tentative" };
    assert.deepEqual(planRecord("ev1", record, base, mapWithStatus, PRIMARY_KEY, fields), { kind: "unchanged" });
  });
});

describe("planRecord — local work to push", () => {
  it("classifies a record with no baseline as a create", () => {
    const record = { gid: "abcde", title: "New plan", on: "2026-07-19T10:00", until: "2026-07-19T11:00" };
    assert.deepEqual(planRecord("abcde", record, undefined, MAP, PRIMARY_KEY, fields), { kind: "create" });
  });

  it("reports only the field the user actually edited", () => {
    const base = shadow();
    const record = { ...syncedRecord("ev1", base), title: "Retitled" };
    assert.deepEqual(planRecord("ev1", record, base, MAP, PRIMARY_KEY, fields), { kind: "changed", fields: ["summary"] });
  });

  it("reports both ends when the event was moved", () => {
    const base = shadow();
    const record = { ...syncedRecord("ev1", base), on: "2026-07-19T11:00:00", until: "2026-07-19T11:15:00" };
    const plan = planRecord("ev1", record, base, MAP, PRIMARY_KEY, fields);
    assert.deepEqual(plan, { kind: "changed", fields: ["start", "end"] });
  });

  it("sees an all-day event moved to another day", () => {
    const base = shadow({ start: "2026-07-19", end: "2026-07-20" });
    const record = { ...syncedRecord("ev1", base), on: "2026-07-21T00:00" };
    assert.deepEqual(planRecord("ev1", record, base, MAP, PRIMARY_KEY, fields), { kind: "changed", fields: ["start"] });
  });
});

describe("locallyChangedFields", () => {
  it("is empty for identical records", () => {
    const base = shadow();
    const record = syncedRecord("ev1", base);
    assert.deepEqual(locallyChangedFields(record, record, MAP), []);
  });

  it("treats null, undefined and empty string as the same absence", () => {
    const left = { title: "", colour: null };
    const right = { colour: undefined };
    assert.deepEqual(locallyChangedFields(left, right, MAP), []);
  });
});

describe("conflictingFields", () => {
  it("is empty when Google still holds the baseline", () => {
    const base = shadow();
    assert.deepEqual(conflictingFields(base, base, ["summary", "start"]), []);
  });

  it("flags a field both sides changed", () => {
    const base = shadow();
    const current = shadow({ summary: "Renamed in Google" });
    assert.deepEqual(conflictingFields(base, current, ["summary"]), ["summary"]);
  });

  // Field-level, not whole-event: refusing this push would be a false conflict.
  it("does not flag a Google change to a field the local edit never touched", () => {
    const base = shadow();
    const current = shadow({ start: "2026-07-19T12:00:00+09:00" });
    assert.deepEqual(conflictingFields(base, current, ["summary"]), []);
  });
});

describe("locallyDeletedIds", () => {
  it("names a baseline entry the collection no longer holds", () => {
    const state = { ev1: shadow(), ev2: shadow() };
    assert.deepEqual(locallyDeletedIds(state, ["ev1"]), ["ev2"]);
  });

  it("is empty when every baseline entry is still present", () => {
    assert.deepEqual(locallyDeletedIds({ ev1: shadow() }, ["ev1", "ev9"]), []);
  });
});

describe("isClientSettableEventId", () => {
  const accepted = ["abcde", "1a2b3c4d", "0".repeat(5), "v".repeat(1024)];
  for (const eventId of accepted) {
    const label = eventId.length > 20 ? `a ${eventId.length}-character base32hex id` : eventId;
    it(`accepts ${label}`, () => {
      assert.equal(isClientSettableEventId(eventId), true);
    });
  }

  // Rejected ids are reported to the user, not silently re-keyed: a missed
  // re-key leaves a duplicate record on the next pull.
  const rejected: [string, string][] = [
    ["a semantic id with a hyphen", "team-standup"],
    ["characters above base32hex", "zzzzz"],
    ["uppercase", "ABCDE"],
    ["too short", "abcd"],
    ["too long", "a".repeat(1025)],
    ["empty", ""],
  ];
  for (const [label, eventId] of rejected) {
    it(`rejects ${label}`, () => {
      assert.equal(isClientSettableEventId(eventId), false);
    });
  }
});

describe("mayAdoptExisting — the 409 recovery gate", () => {
  // A 409 from `insert` is usually a previous push whose baseline never landed,
  // but it can also be an unrelated event holding the same id. Adoption is
  // therefore gated on the remote event ALREADY equalling the record, and the
  // recovery writes nothing — otherwise a push could modify a stranger's event.
  // (Codex review on #2600.)
  it("adopts an event that already matches the record", () => {
    const existing = shadow();
    assert.equal(mayAdoptExisting("ev1", syncedRecord("ev1", existing), existing, MAP, PRIMARY_KEY, fields), true);
  });

  it("refuses an event whose title differs — it may not be ours", () => {
    const existing = shadow();
    const record = { ...syncedRecord("ev1", existing), title: "Something else entirely" };
    assert.equal(mayAdoptExisting("ev1", record, existing, MAP, PRIMARY_KEY, fields), false);
  });

  it("refuses an event whose time differs", () => {
    const existing = shadow();
    const record = { ...syncedRecord("ev1", existing), on: "2026-07-19T15:00" };
    assert.equal(mayAdoptExisting("ev1", record, existing, MAP, PRIMARY_KEY, fields), false);
  });

  it("adopts across the seconds spelling, so a hand-typed time still heals", () => {
    const existing = shadow({ start: "2026-07-19T09:30:00+09:00", end: "2026-07-19T10:00:00+09:00" });
    const record = { ...syncedRecord("ev1", existing), on: "2026-07-19T09:30", until: "2026-07-19T10:00" };
    assert.equal(mayAdoptExisting("ev1", record, existing, MAP, PRIMARY_KEY, fields), true);
  });
});

describe("mergeShadow", () => {
  it("adds a new baseline entry", () => {
    const merged = mergeShadow({}, { ev1: shadow() });
    assert.deepEqual(Object.keys(merged), ["ev1"]);
  });

  it("replaces an existing entry in place", () => {
    const merged = mergeShadow({ ev1: shadow() }, { ev1: shadow({ summary: "Moved" }) });
    assert.equal(merged.ev1?.summary, "Moved");
  });

  it("removes an entry on null, so a recreate cannot resume from a dead baseline", () => {
    const merged = mergeShadow({ ev1: shadow(), ev2: shadow() }, { ev1: null });
    assert.deepEqual(Object.keys(merged), ["ev2"]);
  });

  it("leaves untouched calendars' entries alone (a window describes only changes)", () => {
    const merged = mergeShadow({ ev1: shadow(), ev2: shadow() }, { ev2: shadow({ summary: "Edited" }) });
    assert.deepEqual(Object.keys(merged).sort(), ["ev1", "ev2"]);
    assert.equal(merged.ev1?.summary, "Standup");
  });
});
