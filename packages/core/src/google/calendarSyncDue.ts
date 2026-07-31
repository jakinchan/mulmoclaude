// Whether a calendar may be synced now, given when this workspace last STARTED
// a sync of it (#2678).
//
// `googleCalendarSyncTaskDef` is a factory several hosts register — MulmoClaude
// and a standalone MulmoTerminal/MulmoBooks — and nothing kept them from syncing
// one calendar at once: the Google link is machine-wide (`~/.config/mulmo`, no
// app name), the calendar lock is module state, and interval schedules fire on
// wall-clock boundaries, so every host ticks in the SAME minute. Since `autoPush`
// (#2620) such a run also writes to Google and rewrites the push baseline.
//
// Same soft-dedup feeds already run on `lastFetchedAt`, and with the same limit:
// the marker is workspace state, so it only speaks for hosts sharing a workspace.

/** Slack between a tick and the marker it writes. Without it a lone host reads
 *  its OWN marker as "not due yet" — elapsed lands a hair under the interval
 *  every time — and syncs every other hour. */
const TICK_JITTER_TOLERANCE_MS = 5 * 60 * 1000;

/** How long a fresh marker suppresses a sync: one interval, less the slack.
 *  The slack is halved rather than subtracted flat for a very short configured
 *  interval, where a fixed five minutes would swallow the window whole. */
export function calendarSyncDueWindowMs(intervalMs: number): number {
  return intervalMs - Math.min(TICK_JITTER_TOLERANCE_MS, intervalMs / 2);
}

/** True iff no recent enough run stands in for this one.
 *
 *  A marker that cannot be read as a time is treated as due: a stuck calendar is
 *  worse than a duplicate run, which the sync is built to tolerate anyway
 *  (writes are upserts by event id). */
export function isCalendarSyncDue(lastSyncedAt: string | null, windowMs: number, now: number = Date.now()): boolean {
  if (!lastSyncedAt) return true;
  const elapsed = now - Date.parse(lastSyncedAt);
  if (!Number.isFinite(elapsed)) return true;
  // A marker from a host whose clock runs ahead would otherwise hold this
  // calendar back for as long as the skew lasts. Beyond a whole window it
  // cannot be a run worth waiting for.
  if (elapsed < -windowMs) return true;
  return elapsed >= windowMs;
}
