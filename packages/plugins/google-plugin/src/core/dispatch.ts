// Server-side router for the `google` tool. Engine calls arrive through
// `context.api` rather than module-scope imports, so "which kind calls which
// engine function with which arguments" can be checked with a stub — while the
// calls were fixed imports, only module mocking could reach that mapping and
// nothing did (#2583). Same shape as `html-plugin/src/core/dispatch.ts`.
import { DEFAULT_LIST_MAX_RESULTS, toolCalendarSyncKey } from "@mulmoclaude/core/google";
import type * as GoogleEngine from "@mulmoclaude/core/google";
import type { PluginRuntime } from "gui-chat-protocol";
import type { GoogleArgs } from "../args";

/** The engine surface the router calls. Signatures are taken from
 *  `@mulmoclaude/core/google` itself, so a change there fails this file
 *  instead of drifting past a hand-written duplicate. */
export type GoogleApi = Pick<
  typeof GoogleEngine,
  | "clearCalendarSyncToken"
  | "clientSecretPresence"
  | "completeTask"
  | "createCalendarEvent"
  | "createDriveFile"
  | "createTask"
  | "deleteCalendarEvent"
  | "deleteTask"
  | "getCalendarColors"
  | "getGoogleAccessToken"
  | "listCalendarEvents"
  | "listCalendars"
  | "listDriveFiles"
  | "listTaskLists"
  | "listTasks"
  | "loadCalendarSyncToken"
  | "loadGoogleTokens"
  | "readDriveFile"
  | "saveCalendarSyncToken"
  | "syncCalendarEvents"
  | "uncompleteTask"
  | "updateCalendarEvent"
  | "updateTask"
>;

export interface GoogleDispatchContext {
  api: GoogleApi;
  /** Narrowed to what the router actually writes, so a test stub stays small. */
  log: Pick<PluginRuntime["log"], "info">;
}

type ArgsOf<K extends GoogleArgs["kind"]> = Extract<GoogleArgs, { kind: K }>;

const LINK_GUIDANCE = "Ask the user to link their Google account in this app's settings, then retry.";

// A sync can legitimately return an entire calendar's history on its first
// run, so the tool answers with counts plus a capped sample — the whole point
// of incremental sync is to stop burning context on calendar data (#2095).
export const SYNC_SAMPLE_LIMIT = 20;

const summarizeSync = (result: GoogleEngine.CalendarSyncResult, incremental: boolean) => {
  const active = result.events.filter((event) => event.status !== "cancelled");
  const cancelled = result.events.length - active.length;
  return {
    ok: true,
    incremental,
    changed: active.length,
    cancelled,
    events: active.slice(0, SYNC_SAMPLE_LIMIT),
    truncated: active.length > SYNC_SAMPLE_LIMIT,
  };
};

// 410 means the stored token aged out; drop it and start clean rather than
// surfacing an error the user can do nothing about.
async function restartFullSync(api: GoogleApi, accessToken: string, calendarId: string | undefined): Promise<GoogleEngine.CalendarSyncResult> {
  await api.clearCalendarSyncToken(toolCalendarSyncKey(calendarId));
  return await api.syncCalendarEvents(accessToken, { calendarId });
}

// This tool's cursor is its own (`toolCalendarSyncKey`): it discards the events
// it reads, so sharing the collections' cursor made each side eat windows the
// other needed (#2850). The events themselves still come from the real
// `calendarId` — only the bookmark is namespaced.
async function runCalendarSync(api: GoogleApi, calendarId: string | undefined, fullResync: boolean): Promise<unknown> {
  const accessToken = await api.getGoogleAccessToken();
  const syncKey = toolCalendarSyncKey(calendarId);
  // Drop the token BEFORE rebuilding, not after: if the full sync then fails
  // mid-way, the next run must still start clean rather than silently resuming
  // from the stale state the user asked to discard.
  if (fullResync) await api.clearCalendarSyncToken(syncKey);
  const storedToken = fullResync ? null : await api.loadCalendarSyncToken(syncKey);
  const first = await api.syncCalendarEvents(accessToken, { calendarId, syncToken: storedToken ?? undefined });
  const result = first.fullResyncRequired ? await restartFullSync(api, accessToken, calendarId) : first;
  // A partial walk has no resume point: storing one would let the next call
  // start after pages this one never read, silently skipping them for good.
  // Guarded here as well as in the engine because `api` is injected, so this
  // seam cannot rely on the engine's own invariant (Codex review #2853).
  if (result.nextSyncToken && !result.pagesExhausted) await api.saveCalendarSyncToken(syncKey, result.nextSyncToken);
  const incremental = Boolean(storedToken) && !first.fullResyncRequired;
  return { ...summarizeSync(result, incremental), expiredToken: first.fullResyncRequired, ...(result.pagesExhausted ? { pagesExhausted: true } : {}) };
}

// One handler per kind, named after the kind, so the router below reads as the
// kind → call table it is.

const status = async ({ api }: GoogleDispatchContext) => {
  const [tokens, clientSecret] = await Promise.all([api.loadGoogleTokens(), api.clientSecretPresence()]);
  const linked = Boolean(tokens?.refresh_token);
  return { ok: true, linked, clientSecret, ...(linked ? {} : { guidance: LINK_GUIDANCE }) };
};

const calendarListCalendars = async ({ api }: GoogleDispatchContext) => ({ ok: true, calendars: await api.listCalendars(await api.getGoogleAccessToken()) });

const calendarColors = async ({ api }: GoogleDispatchContext) => ({ ok: true, colors: await api.getCalendarColors(await api.getGoogleAccessToken()) });

const calendarListEvents = async ({ api }: GoogleDispatchContext, args: ArgsOf<"calendarListEvents">) => {
  const events = await api.listCalendarEvents(await api.getGoogleAccessToken(), {
    calendarId: args.calendarId,
    timeMin: args.timeMin,
    maxResults: args.maxResults ?? DEFAULT_LIST_MAX_RESULTS,
  });
  return { ok: true, events };
};

const calendarSync = async ({ api }: GoogleDispatchContext, args: ArgsOf<"calendarSync">) =>
  await runCalendarSync(api, args.calendarId, args.fullResync ?? false);

const calendarCreateEvent = async ({ api, log }: GoogleDispatchContext, args: ArgsOf<"calendarCreateEvent">) => {
  const event = await api.createCalendarEvent(await api.getGoogleAccessToken(), {
    summary: args.summary,
    startDateTime: args.start,
    endDateTime: args.end,
    description: args.description,
    calendarId: args.calendarId,
    colorId: args.colorId,
  });
  // Log ids only — titles / bodies are personal content.
  log.info("calendar event created", { id: event.id });
  return { ok: true, event };
};

const calendarUpdateEvent = async ({ api, log }: GoogleDispatchContext, args: ArgsOf<"calendarUpdateEvent">) => {
  const event = await api.updateCalendarEvent(await api.getGoogleAccessToken(), {
    eventId: args.eventId,
    summary: args.summary,
    startDateTime: args.start,
    endDateTime: args.end,
    description: args.description,
    calendarId: args.calendarId,
    colorId: args.colorId,
  });
  log.info("calendar event updated", { id: event.id });
  return { ok: true, event };
};

const calendarDeleteEvent = async ({ api, log }: GoogleDispatchContext, args: ArgsOf<"calendarDeleteEvent">) => {
  await api.deleteCalendarEvent(await api.getGoogleAccessToken(), { eventId: args.eventId, calendarId: args.calendarId });
  log.info("calendar event deleted", { id: args.eventId });
  return { ok: true, deleted: args.eventId };
};

const taskListsList = async ({ api }: GoogleDispatchContext) => ({ ok: true, taskLists: await api.listTaskLists(await api.getGoogleAccessToken()) });

const tasksList = async ({ api }: GoogleDispatchContext, args: ArgsOf<"tasksList">) => {
  const tasks = await api.listTasks(await api.getGoogleAccessToken(), {
    taskListId: args.taskListId,
    maxResults: args.maxResults ?? DEFAULT_LIST_MAX_RESULTS,
    showCompleted: args.showCompleted,
  });
  return { ok: true, tasks };
};

const tasksCreate = async ({ api, log }: GoogleDispatchContext, args: ArgsOf<"tasksCreate">) => {
  const task = await api.createTask(await api.getGoogleAccessToken(), {
    title: args.title,
    notes: args.notes,
    due: args.due,
    taskListId: args.taskListId,
  });
  log.info("task created", { id: task.id });
  return { ok: true, task };
};

const tasksUpdate = async ({ api, log }: GoogleDispatchContext, args: ArgsOf<"tasksUpdate">) => {
  const task = await api.updateTask(await api.getGoogleAccessToken(), {
    taskId: args.taskId,
    title: args.title,
    notes: args.notes,
    due: args.due,
    taskListId: args.taskListId,
  });
  log.info("task updated", { id: task.id });
  return { ok: true, task };
};

const tasksComplete = async ({ api }: GoogleDispatchContext, args: ArgsOf<"tasksComplete">) => {
  const task = await api.completeTask(await api.getGoogleAccessToken(), { taskId: args.taskId, taskListId: args.taskListId });
  return { ok: true, task };
};

const tasksUncomplete = async ({ api }: GoogleDispatchContext, args: ArgsOf<"tasksUncomplete">) => {
  const task = await api.uncompleteTask(await api.getGoogleAccessToken(), { taskId: args.taskId, taskListId: args.taskListId });
  return { ok: true, task };
};

const tasksDelete = async ({ api, log }: GoogleDispatchContext, args: ArgsOf<"tasksDelete">) => {
  await api.deleteTask(await api.getGoogleAccessToken(), { taskId: args.taskId, taskListId: args.taskListId });
  log.info("task deleted", { id: args.taskId });
  return { ok: true, deleted: args.taskId };
};

const driveList = async ({ api }: GoogleDispatchContext, args: ArgsOf<"driveList">) => {
  const files = await api.listDriveFiles(await api.getGoogleAccessToken(), { maxResults: args.maxResults ?? DEFAULT_LIST_MAX_RESULTS });
  return { ok: true, files };
};

const driveCreate = async ({ api, log }: GoogleDispatchContext, args: ArgsOf<"driveCreate">) => {
  const file = await api.createDriveFile(await api.getGoogleAccessToken(), { name: args.name, content: args.content, mimeType: args.mimeType });
  log.info("drive file created", { id: file.id });
  return { ok: true, file };
};

const driveRead = async ({ api }: GoogleDispatchContext, args: ArgsOf<"driveRead">) => {
  const { file, content } = await api.readDriveFile(await api.getGoogleAccessToken(), { fileId: args.fileId });
  return { ok: true, file, content };
};

export async function executeGoogleDispatch(context: GoogleDispatchContext, args: GoogleArgs): Promise<unknown> {
  switch (args.kind) {
    case "status":
      return await status(context);
    case "calendarListCalendars":
      return await calendarListCalendars(context);
    case "calendarColors":
      return await calendarColors(context);
    case "calendarListEvents":
      return await calendarListEvents(context, args);
    case "calendarSync":
      return await calendarSync(context, args);
    case "calendarCreateEvent":
      return await calendarCreateEvent(context, args);
    case "calendarUpdateEvent":
      return await calendarUpdateEvent(context, args);
    case "calendarDeleteEvent":
      return await calendarDeleteEvent(context, args);
    case "taskListsList":
      return await taskListsList(context);
    case "tasksList":
      return await tasksList(context, args);
    case "tasksCreate":
      return await tasksCreate(context, args);
    case "tasksUpdate":
      return await tasksUpdate(context, args);
    case "tasksComplete":
      return await tasksComplete(context, args);
    case "tasksUncomplete":
      return await tasksUncomplete(context, args);
    case "tasksDelete":
      return await tasksDelete(context, args);
    case "driveList":
      return await driveList(context, args);
    case "driveCreate":
      return await driveCreate(context, args);
    case "driveRead":
      return await driveRead(context, args);
    default: {
      // Exhaustiveness guard: a new kind without a branch trips this at compile time.
      const exhaustive: never = args;
      throw new Error(`unknown kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}
