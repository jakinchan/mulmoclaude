import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SCHEDULE_TYPES, MISSED_RUN_POLICIES } from "@receptron/task-scheduler";
import {
  createTaskManager,
  configureScheduler,
  initScheduler,
  getSchedulerTasks,
  getSchedulerTaskState,
  getSchedulerLogs,
  recordExternalRun,
  resetSchedulerForTesting,
  TASK_TRIGGERS,
  type ITaskManager,
  type TaskDefinition,
  type SystemTaskDef,
} from "../../src/scheduler/index.ts";
import { collectDueTasks, listTaskSummaries } from "../../src/scheduler/task-manager.ts";

const stubTm = (over: Partial<ITaskManager>): ITaskManager => ({
  registerTask: () => {},
  removeTask: () => {},
  updateSchedule: () => true,
  start: () => {},
  stop: () => {},
  tick: async () => {},
  listTasks: () => [],
  ...over,
});

afterEach(() => resetSchedulerForTesting());

// ── task-manager (tick engine) ────────────────────────────────────

test("tick runs due interval tasks", async () => {
  const ran: string[] = [];
  // A 1-minute interval task is due at UTC midnight (0 ms since midnight).
  const manager = createTaskManager({ tickMs: 60_000, now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0)) });
  manager.registerTask({
    id: "a",
    schedule: { type: SCHEDULE_TYPES.interval, intervalMs: 60_000 },
    run: async () => {
      ran.push("a");
    },
  });
  await manager.tick();
  assert.deepEqual(ran, ["a"]);
});

test("dependsOn enforces ordering within a tick; dependent skipped if dep fails", async () => {
  const order: string[] = [];
  const manager = createTaskManager({ tickMs: 60_000, now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0)) });
  manager.registerTask({
    id: "dep",
    schedule: { type: SCHEDULE_TYPES.interval, intervalMs: 60_000 },
    run: async () => {
      order.push("dep");
    },
  });
  manager.registerTask({
    id: "child",
    dependsOn: "dep",
    schedule: { type: SCHEDULE_TYPES.interval, intervalMs: 60_000 },
    run: async () => {
      order.push("child");
    },
  });
  await manager.tick();
  assert.deepEqual(order, ["dep", "child"]);

  const order2: string[] = [];
  const tm2 = createTaskManager({ tickMs: 60_000, now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0)) });
  tm2.registerTask({
    id: "dep",
    schedule: { type: SCHEDULE_TYPES.interval, intervalMs: 60_000 },
    run: async () => {
      throw new Error("boom");
    },
  });
  tm2.registerTask({
    id: "child",
    dependsOn: "dep",
    schedule: { type: SCHEDULE_TYPES.interval, intervalMs: 60_000 },
    run: async () => {
      order2.push("child");
    },
  });
  await tm2.tick();
  assert.deepEqual(order2, []); // child never runs because dep did not succeed
});

test("staggers the start of independently-due tasks by firingStaggerMs (#2057)", async () => {
  const requestedDelays: number[] = [];
  const ran: string[] = [];
  const manager = createTaskManager({
    tickMs: 60_000,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0)),
    firingStaggerMs: 500,
    sleep: async (delayMs) => {
      requestedDelays.push(delayMs);
    },
  });
  for (const taskId of ["a", "b", "c"]) {
    manager.registerTask({
      id: taskId,
      schedule: { type: SCHEDULE_TYPES.interval, intervalMs: 60_000 },
      run: async () => {
        ran.push(taskId);
      },
    });
  }
  await manager.tick();
  assert.deepEqual(ran.sort(), ["a", "b", "c"]); // every due task still runs this tick
  // First task starts immediately (no sleep); the rest are offset by index * gap.
  assert.deepEqual(requestedDelays, [500, 1000]);
});

test("caps the total stagger to half a tick so tasks never spill into the next tick (#2057)", async () => {
  // Debug-mode shape: tickMs == firingStaggerMs. Without the cap the 2nd task
  // would start a full tick late and ticks would overlap. The cap shrinks the
  // step to (tickMs * 0.5) / (count - 1) = (1000 * 0.5) / 2 = 250ms.
  const requestedDelays: number[] = [];
  const manager = createTaskManager({
    tickMs: 1000,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0)),
    firingStaggerMs: 1000,
    sleep: async (delayMs) => {
      requestedDelays.push(delayMs);
    },
  });
  for (const taskId of ["a", "b", "c"]) {
    manager.registerTask({
      id: taskId,
      schedule: { type: SCHEDULE_TYPES.interval, intervalMs: 1000 },
      run: async () => {},
    });
  }
  await manager.tick();
  assert.deepEqual(requestedDelays, [250, 500]);
  assert.ok(Math.max(...requestedDelays) < 1000, "last start stays within the tick");
});

test("firingStaggerMs: 0 fires all due tasks without any delay", async () => {
  const requestedDelays: number[] = [];
  const manager = createTaskManager({
    tickMs: 60_000,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0)),
    firingStaggerMs: 0,
    sleep: async (delayMs) => {
      requestedDelays.push(delayMs);
    },
  });
  for (const taskId of ["a", "b"]) {
    manager.registerTask({
      id: taskId,
      schedule: { type: SCHEDULE_TYPES.interval, intervalMs: 60_000 },
      run: async () => {},
    });
  }
  await manager.tick();
  assert.deepEqual(requestedDelays, []);
});

test("registerTask rejects duplicate ids; updateSchedule returns false for unknown", () => {
  const manager = createTaskManager();
  manager.registerTask({ id: "a", schedule: { type: SCHEDULE_TYPES.daily, time: "09:00" }, run: async () => {} });
  assert.throws(() => manager.registerTask({ id: "a", schedule: { type: SCHEDULE_TYPES.daily, time: "10:00" }, run: async () => {} }));
  assert.equal(manager.updateSchedule("missing", { type: SCHEDULE_TYPES.daily, time: "10:00" }), false);
  assert.equal(manager.updateSchedule("a", { type: SCHEDULE_TYPES.daily, time: "10:00" }), true);
});

// ── pure helpers extracted from createTaskManager ─────────────────

const makeDef = (over: Partial<TaskDefinition> & { id: string }): TaskDefinition => ({
  schedule: { type: SCHEDULE_TYPES.interval, intervalMs: 60_000 },
  run: async () => {},
  ...over,
});

test("listTaskSummaries strips run and keeps the summary fields", () => {
  const registry = new Map<string, TaskDefinition>();
  assert.deepEqual(listTaskSummaries(registry), []);
  registry.set("a", makeDef({ id: "a", description: "d", dependsOn: "b" }));
  const [summary] = listTaskSummaries(registry);
  assert.deepEqual(summary, {
    id: "a",
    description: "d",
    schedule: { type: SCHEDULE_TYPES.interval, intervalMs: 60_000 },
    dependsOn: "b",
  });
  assert.equal("run" in summary, false);
});

test("collectDueTasks partitions due tasks and skips disabled/not-due", () => {
  const midnight = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
  const registry = new Map<string, TaskDefinition>();
  registry.set("indep", makeDef({ id: "indep" }));
  registry.set("dep", makeDef({ id: "dep", dependsOn: "indep" }));
  registry.set("off", makeDef({ id: "off", enabled: false }));
  registry.set("notDue", makeDef({ id: "notDue", schedule: { type: SCHEDULE_TYPES.daily, time: "09:00" } }));
  const { independent, dependent } = collectDueTasks(midnight, registry, 60_000);
  assert.deepEqual(
    independent.map((def) => def.id),
    ["indep"],
  );
  assert.deepEqual(
    dependent.map((def) => def.id),
    ["dep"],
  );
});

// ── adapter (catch-up + persistence + state) ──────────────────────

function configure(root: string): void {
  configureScheduler({
    workspaceRoot: root,
    writeFileAtomic: async (filePath, content) => {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, content);
    },
  });
}

test("initScheduler registers system tasks with the task-manager and exposes their state", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "sched-"));
  try {
    configure(root);
    const registered: string[] = [];
    const fakeTm = stubTm({
      registerTask: (def: TaskDefinition) => {
        registered.push(def.id);
      },
    });
    const tasks: SystemTaskDef[] = [
      {
        id: "system:journal",
        name: "Journal",
        description: "d",
        schedule: { type: SCHEDULE_TYPES.interval, intervalMs: 3_600_000 },
        missedRunPolicy: MISSED_RUN_POLICIES.runOnce,
        run: async () => {},
      },
    ];
    await initScheduler(fakeTm, tasks);
    assert.deepEqual(registered, ["system:journal"]);
    const states = getSchedulerTasks();
    assert.equal(states.length, 1);
    const [journalState] = states;
    assert.ok(journalState);
    assert.equal(journalState.id, "system:journal");
    // state.json directory was created under the injected workspace root.
    assert.ok(existsSync(path.join(root, "config", "scheduler")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a scheduled run executes the task and persists state to the injected workspace", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "sched-"));
  try {
    configure(root);
    let ran = 0;
    const captured: { run?: TaskDefinition["run"] } = {};
    const fakeTm = stubTm({
      registerTask: (def: TaskDefinition) => {
        captured.run = def.run;
      },
    });
    await initScheduler(fakeTm, [
      {
        id: "system:feed",
        name: "Feed",
        description: "d",
        schedule: { type: SCHEDULE_TYPES.interval, intervalMs: 3_600_000 },
        missedRunPolicy: MISSED_RUN_POLICIES.runOnce,
        run: async () => {
          ran++;
        },
      },
    ]);
    const runThunk = captured.run;
    assert.ok(runThunk, "task-manager received a run thunk");
    await runThunk({ taskId: "system:feed", now: new Date() });
    assert.equal(ran, 1);
    const statePath = path.join(root, "config", "scheduler", "state.json");
    assert.ok(existsSync(statePath));
    const persisted = JSON.parse(readFileSync(statePath, "utf-8"));
    assert.ok(JSON.stringify(persisted).includes("system:feed"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── external (skill / user) runs — #2012 ──────────────────────────

test("recordExternalRun persists state + a log entry, readable via getSchedulerTaskState", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "sched-"));
  try {
    configure(root);
    await initScheduler(stubTm({}), []); // no system tasks — just load state + create dirs

    const before = getSchedulerTaskState("skill.news-filter");
    assert.equal(before.totalRuns, 0);
    assert.equal(before.lastRunAt, null);

    // Log files partition by the run's `startedAt` day and getSchedulerLogs
    // reads today's partition, so use a same-day timestamp here.
    const now = new Date().toISOString();
    await recordExternalRun({
      id: "skill.news-filter",
      name: "news-filter",
      schedule: { type: SCHEDULE_TYPES.daily, time: "07:30" },
      scheduledFor: now,
      startedAt: now,
      durationMs: 5,
      trigger: TASK_TRIGGERS.scheduled,
      errorMessage: null,
      chatSessionId: "chat-123",
    });

    const after = getSchedulerTaskState("skill.news-filter");
    assert.equal(after.totalRuns, 1);
    assert.equal(after.lastRunResult, "success");
    assert.equal(after.lastRunAt, now);
    assert.ok(after.nextScheduledAt, "next run computed from the daily schedule");

    const logs = await getSchedulerLogs({ taskId: "skill.news-filter" });
    assert.equal(logs.length, 1);
    const [scheduledLog] = logs;
    assert.ok(scheduledLog);
    assert.equal(scheduledLog.trigger, "scheduled");
    assert.equal(scheduledLog.chatSessionId, "chat-123");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recordExternalRun records a failed dispatch as an error run", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "sched-"));
  try {
    configure(root);
    await initScheduler(stubTm({}), []);
    const now = new Date().toISOString();
    await recordExternalRun({
      id: "user.abc",
      name: "my task",
      schedule: { type: SCHEDULE_TYPES.interval, intervalMs: 3_600_000 },
      scheduledFor: now,
      startedAt: now,
      durationMs: 1,
      trigger: TASK_TRIGGERS.manual,
      errorMessage: "too many background sessions",
    });
    const state = getSchedulerTaskState("user.abc");
    assert.equal(state.lastRunResult, "error");
    assert.equal(state.lastErrorMessage, "too many background sessions");
    assert.equal(state.consecutiveFailures, 1);
    const [errorLog] = await getSchedulerLogs({ taskId: "user.abc" });
    assert.ok(errorLog);
    assert.equal(errorLog.result, "error");
    assert.equal(errorLog.errorMessage, "too many background sessions");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// `makeGuardedTick` has a `finally` but no `catch`, so a tick that rejects
// propagates. Awaiting `tick()` hands that to the caller, which is fine — but
// `start()` drives the same function from `setInterval`, where a rejection has
// nowhere to go and the host turns it into a process exit. One bad tick used to
// be able to take the server down; this pins that it no longer can, and that
// the interval keeps firing afterwards.
test("start(): a rejected tick is logged and later ticks keep running", async () => {
  const errors: string[] = [];
  let nowCalls = 0;
  const manager = createTaskManager({
    tickMs: 5,
    log: { info: () => {}, warn: () => {}, error: (message) => errors.push(message) },
    // `runTick` calls `now()` first thing, so throwing here rejects the tick
    // itself rather than an individual task (those are caught per-task).
    now: () => {
      nowCalls += 1;
      throw new Error("clock exploded");
    },
  });

  manager.start();
  await new Promise((resolve) => setTimeout(resolve, 60));
  manager.stop();

  assert.ok(nowCalls >= 2, `interval stopped after the first rejection (${nowCalls} tick(s))`);
  assert.ok(errors.includes("tick failed"), `expected a "tick failed" log, got ${JSON.stringify(errors)}`);
});
