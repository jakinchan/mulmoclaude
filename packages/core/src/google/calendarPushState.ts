// What Google last reported for each synced event — the baseline a push diffs
// against (#2598).
//
// Without it, a local edit and an untouched record are indistinguishable: the
// pull writes Google's value into the record and keeps no copy, so "the record
// says 09:30" answers nothing about who put it there.
//
// It holds the RAW Google values, not a hash of them, because the push has to
// REBUILD a Google time from a stored one and `toCollectionDateTime` is lossy —
// it drops the zone offset and flattens all-day into `…T00:00`. The baseline is
// where both come back from (see `pushDateTime.ts`).
//
// Lives inside the workspace next to the sync token, and for the same reason
// (`calendarSyncStore.ts`): it is a claim about which records the workspace
// holds, so it must reset when the workspace does.
import path from "node:path";
import { getWorkspaceRoot } from "../collection/server/host.js";
import { readJsonOrNull, writeJsonAtomicWithMode } from "./fsJson.js";
import { canonicalCalendarId, type CalendarEventSummary } from "./calendar.js";
import { stateLockPath, withCalendarStateLock } from "./calendarStateLock.js";

const PUSH_STATE_MODE = 0o600;

/** The pushable subset of an event. `htmlLink` and `status` are read-only on
 *  Google's side, so a baseline for them could never be acted on. */
export type ShadowEvent = Pick<CalendarEventSummary, "summary" | "start" | "end" | "colorId" | "description" | "location">;

/** calendarId → eventId → what Google last said. */
interface PushState {
  events: Record<string, Record<string, ShadowEvent>>;
}

/** `<workspace>/data/calendar/.push-state.json` */
export function calendarPushStatePath(workspaceRoot?: string): string {
  return path.join(workspaceRoot ?? getWorkspaceRoot(), "data", "calendar", ".push-state.json");
}

// A state file written before `description` / `location` joined the pushable set
// simply lacks those keys. That needs no migration: `fieldText(undefined)` and
// the `""` Google reports for an unset field both compare as empty, so an
// upgraded host does not read every record as locally edited.
export const toShadowEvent = (event: CalendarEventSummary): ShadowEvent => ({
  summary: event.summary,
  start: event.start,
  end: event.end,
  colorId: event.colorId,
  description: event.description,
  location: event.location,
});

async function readState(workspaceRoot?: string): Promise<PushState> {
  const stored = await readJsonOrNull<PushState>(calendarPushStatePath(workspaceRoot));
  return stored?.events ? stored : { events: {} };
}

// One file holds every calendar's baseline, so an unguarded read-modify-write
// loses updates — the same trap `calendarSyncStore.ts` documents. Serialising
// the whole cycle keeps concurrent calendars ordered.
const writeQueue: { tail: Promise<unknown> } = { tail: Promise.resolve() };

async function updateState(mutate: (events: PushState["events"]) => PushState["events"], workspaceRoot?: string): Promise<void> {
  const statePath = calendarPushStatePath(workspaceRoot);
  // Same pairing as `calendarSyncStore.ts`: the queue orders this process, the
  // file lock orders the others (#2679).
  const run = writeQueue.tail.then(
    async () =>
      await withCalendarStateLock(stateLockPath(statePath), async () => {
        const state = await readState(workspaceRoot);
        await writeJsonAtomicWithMode(statePath, { events: mutate(state.events) }, PUSH_STATE_MODE);
      }),
  );
  // Swallow on the queue only — the caller still sees the original rejection.
  writeQueue.tail = run.catch(() => undefined);
  return await run;
}

export async function loadCalendarShadow(calendarId?: string, workspaceRoot?: string): Promise<Record<string, ShadowEvent>> {
  const state = await readState(workspaceRoot);
  return state.events[canonicalCalendarId(calendarId)] ?? {};
}

/** Apply a batch to one calendar's baseline. `null` removes an entry (the event
 *  was cancelled), so a cancel-then-recreate cannot resume from a stale one.
 *  Merged rather than replaced: a sync window describes only what changed. */
export function mergeShadow(current: Record<string, ShadowEvent>, updates: Record<string, ShadowEvent | null>): Record<string, ShadowEvent> {
  const removed = new Set(
    Object.entries(updates)
      .filter(([, entry]) => entry === null)
      .map(([eventId]) => eventId),
  );
  const kept = Object.entries(current).filter(([eventId]) => !removed.has(eventId));
  const written = Object.entries(updates).filter((entry): entry is [string, ShadowEvent] => entry[1] !== null);
  return Object.fromEntries([...kept, ...written]);
}

export async function saveCalendarShadow(calendarId: string | undefined, updates: Record<string, ShadowEvent | null>, workspaceRoot?: string): Promise<void> {
  if (Object.keys(updates).length === 0) return;
  const key = canonicalCalendarId(calendarId);
  await updateState((events) => ({ ...events, [key]: mergeShadow(events[key] ?? {}, updates) }), workspaceRoot);
}

/** Drop one calendar's whole baseline. Called wherever the sync token is
 *  cleared: a baseline outliving its token would let a push diff against events
 *  the workspace no longer holds. */
export async function clearCalendarShadow(calendarId?: string, workspaceRoot?: string): Promise<void> {
  const dropped = canonicalCalendarId(calendarId);
  await updateState((events) => Object.fromEntries(Object.entries(events).filter(([key]) => key !== dropped)), workspaceRoot);
}
