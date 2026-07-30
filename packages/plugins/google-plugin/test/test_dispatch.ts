// What each `kind` actually calls, and with which arguments. The engine is a
// stub here — no network, no token file — which is the point: before the
// router took its dependencies through a context (#2583) this mapping was only
// reachable by mocking modules, so nothing checked it and a kind wired to the
// wrong call or the wrong field name would have shipped silently.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_LIST_MAX_RESULTS, type CalendarEventSummary, type CalendarSyncResult, type ClientSecretPresence } from "@mulmoclaude/core/google";

import { GoogleArgs } from "../src/args";
import { executeGoogleDispatch, SYNC_SAMPLE_LIMIT, type GoogleApi, type GoogleDispatchContext } from "../src/core/dispatch";
import { TOOL_DEFINITION } from "../src/definition";

const ACCESS_TOKEN = "test-access-token";
const NEXT_SYNC_TOKEN = "next-sync-token";

const EVENT: CalendarEventSummary = {
  id: "evt-1",
  summary: "Lunch",
  start: "2026-07-31T12:00:00+09:00",
  end: "2026-07-31T13:00:00+09:00",
  htmlLink: "https://calendar.google.com/event?eid=evt-1",
  status: "confirmed",
  colorId: "",
};
const CANCELLED_EVENT: CalendarEventSummary = { ...EVENT, id: "evt-cancelled", status: "cancelled" };
const TASK = { id: "task-1", title: "Buy milk", status: "needsAction", due: "", notes: "" };
const TASK_LIST = { id: "list-1", title: "My list" };
const DRIVE_FILE = { id: "file-1", name: "notes.txt", mimeType: "text/plain", webViewLink: "https://drive.google.com/file/d/file-1", modifiedTime: "" };
const SYNC_RESULT: CalendarSyncResult = { events: [EVENT], nextSyncToken: NEXT_SYNC_TOKEN, fullResyncRequired: false };

/** A recorded call: the engine function's name followed by its arguments. */
type Call = unknown[];

interface SpyKit {
  /** Records every call and always answers `result`. */
  spy: <R>(name: string, result: R) => (...args: unknown[]) => Promise<R>;
  /** Records every call and answers `results` in order, repeating the last. */
  spyQueue: <R>(name: string, results: [R, ...R[]]) => (...args: unknown[]) => Promise<R>;
}

const createStub = (buildOverrides: (kit: SpyKit) => Partial<GoogleApi> = () => ({})) => {
  const calls: Call[] = [];
  const logged: Call[] = [];
  const spy =
    <R>(name: string, result: R) =>
    async (...args: unknown[]): Promise<R> => {
      calls.push([name, ...args]);
      return result;
    };
  const spyQueue = <R>(name: string, results: [R, ...R[]]) => {
    const remaining = [...results];
    return async (...args: unknown[]): Promise<R> => {
      calls.push([name, ...args]);
      return remaining.length > 1 ? (remaining.shift() ?? results[0]) : remaining[0];
    };
  };
  const api: GoogleApi = {
    getGoogleAccessToken: spy("getGoogleAccessToken", ACCESS_TOKEN),
    loadGoogleTokens: spy("loadGoogleTokens", { refresh_token: "stored-refresh" }),
    clientSecretPresence: spy<ClientSecretPresence>("clientSecretPresence", "found"),
    listCalendars: spy("listCalendars", []),
    getCalendarColors: spy("getCalendarColors", { event: {}, calendar: {} }),
    listCalendarEvents: spy("listCalendarEvents", [EVENT]),
    syncCalendarEvents: spy("syncCalendarEvents", SYNC_RESULT),
    loadCalendarSyncToken: spy("loadCalendarSyncToken", null),
    saveCalendarSyncToken: spy("saveCalendarSyncToken", undefined),
    clearCalendarSyncToken: spy("clearCalendarSyncToken", undefined),
    createCalendarEvent: spy("createCalendarEvent", EVENT),
    updateCalendarEvent: spy("updateCalendarEvent", EVENT),
    deleteCalendarEvent: spy("deleteCalendarEvent", undefined),
    listTaskLists: spy("listTaskLists", [TASK_LIST]),
    listTasks: spy("listTasks", [TASK]),
    createTask: spy("createTask", TASK),
    updateTask: spy("updateTask", TASK),
    completeTask: spy("completeTask", TASK),
    uncompleteTask: spy("uncompleteTask", TASK),
    deleteTask: spy("deleteTask", undefined),
    listDriveFiles: spy("listDriveFiles", [DRIVE_FILE]),
    createDriveFile: spy("createDriveFile", DRIVE_FILE),
    readDriveFile: spy("readDriveFile", { file: DRIVE_FILE, content: "hello" }),
    ...buildOverrides({ spy, spyQueue }),
  };
  const context: GoogleDispatchContext = {
    api,
    log: {
      info: (msg: string, data?: object) => {
        logged.push([msg, data]);
      },
    },
  };
  return { context, calls, logged };
};

/** Parses like the tool does, so a route's arguments must also be arguments the
 *  LLM could actually send. */
const dispatch = async (rawArgs: unknown, buildOverrides?: (kit: SpyKit) => Partial<GoogleApi>) => {
  const stub = createStub(buildOverrides);
  const result = await executeGoogleDispatch(stub.context, GoogleArgs.parse(rawArgs));
  return { result, calls: stub.calls, logged: stub.logged };
};

interface Route {
  args: GoogleArgs;
  calls: Call[];
  /** Expected `log.info` calls — ids only, never titles or bodies. */
  logged?: Call[];
}

const ROUTES: Route[] = [
  { args: { kind: "status" }, calls: [["loadGoogleTokens"], ["clientSecretPresence"]] },
  { args: { kind: "calendarListCalendars" }, calls: [["getGoogleAccessToken"], ["listCalendars", ACCESS_TOKEN]] },
  { args: { kind: "calendarColors" }, calls: [["getGoogleAccessToken"], ["getCalendarColors", ACCESS_TOKEN]] },
  {
    args: { kind: "calendarListEvents", calendarId: "cal-1", timeMin: "2026-07-31T00:00:00+09:00" },
    calls: [
      ["getGoogleAccessToken"],
      ["listCalendarEvents", ACCESS_TOKEN, { calendarId: "cal-1", timeMin: "2026-07-31T00:00:00+09:00", maxResults: DEFAULT_LIST_MAX_RESULTS }],
    ],
  },
  {
    args: { kind: "calendarSync", calendarId: "cal-1" },
    calls: [
      ["getGoogleAccessToken"],
      ["loadCalendarSyncToken", "cal-1"],
      ["syncCalendarEvents", ACCESS_TOKEN, { calendarId: "cal-1", syncToken: undefined }],
      ["saveCalendarSyncToken", "cal-1", NEXT_SYNC_TOKEN],
    ],
  },
  {
    args: { kind: "calendarCreateEvent", summary: "Lunch", start: "2026-07-31T12:00:00+09:00", end: "2026-07-31T13:00:00+09:00" },
    calls: [
      ["getGoogleAccessToken"],
      [
        "createCalendarEvent",
        ACCESS_TOKEN,
        {
          summary: "Lunch",
          startDateTime: "2026-07-31T12:00:00+09:00",
          endDateTime: "2026-07-31T13:00:00+09:00",
          description: undefined,
          calendarId: undefined,
          colorId: undefined,
        },
      ],
    ],
    logged: [["calendar event created", { id: EVENT.id }]],
  },
  {
    args: { kind: "calendarUpdateEvent", eventId: "evt-1", summary: "Brunch" },
    calls: [
      ["getGoogleAccessToken"],
      [
        "updateCalendarEvent",
        ACCESS_TOKEN,
        {
          eventId: "evt-1",
          summary: "Brunch",
          startDateTime: undefined,
          endDateTime: undefined,
          description: undefined,
          calendarId: undefined,
          colorId: undefined,
        },
      ],
    ],
    logged: [["calendar event updated", { id: EVENT.id }]],
  },
  {
    args: { kind: "calendarDeleteEvent", eventId: "evt-1" },
    calls: [["getGoogleAccessToken"], ["deleteCalendarEvent", ACCESS_TOKEN, { eventId: "evt-1", calendarId: undefined }]],
    logged: [["calendar event deleted", { id: "evt-1" }]],
  },
  { args: { kind: "taskListsList" }, calls: [["getGoogleAccessToken"], ["listTaskLists", ACCESS_TOKEN]] },
  {
    args: { kind: "tasksList", showCompleted: true },
    calls: [["getGoogleAccessToken"], ["listTasks", ACCESS_TOKEN, { taskListId: undefined, maxResults: DEFAULT_LIST_MAX_RESULTS, showCompleted: true }]],
  },
  {
    args: { kind: "tasksCreate", title: "Buy milk" },
    calls: [["getGoogleAccessToken"], ["createTask", ACCESS_TOKEN, { title: "Buy milk", notes: undefined, due: undefined, taskListId: undefined }]],
    logged: [["task created", { id: TASK.id }]],
  },
  {
    args: { kind: "tasksUpdate", taskId: "task-1", notes: "2 litres" },
    calls: [
      ["getGoogleAccessToken"],
      ["updateTask", ACCESS_TOKEN, { taskId: "task-1", title: undefined, notes: "2 litres", due: undefined, taskListId: undefined }],
    ],
    logged: [["task updated", { id: TASK.id }]],
  },
  {
    args: { kind: "tasksComplete", taskId: "task-1" },
    calls: [["getGoogleAccessToken"], ["completeTask", ACCESS_TOKEN, { taskId: "task-1", taskListId: undefined }]],
  },
  {
    args: { kind: "tasksUncomplete", taskId: "task-1" },
    calls: [["getGoogleAccessToken"], ["uncompleteTask", ACCESS_TOKEN, { taskId: "task-1", taskListId: undefined }]],
  },
  {
    args: { kind: "tasksDelete", taskId: "task-1", taskListId: "list-1" },
    calls: [["getGoogleAccessToken"], ["deleteTask", ACCESS_TOKEN, { taskId: "task-1", taskListId: "list-1" }]],
    logged: [["task deleted", { id: "task-1" }]],
  },
  { args: { kind: "driveList" }, calls: [["getGoogleAccessToken"], ["listDriveFiles", ACCESS_TOKEN, { maxResults: DEFAULT_LIST_MAX_RESULTS }]] },
  {
    args: { kind: "driveCreate", name: "notes.txt", content: "hello" },
    calls: [["getGoogleAccessToken"], ["createDriveFile", ACCESS_TOKEN, { name: "notes.txt", content: "hello", mimeType: undefined }]],
    logged: [["drive file created", { id: DRIVE_FILE.id }]],
  },
  { args: { kind: "driveRead", fileId: "file-1" }, calls: [["getGoogleAccessToken"], ["readDriveFile", ACCESS_TOKEN, { fileId: "file-1" }]] },
];

describe("executeGoogleDispatch routing", () => {
  for (const route of ROUTES) {
    it(`${route.args.kind} calls the engine it says it does`, async () => {
      const { calls, logged } = await dispatch(route.args);
      assert.deepEqual(calls, route.calls);
      assert.deepEqual(logged, route.logged ?? []);
    });
  }

  it("routes every kind the tool advertises", () => {
    // `test_kind_coverage.ts` already pins this enum to the Zod union, so
    // covering the enum covers the schema — and a new kind added without a
    // route here fails rather than going untested.
    const routed: string[] = ROUTES.map((route) => route.args.kind);
    const missing = [...TOOL_DEFINITION.parameters.properties.kind.enum].filter((kind) => !routed.includes(kind));
    assert.deepEqual(missing, [], `advertised kinds with no routing test: ${missing.join(", ")}`);
  });

  it("rejects a kind the schema does not accept", async () => {
    await assert.rejects(() => dispatch({ kind: "calendarDropEverything" }));
  });
});

describe("google dispatch results", () => {
  it("reports a linked account without guidance", async () => {
    const { result } = await dispatch({ kind: "status" });
    assert.deepEqual(result, { ok: true, linked: true, clientSecret: "found" });
  });

  it("adds guidance when no refresh token is stored", async () => {
    const { result } = await dispatch({ kind: "status" }, ({ spy }) => ({
      loadGoogleTokens: spy("loadGoogleTokens", null),
      clientSecretPresence: spy<ClientSecretPresence>("clientSecretPresence", "missing"),
    }));
    assert.deepEqual(result, {
      ok: true,
      linked: false,
      clientSecret: "missing",
      guidance: "Ask the user to link their Google account in this app's settings, then retry.",
    });
  });

  it("returns the file and its content for driveRead", async () => {
    const { result } = await dispatch({ kind: "driveRead", fileId: "file-1" });
    assert.deepEqual(result, { ok: true, file: DRIVE_FILE, content: "hello" });
  });
});

describe("calendarSync", () => {
  it("counts changed and cancelled events separately", async () => {
    const { result } = await dispatch({ kind: "calendarSync" }, ({ spy }) => ({
      syncCalendarEvents: spy("syncCalendarEvents", { events: [EVENT, CANCELLED_EVENT], nextSyncToken: NEXT_SYNC_TOKEN, fullResyncRequired: false }),
    }));
    assert.deepEqual(result, { ok: true, incremental: false, changed: 1, cancelled: 1, events: [EVENT], truncated: false, expiredToken: false });
  });

  it("caps the returned sample and says it did", async () => {
    const events = Array.from({ length: SYNC_SAMPLE_LIMIT + 5 }, (__unused, index) => ({ ...EVENT, id: `evt-${index}` }));
    const { result } = await dispatch({ kind: "calendarSync" }, ({ spy }) => ({
      syncCalendarEvents: spy("syncCalendarEvents", { events, nextSyncToken: NEXT_SYNC_TOKEN, fullResyncRequired: false }),
    }));
    assert.deepEqual(result, {
      ok: true,
      incremental: false,
      changed: events.length,
      cancelled: 0,
      events: events.slice(0, SYNC_SAMPLE_LIMIT),
      truncated: true,
      expiredToken: false,
    });
  });

  it("passes the stored token and reports the sync as incremental", async () => {
    const { result, calls } = await dispatch({ kind: "calendarSync" }, ({ spy }) => ({
      loadCalendarSyncToken: spy("loadCalendarSyncToken", "stored-token"),
    }));
    assert.deepEqual(
      calls.find((call) => call[0] === "syncCalendarEvents"),
      ["syncCalendarEvents", ACCESS_TOKEN, { calendarId: undefined, syncToken: "stored-token" }],
    );
    assert.deepEqual(result, { ok: true, incremental: true, changed: 1, cancelled: 0, events: [EVENT], truncated: false, expiredToken: false });
  });

  it("drops the stored token before rebuilding on fullResync", async () => {
    // Order matters: a full sync that dies mid-way must still leave the next
    // run starting clean, which only holds if the token is gone first.
    const { calls } = await dispatch({ kind: "calendarSync", fullResync: true });
    assert.deepEqual(
      calls.map((call) => call[0]),
      ["getGoogleAccessToken", "clearCalendarSyncToken", "syncCalendarEvents", "saveCalendarSyncToken"],
    );
  });

  it("never reads a stored token on fullResync", async () => {
    const { result, calls } = await dispatch({ kind: "calendarSync", fullResync: true }, ({ spy }) => ({
      loadCalendarSyncToken: spy("loadCalendarSyncToken", "stored-token"),
    }));
    assert.equal(
      calls.some((call) => call[0] === "loadCalendarSyncToken"),
      false,
    );
    assert.deepEqual(result, { ok: true, incremental: false, changed: 1, cancelled: 0, events: [EVENT], truncated: false, expiredToken: false });
  });

  it("restarts from scratch when the stored token expired", async () => {
    const { result, calls } = await dispatch({ kind: "calendarSync" }, ({ spy, spyQueue }) => ({
      loadCalendarSyncToken: spy("loadCalendarSyncToken", "expired-token"),
      syncCalendarEvents: spyQueue("syncCalendarEvents", [{ events: [], fullResyncRequired: true }, SYNC_RESULT]),
    }));
    assert.deepEqual(
      calls.map((call) => call[0]),
      ["getGoogleAccessToken", "loadCalendarSyncToken", "syncCalendarEvents", "clearCalendarSyncToken", "syncCalendarEvents", "saveCalendarSyncToken"],
    );
    // The retry is a full sync, so it is not incremental even though a token
    // was stored — and the caller is told the token expired.
    assert.deepEqual(result, { ok: true, incremental: false, changed: 1, cancelled: 0, events: [EVENT], truncated: false, expiredToken: true });
  });

  it("keeps the old token when the sync returns none", async () => {
    const { calls } = await dispatch({ kind: "calendarSync" }, ({ spy }) => ({
      syncCalendarEvents: spy("syncCalendarEvents", { events: [EVENT], fullResyncRequired: false }),
    }));
    assert.equal(
      calls.some((call) => call[0] === "saveCalendarSyncToken"),
      false,
    );
  });
});
