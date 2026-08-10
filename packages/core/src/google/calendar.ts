// Google Calendar v3 REST calls. Events read/write against any calendar the
// user can access (default: their primary); the calendar list and colour
// palette let callers show non-primary calendars and their colours.
import { asRecord, googleApiError, googleRequest, isGoogleApiError, itemsOf, stringField, DEFAULT_LIST_MAX_RESULTS } from "./apiClient.js";
import { isRecord } from "./util.js";

const CALENDAR_BASE_URL = "https://www.googleapis.com/calendar/v3";
const CALENDAR_API_LABEL = "Google Calendar API";
const DEFAULT_CALENDAR_ID = "primary";
// CalendarList.list is paginated; page through nextPageToken so an account
// with many subscribed calendars isn't silently truncated. The page cap is a
// runaway guard — 250 * 40 = 10k calendars, far beyond any real account.
const CALENDAR_LIST_PAGE_SIZE = 250;
const MAX_CALENDAR_LIST_PAGES = 40;
// Events.list caps maxResults at 2500. The page cap is a runaway guard —
// 2500 * 200 = 500k events, far beyond any real calendar's history.
const EVENT_SYNC_PAGE_SIZE = 2500;
const MAX_EVENT_SYNC_PAGES = 200;
// `getCalendarMeta` reads the list envelope, never the events in it. Google's
// accepted range for maxResults starts at 1, so this is the smallest page it
// will serve.
const CALENDAR_META_PAGE_SIZE = 1;
// An expired/invalidated calendar syncToken.
const HTTP_GONE = 410;
const HTTP_NOT_FOUND = 404;
// A GET on an event that is not there: 404 when it never existed on this
// calendar, 410 when it was deleted and the tombstone is no longer served.
const EVENT_ABSENT_STATUSES: readonly number[] = [HTTP_NOT_FOUND, HTTP_GONE];
/** An `If-Match` write whose etag no longer matches — someone else changed the
 *  event since it was read. */
export const HTTP_PRECONDITION_FAILED = 412;
/** An `insert` whose caller-supplied event id is already taken. */
export const HTTP_CONFLICT = 409;
/** Google's status for an event that was deleted; a sync window reports it so
 *  consumers can remove their copy. Single-sourced — the pull and the push both
 *  branch on it. */
export const CANCELLED_EVENT_STATUS = "cancelled";

/** Resolve a declared calendarId to the one the API and the sync-token store
 *  both address. `||` (not `??`) so an empty string also falls back instead of
 *  building a malformed `/calendars//events` URL. Single-sourced because an
 *  omitted id and an explicit "primary" MUST agree everywhere — grouping them
 *  apart while they share a sync token silently loses events (#2184). */
export const canonicalCalendarId = (calendarId: string | undefined): string => calendarId || DEFAULT_CALENDAR_ID;

const eventsUrl = (calendarId: string | undefined): string => `${CALENDAR_BASE_URL}/calendars/${encodeURIComponent(canonicalCalendarId(calendarId))}/events`;

/** One end of an event as the API expresses it: a timed instant, or a whole day.
 *
 *  `timeZone` names the zone a `dateTime` WITHOUT an offset is read in — the
 *  shape a collection push needs, since the stored clock carries no offset
 *  (`pushDateTime.ts`). A `dateTime` that already ends in `Z`/`+09:00` needs no
 *  `timeZone`. `date` is an all-day event, whose `end` Google treats as
 *  EXCLUSIVE. */
export type CalendarEventTime = { dateTime: string; timeZone?: string } | { date: string };

/** The two ways to state an event's span. The flat pair is what the `google`
 *  tool passes (RFC3339 with an offset); the structured pair is what a push
 *  needs to express an all-day event or an explicit zone. Expressed as a union
 *  so "neither given" cannot typecheck on a create. */
export type CalendarEventSpan = { startDateTime: string; endDateTime: string } | { start: CalendarEventTime; end: CalendarEventTime };

export type CalendarEventInput = {
  summary: string;
  description?: string | undefined;
  location?: string | undefined;
  /** Calendar to create the event on; defaults to the user's primary. */
  calendarId?: string | undefined;
  /** Event colour (Google event palette id "1".."11"); omit to inherit the calendar's colour. */
  colorId?: string | undefined;
  /** Caller-chosen event id. Google requires base32hex (`0-9a-v`), 5-1024 chars,
   *  and answers 409 when it is already taken. A collection push sets this so a
   *  locally-created record keeps its own record id as the event id, instead of
   *  being re-keyed to Google's after the fact — a re-key that is missed leaves
   *  a duplicate record on the next pull. */
  eventId?: string | undefined;
} & CalendarEventSpan;

export interface UpdateCalendarEventInput {
  eventId: string;
  summary?: string | undefined;
  startDateTime?: string | undefined;
  endDateTime?: string | undefined;
  /** Structured span; wins over the flat pair when both are present. */
  start?: CalendarEventTime | undefined;
  end?: CalendarEventTime | undefined;
  /** `""` clears the description; omit to leave it untouched. */
  description?: string | undefined;
  /** `""` clears the location; omit to leave it untouched. */
  location?: string | undefined;
  calendarId?: string | undefined;
  colorId?: string | undefined;
  /** Etag of the version this edit was computed against. Sent as `If-Match`, so
   *  Google answers 412 rather than letting the PATCH clobber a change that
   *  landed after the caller read the event. Omit for an unconditional write. */
  ifMatch?: string | undefined;
}

export interface DeleteCalendarEventInput {
  eventId: string;
  calendarId?: string | undefined;
}

export interface ListEventsInput {
  timeMin?: string | undefined;
  maxResults?: number | undefined;
  /** Calendar to read; defaults to the user's primary. */
  calendarId?: string | undefined;
}

export interface CalendarEventSummary {
  id: string;
  summary: string;
  start: string;
  end: string;
  htmlLink: string;
  status: string;
  /** Google event palette id ("1".."11"), or "" when the event inherits the calendar's colour. */
  colorId: string;
  /** The event body, RAW. Google stores limited HTML here, and normalising it on
   *  the way in would silently strip the user's formatting on the way back out —
   *  a mirrored calendar has to survive the round trip, so any prettifying
   *  belongs to whatever displays it. */
  description: string;
  location: string;
}

export interface CalendarSummary {
  id: string;
  summary: string;
  description: string;
  /** True only for the user's primary calendar. */
  primary: boolean;
  accessRole: string;
  backgroundColor: string;
  foregroundColor: string;
  /** Calendar palette id backing background/foregroundColor. */
  colorId: string;
  /** IANA zone (`Asia/Tokyo`). The zone a pushed `dateTime` without an offset is
   *  read in: the collection stores the clock the user reads off THIS calendar,
   *  so this is the only correct zone to re-attach. `""` when Google omits it. */
  timeZone: string;
}

export interface CalendarColorEntry {
  background: string;
  foreground: string;
}

/** Palettes from Google's `/colors` endpoint: `event` maps an event's `colorId`
 *  and `calendar` maps a calendar's `colorId` to hex background/foreground. */
export interface CalendarColors {
  event: Record<string, CalendarColorEntry>;
  calendar: Record<string, CalendarColorEntry>;
}

// All-day events carry `date`, timed events carry `dateTime`.
const eventTime = (value: unknown): string => {
  if (!isRecord(value)) return "";
  if (typeof value.dateTime === "string") return value.dateTime;
  if (typeof value.date === "string") return value.date;
  return "";
};

export const toEventSummary = (value: unknown): CalendarEventSummary => {
  const record = asRecord(value);
  return {
    id: stringField(record, "id"),
    summary: stringField(record, "summary"),
    start: eventTime(record.start),
    end: eventTime(record.end),
    htmlLink: stringField(record, "htmlLink"),
    status: stringField(record, "status"),
    colorId: stringField(record, "colorId"),
    description: stringField(record, "description"),
    location: stringField(record, "location"),
  };
};

export const toCalendarSummary = (value: unknown): CalendarSummary => {
  const record = asRecord(value);
  return {
    id: stringField(record, "id"),
    summary: stringField(record, "summary"),
    description: stringField(record, "description"),
    primary: record.primary === true,
    accessRole: stringField(record, "accessRole"),
    backgroundColor: stringField(record, "backgroundColor"),
    foregroundColor: stringField(record, "foregroundColor"),
    colorId: stringField(record, "colorId"),
    timeZone: stringField(record, "timeZone"),
  };
};

const toColorMap = (value: unknown): Record<string, CalendarColorEntry> => {
  const entries = Object.entries(asRecord(value)).map(([colorId, entry]): [string, CalendarColorEntry] => {
    const record = asRecord(entry);
    return [colorId, { background: stringField(record, "background"), foreground: stringField(record, "foreground") }];
  });
  return Object.fromEntries(entries);
};

/** Kept as a named export for the existing unit tests / callers; the shared
 *  helper now carries the wording. */
export const calendarApiError = (status: number, body: string): Error => googleApiError(CALENDAR_API_LABEL, status, body);

/** Normalise either spelling of a span into the pair the API body carries. */
export const resolveEventSpan = (span: CalendarEventSpan): { start: CalendarEventTime; end: CalendarEventTime } =>
  "start" in span ? { start: span.start, end: span.end } : { start: { dateTime: span.startDateTime }, end: { dateTime: span.endDateTime } };

export async function createCalendarEvent(accessToken: string, input: CalendarEventInput): Promise<CalendarEventSummary> {
  const body = {
    summary: input.summary,
    description: input.description,
    location: input.location,
    ...resolveEventSpan(input),
    ...(input.colorId ? { colorId: input.colorId } : {}),
    ...(input.eventId ? { id: input.eventId } : {}),
  };
  const created = await googleRequest(CALENDAR_API_LABEL, accessToken, eventsUrl(input.calendarId), { method: "POST", body: JSON.stringify(body) });
  return toEventSummary(created);
}

const eventUrl = (calendarId: string | undefined, eventId: string): string => `${eventsUrl(calendarId)}/${encodeURIComponent(eventId)}`;

/** PATCH body for an event edit — only the fields the caller actually supplied.
 *
 *  `undefined` means "leave as is" and `""` means "clear it", so the two cannot
 *  be collapsed: dropping `description: ""` would silently ignore a request to
 *  empty the body text. Pure so the distinction is testable without network. */
/** One end of the patch: the structured value if given, else the flat one
 *  wrapped, else absent (= leave it alone). */
const eventEnd = (key: "start" | "end", structured: CalendarEventTime | undefined, flat: string | undefined): Record<string, CalendarEventTime> => {
  if (structured !== undefined) return { [key]: structured };
  return flat !== undefined ? { [key]: { dateTime: flat } } : {};
};

export const buildEventPatch = (input: UpdateCalendarEventInput): Record<string, unknown> => ({
  ...(input.summary !== undefined ? { summary: input.summary } : {}),
  ...(input.description !== undefined ? { description: input.description } : {}),
  ...(input.location !== undefined ? { location: input.location } : {}),
  ...eventEnd("start", input.start, input.startDateTime),
  ...eventEnd("end", input.end, input.endDateTime),
  ...(input.colorId ? { colorId: input.colorId } : {}),
});

/** Edit an existing event in place. PATCH, not PUT — a PUT would need the whole
 *  event and would drop every field the caller never read (attendees,
 *  reminders, recurrence). */
export async function updateCalendarEvent(accessToken: string, input: UpdateCalendarEventInput): Promise<CalendarEventSummary> {
  const url = eventUrl(input.calendarId, input.eventId);
  const updated = await googleRequest(CALENDAR_API_LABEL, accessToken, url, {
    method: "PATCH",
    body: JSON.stringify(buildEventPatch(input)),
    ...(input.ifMatch ? { extraHeaders: { "If-Match": input.ifMatch } } : {}),
  });
  return toEventSummary(updated);
}

/** An event plus the version token a conditional write needs. */
export interface FetchedCalendarEvent {
  event: CalendarEventSummary;
  /** Google's `etag` for this version, `""` when absent. Sent back as
   *  `If-Match` so a PATCH cannot overwrite a version we never read. */
  etag: string;
}

/** Read ONE event, or null when it is gone (404 / 410).
 *
 *  A push needs Google's current value per changed record to tell a local-only
 *  edit from a both-sides conflict. Deliberately not `syncCalendarEvents`: that
 *  consumes the calendar's sync token, and the token's window is served once —
 *  spending it here would make the next pull miss everything in it. */
export async function getCalendarEvent(accessToken: string, input: DeleteCalendarEventInput): Promise<FetchedCalendarEvent | null> {
  try {
    const fetched = await googleRequest(CALENDAR_API_LABEL, accessToken, eventUrl(input.calendarId, input.eventId));
    return { event: toEventSummary(fetched), etag: stringField(asRecord(fetched), "etag") };
  } catch (error) {
    if (isGoogleApiError(error) && EVENT_ABSENT_STATUSES.includes(error.status)) return null;
    throw error;
  }
}

/** Remove an event. Google answers 204 with no body, so there is nothing to
 *  return; a second delete of the same id answers 410, which surfaces as a
 *  GoogleApiError rather than being swallowed. */
export async function deleteCalendarEvent(accessToken: string, input: DeleteCalendarEventInput): Promise<void> {
  await googleRequest(CALENDAR_API_LABEL, accessToken, eventUrl(input.calendarId, input.eventId), { method: "DELETE" });
}

export async function listCalendarEvents(accessToken: string, input: ListEventsInput = {}): Promise<CalendarEventSummary[]> {
  const params = new URLSearchParams({
    timeMin: input.timeMin ?? new Date().toISOString(),
    maxResults: String(input.maxResults ?? DEFAULT_LIST_MAX_RESULTS),
    singleEvents: "true",
    orderBy: "startTime",
  });
  const listed = await googleRequest(CALENDAR_API_LABEL, accessToken, `${eventsUrl(input.calendarId)}?${params.toString()}`);
  return itemsOf(listed).map(toEventSummary);
}

export interface SyncEventsInput {
  /** Calendar to sync; defaults to the user's primary. */
  calendarId?: string | undefined;
  /** Token from the previous sync. Omit for a full sync. */
  syncToken?: string | undefined;
  /** Page size for the underlying list calls. */
  maxResults?: number | undefined;
}

export interface CalendarSyncResult {
  /** Changed events since `syncToken` (all of them on a full sync). Deletions
   *  arrive here too, as `status: "cancelled"`. */
  events: CalendarEventSummary[];
  /** Token to pass to the NEXT sync. Absent only if Google omitted it. */
  nextSyncToken?: string | undefined;
  /** The stored token had expired (410) — the caller must drop it and re-sync
   *  from scratch; no events are returned in that case. */
  fullResyncRequired: boolean;
  /** The page guard fired with pages still pending, so `events` is a PARTIAL
   *  window and `nextSyncToken` is absent.
   *
   *  Reported rather than left implicit because a truncated walk is otherwise
   *  byte-identical to a completed one: the caller would apply the partial set,
   *  report success, and — since only Google's last page carries the token —
   *  repeat the same truncated walk on every later run, silently (#2850).
   *  Google states a page "may be less than this value, or none at all, even if
   *  there are more events matching the query", so this is reachable on a real
   *  calendar, the more so with `singleEvents` expanding unbounded recurrences. */
  pagesExhausted: boolean;
}

// Sentinel for "the syncToken expired" so the page loop can bail without
// throwing — 410 is an expected, recoverable state, not a failure.
const GONE = Symbol("calendar-sync-gone");

async function fetchSyncPage(accessToken: string, calendarId: string | undefined, params: URLSearchParams): Promise<unknown> {
  try {
    return await googleRequest(CALENDAR_API_LABEL, accessToken, `${eventsUrl(calendarId)}?${params.toString()}`);
  } catch (err: unknown) {
    if (isGoogleApiError(err) && err.status === HTTP_GONE) return GONE;
    throw err;
  }
}

/** Incremental sync over the events of one calendar (#2095).
 *
 *  Deliberately separate from `listCalendarEvents`: Google forbids combining
 *  `syncToken` with `timeMin` / `timeMax` / `updatedMin` / `orderBy` / `q`,
 *  and that function always sends `timeMin` + `orderBy`. So this one sends
 *  neither — a sync covers the WHOLE calendar and the caller sorts / windows
 *  client-side. `showDeleted` must stay true or deletions would be invisible.
 *
 *  `nextSyncToken` is only present on the LAST page, so every page must be
 *  walked before the token is worth storing. */
/** The query for one page of the walk. `showDeleted` must stay true or
 *  deletions would be invisible; `pageToken` is sent ALONGSIDE `syncToken`,
 *  which is what Google requires to page an incremental sync. */
export function syncPageParams(input: SyncEventsInput, pageToken: string | undefined): URLSearchParams {
  const params = new URLSearchParams({
    singleEvents: "true",
    showDeleted: "true",
    maxResults: String(input.maxResults ?? EVENT_SYNC_PAGE_SIZE),
  });
  if (input.syncToken) params.set("syncToken", input.syncToken);
  if (pageToken) params.set("pageToken", pageToken);
  return params;
}

export async function syncCalendarEvents(accessToken: string, input: SyncEventsInput = {}): Promise<CalendarSyncResult> {
  const events: CalendarEventSummary[] = [];
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;

  for (let page = 0; page < MAX_EVENT_SYNC_PAGES; page += 1) {
    const payload = await fetchSyncPage(accessToken, input.calendarId, syncPageParams(input, pageToken));
    if (payload === GONE) return { events: [], fullResyncRequired: true, pagesExhausted: false };

    const record = asRecord(payload);
    events.push(...itemsOf(payload).map(toEventSummary));
    nextSyncToken = stringField(record, "nextSyncToken") || undefined;
    pageToken = stringField(record, "nextPageToken") || undefined;
    if (!pageToken) break;
    // Google sends the sync token only on the LAST page, so anything read
    // before one is not a resume point for the walk this call is doing.
    // Dropped rather than trusted: kept, it would let a caller resume past the
    // pages this walk never read (Codex review #2853).
    nextSyncToken = undefined;
  }

  // A token still in hand means the loop ran out of pages, not out of calendar.
  return { events, nextSyncToken, fullResyncRequired: false, pagesExhausted: pageToken !== undefined };
}

export interface CalendarListPage {
  items: unknown[];
  nextPageToken?: string | undefined;
}

/** Pagination loop for CalendarList.list, extracted so it can be tested without
 *  network. Stops at the last page (no token) or the runaway page cap. */
export async function collectCalendarPages(
  fetchPage: (pageToken?: string) => Promise<CalendarListPage>,
  maxPages = MAX_CALENDAR_LIST_PAGES,
): Promise<CalendarSummary[]> {
  const calendars: CalendarSummary[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const { items, nextPageToken } = await fetchPage(pageToken);
    calendars.push(...items.map(toCalendarSummary));
    if (!nextPageToken) break;
    pageToken = nextPageToken;
  }
  return calendars;
}

/** What a calendar absent from the user's list can still tell about itself. */
export interface CalendarMeta {
  /** IANA zone (`Asia/Tokyo`), `""` when Google omits it. */
  timeZone: string;
  /** `owner` / `writer` / `reader` / `freeBusyReader`, `""` when unreported. */
  accessRole: string;
}

export const toCalendarMeta = (value: unknown): CalendarMeta => {
  const record = asRecord(value);
  return { timeZone: stringField(record, "timeZone"), accessRole: stringField(record, "accessRole") };
};

/** One calendar's zone and the caller's role on it, read by id rather than
 *  looked up in the user's list.
 *
 *  `calendarList` only holds calendars the user has ADDED; a calendar shared
 *  with them can be readable and writable by id without appearing there, and a
 *  push still needs its zone to send an offset-less `dateTime`.
 *
 *  Deliberately `events.list` and NOT `calendars.get`: the latter takes only
 *  full-calendar scopes (`calendar`, `calendar.readonly`, `calendar.calendars*`)
 *  and this app asks for none of them, so it answers 403 for every account it
 *  links (#2735). The events list carries the same `timeZone` — plus the
 *  `accessRole` the calendar resource does not have — under `calendar.events`,
 *  which the push already holds because it writes with it. Only the envelope is
 *  read; the one event asked for is the smallest page Google will serve. */
export async function getCalendarMeta(accessToken: string, calendarId: string | undefined): Promise<CalendarMeta> {
  const params = new URLSearchParams({ maxResults: String(CALENDAR_META_PAGE_SIZE) });
  return toCalendarMeta(await googleRequest(CALENDAR_API_LABEL, accessToken, `${eventsUrl(calendarId)}?${params.toString()}`));
}

/** The calendars the user has added/subscribed to (primary + secondary +
 *  shared), each with its id, name and colour, following pagination. Needs the
 *  calendar-list read scope (GOOGLE_CALENDARLIST_SCOPE). */
export async function listCalendars(accessToken: string): Promise<CalendarSummary[]> {
  return collectCalendarPages(async (pageToken) => {
    const params = new URLSearchParams({ maxResults: String(CALENDAR_LIST_PAGE_SIZE) });
    if (pageToken) params.set("pageToken", pageToken);
    const payload = await googleRequest(CALENDAR_API_LABEL, accessToken, `${CALENDAR_BASE_URL}/users/me/calendarList?${params.toString()}`);
    const record = asRecord(payload);
    return { items: itemsOf(payload), nextPageToken: typeof record.nextPageToken === "string" ? record.nextPageToken : undefined };
  });
}

/** Resolve a `colorId` (on an event or calendar) to its hex background/foreground. */
export async function getCalendarColors(accessToken: string): Promise<CalendarColors> {
  const payload = await googleRequest(CALENDAR_API_LABEL, accessToken, `${CALENDAR_BASE_URL}/colors`);
  const record = asRecord(payload);
  return { event: toColorMap(record.event), calendar: toColorMap(record.calendar) };
}
