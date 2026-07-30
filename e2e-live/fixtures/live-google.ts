// Live Google Calendar helpers for e2e-live (#2602).
//
// Unlike every other spec under `e2e-live/`, the Google specs drive no browser
// and no LLM. What is under test is Google's own answer to the shapes
// `@mulmoclaude/core/google` sends — a fact no amount of reading our code can
// settle. Playwright is here for the runner, the trace and the report.
//
// Nothing here creates or deletes a CALENDAR. The app's OAuth grant covers
// `calendar.events`, not the full `calendar` scope, so a throwaway calendar has
// to be made by a human in Google's UI and handed over by id through the env
// vars below. EVENTS are created and removed per test.

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { test } from "@playwright/test";

import { configureCollectionHost } from "@mulmoclaude/core/collection/server";
import { deleteCalendarEvent, isGoogleApiError, loadGoogleTokens } from "@mulmoclaude/core/google";

/** A calendar the linked account may write to. These specs own its events, so
 *  point it at a throwaway calendar — never a real one. */
export const WRITABLE_CALENDAR_ENV = "E2E_LIVE_GOOGLE_CALENDAR_ID";
/** A calendar the account can read but not write (a subscribed holiday calendar
 *  is the easiest one to come by). Optional. */
export const READONLY_CALENDAR_ENV = "E2E_LIVE_GOOGLE_READONLY_CALENDAR_ID";
/** A calendar the account may write to but has NOT added to its calendar list —
 *  #2602 item 5. Needs a second account to share one, so it stays optional. */
export const UNLISTED_CALENDAR_ENV = "E2E_LIVE_GOOGLE_UNLISTED_CALENDAR_ID";

export const calendarIdFrom = (envName: string): string => process.env[envName]?.trim() ?? "";

/** The alias every Google call resolves to when no calendar is named — i.e. the
 *  user's real calendar. Refused as a target below. */
const PRIMARY_CALENDAR_ID = "primary";

/** Why this run cannot exercise a live calendar, or null when it can.
 *
 *  Returned as a sentence rather than a boolean so the skip reason in the report
 *  tells the next person exactly what to set up — a silently skipped suite reads
 *  the same as a passing one. */
export async function liveCalendarBlocker(): Promise<string | null> {
  const writable = calendarIdFrom(WRITABLE_CALENDAR_ENV);
  if (writable === "") {
    return `${WRITABLE_CALENDAR_ENV} is unset — create a throwaway calendar in Google Calendar and export its id`;
  }
  // These specs create AND delete events, so the one input that must never be
  // wrong is which calendar they land on. `primary` is the value the engine
  // itself falls back to, which makes it the easy mistake to make — and the
  // one that writes into the user's real calendar.
  if (writable === PRIMARY_CALENDAR_ID) {
    return `${WRITABLE_CALENDAR_ENV} is "${PRIMARY_CALENDAR_ID}" — these specs create and delete events, so point it at a throwaway calendar instead`;
  }
  const tokens = await loadGoogleTokens();
  if (!tokens?.refresh_token) return "no Google account is linked on this host — link one in settings, then re-run";
  return null;
}

/** Skip reason for a test that needs one of the optional calendars. */
export const missingCalendarReason = (envName: string, what: string): string => `${envName} is unset — set it to ${what}`;

// Google requires a client-supplied event id to be base32hex (`0-9a-v`), 5-1024
// characters. A UUID's first 8 characters are lowercase hex, which is exactly
// the shape #2602 asks about.
const CLIENT_EVENT_ID_LENGTH = 8;

export const newEventId = (): string => randomUUID().slice(0, CLIENT_EVENT_ID_LENGTH);

const HTTP_NOT_FOUND = 404;
const HTTP_GONE = 410;
/** An event that is already gone: teardown's success case, not a failure. */
const ALREADY_GONE_STATUSES: readonly number[] = [HTTP_NOT_FOUND, HTTP_GONE];

/** Best-effort teardown. A cleanup failure is recorded as an annotation instead
 *  of thrown: raising here would replace the real assertion failure with a
 *  delete error, and the leftover event still needs to be visible somewhere. */
export async function deleteEventQuietly(accessToken: string, calendarId: string, eventId: string): Promise<void> {
  try {
    await deleteCalendarEvent(accessToken, { calendarId, eventId });
  } catch (error) {
    if (isGoogleApiError(error) && ALREADY_GONE_STATUSES.includes(error.status)) return;
    test.info().annotations.push({ type: "cleanup-failed", description: `${calendarId}/${eventId}: ${String(error)}` });
  }
}

/** The `GoogleApiError` status a call answers with, or null when it resolved.
 *
 *  #2602 is mostly a question about STATUS CODES (409 vs 400, 412 vs 409), and
 *  `rejects.toThrow()` cannot tell them apart. A non-Google error is rethrown so
 *  a bug in the test itself never reads as "Google said something else". */
export async function statusOfRejection(run: () => Promise<unknown>): Promise<number | null> {
  try {
    await run();
    return null;
  } catch (error) {
    if (isGoogleApiError(error)) return error.status;
    throw error;
  }
}

// --- the collection side ---------------------------------------------------

/** Field names of the seeded collection. Fixed so a spec can address a record
 *  without restating the schema's map. */
export const CALENDAR_FIELDS = { id: "gid", summary: "title", start: "on", end: "until" } as const;

const DATA_ROOT_SEGMENTS = ["data", "collections"];
const ITEMS_DIR = "items";
const SLUG_NONCE_LENGTH = 6;

// The schema declares its dataPath workspace-relative with forward slashes (the
// on-disk form every other schema uses); `path.normalize` handles the Windows
// separator on the way in.
const dataPathFor = (slug: string): string => [...DATA_ROOT_SEGMENTS, slug, ITEMS_DIR].join("/");
const dataDirFor = (root: string, slug: string): string => path.join(root, ...DATA_ROOT_SEGMENTS, slug, ITEMS_DIR);

const schemaFor = (slug: string, calendarId: string): Record<string, unknown> => ({
  title: "e2e-live calendar push",
  icon: "event",
  dataPath: dataPathFor(slug),
  primaryKey: CALENDAR_FIELDS.id,
  fields: {
    [CALENDAR_FIELDS.id]: { type: "string", label: "Event id", primary: true },
    [CALENDAR_FIELDS.summary]: { type: "string", label: "Title" },
    [CALENDAR_FIELDS.start]: { type: "datetime", label: "Start" },
    [CALENDAR_FIELDS.end]: { type: "datetime", label: "End" },
  },
  googleCalendar: {
    calendarId,
    map: { [CALENDAR_FIELDS.summary]: "summary", [CALENDAR_FIELDS.start]: "start", [CALENDAR_FIELDS.end]: "end" },
  },
});

// The engine reads the workspace layout off its host binding, so a spec that
// calls `pushCalendarForCollection` must wire one. Bound once at module scope
// with a placeholder root — every call passes its own root explicitly, and only
// the path factories below are actually exercised. `userSkillsDir` points at
// nothing on purpose: user-scope discovery must not pick up the developer's own
// collections mid-test.
const NO_USER_SKILLS_DIR = path.join(tmpdir(), "e2e-live-no-user-skills");
configureCollectionHost({
  workspaceRoot: path.join(tmpdir(), "e2e-live-google-placeholder"),
  log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  paths: {
    userSkillsDir: NO_USER_SKILLS_DIR,
    projectSkillsDir: (root: string) => path.join(root, ".claude", "skills"),
    feedsRoot: (root: string) => path.join(root, "feeds"),
    skillsStagingDir: (root: string) => path.join(root, "data", "skills"),
    archiveDir: ".archive",
    collectionsRegistriesConfig: (root: string) => path.join(root, "config", "collections-registries.json"),
  },
  isPresetSlug: () => false,
});

/** A throwaway workspace holding one `googleCalendar` collection, ready for
 *  `pushCalendarForCollection(slug, root)` — the same call the HTTP route makes. */
export interface CalendarCollectionWorkspace {
  root: string;
  slug: string;
  /** Write (or overwrite) one record file. */
  putRecord: (recordId: string, record: Record<string, unknown>) => Promise<void>;
  cleanup: () => Promise<void>;
}

export async function createCalendarCollectionWorkspace(calendarId: string): Promise<CalendarCollectionWorkspace> {
  const root = await mkdtemp(path.join(tmpdir(), "e2e-live-calendar-"));
  const slug = `e2e-live-push-${randomUUID().slice(0, SLUG_NONCE_LENGTH)}`;
  const skillDir = path.join(root, ".claude", "skills", slug);
  const dataDir = dataDirFor(root, slug);
  await mkdir(skillDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(skillDir, "schema.json"), JSON.stringify(schemaFor(slug, calendarId), null, 2), "utf-8");
  return {
    root,
    slug,
    putRecord: async (recordId, record) => {
      await writeFile(path.join(dataDir, `${recordId}.json`), JSON.stringify(record, null, 2), "utf-8");
    },
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}
