// Cross-process exclusion for the calendar state files (#2679).
//
// `.sync-state.json` and `.push-state.json` are both read-modify-write over a
// whole file. Inside one process a write queue orders that; between processes
// nothing did, so two hosts sharing a workspace could each read the same
// snapshot and the later write would drop the earlier one's entry.
//
// Scoped to the file mutation, NOT to the sync run. The mutation is held for
// milliseconds, which is what makes this cheap: no "another host is busy"
// result to thread through the routes, and a stale lock can be reclaimed on a
// short timer instead of needing a heartbeat sized against a multi-minute full
// walk.
//
// What it does NOT do: stop two hosts walking the same calendar at once. That
// wastes API calls, but the records are upserts and the baseline is now safe,
// so nothing is lost by it.
import { open, readFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { log } from "./host.js";

const LOCK_MODE = 0o600;
/** How long a lock may sit untouched before another process may reclaim it.
 *
 *  Sized against the HOLD time, which is one read plus one atomic write — a few
 *  milliseconds. Generous by three orders of magnitude so a slow disk never
 *  looks like a crash, while a host that died mid-write blocks the others for
 *  at most this long. */
const LOCK_STALE_MS = 10_000;
/** How long a caller waits before giving up and proceeding unlocked. */
const LOCK_WAIT_MS = 5_000;
const LOCK_RETRY_MS = 20;

interface LockFile {
  /** Who holds it. Not a secret — it only has to be unique per acquisition, so
   *  that a release removes its OWN lock and never the one that replaced it. */
  holder: string;
  at: number;
}

/** The clock and the sleep, injected so the timing rules can be exercised
 *  without real waits. */
export interface LockClock {
  now: () => number;
  sleep: (delay_ms: number) => Promise<void>;
}

export const liveLockClock: LockClock = {
  now: () => Date.now(),
  sleep: (delay_ms) => new Promise((resolve) => setTimeout(resolve, delay_ms)),
};

const isEexist = (error: unknown): boolean => typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";

/** The file's bytes, or null when it is not there. */
async function readLockRaw(lockPath: string): Promise<string | null> {
  try {
    return await readFile(lockPath, "utf-8");
  } catch {
    return null;
  }
}

/** Absent means unheld; UNREADABLE does not — see `stealIfStale`. */
function parseLock(raw: string): LockFile | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { holder, at } = parsed as Partial<LockFile>;
    return typeof holder === "string" && typeof at === "number" ? { holder, at } : null;
  } catch {
    return null;
  }
}

async function readLock(lockPath: string): Promise<LockFile | null> {
  const raw = await readLockRaw(lockPath);
  return raw === null ? null : parseLock(raw);
}

/** Take the lock, or answer false because someone else holds a live one. */
async function tryAcquire(lockPath: string, holder: string, clock: LockClock): Promise<boolean> {
  try {
    const handle = await open(lockPath, "wx", LOCK_MODE);
    try {
      await handle.writeFile(JSON.stringify({ holder, at: clock.now() }));
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    if (!isEexist(error)) throw error;
    return false;
  }
}

/** Drop a lock whose holder has gone quiet for longer than the TTL.
 *
 *  The holder seen before the age check is re-read and compared before the
 *  unlink, so a holder that renewed in between is not evicted. That narrows the
 *  window rather than closing it — two processes can still both decide to steal
 *  the same corpse. The cost of losing that race is one lost update, which is
 *  what this file reduces rather than a new failure, and it takes a host dying
 *  mid-write plus a 10-second wait to reach at all. */
async function stealIfStale(lockPath: string, clock: LockClock): Promise<void> {
  const raw = await readLockRaw(lockPath);
  if (raw === null) return;
  const held = parseLock(raw);
  // A lock nobody can read is a lock nobody can release: `release` only removes
  // a file whose holder matches, so a truncated or hand-edited one would sit
  // there forever, costing every later mutation the full wait before it gave up
  // and proceeded unlocked. Reclaim it instead (found by its own test taking
  // the timeout to pass).
  if (held === null) {
    log.warn("google", "reclaiming an unreadable calendar state lock", { lockPath });
    await unlink(lockPath).catch(() => undefined);
    return;
  }
  if (clock.now() - held.at < LOCK_STALE_MS) return;
  const stillHeld = await readLock(lockPath);
  if (stillHeld?.holder !== held.holder) return;
  log.warn("google", "reclaiming a calendar state lock whose holder went quiet", { lockPath, heldForMs: clock.now() - held.at });
  await unlink(lockPath).catch(() => undefined);
}

async function release(lockPath: string, holder: string): Promise<void> {
  const held = await readLock(lockPath);
  // Only ever remove OUR lock: after a steal the file may belong to whoever
  // took it next, and unlinking that would hand the same lock to two holders.
  if (held?.holder !== holder) return;
  await unlink(lockPath).catch(() => undefined);
}

/** Run `mutate` with no other process mutating the same file.
 *
 *  Fails OPEN. A workspace that cannot create the lock file — a read-only
 *  mount, a missing directory, an exhausted disk — still syncs, the way it did
 *  before #2679; the lock removes a race, it is not a precondition for
 *  correctness. The same applies to waiting the timeout out: proceeding
 *  unlocked risks the lost update this exists to prevent, whereas refusing
 *  would stop the sync outright.
 *
 *  Note what this cannot promise. `O_EXCL` is atomic on a local filesystem and
 *  on NFSv3+, but a workspace living in a consumer sync folder (Dropbox,
 *  iCloud, Drive) has no such guarantee — there the file is replicated after
 *  the fact and both hosts believe they hold it. */
export async function withCalendarStateLock<T>(lockPath: string, mutate: () => Promise<T>, clock: LockClock = liveLockClock): Promise<T> {
  const holder = randomUUID();
  const deadline = clock.now() + LOCK_WAIT_MS;
  let holding = false;
  try {
    holding = await acquireBefore(lockPath, holder, deadline, clock);
    if (!holding) log.warn("google", "proceeding without the calendar state lock — another host is holding it", { lockPath });
    return await mutate();
  } finally {
    if (holding) await release(lockPath, holder);
  }
}

/** Poll until the lock is ours or the deadline passes. */
async function acquireBefore(lockPath: string, holder: string, deadline: number, clock: LockClock): Promise<boolean> {
  for (;;) {
    try {
      if (await tryAcquire(lockPath, holder, clock)) return true;
      await stealIfStale(lockPath, clock);
    } catch (error) {
      log.warn("google", "could not take the calendar state lock — mutating without it", { lockPath, error: String(error) });
      return false;
    }
    if (clock.now() >= deadline) return false;
    await clock.sleep(LOCK_RETRY_MS);
  }
}

/** `<state file>.lock`, so each state file is serialised on its own. */
export const stateLockPath = (statePath: string): string => `${statePath}.lock`;
