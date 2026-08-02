import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { configureScheduler, initScheduler, getSchedulerTaskState, resetSchedulerForTesting } from "@mulmoclaude/core/scheduler";
import { registerScheduledSkills, getScheduledSkills, runScheduledSkillNow } from "../../server/workspace/skills/scheduler.js";
import { runCompletionHook } from "../../server/agent/backgroundSessions.js";
import type { ITaskManager } from "../../server/events/task-manager/index.js";

const stubTm = (over: Partial<ITaskManager> = {}): ITaskManager => ({
  registerTask: () => {},
  removeTask: () => {},
  updateSchedule: () => true,
  start: () => {},
  stop: () => {},
  tick: async () => {},
  listTasks: () => [],
  ...over,
});

async function writeScheduledSkill(root: string, name: string): Promise<void> {
  const dir = join(root, ".claude", "skills", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\ndescription: ${name} description\nschedule: daily 08:00\n---\n\nBody`);
}

afterEach(() => resetSchedulerForTesting());

describe("skill scheduler visibility + manual run (#2012)", () => {
  it("lists a scheduled skill and fires it via runScheduledSkillNow, recording the run", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillsched-"));
    try {
      configureScheduler({
        workspaceRoot: root,
        writeFileAtomic: async (filePath, content) => {
          await mkdir(dirname(filePath), { recursive: true });
          await writeFile(filePath, content);
        },
      });
      await initScheduler(stubTm(), []);
      await writeScheduledSkill(root, "news-filter");

      const calls: { message: string; chatSessionId: string }[] = [];
      await registerScheduledSkills({
        taskManager: stubTm(),
        workspaceRoot: root,
        startChat: async (params) => {
          calls.push({ message: params.message, chatSessionId: params.chatSessionId });
          return { kind: "started" };
        },
      });

      // A: the skill now appears with its task-manager id + parsed schedule.
      const mine = getScheduledSkills().find((skill) => skill.name === "news-filter");
      assert.ok(mine, "scheduled skill appears in getScheduledSkills()");
      assert.equal(mine.id, "skill.news-filter");
      assert.deepEqual(mine.schedule, { type: "daily", time: "08:00" });

      // C: manual run dispatches `/news-filter` and returns the chat session id.
      const chatSessionId = await runScheduledSkillNow("skill.news-filter");
      assert.ok(chatSessionId, "run returns a chat session id");
      assert.equal(calls.length, 1);
      const [call] = calls;
      assert.ok(call);
      assert.equal(call.message, "/news-filter");

      // B: a successful DISPATCH does not record a run yet — the outcome is
      // recorded from the turn's completion hook, not at spawn time (#2057), so
      // a run that spawns but fails its first turn can't log a false success.
      assert.equal(getSchedulerTaskState("skill.news-filter").totalRuns, 0);

      // The turn finishes without error → recorded as a successful run.
      await runCompletionHook(chatSessionId, { didError: false });
      const state = getSchedulerTaskState("skill.news-filter");
      assert.equal(state.totalRuns, 1);
      assert.equal(state.lastRunResult, "success");

      // Unknown id is not a skill → null (route falls through to system/404).
      assert.equal(await runScheduledSkillNow("skill.does-not-exist"), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records the run even when startChat rejects, then rethrows (dispatch failure is not lost)", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillsched-"));
    try {
      configureScheduler({
        workspaceRoot: root,
        writeFileAtomic: async (filePath, content) => {
          await mkdir(dirname(filePath), { recursive: true });
          await writeFile(filePath, content);
        },
      });
      await initScheduler(stubTm(), []);
      await writeScheduledSkill(root, "boom-skill");
      await registerScheduledSkills({
        taskManager: stubTm(),
        workspaceRoot: root,
        startChat: async () => {
          throw new Error("spawn crashed");
        },
      });

      await assert.rejects(() => runScheduledSkillNow("skill.boom-skill"), /spawn crashed/);

      const state = getSchedulerTaskState("skill.boom-skill");
      assert.equal(state.totalRuns, 1);
      assert.equal(state.lastRunResult, "error");
      assert.match(state.lastErrorMessage ?? "", /spawn crashed/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // #2057: the failure this whole family is about — a run that SPAWNS fine but
  // loses the MCP-broker startup race and does nothing. Its completion hook
  // reports didError, so it must be recorded as an error, never a false success.
  it("records a spawned-but-failed turn as an error run, not a false success (#2057)", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillsched-"));
    try {
      configureScheduler({
        workspaceRoot: root,
        writeFileAtomic: async (filePath, content) => {
          await mkdir(dirname(filePath), { recursive: true });
          await writeFile(filePath, content);
        },
      });
      await initScheduler(stubTm(), []);
      await writeScheduledSkill(root, "race-skill");
      await registerScheduledSkills({
        taskManager: stubTm(),
        workspaceRoot: root,
        startChat: async () => ({ kind: "started" }),
      });

      const chatSessionId = await runScheduledSkillNow("skill.race-skill");
      assert.ok(chatSessionId);
      // Dispatch succeeded, so nothing is recorded yet…
      assert.equal(getSchedulerTaskState("skill.race-skill").totalRuns, 0);

      // …then the turn finishes having errored (broker never came up).
      await runCompletionHook(chatSessionId, { didError: true });
      const state = getSchedulerTaskState("skill.race-skill");
      assert.equal(state.totalRuns, 1);
      assert.equal(state.lastRunResult, "error");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The completion hook must be registered BEFORE dispatch: startChat
  // fire-and-forgets the background run, so a fast-finishing turn can complete
  // (finalizeRun → runCompletionHook) before fireScheduledChat's post-await
  // code. If the hook were registered after, that run record would be dropped.
  it("records a run that finishes during dispatch (hook registered pre-dispatch, #2057)", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillsched-"));
    try {
      configureScheduler({
        workspaceRoot: root,
        writeFileAtomic: async (filePath, content) => {
          await mkdir(dirname(filePath), { recursive: true });
          await writeFile(filePath, content);
        },
      });
      await initScheduler(stubTm(), []);
      await writeScheduledSkill(root, "fast-skill");
      await registerScheduledSkills({
        taskManager: stubTm(),
        workspaceRoot: root,
        // Simulate the background run completing DURING dispatch.
        startChat: async (params) => {
          await runCompletionHook(params.chatSessionId, { didError: false });
          return { kind: "started" };
        },
      });

      const chatSessionId = await runScheduledSkillNow("skill.fast-skill");
      assert.ok(chatSessionId);
      // Recorded despite finishing before dispatch returned — hook pre-existed.
      const state = getSchedulerTaskState("skill.fast-skill");
      assert.equal(state.totalRuns, 1);
      assert.equal(state.lastRunResult, "success");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
