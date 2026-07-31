// Unit tests for the cross-host sync gate (#2678). Two hosts registering
// `googleCalendarSyncTaskDef` tick in the SAME minute — interval schedules align
// to wall-clock boundaries — so this predicate is the only thing standing between
// them and a concurrent run that writes to Google and rewrites the push baseline.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { calendarSyncDueWindowMs, dueCalendarGroups, isCalendarSyncDue } from "@mulmoclaude/core/google";

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

describe("dueCalendarGroups (#2678)", () => {
  const groups = new Map([
    ["primary", "group-primary"],
    ["work@group.calendar.google.com", "group-work"],
  ]);

  it("keeps only the calendars nothing synced inside the window", async () => {
    const markers: Record<string, string> = { primary: isoAt(-ONE_MINUTE_MS) };
    const due = await dueCalendarGroups(groups, (calendarId) => Promise.resolve(markers[calendarId] ?? null), HOURLY_WINDOW_MS, NOW);
    assert.deepEqual([...due.keys()], ["work@group.calendar.google.com"]);
  });

  it("keeps every group when nothing has been synced", async () => {
    const due = await dueCalendarGroups(groups, () => Promise.resolve(null), HOURLY_WINDOW_MS, NOW);
    assert.equal(due.size, 2);
  });

  it("drops every group while another host holds them all", async () => {
    const due = await dueCalendarGroups(groups, () => Promise.resolve(isoAt(-ONE_MINUTE_MS)), HOURLY_WINDOW_MS, NOW);
    assert.equal(due.size, 0);
  });

  it("carries the group value through untouched", async () => {
    const due = await dueCalendarGroups(groups, () => Promise.resolve(null), HOURLY_WINDOW_MS, NOW);
    assert.equal(due.get("primary"), "group-primary");
  });
});
