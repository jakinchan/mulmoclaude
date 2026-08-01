// The manual calendar-sync response (#2427). The rule under test is what the
// user is told: a sync that could not run must never read as a successful
// empty sync, and a group fan-out must report only the collection the user
// clicked on.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { calendarRefreshBody, CALENDAR_NOT_DECLARED_ERROR, CALENDAR_NOT_LINKED_ERROR } from "../../server/api/routes/collectionCalendarRefresh.js";
import type { CalendarCollectionSyncResult } from "@mulmoclaude/core/google";

const result = (overrides: Partial<CalendarCollectionSyncResult> & { slug: string }): CalendarCollectionSyncResult => ({
  written: 0,
  removed: 0,
  unwritable: [],
  withheld: [],
  errors: [],
  ...overrides,
});

describe("calendarRefreshBody (#2427)", () => {
  it("reports the requested collection's own counts", () => {
    const body = calendarRefreshBody("my-schedule", {
      kind: "synced",
      results: [result({ slug: "my-schedule", written: 3, removed: 1 })],
    });
    assert.deepEqual(body, { refreshed: true, written: 3, removed: 1, errors: [] });
  });

  it("ignores the other collections the shared calendar fanned out to", () => {
    const body = calendarRefreshBody("my-schedule", {
      kind: "synced",
      results: [result({ slug: "my-schedule", written: 2 }), result({ slug: "team-schedule", written: 40, errors: ["write x: io"] })],
    });
    assert.equal(body.written, 2);
    assert.deepEqual(body.errors, []);
  });

  it("sums the counts when a collection appears in more than one group", () => {
    const body = calendarRefreshBody("my-schedule", {
      kind: "synced",
      results: [result({ slug: "my-schedule", written: 2, removed: 1 }), result({ slug: "my-schedule", written: 5, removed: 2 })],
    });
    assert.equal(body.written, 7);
    assert.equal(body.removed, 3);
  });

  it("surfaces retryable errors AND events that can never be stored", () => {
    const body = calendarRefreshBody("my-schedule", {
      kind: "synced",
      results: [result({ slug: "my-schedule", errors: ["write ev-1: io"], unwritable: ["write ev-2: invalid-id"] })],
    });
    assert.deepEqual(body.errors, ["write ev-1: io", "write ev-2: invalid-id"]);
  });

  it("reports an unlinked Google account instead of a silent success", () => {
    const body = calendarRefreshBody("my-schedule", { kind: "not-linked" });
    assert.equal(body.written, 0);
    assert.deepEqual(body.errors, [CALENDAR_NOT_LINKED_ERROR]);
  });

  it("reports a collection that no longer declares googleCalendar", () => {
    const body = calendarRefreshBody("my-schedule", { kind: "not-a-calendar" });
    assert.deepEqual(body.errors, [CALENDAR_NOT_DECLARED_ERROR]);
  });

  it("returns zeroes — not an error — when the sync legitimately found nothing", () => {
    const body = calendarRefreshBody("my-schedule", { kind: "synced", results: [result({ slug: "my-schedule" })] });
    assert.deepEqual(body, { refreshed: true, written: 0, removed: 0, errors: [] });
  });

  it("survives a slug that matched no result at all (deleted mid-sync)", () => {
    const body = calendarRefreshBody("gone", { kind: "synced", results: [result({ slug: "my-schedule", written: 9 })] });
    assert.deepEqual(body, { refreshed: true, written: 0, removed: 0, errors: [] });
  });
});
