// Unit tests for the calendar sync-token store (#2095). The token lives IN
// the workspace (unlike the OAuth token) because it describes which records
// the workspace already holds — these tests pin the path and the per-calendar
// isolation that the incremental sync depends on.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  calendarSyncStatePath,
  claimCalendarSyncIfDue,
  clearCalendarLastSyncedAt,
  clearCalendarSyncToken,
  loadCalendarLastSyncedAt,
  loadCalendarSyncToken,
  saveCalendarSyncToken,
} from "@mulmoclaude/core/google";

/** The unconditional claim every user-facing door makes. */
const ALWAYS = () => true;
const saveCalendarLastSyncedAt = (calendarId: string | undefined, startedAt: string, workspaceRoot: string) =>
  claimCalendarSyncIfDue(calendarId, startedAt, ALWAYS, workspaceRoot);

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "calendar-sync-store-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("calendar sync-token store (#2095)", () => {
  it("stores the state next to the calendar data inside the workspace", () => {
    assert.equal(calendarSyncStatePath(workspace), join(workspace, "data", "calendar", ".sync-state.json"));
  });

  it("returns null before anything has been synced", async () => {
    assert.equal(await loadCalendarSyncToken(undefined, workspace), null);
  });

  it("round-trips a token", async () => {
    await saveCalendarSyncToken(undefined, "tok-1", workspace);
    assert.equal(await loadCalendarSyncToken(undefined, workspace), "tok-1");
  });

  it("keeps a separate token per calendar", async () => {
    await saveCalendarSyncToken("work@group.calendar.google.com", "tok-work", workspace);
    await saveCalendarSyncToken("home@group.calendar.google.com", "tok-home", workspace);
    assert.equal(await loadCalendarSyncToken("work@group.calendar.google.com", workspace), "tok-work");
    assert.equal(await loadCalendarSyncToken("home@group.calendar.google.com", workspace), "tok-home");
  });

  it("treats an absent calendarId as the primary calendar", async () => {
    await saveCalendarSyncToken(undefined, "tok-primary", workspace);
    assert.equal(await loadCalendarSyncToken("primary", workspace), "tok-primary");
  });

  it("overwrites the token for the same calendar", async () => {
    await saveCalendarSyncToken(undefined, "tok-1", workspace);
    await saveCalendarSyncToken(undefined, "tok-2", workspace);
    assert.equal(await loadCalendarSyncToken(undefined, workspace), "tok-2");
  });

  it("clears only the targeted calendar's token (the 410 recovery path)", async () => {
    await saveCalendarSyncToken("a", "tok-a", workspace);
    await saveCalendarSyncToken("b", "tok-b", workspace);
    await clearCalendarSyncToken("a", workspace);
    assert.equal(await loadCalendarSyncToken("a", workspace), null);
    assert.equal(await loadCalendarSyncToken("b", workspace), "tok-b");
  });

  it("clearing an unknown calendar is a no-op, not a crash", async () => {
    await clearCalendarSyncToken("never-synced", workspace);
    assert.equal(await loadCalendarSyncToken("never-synced", workspace), null);
  });

  // All calendars share one state file, so an unguarded read-modify-write let
  // the later save clobber the earlier one's token (CodeRabbit review on
  // #2182) — silently forcing that calendar into a full re-walk next run.
  it("does not lose a token when several calendars are saved concurrently", async () => {
    await Promise.all([
      saveCalendarSyncToken("a", "tok-a", workspace),
      saveCalendarSyncToken("b", "tok-b", workspace),
      saveCalendarSyncToken("c", "tok-c", workspace),
    ]);
    assert.equal(await loadCalendarSyncToken("a", workspace), "tok-a");
    assert.equal(await loadCalendarSyncToken("b", workspace), "tok-b");
    assert.equal(await loadCalendarSyncToken("c", workspace), "tok-c");
  });

  it("keeps concurrent save and clear of different calendars independent", async () => {
    await saveCalendarSyncToken("keep", "tok-keep", workspace);
    await Promise.all([saveCalendarSyncToken("added", "tok-added", workspace), clearCalendarSyncToken("keep", workspace)]);
    assert.equal(await loadCalendarSyncToken("keep", workspace), null);
    assert.equal(await loadCalendarSyncToken("added", workspace), "tok-added");
  });
});

// The marker several hosts read to see that a calendar is already being synced
// (#2678). It shares the state file with the tokens, so what these pin is mostly
// that the two maps stay independent — the token answers "how far have we read",
// the marker "when did anyone last start".
describe("calendar sync marker (#2678)", () => {
  const stamp = "2026-08-01T09:00:03.412Z";

  it("returns null before any host has synced", async () => {
    assert.equal(await loadCalendarLastSyncedAt(undefined, workspace), null);
  });

  it("round-trips a marker", async () => {
    await saveCalendarLastSyncedAt(undefined, stamp, workspace);
    assert.equal(await loadCalendarLastSyncedAt(undefined, workspace), stamp);
  });

  it("keeps a separate marker per calendar", async () => {
    await saveCalendarLastSyncedAt("work@group.calendar.google.com", stamp, workspace);
    assert.equal(await loadCalendarLastSyncedAt("home@group.calendar.google.com", workspace), null);
  });

  it("treats an absent calendarId as the primary calendar, like the token does", async () => {
    await saveCalendarLastSyncedAt(undefined, stamp, workspace);
    assert.equal(await loadCalendarLastSyncedAt("primary", workspace), stamp);
  });

  it("clears only the targeted calendar's marker (the failed-run release)", async () => {
    await saveCalendarLastSyncedAt("a", stamp, workspace);
    await saveCalendarLastSyncedAt("b", stamp, workspace);
    await clearCalendarLastSyncedAt("a", workspace);
    assert.equal(await loadCalendarLastSyncedAt("a", workspace), null);
    assert.equal(await loadCalendarLastSyncedAt("b", workspace), stamp);
  });

  // Both maps live in one file, so a save of either one reads-modifies-writes
  // the whole thing — the trap that would silently drop the other map.
  it("does not drop the token when the marker is written, or the reverse", async () => {
    await saveCalendarSyncToken("a", "tok-a", workspace);
    await saveCalendarLastSyncedAt("a", stamp, workspace);
    assert.equal(await loadCalendarSyncToken("a", workspace), "tok-a");
    assert.equal(await loadCalendarLastSyncedAt("a", workspace), stamp);
  });

  it("keeps the marker when the token is cleared for a full re-walk (410)", async () => {
    await saveCalendarLastSyncedAt("a", stamp, workspace);
    await saveCalendarSyncToken("a", "tok-a", workspace);
    await clearCalendarSyncToken("a", workspace);
    assert.equal(await loadCalendarLastSyncedAt("a", workspace), stamp);
  });

  it("does not lose a marker when several calendars are stamped concurrently", async () => {
    await Promise.all([
      saveCalendarLastSyncedAt("a", stamp, workspace),
      saveCalendarLastSyncedAt("b", stamp, workspace),
      saveCalendarSyncToken("c", "tok-c", workspace),
    ]);
    assert.equal(await loadCalendarLastSyncedAt("a", workspace), stamp);
    assert.equal(await loadCalendarLastSyncedAt("b", workspace), stamp);
    assert.equal(await loadCalendarSyncToken("c", workspace), "tok-c");
  });

  // A workspace synced before this existed holds a file with `tokens` only.
  it("reads a state file written before the marker existed", async () => {
    const statePath = calendarSyncStatePath(workspace);
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify({ tokens: { primary: "tok-old" } }));
    assert.equal(await loadCalendarSyncToken(undefined, workspace), "tok-old");
    assert.equal(await loadCalendarLastSyncedAt(undefined, workspace), null);
    await saveCalendarLastSyncedAt(undefined, stamp, workspace);
    assert.equal(await loadCalendarSyncToken(undefined, workspace), "tok-old");
  });

  // The claim decides from the state it is about to write, in one pass through
  // the write queue. Deciding from a snapshot read earlier is what let two hosts
  // both conclude the calendar was free (Codex review on PR #2680).
  it("refuses the claim when the guard rejects what the marker says", async () => {
    await saveCalendarLastSyncedAt("a", stamp, workspace);
    const claimed = await claimCalendarSyncIfDue("a", "2026-08-01T09:30:00.000Z", (lastSyncedAt) => lastSyncedAt === null, workspace);
    assert.equal(claimed, false);
    assert.equal(await loadCalendarLastSyncedAt("a", workspace), stamp);
  });

  it("takes the claim when the guard accepts, and reports which call took it", async () => {
    const claimed = await claimCalendarSyncIfDue("a", stamp, (lastSyncedAt) => lastSyncedAt === null, workspace);
    assert.equal(claimed, true);
    assert.equal(await loadCalendarLastSyncedAt("a", workspace), stamp);
  });

  it("lets exactly one of two concurrent claims through", async () => {
    const untaken = (lastSyncedAt: string | null) => lastSyncedAt === null;
    const outcomes = await Promise.all([
      claimCalendarSyncIfDue("a", "2026-08-01T09:00:00.000Z", untaken, workspace),
      claimCalendarSyncIfDue("a", "2026-08-01T09:00:01.000Z", untaken, workspace),
    ]);
    assert.deepEqual(outcomes.filter(Boolean).length, 1);
    assert.equal(await loadCalendarLastSyncedAt("a", workspace), "2026-08-01T09:00:00.000Z");
  });

  it("keeps the claims of different calendars independent", async () => {
    const untaken = (lastSyncedAt: string | null) => lastSyncedAt === null;
    await saveCalendarLastSyncedAt("a", stamp, workspace);
    assert.equal(await claimCalendarSyncIfDue("b", stamp, untaken, workspace), true);
  });

  // Hand-edited or half-migrated files must degrade to "nothing stored", not
  // throw: a stuck sync is worse than a duplicate run.
  it("reads a malformed state file as empty rather than throwing", async () => {
    const statePath = calendarSyncStatePath(workspace);
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify({ tokens: "not-a-map", lastSyncedAt: { primary: 42 } }));
    assert.equal(await loadCalendarSyncToken(undefined, workspace), null);
    assert.equal(await loadCalendarLastSyncedAt(undefined, workspace), null);
  });
});
