// Serialising everything that touches ONE calendar's sync state.
//
// A leaf on purpose: both directions need it (the pull in `collectionSync.ts`,
// the push in `collectionPush.ts`), and the pull now drives the push, so leaving
// the lock inside either one would make the two import each other.
import { canonicalCalendarId } from "./calendar.js";

/** Serialise `run` against whatever is already running for `key`.
 *
 *  `locks` is passed in so the queuing rule is testable without module state;
 *  the key is dropped once nothing is queued behind it, so the map cannot grow
 *  an entry per calendar forever. A failed predecessor still releases the
 *  queue — `then(run, run)`. */
export async function withKeyedLock<T>(locks: Map<string, Promise<unknown>>, key: string, run: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const result = previous.then(run, run);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  locks.set(key, tail);
  try {
    return await result;
  } finally {
    if (locks.get(key) === tail) locks.delete(key);
  }
}

/** In-flight work per canonical calendar id. Module state on purpose: the
 *  scheduler, the create trigger and the Refresh button are three doors into
 *  the same calendar (CodeRabbit review #2566). */
const calendarLocks = new Map<string, Promise<unknown>>();

/** Serialise anything that touches ONE calendar's sync state.
 *
 *  Shared with the push path (#2598), not only the pull doors: a push that
 *  overtakes an in-flight pull would record a baseline for events the pull is
 *  still writing, so the next push would diff against a future it never saw.
 *
 *  NOT reentrant — a holder must call the lock-free form of whatever it drives,
 *  or it waits on itself forever. */
export async function withCalendarLock<T>(calendarId: string | undefined, run: () => Promise<T>): Promise<T> {
  return await withKeyedLock(calendarLocks, canonicalCalendarId(calendarId), run);
}
