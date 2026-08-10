// Whether a collection has ever received the whole calendar (#2850).
//
// The sync token cannot answer this. It is keyed by `calendarId` and nothing
// else, so it is a claim about the CALENDAR, shared by every consumer of it —
// the standalone `google` tool's `calendarSync`, and every collection bound to
// that calendar. Whoever walks first stores a cursor, and the next collection
// resumes from a window it never received: it gets the delta, reports success
// with no error, and never holds the history at all.
//
// So the claim this file stores is the per-collection one the token is not:
// "these records already cover the whole of calendar X".
//
// Kept in the collection's OWN data dir rather than in the shared calendar
// state, and that placement is the design. The marker describes the records, so
// it must reset exactly when they do — deleting a collection's data (through
// `deleteCollection` or by hand, which is what the #2850 reporter did six
// times) leaves no marker behind claiming a backfill that is gone. The
// alternative, a slug-keyed entry in `.sync-state.json`, needs a cleanup that
// stays in step with every delete path — the shape #2428 already was.
//
// Dot-prefixed so `listItems` skips it: record files are `<id>.json`, and the
// reader already ignores names starting with `.`.
import path from "node:path";
import { readJsonOrNull, writeJsonAtomicWithMode } from "./fsJson.js";
import { canonicalCalendarId } from "./calendar.js";
import { log } from "./host.js";

const BACKFILL_STATE_MODE = 0o600;
const BACKFILL_FILE = ".calendar-sync.json";

interface BackfillState {
  /** The canonical calendar these records were walked in full against. */
  calendarId: string;
  /** When that walk landed (ISO). Diagnostics — but its PRESENCE is checked,
   *  see `needsCalendarBackfill`. */
  walkedAt: string;
}

/** `<dataDir>/.calendar-sync.json` */
export const calendarBackfillPath = (dataDir: string): string => path.join(dataDir, BACKFILL_FILE);

/** Whether these records still need the whole calendar walked into them.
 *
 *  Compared against the calendar the marker NAMES, not merely its presence: a
 *  schema repointed at another calendar holds a backfill of the wrong one, and
 *  resuming that calendar's cursor would leave the same silent gap this exists
 *  to close.
 *
 *  Unreadable, absent or INCOMPLETE all answer "yes" — every field must be
 *  there, not just the one being compared. A redundant full walk costs API
 *  calls and rewrites records that already match; skipping a needed one loses
 *  the history silently, which is the failure being fixed, so the bias only
 *  ever goes one way (CodeRabbit review #2853). */
export async function needsCalendarBackfill(dataDir: string, calendarId: string | undefined): Promise<boolean> {
  const stored = await readJsonOrNull<Partial<BackfillState>>(calendarBackfillPath(dataDir));
  if (typeof stored?.walkedAt !== "string" || stored.walkedAt === "") return true;
  return stored.calendarId !== canonicalCalendarId(calendarId);
}

/** Record that these records now cover the whole calendar. Never throws: the
 *  marker is an optimisation over re-walking, so a workspace that cannot write
 *  it syncs correctly and simply walks in full again next time. */
export async function markCalendarBackfilled(dataDir: string, calendarId: string | undefined, walkedAt: string): Promise<void> {
  const state: BackfillState = { calendarId: canonicalCalendarId(calendarId), walkedAt };
  try {
    await writeJsonAtomicWithMode(calendarBackfillPath(dataDir), state, BACKFILL_STATE_MODE);
  } catch (error) {
    log.warn("google", "could not record the calendar backfill marker — the next sync will walk the calendar again", { dataDir, error: String(error) });
  }
}
