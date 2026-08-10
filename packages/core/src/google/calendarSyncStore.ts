// Persistence for the Google Calendar incremental-sync tokens (#2095) and the
// cross-host sync markers (#2678).
//
// Unlike the OAuth material in `paths.ts`, this state lives INSIDE the
// workspace. A syncToken is a claim about which records the workspace already
// holds: if it survived a workspace reset, the next incremental sync would
// report "nothing changed" against an empty calendar and stay silently empty.
// Keeping it next to the data it describes makes the two reset together.
import path from "node:path";
import { getWorkspaceRoot } from "../collection/server/host.js";
import { readJsonOrNull, writeJsonAtomicWithMode } from "./fsJson.js";
import { canonicalCalendarId } from "./calendar.js";
import { stateLockPath, withCalendarStateLock } from "./calendarStateLock.js";

const SYNC_STATE_MODE = 0o600;

/** `<workspace>/data/calendar/.sync-state.json` */
export function calendarSyncStatePath(workspaceRoot?: string): string {
  return path.join(workspaceRoot ?? getWorkspaceRoot(), "data", "calendar", ".sync-state.json");
}

interface CalendarSyncState {
  /** calendarId → the `nextSyncToken` returned by that calendar's last sync. */
  tokens: Record<string, string>;
  /** calendarId → when a sync of it last STARTED (ISO).
   *
   *  A separate concern from the token, deliberately: the token says how far
   *  the workspace has read, never when anyone last ran. Workspace state rather
   *  than host state, because that is exactly what lets a second host see that
   *  this calendar is already being synced (#2678, `calendarSyncDue.ts`). */
  lastSyncedAt: Record<string, string>;
}

// Shared with the REST layer so a stored token is keyed by exactly the
// calendar the request addressed — an omitted id and an explicit "primary"
// must never end up as two different keys.
const calendarKey = canonicalCalendarId;

/** The key for a consumer that reads a calendar without KEEPING what it reads.
 *
 *  A sync token is a claim about which events the consumer already holds, but
 *  the key above names only the calendar — so every consumer of one calendar
 *  shares one cursor. That is right for the collections bound to it (one fetch
 *  fans out to all of them in the same pass) and wrong for the standalone
 *  `google` tool's `calendarSync`, which walks the calendar, reports a summary
 *  to the LLM and discards the events.
 *
 *  Sharing it lost data both ways (#2850): the tool consumed windows the
 *  collections then never received, and a collection created afterwards resumed
 *  from the tool's cursor — so its "first sync" was a delta of a window it had
 *  never held, and the calendar's history never arrived. Same file, separate
 *  keyspace. Idempotent through `calendarKey`, since the result is non-empty. */
export const toolCalendarSyncKey = (calendarId: string | undefined): string => `tool:${canonicalCalendarId(calendarId)}`;

/** Read one map out of whatever is on disk. Tolerant on purpose: a file written
 *  before `lastSyncedAt` existed simply lacks the key, and a hand-edited one may
 *  hold anything. A dropped entry costs a full re-walk or a duplicate run, never
 *  data — throwing here would stop the sync entirely. */
function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

async function readState(workspaceRoot?: string): Promise<CalendarSyncState> {
  const stored = await readJsonOrNull<Partial<CalendarSyncState>>(calendarSyncStatePath(workspaceRoot));
  return { tokens: stringRecord(stored?.tokens), lastSyncedAt: stringRecord(stored?.lastSyncedAt) };
}

// One file holds every calendar's token, so an unguarded read-modify-write
// loses updates: two calendars syncing at once both read the same snapshot and
// the later write drops the earlier one's token — silently forcing that
// calendar into a full re-walk next run. Serialising the whole cycle keeps
// them ordered. Scope is this process, which is where the concurrency comes
// from (parallel tool calls today, the scheduler fanning out over calendars
// next). Held in a const wrapper so the tail can advance without a `let`.
const writeQueue: { tail: Promise<unknown> } = { tail: Promise.resolve() };

/** Decide from the stored state and write the result, both inside the queue, so
 *  nothing in this process can read between the two. A `null` state skips the
 *  write; `result` is what the caller learns about the decision. */
async function updateStateWith<T>(decide: (state: CalendarSyncState) => { state: CalendarSyncState | null; result: T }, workspaceRoot?: string): Promise<T> {
  const statePath = calendarSyncStatePath(workspaceRoot);
  // The queue orders this process; the file lock orders the others. Both are
  // needed — the lock is per read-modify-write, so two of THIS process's own
  // mutations would still interleave without the queue (#2679).
  const run = writeQueue.tail.then(
    async () =>
      await withCalendarStateLock(stateLockPath(statePath), async () => {
        const { state, result } = decide(await readState(workspaceRoot));
        if (state) await writeJsonAtomicWithMode(statePath, state, SYNC_STATE_MODE);
        return result;
      }),
  );
  // Swallow on the queue only — the caller still sees the original rejection.
  writeQueue.tail = run.catch(() => undefined);
  return await run;
}

async function updateState(mutate: (state: CalendarSyncState) => CalendarSyncState, workspaceRoot?: string): Promise<void> {
  await updateStateWith((state) => ({ state: mutate(state), result: undefined }), workspaceRoot);
}

const withoutKey = (record: Record<string, string>, dropped: string): Record<string, string> =>
  Object.fromEntries(Object.entries(record).filter(([key]) => key !== dropped));

export async function loadCalendarSyncToken(calendarId?: string, workspaceRoot?: string): Promise<string | null> {
  const state = await readState(workspaceRoot);
  return state.tokens[calendarKey(calendarId)] ?? null;
}

export async function saveCalendarSyncToken(calendarId: string | undefined, syncToken: string, workspaceRoot?: string): Promise<void> {
  const stored = calendarKey(calendarId);
  await updateState((state) => ({ ...state, tokens: { ...state.tokens, [stored]: syncToken } }), workspaceRoot);
}

/** Drop one calendar's token — used when Google answers 410, so the next run
 *  starts a clean full sync. Leaves the sync marker alone: "restart the walk"
 *  says nothing about "nobody is running". */
export async function clearCalendarSyncToken(calendarId?: string, workspaceRoot?: string): Promise<void> {
  const dropped = calendarKey(calendarId);
  await updateState((state) => ({ ...state, tokens: withoutKey(state.tokens, dropped) }), workspaceRoot);
}

export async function loadCalendarLastSyncedAt(calendarId?: string, workspaceRoot?: string): Promise<string | null> {
  const state = await readState(workspaceRoot);
  return state.lastSyncedAt[calendarKey(calendarId)] ?? null;
}

/** Stamp when a sync of this calendar started, but only if `mayClaim` accepts
 *  what the marker currently says. Answers whether THIS call is the one that
 *  claimed it.
 *
 *  The decision and the stamp share one pass through the queue on purpose.
 *  Deciding from a snapshot read earlier — as a caller filtering a whole map of
 *  calendars up front must — leaves both hosts believing the calendar is free,
 *  which is the race this exists to close (Codex review #2680). What remains is
 *  the read→write gap BETWEEN processes; closing that needs a real file lock
 *  (#2679), and this stays a soft dedup until then.
 *
 *  The time is passed in rather than read here so the rule stays testable
 *  without freezing the clock. */
export async function claimCalendarSyncIfDue(
  calendarId: string | undefined,
  startedAt: string,
  mayClaim: (lastSyncedAt: string | null) => boolean,
  workspaceRoot?: string,
): Promise<boolean> {
  const stored = calendarKey(calendarId);
  return await updateStateWith((state) => {
    const claimed = mayClaim(state.lastSyncedAt[stored] ?? null);
    return { state: claimed ? { ...state, lastSyncedAt: { ...state.lastSyncedAt, [stored]: startedAt } } : null, result: claimed };
  }, workspaceRoot);
}

/** Drop one calendar's marker, so the next tick — on either host — may sync it
 *  immediately instead of waiting the window out. */
export async function clearCalendarLastSyncedAt(calendarId?: string, workspaceRoot?: string): Promise<void> {
  const dropped = calendarKey(calendarId);
  await updateState((state) => ({ ...state, lastSyncedAt: withoutKey(state.lastSyncedAt, dropped) }), workspaceRoot);
}
