// The scheduled feed refresh is root-parameterised: a multi-root host registers
// one task def per project it wants refreshed. A task id is the scheduler's
// primary key, so the ids have to differ — N roots under one id and only the
// last registration would ever run, with the rest silently never refreshing.
//
// The root-less call keeps the historical id, because it is the row a
// single-workspace host's persisted scheduler state already points at.
import { test } from "node:test";
import assert from "node:assert/strict";

import { feedRefreshTaskDef, feedRefreshTaskId, FEED_REFRESH_TASK_ID, DEFAULT_FEED_REFRESH_INTERVAL_MS } from "../../src/feeds/server/scheduledRefresh.ts";

test("no root keeps the historical id, name and cadence", () => {
  const def = feedRefreshTaskDef();
  assert.equal(def.id, FEED_REFRESH_TASK_ID);
  assert.equal(feedRefreshTaskId(), FEED_REFRESH_TASK_ID);
  assert.equal(def.name, "Scheduled collection refresh");
  assert.deepEqual(def.schedule, { type: "interval", intervalMs: DEFAULT_FEED_REFRESH_INTERVAL_MS });
});

test("each root gets its own id, so per-project registrations do not overwrite each other", () => {
  const defA = feedRefreshTaskDef({ workspaceRoot: "/tmp/proj-a" });
  const defB = feedRefreshTaskDef({ workspaceRoot: "/tmp/proj-b" });
  assert.notEqual(defA.id, defB.id);
  assert.notEqual(defA.id, FEED_REFRESH_TASK_ID);
  assert.equal(defA.id, feedRefreshTaskId("/tmp/proj-a"));
  // The name says which project, so a scheduler UI listing N rows is readable.
  assert.match(defA.name, /proj-a/);
});

test("a per-root def still honours the interval override", () => {
  const def = feedRefreshTaskDef({ workspaceRoot: "/tmp/proj-a", intervalMs: 1234 });
  assert.deepEqual(def.schedule, { type: "interval", intervalMs: 1234 });
});
