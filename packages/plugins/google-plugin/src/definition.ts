// Tool schema for the single `google` tool. The LLM picks a `kind`;
// the dispatch in `index.ts` validates with Zod and routes to the
// matching engine call in @mulmoclaude/core/google.
//
// `name: "google" as const` narrows the literal so `definePlugin`'s
// `PluginFactoryResult<N>` requires a handler exported under exactly
// this key.

export const TOOL_DEFINITION = {
  type: "function" as const,
  name: "google" as const,
  prompt:
    "The user's Google account is linked LOCALLY on this machine — the refresh token is stored in ~/.config/mulmo/ and goes only to Google to mint access tokens, never to claude.ai or any other service. " +
    "This is independent of claude.ai Google connectors; the tool works without them. " +
    "If a call fails with 'Google account not linked', ask the user to link their Google account in this app's settings, then retry the original call.",
  description:
    "Operate the user's Google services through the locally linked Google account: Calendar, Tasks, and Drive. Supported kinds:\n" +
    " - `status`: report whether the Google account is linked on this machine — call this first when unsure.\n" +
    "\n" +
    "Calendar (events default to the primary calendar; pass `calendarId` — from `calendarListCalendars` — to target another):\n" +
    " - `calendarListCalendars`: list the calendars the user has added/subscribed to (`id`, `summary`, `primary`, `backgroundColor`/`foregroundColor` hex, `colorId`, `accessRole`). Call this to work with a non-primary calendar.\n" +
    " - `calendarColors`: palettes that map an event/calendar `colorId` to hex — `event` for per-event colours, `calendar` for calendar colours.\n" +
    " - `calendarListEvents`: list upcoming events (each carries `colorId`, empty when it inherits the calendar colour). Optional `calendarId`, `timeMin` (ISO 8601 date-time with timezone offset; default now), `maxResults` (1-50, default 10).\n" +
    " - `calendarSync`: fetch only what CHANGED since the last sync of this calendar, using a stored sync token. Use this for repeated/periodic syncing — it does not re-fetch the whole calendar, so it stays cheap. The FIRST call (or after `fullResync: true`) walks the entire calendar to establish the token. Returns counts (`changed`, `cancelled`) plus a capped `events` sample — never the full list, so it will not flood the conversation; `truncated: true` means more changed than are shown. Deletions are reported as the `cancelled` count. `pagesExhausted: true` means the calendar had more pages than one pass walks, so this is a PARTIAL read and no cursor was stored — say so rather than reporting the sync as complete; the usual cause is a recurring event with no end date. Optional `calendarId`, `fullResync` (discard the stored token and start over).\n" +
    ' - `calendarCreateEvent`: create an event. Requires `summary`, `start`, `end` — ISO 8601 date-times WITH a timezone offset (e.g. 2026-07-17T09:00:00+09:00); optional `description`, `calendarId`, `colorId` (event palette id "1"-"11").\n' +
    ' - `calendarUpdateEvent`: edit an existing event. Requires `eventId` (from `calendarListEvents` / `calendarSync`) plus AT LEAST ONE of `summary`, `start`, `end`, `description`, `colorId`; fields you omit keep their current value, and `description: ""` clears the body. Optional `calendarId`. Moving only one end of the event still has to leave start before end, or Calendar rejects it.\n' +
    " - `calendarDeleteEvent`: delete an event. Requires `eventId`; optional `calendarId`. This removes it for every attendee and cannot be undone — confirm with the user before calling. For a recurring event, an instance id (as returned by the list kinds) deletes that single occurrence.\n" +
    "\n" +
    "Tasks:\n" +
    " - `taskListsList`: list the user's task lists (`id`, `title`). Only needed when the user means a list other than their default one.\n" +
    " - `tasksList`: list tasks. Optional `taskListId` (default: the user's default list), `maxResults` (1-50, default 10), `showCompleted` (default false).\n" +
    " - `tasksCreate`: add a task. Requires `title`; optional `notes`, `due` (ISO 8601 with offset — Google keeps the DATE only, so do not promise a time of day), `taskListId`.\n" +
    ' - `tasksUpdate`: edit a task. Requires `taskId` (from `tasksList`) plus AT LEAST ONE of `title`, `notes`, `due`; omitted fields keep their value and `notes: ""` clears them. Use `tasksComplete` / `tasksUncomplete` to change status — this kind does not. Optional `taskListId`.\n' +
    " - `tasksComplete`: mark a task done. Requires `taskId` (from `tasksList`); optional `taskListId`.\n" +
    " - `tasksUncomplete`: put a completed task back on the to-do list. Requires `taskId`; optional `taskListId`. Completed tasks are hidden from `tasksList` unless you pass `showCompleted: true`, so list with that first to find the id.\n" +
    " - `tasksDelete`: delete a task. Requires `taskId`; optional `taskListId`. Cannot be undone — confirm with the user before calling.\n" +
    "\n" +
    "Drive — IMPORTANT: this app can only see files IT created, never the user's wider Drive. Never claim you searched their whole Drive:\n" +
    " - `driveList`: list files this app created. Optional `maxResults` (1-50, default 10).\n" +
    " - `driveCreate`: create a text file. Requires `name` and `content`; optional `mimeType` (default text/plain).\n" +
    " - `driveRead`: read one of this app's files. Requires `fileId` (from `driveList` or `driveCreate`). Text files only.",
  parameters: {
    type: "object" as const,
    properties: {
      kind: {
        type: "string",
        enum: [
          "status",
          "calendarListCalendars",
          "calendarColors",
          "calendarListEvents",
          "calendarSync",
          "calendarCreateEvent",
          "calendarUpdateEvent",
          "calendarDeleteEvent",
          "taskListsList",
          "tasksList",
          "tasksCreate",
          "tasksUpdate",
          "tasksComplete",
          "tasksUncomplete",
          "tasksDelete",
          "driveList",
          "driveCreate",
          "driveRead",
        ],
      },
      calendarId: { type: "string", description: "calendar kinds: target calendar id from calendarListCalendars (default: the user's primary)" },
      colorId: { type: "string", description: 'calendarCreateEvent / calendarUpdateEvent: optional event palette colour id "1"-"11"' },
      eventId: { type: "string", description: "calendarUpdateEvent / calendarDeleteEvent: id of the event, from calendarListEvents or calendarSync" },
      timeMin: { type: "string", description: "calendarListEvents: lower bound, ISO 8601 with timezone offset (default: now)" },
      fullResync: { type: "boolean", description: "calendarSync: discard the stored sync token and re-walk the whole calendar (default false)" },
      maxResults: { type: "number", description: "list kinds: max items to return, 1-50 (default 10)" },
      summary: { type: "string", description: "calendarCreateEvent / calendarUpdateEvent: event title" },
      start: { type: "string", description: "calendarCreateEvent / calendarUpdateEvent: start, ISO 8601 with timezone offset" },
      end: { type: "string", description: "calendarCreateEvent / calendarUpdateEvent: end, ISO 8601 with timezone offset" },
      description: { type: "string", description: 'calendarCreateEvent / calendarUpdateEvent: event body ("" on update clears it)' },
      taskListId: { type: "string", description: "tasks kinds: target list id (default: the user's default list)" },
      showCompleted: { type: "boolean", description: "tasksList: include completed tasks (default false)" },
      title: { type: "string", description: "tasksCreate / tasksUpdate: task title" },
      notes: { type: "string", description: 'tasksCreate / tasksUpdate: task notes ("" on update clears them)' },
      due: { type: "string", description: "tasksCreate / tasksUpdate: due date, ISO 8601 with offset (Google keeps the date only)" },
      taskId: { type: "string", description: "tasksUpdate / tasksComplete / tasksUncomplete / tasksDelete: id of the task, from tasksList" },
      name: { type: "string", description: "driveCreate: file name" },
      content: { type: "string", description: "driveCreate: file body" },
      mimeType: { type: "string", description: "driveCreate: optional MIME type (default text/plain)" },
      fileId: { type: "string", description: "driveRead: id of a file this app created" },
    },
    required: ["kind"],
  },
};
