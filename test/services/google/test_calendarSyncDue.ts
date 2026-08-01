// Unit tests for the cross-host sync gate (#2678). Two hosts registering
// `googleCalendarSyncTaskDef` tick in the SAME minute — interval schedules align
// to wall-clock boundaries — so this predicate is the only thing standing between
// them and a concurrent run that writes to Google and rewrites the push baseline.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { calendarSyncDueWindowMs, isCalendarSyncDue } from "@mulmoclaude/core/google";

const ONE_MINUTE_MS = 60 * 1000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;
const HOURLY_WINDOW_MS = calendarSyncDueWindowMs(ONE_HOUR_MS);
const NOW = Date.parse("2026-08-01T10:00:00.000Z");
const isoAt = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

describe("calendarSyncDueWindowMs (#2678)", () => {
  it("leaves an hourly interval a window short enough that a lone host runs every tick", () => {
    // Without the slack a host reads its own marker — stamped a moment after the
    // tick — as "not due yet", and syncs every other hour instead.
    assert.equal(HOURLY_WINDOW_MS, 55 * ONE_MINUTE_MS);
    assert.equal(isCalendarSyncDue(isoAt(-ONE_HOUR_MS), HOURLY_WINDOW_MS, NOW), true);
  });

  it("halves a short configured interval rather than letting the slack swallow it", () => {
    assert.equal(calendarSyncDueWindowMs(5 * ONE_MINUTE_MS), 2.5 * ONE_MINUTE_MS);
    assert.equal(calendarSyncDueWindowMs(ONE_MINUTE_MS), 0.5 * ONE_MINUTE_MS);
  });

  it("keeps a long interval close to its own cadence", () => {
    assert.equal(calendarSyncDueWindowMs(6 * ONE_HOUR_MS), 6 * ONE_HOUR_MS - 5 * ONE_MINUTE_MS);
  });
});

describe("isCalendarSyncDue (#2678)", () => {
  it("is due when no host has ever synced the calendar", () => {
    assert.equal(isCalendarSyncDue(null, HOURLY_WINDOW_MS, NOW), true);
  });

  it("is not due right after another host claimed it", () => {
    assert.equal(isCalendarSyncDue(isoAt(-2 * ONE_MINUTE_MS), HOURLY_WINDOW_MS, NOW), false);
  });

  it("is due exactly at the window boundary", () => {
    assert.equal(isCalendarSyncDue(isoAt(-HOURLY_WINDOW_MS), HOURLY_WINDOW_MS, NOW), true);
    assert.equal(isCalendarSyncDue(isoAt(-HOURLY_WINDOW_MS + 1), HOURLY_WINDOW_MS, NOW), false);
  });

  // A stuck calendar is worse than a duplicate run — the sync tolerates the
  // latter by construction (writes are upserts by event id).
  it("is due when the marker cannot be read as a time", () => {
    assert.equal(isCalendarSyncDue("whenever", HOURLY_WINDOW_MS, NOW), true);
    assert.equal(isCalendarSyncDue("", HOURLY_WINDOW_MS, NOW), true);
  });

  it("waits out a marker from a slightly fast clock, but not one beyond a whole window", () => {
    assert.equal(isCalendarSyncDue(isoAt(ONE_MINUTE_MS), HOURLY_WINDOW_MS, NOW), false);
    assert.equal(isCalendarSyncDue(isoAt(2 * ONE_HOUR_MS), HOURLY_WINDOW_MS, NOW), true);
  });
});

// The predicate is the guard the sync hands DOWN to the claim rather than
// evaluating up front, so these pin the two shapes the caller actually passes.
describe("the guard a scheduled run hands to the claim (#2678)", () => {
  const scheduledGuard = (lastSyncedAt: string | null) => isCalendarSyncDue(lastSyncedAt, HOURLY_WINDOW_MS, NOW);

  it("takes a calendar nothing has claimed", () => {
    assert.equal(scheduledGuard(null), true);
  });

  it("backs off a calendar another host claimed a minute ago", () => {
    assert.equal(scheduledGuard(isoAt(-ONE_MINUTE_MS)), false);
  });

  it("takes one whose last run has aged past the window", () => {
    assert.equal(scheduledGuard(isoAt(-ONE_HOUR_MS)), true);
  });
});
