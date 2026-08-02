// API routes for the unified scheduler (#357).
//
//   GET    /api/scheduler/tasks        — all registered tasks + state
//   POST   /api/scheduler/tasks        — create user task
//   PUT    /api/scheduler/tasks/:id    — update user task
//   DELETE /api/scheduler/tasks/:id    — delete user task
//   POST   /api/scheduler/tasks/:id/run — manual trigger
//   GET    /api/scheduler/logs         — execution log (newest first)

import { Router, type Request } from "express";
import { getSchedulerTasks, getSchedulerLogs, getSchedulerTaskState } from "../../events/scheduler-adapter.js";
import type { TaskLogEntry } from "@receptron/task-scheduler";
import { API_ROUTES } from "../../../src/config/apiRoutes.js";
import { bindRoute } from "../../utils/router.js";
import {
  loadUserTasks,
  validateAndCreate,
  applyUpdate,
  withUserTaskLock,
  runUserTaskNow,
  userTaskManagerId,
  type PersistedUserTask,
} from "../../workspace/skills/user-tasks.js";
import { getScheduledSkills, runScheduledSkillNow } from "../../workspace/skills/scheduler.js";
import { badRequest, notFound, type ApiResponse } from "../../utils/httpError.js";
import { errorMessage } from "../../utils/errors.js";
import { getOptionalStringQuery } from "../../utils/request.js";
import { singleLineForLog } from "../../utils/logPreview.js";
import { log } from "../../system/logger/index.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

const router = Router();

// ── List all tasks ──────────────────────────────────────────────

bindRoute(
  router,
  API_ROUTES.scheduler.tasksList,
  asyncHandler("scheduler-tasks", "Failed to list tasks", async (_req, res) => {
    log.info("scheduler-tasks", "list: start");
    // Three registration paths, unified here with an `origin` tag the client
    // renders as a badge. System tasks carry their own state (they run through
    // the adapter); user + skill tasks register directly on the task-manager,
    // so we attach their execution state by their prefixed task-manager id.
    const systemTasks = getSchedulerTasks();
    const userTasks = loadUserTasks();
    const skillTasks = getScheduledSkills();
    const all = [
      ...systemTasks.map((task) => ({ ...task, origin: "system" as const })),
      ...userTasks.map((task) => ({ ...task, origin: "user" as const, state: getSchedulerTaskState(userTaskManagerId(task.id)) })),
      ...skillTasks.map((task) => ({ ...task, origin: "skill" as const, state: getSchedulerTaskState(task.id) })),
    ];
    log.info("scheduler-tasks", "list: ok", { system: systemTasks.length, user: userTasks.length, skill: skillTasks.length });
    res.json({ tasks: all });
  }),
);

// ── Create user task ────────────────────────────────────────────

bindRoute(
  router,
  API_ROUTES.scheduler.tasksCreate,
  asyncHandler("scheduler-tasks", "Failed to create task", async (req, res) => {
    log.info("scheduler-tasks", "create: start");
    const validated = validateAndCreate(req.body);
    if (validated.kind === "error") {
      // Same vector as the update path: `validated.error` is built from
      // `req.body`, so it carries request-controlled text into the log.
      log.warn("scheduler-tasks", "create: validation failed", { error: singleLineForLog(validated.error) });
      badRequest(res, validated.error);
      return;
    }
    const task = await withUserTaskLock(async (tasks) => ({
      tasks: [...tasks, validated.task],
      result: validated.task,
    }));
    log.info("scheduler-tasks", "create: ok", { id: task.id, name: task.name });
    res.status(201).json({ task });
  }),
);

// ── Update user task ────────────────────────────────────────────

bindRoute(
  router,
  API_ROUTES.scheduler.taskUpdate,
  asyncHandler<Request<{ id: string }>, ApiResponse<{ task: PersistedUserTask | undefined }>>("scheduler-tasks", "Failed to update task", async (req, res) => {
    const { id: taskId } = req.params;
    // Raw `taskId` drives lookup and dispatch; the sanitised copy is for logs only.
    const taskIdForLog = singleLineForLog(taskId);
    log.info("scheduler-tasks", "update: start", { taskId: taskIdForLog });
    try {
      const updated = await withUserTaskLock(async (tasks) => {
        const result = applyUpdate(tasks, taskId, req.body);
        if (result.kind === "error") {
          throw new Error(result.error);
        }
        const task = result.tasks.find((taskItem) => taskItem.id === taskId);
        return { tasks: result.tasks, result: task };
      });
      log.info("scheduler-tasks", "update: ok", { taskId: taskIdForLog });
      res.json({ task: updated });
    } catch (err) {
      // Domain-shaped errors → 404; everything else rethrows for the
      // asyncHandler wrapper to surface as 500.
      const msg = errorMessage(err);
      if (msg.startsWith("task not found") || msg.startsWith("request body")) {
        // `msg` embeds the raw taskId (`task not found: <id>`), so sanitising
        // the taskId field alone would leave the same CR/LF through this one.
        // The response keeps the raw message.
        log.warn("scheduler-tasks", "update: validation failed", { taskId: taskIdForLog, reason: singleLineForLog(msg) });
        notFound(res, msg);
        return;
      }
      throw err;
    }
  }),
);

// ── Delete user task ────────────────────────────────────────────

bindRoute(
  router,
  API_ROUTES.scheduler.taskDelete,
  asyncHandler<Request<{ id: string }>, ApiResponse<{ deleted: string }>>("scheduler-tasks", "Failed to delete task", async (req, res) => {
    const { id: taskId } = req.params;
    // Raw `taskId` drives lookup and dispatch; the sanitised copy is for logs only.
    const taskIdForLog = singleLineForLog(taskId);
    log.info("scheduler-tasks", "delete: start", { taskId: taskIdForLog });
    try {
      await withUserTaskLock(async (tasks) => {
        const index = tasks.findIndex((task) => task.id === taskId);
        if (index === -1) throw new Error(`task not found: ${taskId}`);
        const next = tasks.filter((task) => task.id !== taskId);
        return { tasks: next, result: undefined };
      });
      log.info("scheduler-tasks", "delete: ok", { taskId: taskIdForLog });
      res.json({ deleted: taskId });
    } catch (err) {
      const msg = errorMessage(err);
      if (msg.startsWith("task not found")) {
        log.warn("scheduler-tasks", "delete: not found", { taskId: taskIdForLog });
        notFound(res, msg);
        return;
      }
      throw err;
    }
  }),
);

// ── Manual trigger ──────────────────────────────────────────────

bindRoute(
  router,
  API_ROUTES.scheduler.taskRun,
  asyncHandler<Request<{ id: string }>, ApiResponse<{ triggered: string; chatSessionId?: string }>>(
    "scheduler-tasks",
    "Failed to run task",
    async (req, res) => {
      const { id: taskId } = req.params;
      // Raw `taskId` drives lookup and dispatch; the sanitised copy is for logs only.
      const taskIdForLog = singleLineForLog(taskId);
      log.info("scheduler-tasks", "run: start", { taskId: taskIdForLog });

      // User task (unprefixed id) — dispatch its prompt + record the run.
      const userChatSessionId = await runUserTaskNow(taskId);
      if (userChatSessionId) {
        log.info("scheduler-tasks", "run: user task triggered", { taskId: taskIdForLog, chatSessionId: userChatSessionId });
        res.json({ triggered: taskId, chatSessionId: userChatSessionId });
        return;
      }

      // Skill task (`skill.<name>` id) — dispatch `/skill-name` + record the run.
      const skillChatSessionId = await runScheduledSkillNow(taskId);
      if (skillChatSessionId) {
        log.info("scheduler-tasks", "run: skill task triggered", { taskId: taskIdForLog, chatSessionId: skillChatSessionId });
        res.json({ triggered: taskId, chatSessionId: skillChatSessionId });
        return;
      }

      // System tasks have no prompt to dispatch; everything else is unknown.
      if (getSchedulerTasks().some((task) => task.id === taskId)) {
        log.warn("scheduler-tasks", "run: refused (system task)", { taskId: taskIdForLog });
        badRequest(res, "manual run is only supported for user and skill tasks");
        return;
      }
      log.warn("scheduler-tasks", "run: not found", { taskId: taskIdForLog });
      notFound(res, `task not found: ${taskId}`);
    },
  ),
);

// ── Execution logs ──────────────────────────────────────────────

interface LogQuery {
  since?: string | undefined;
  taskId?: string | undefined;
  limit?: string | undefined;
}

bindRoute(
  router,
  API_ROUTES.scheduler.logs,
  asyncHandler<Request<object, unknown, object, LogQuery>, ApiResponse<{ logs: TaskLogEntry[] }>>(
    "scheduler-tasks",
    "Failed to read scheduler logs",
    async (req, res) => {
      const MAX_LIMIT = 500;
      const rawLimitStr = getOptionalStringQuery(req, "limit");
      const rawLimit = rawLimitStr ? parseInt(rawLimitStr, 10) : undefined;
      const limit = rawLimit !== undefined && Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : undefined;
      const taskId = getOptionalStringQuery(req, "taskId");
      const taskIdForLog = singleLineForLog(taskId);
      log.info("scheduler-tasks", "logs: start", { taskId: taskIdForLog, limit });
      const logs = await getSchedulerLogs({
        since: getOptionalStringQuery(req, "since"),
        taskId,
        limit,
      });
      log.info("scheduler-tasks", "logs: ok", { entries: logs.length, taskId: taskIdForLog });
      res.json({ logs });
    },
  ),
);

export default router;
