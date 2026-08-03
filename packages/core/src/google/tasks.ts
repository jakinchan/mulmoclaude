// Google Tasks v1 REST calls. `@default` is Google's alias for the user's
// default task list, so callers can stay list-agnostic.
import { asRecord, googleRequest, itemsOf, stringField, DEFAULT_LIST_MAX_RESULTS } from "./apiClient.js";

const TASKS_BASE_URL = "https://tasks.googleapis.com/tasks/v1";
const TASKS_API_LABEL = "Google Tasks API";
const DEFAULT_TASK_LIST_ID = "@default";
const TASK_STATUS_COMPLETED = "completed";
const TASK_STATUS_NEEDS_ACTION = "needsAction";
const MAX_TASK_LISTS = 50;

export interface TaskListSummary {
  id: string;
  title: string;
}

export interface TaskSummary {
  id: string;
  title: string;
  status: string;
  due: string;
  notes: string;
}

export interface ListTasksInput {
  taskListId?: string | undefined;
  maxResults?: number | undefined;
  showCompleted?: boolean | undefined;
}

export interface CreateTaskInput {
  title: string;
  notes?: string | undefined;
  /** RFC3339. Google stores a DATE only — the time part is recorded but
   *  ignored by the UI, so callers should not promise time-of-day fidelity. */
  due?: string | undefined;
  taskListId?: string | undefined;
}

export interface CompleteTaskInput {
  taskId: string;
  taskListId?: string | undefined;
}

export interface UpdateTaskInput {
  taskId: string;
  title?: string | undefined;
  /** `""` clears the notes; omit to leave them untouched. */
  notes?: string | undefined;
  /** RFC3339. Same DATE-only caveat as `CreateTaskInput.due`. Google rejects
   *  `""`, so a due date can be changed but not removed through this call. */
  due?: string | undefined;
  taskListId?: string | undefined;
}

export const toTaskListSummary = (value: unknown): TaskListSummary => {
  const record = asRecord(value);
  return { id: stringField(record, "id"), title: stringField(record, "title") };
};

export const toTaskSummary = (value: unknown): TaskSummary => {
  const record = asRecord(value);
  return {
    id: stringField(record, "id"),
    title: stringField(record, "title"),
    status: stringField(record, "status"),
    due: stringField(record, "due"),
    notes: stringField(record, "notes"),
  };
};

/** Resolve a declared taskListId to the one the API addresses. `||` (not `??`)
 *  so a blank string also falls back instead of building a malformed
 *  `/lists//tasks` URL — the same rule, and the same reason, as
 *  `canonicalCalendarId`. */
export const canonicalTaskListId = (taskListId: string | undefined): string => taskListId?.trim() || DEFAULT_TASK_LIST_ID;

const tasksUrl = (taskListId: string | undefined, suffix = ""): string =>
  `${TASKS_BASE_URL}/lists/${encodeURIComponent(canonicalTaskListId(taskListId))}/tasks${suffix}`;

export async function listTaskLists(accessToken: string): Promise<TaskListSummary[]> {
  const listed = await googleRequest(TASKS_API_LABEL, accessToken, `${TASKS_BASE_URL}/users/@me/lists?maxResults=${MAX_TASK_LISTS}`);
  return itemsOf(listed).map(toTaskListSummary);
}

export async function listTasks(accessToken: string, input: ListTasksInput = {}): Promise<TaskSummary[]> {
  const params = new URLSearchParams({
    maxResults: String(input.maxResults ?? DEFAULT_LIST_MAX_RESULTS),
    showCompleted: String(input.showCompleted ?? false),
  });
  const listed = await googleRequest(TASKS_API_LABEL, accessToken, `${tasksUrl(input.taskListId)}?${params.toString()}`);
  return itemsOf(listed).map(toTaskSummary);
}

export async function createTask(accessToken: string, input: CreateTaskInput): Promise<TaskSummary> {
  const body = { title: input.title, notes: input.notes, due: input.due };
  const created = await googleRequest(TASKS_API_LABEL, accessToken, tasksUrl(input.taskListId), { method: "POST", body: JSON.stringify(body) });
  return toTaskSummary(created);
}

/** PATCH body for a task edit — only the fields the caller supplied. As with
 *  events, `undefined` means "leave as is" and `""` means "clear it", so the
 *  two must stay distinct. `status` is deliberately absent: `completeTask` /
 *  `uncompleteTask` own that transition, and two ways to set it would drift
 *  apart. */
export const buildTaskPatch = (input: UpdateTaskInput): Record<string, unknown> => ({
  ...(input.title !== undefined ? { title: input.title } : {}),
  ...(input.notes !== undefined ? { notes: input.notes } : {}),
  ...(input.due !== undefined ? { due: input.due } : {}),
});

export async function updateTask(accessToken: string, input: UpdateTaskInput): Promise<TaskSummary> {
  const url = tasksUrl(input.taskListId, `/${encodeURIComponent(input.taskId)}`);
  const updated = await googleRequest(TASKS_API_LABEL, accessToken, url, { method: "PATCH", body: JSON.stringify(buildTaskPatch(input)) });
  return toTaskSummary(updated);
}

/** The only two states this module transitions a task between. Spelled as a
 *  union rather than `string` so the compiler, not just the doc comment,
 *  enforces that there is no third one. */
type TaskStatus = typeof TASK_STATUS_COMPLETED | typeof TASK_STATUS_NEEDS_ACTION;

/** Shared body of the two status transitions. PATCH keeps the rest of the task
 *  intact — a PUT would need the full body and would silently drop fields the
 *  caller never read. Private on purpose: the exported `completeTask` /
 *  `uncompleteTask` names are the API, so no caller can invent a third target
 *  state by passing an arbitrary status through. */
async function patchTaskStatus(accessToken: string, input: CompleteTaskInput, status: TaskStatus): Promise<TaskSummary> {
  const url = tasksUrl(input.taskListId, `/${encodeURIComponent(input.taskId)}`);
  const updated = await googleRequest(TASKS_API_LABEL, accessToken, url, { method: "PATCH", body: JSON.stringify({ status }) });
  return toTaskSummary(updated);
}

export async function completeTask(accessToken: string, input: CompleteTaskInput): Promise<TaskSummary> {
  return patchTaskStatus(accessToken, input, TASK_STATUS_COMPLETED);
}

/** Send a completed task back to the to-do list.
 *
 *  Its own function rather than a flag on `completeTask`, and deliberately not
 *  a `status` field on `updateTask`: one kind per target state keeps the name
 *  honest and leaves exactly one code path setting each value.
 *
 *  The patch carries `status` alone — mirroring `completeTask`, which also
 *  sets only `status` and lets Google fill in the `completed` timestamp. Note
 *  that whether Google *clears* that timestamp on the way back is its
 *  behaviour, not ours, and is unverified here: `TaskSummary` doesn't carry
 *  `completed`, so nothing in this codebase would show a stale one. If a
 *  reopened task ever displays a completion date in Google's own UI, this is
 *  the place to add `completed: null` to the patch. */
export async function uncompleteTask(accessToken: string, input: CompleteTaskInput): Promise<TaskSummary> {
  return patchTaskStatus(accessToken, input, TASK_STATUS_NEEDS_ACTION);
}

export async function deleteTask(accessToken: string, input: CompleteTaskInput): Promise<void> {
  const url = tasksUrl(input.taskListId, `/${encodeURIComponent(input.taskId)}`);
  await googleRequest(TASKS_API_LABEL, accessToken, url, { method: "DELETE" });
}
