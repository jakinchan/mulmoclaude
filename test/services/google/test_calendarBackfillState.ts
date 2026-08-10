// Regression tests for #2850 — a googleCalendar collection that never receives
// the calendar's history.
//
// The bug: a sync token is keyed by `calendarId` and nothing else, so it is
// shared by every consumer of that calendar. Whoever walks first stores a
// cursor, and the next collection resumes from a window it never received —
// Google answers with a delta of a handful of events, the collection writes
// them, reports success with ZERO errors, and the history never arrives. Two
// real routes into that state, both in the reporter's timeline: the standalone
// `google` tool's `calendarSync` stored a token, and a second collection was
// created on a calendar a sibling had already synced.
//
// These pin the rule that replaces "has the calendar got a token?" with "have
// THESE records got the history?". Real files under a mkdtemp root, because the
// whole point of the marker is where it lives — beside the records it describes,
// so the two reset together.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  calendarBackfillPath,
  collectionsNeedingBackfill,
  markCalendarBackfilled,
  needsCalendarBackfill,
  resumableToken,
  saveCalendarSyncToken,
  toolCalendarSyncKey,
  withPartialWindowError,
  PARTIAL_CALENDAR_WINDOW,
  type CalendarCollectionSyncResult,
} from "@mulmoclaude/core/google";
import type { LoadedCollection } from "@mulmoclaude/core/collection/server";

const WALKED_AT = "2026-08-10T00:00:00.000Z";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "cal-backfill-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A records dir under the temp root. */
const dataDirFor = (slug: string): string => {
  const dir = path.join(root, "data", "collections", slug, "items");
  mkdirSync(dir, { recursive: true });
  return dir;
};

const collectionOn = (slug: string, calendarId?: string): LoadedCollection =>
  ({ slug, dataDir: dataDirFor(slug), schema: { googleCalendar: { calendarId, map: {} } } }) as unknown as LoadedCollection;

describe("needsCalendarBackfill (#2850)", () => {
  it("says yes for records that have never been walked", async () => {
    assert.equal(await needsCalendarBackfill(dataDirFor("fresh"), "primary"), true);
  });

  it("says no once the walk has been recorded", async () => {
    const dataDir = dataDirFor("filled");
    await markCalendarBackfilled(dataDir, "primary", WALKED_AT);
    assert.equal(await needsCalendarBackfill(dataDir, "primary"), false);
  });

  // An omitted id and an explicit "primary" are one calendar everywhere else
  // (`canonicalCalendarId`); disagreeing here would re-walk on every run.
  it("treats an omitted calendarId and an explicit primary as the same calendar", async () => {
    const dataDir = dataDirFor("canonical");
    await markCalendarBackfilled(dataDir, undefined, WALKED_AT);
    assert.equal(await needsCalendarBackfill(dataDir, "primary"), false);
    assert.equal(await needsCalendarBackfill(dataDir, undefined), false);
  });

  // A schema repointed at another calendar holds a backfill of the wrong one.
  it("says yes again when the schema now names a different calendar", async () => {
    const dataDir = dataDirFor("moved");
    await markCalendarBackfilled(dataDir, "primary", WALKED_AT);
    assert.equal(await needsCalendarBackfill(dataDir, "team@group.calendar.google.com"), true);
  });

  // The marker lives beside the records so the two reset together — that is
  // what makes a hand-deleted collection (what the reporter did six times) ask
  // for a new backfill instead of inheriting a claim to data that is gone.
  it("says yes again after the records dir is deleted and recreated", async () => {
    const dataDir = dataDirFor("recreated");
    await markCalendarBackfilled(dataDir, "primary", WALKED_AT);
    rmSync(path.dirname(dataDir), { recursive: true, force: true });
    assert.equal(await needsCalendarBackfill(dataDirFor("recreated"), "primary"), true);
  });

  // Failing OPEN here loses the history silently, which is the whole bug; a
  // redundant walk only costs API calls and rewrites records that already match.
  it("says yes for a marker that cannot be parsed", async () => {
    const dataDir = dataDirFor("corrupt");
    writeFileSync(calendarBackfillPath(dataDir), "{ not json");
    assert.equal(await needsCalendarBackfill(dataDir, "primary"), true);
  });

  it("keeps the marker out of the record set (dot-prefixed, so listItems skips it)", () => {
    assert.equal(path.basename(calendarBackfillPath(dataDirFor("hidden"))).startsWith("."), true);
  });
});

describe("collectionsNeedingBackfill (#2850)", () => {
  it("names only the collections still owed the history", async () => {
    const filled = collectionOn("filled", "primary");
    const unfilled = collectionOn("unfilled", "primary");
    await markCalendarBackfilled(filled.dataDir, "primary", WALKED_AT);
    assert.deepEqual(await collectionsNeedingBackfill([filled, unfilled]), ["unfilled"]);
  });

  it("is empty once every collection in the group holds the history", async () => {
    const one = collectionOn("one", "primary");
    const two = collectionOn("two", "primary");
    await Promise.all([markCalendarBackfilled(one.dataDir, "primary", WALKED_AT), markCalendarBackfilled(two.dataDir, "primary", WALKED_AT)]);
    assert.deepEqual(await collectionsNeedingBackfill([one, two]), []);
  });

  it("is empty for an empty group", async () => {
    assert.deepEqual(await collectionsNeedingBackfill([]), []);
  });
});

describe("resumableToken — the #2850 fix", () => {
  // Case A from the issue: the reporter ran the `google` tool's calendarSync to
  // prove the grant worked, which stored a token. Every collection created
  // afterwards was handed a delta of a window it had never received.
  it("refuses to resume a token left by another consumer when the collection is unfilled", async () => {
    await saveCalendarSyncToken("primary", "tok-from-google-tool", root);
    const fresh = collectionOn("fresh", "primary");
    assert.equal(await resumableToken("primary", [fresh], root), undefined, "an unfilled collection must walk the calendar in full");
  });

  // Case B: the second calendar collection a user asks for. Before the fix it
  // inherited the first one's cursor and stayed permanently empty, no error.
  it("refuses to resume when only ONE collection of the group is unfilled", async () => {
    await saveCalendarSyncToken("primary", "tok-1", root);
    const first = collectionOn("first", "primary");
    const second = collectionOn("second", "primary");
    await markCalendarBackfilled(first.dataDir, "primary", WALKED_AT);
    assert.equal(await resumableToken("primary", [first, second], root), undefined);
  });

  it("resumes normally once every collection holds the history — incremental sync still works", async () => {
    await saveCalendarSyncToken("primary", "tok-1", root);
    const filled = collectionOn("filled", "primary");
    await markCalendarBackfilled(filled.dataDir, "primary", WALKED_AT);
    assert.equal(await resumableToken("primary", [filled], root), "tok-1");
  });

  it("answers undefined when the calendar has no token at all", async () => {
    const filled = collectionOn("filled", "primary");
    await markCalendarBackfilled(filled.dataDir, "primary", WALKED_AT);
    assert.equal(await resumableToken("primary", [filled], root), undefined);
  });
});

describe("toolCalendarSyncKey (#2850)", () => {
  // The tool discards the events it reads, so it must not consume the cursor a
  // collection needs — nor leave one a collection would resume from.
  it("keys the standalone tool's cursor apart from the collections'", () => {
    assert.notEqual(toolCalendarSyncKey("primary"), "primary");
  });

  it("canonicalises the calendar inside the key, so an omitted id and primary agree", () => {
    assert.equal(toolCalendarSyncKey(undefined), toolCalendarSyncKey("primary"));
  });

  it("keeps two calendars apart", () => {
    assert.notEqual(toolCalendarSyncKey("primary"), toolCalendarSyncKey("team@group.calendar.google.com"));
  });

  // The store canonicalises whatever it is handed; a key that changed on the
  // way through would store under one name and read back under another.
  it("survives a second canonicalisation unchanged", () => {
    assert.equal(toolCalendarSyncKey(toolCalendarSyncKey("primary")), `tool:${toolCalendarSyncKey("primary")}`);
  });
});

describe("withPartialWindowError (#2850)", () => {
  const result = (slug: string, errors: string[] = []): CalendarCollectionSyncResult => ({
    slug,
    written: 3,
    removed: 0,
    unwritable: [],
    withheld: [],
    errors,
  });

  // A truncated walk used to be indistinguishable from a completed one, so the
  // half-copied calendar read as success and repeated forever in silence.
  it("marks every collection in the group when the walk was cut short", () => {
    const marked = withPartialWindowError([result("a"), result("b")], true);
    assert.deepEqual(
      marked.map((entry) => entry.errors),
      [[PARTIAL_CALENDAR_WINDOW], [PARTIAL_CALENDAR_WINDOW]],
    );
  });

  it("leaves a completed walk untouched", () => {
    const marked = withPartialWindowError([result("a")], false);
    assert.deepEqual(marked[0]?.errors, []);
  });

  it("keeps the errors the apply already reported", () => {
    const marked = withPartialWindowError([result("a", ["write ev-1: conflict"])], true);
    assert.deepEqual(marked[0]?.errors, ["write ev-1: conflict", PARTIAL_CALENDAR_WINDOW]);
  });

  it("does not mutate the results it was given", () => {
    const original = result("a");
    withPartialWindowError([original], true);
    assert.deepEqual(original.errors, []);
  });

  // The counts still stand: the events that DID land were written.
  it("keeps the written counts of the partial window", () => {
    const marked = withPartialWindowError([result("a")], true);
    assert.equal(marked[0]?.written, 3);
  });
});
