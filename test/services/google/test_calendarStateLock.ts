// `.sync-state.json` / `.push-state.json` are read-modify-write over a whole
// file. A write queue orders that inside one process; between processes nothing
// did, so two hosts sharing a workspace each read the same snapshot and the
// later write dropped the earlier one's entry (#2679).
//
// Exercised against a real temp directory rather than a mocked fs: the whole
// mechanism IS the filesystem's `O_EXCL`, so faking it would test nothing.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stateLockPath, withCalendarStateLock, type LockClock } from "@mulmoclaude/core/google";

const withTempDir = async (run: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(path.join(tmpdir(), "calendar-state-lock-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/** A clock that never blocks, so a wait-out is instant instead of 5 seconds. */
const fastClock = (start = 0): LockClock => {
  const state = { now: start };
  return {
    now: () => state.now,
    sleep: (delay_ms) => {
      state.now += delay_ms;
      return Promise.resolve();
    },
  };
};

const pathExists = async (file: string): Promise<boolean> => {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
};

describe("stateLockPath", () => {
  it("gives each state file its own lock, so one calendar file cannot block the other", () => {
    assert.notEqual(stateLockPath("/ws/.sync-state.json"), stateLockPath("/ws/.push-state.json"));
    assert.equal(stateLockPath("/ws/.push-state.json"), "/ws/.push-state.json.lock");
  });
});

describe("withCalendarStateLock (#2679 cross-process read-modify-write)", () => {
  it("removes the lock file once the mutation is done", async () => {
    await withTempDir(async (dir) => {
      const lock = stateLockPath(path.join(dir, "state.json"));
      await withCalendarStateLock(lock, () => Promise.resolve("done"), fastClock());
      assert.equal(await pathExists(lock), false);
    });
  });

  it("returns what the mutation returned", async () => {
    await withTempDir(async (dir) => {
      const value = await withCalendarStateLock(stateLockPath(path.join(dir, "state.json")), () => Promise.resolve(42), fastClock());
      assert.equal(value, 42);
    });
  });

  it("releases the lock even when the mutation throws", async () => {
    await withTempDir(async (dir) => {
      const lock = stateLockPath(path.join(dir, "state.json"));
      await assert.rejects(() => withCalendarStateLock(lock, () => Promise.reject(new Error("disk full")), fastClock()));
      assert.equal(await pathExists(lock), false);
    });
  });

  // The property the whole file exists for: a read-modify-write cannot be
  // interleaved by another holder of the same lock.
  it("serialises two mutations of the same file", async () => {
    await withTempDir(async (dir) => {
      const lock = stateLockPath(path.join(dir, "state.json"));
      const order: string[] = [];
      const mutation = (name: string) => async () => {
        order.push(`${name}:start`);
        await new Promise((resolve) => setImmediate(resolve));
        order.push(`${name}:end`);
      };
      await Promise.all([withCalendarStateLock(lock, mutation("a"), fastClock()), withCalendarStateLock(lock, mutation("b"), fastClock())]);
      const [first] = order[0].split(":");
      assert.deepEqual(order, [`${first}:start`, `${first}:end`, ...order.slice(2)]);
      assert.equal(order.length, 4);
    });
  });

  // Fail OPEN. The lock removes a race; it is not a precondition for syncing
  // correctly, so a host that cannot get it still does its work.
  it("proceeds anyway when a live lock never frees up", async () => {
    await withTempDir(async (dir) => {
      const lock = stateLockPath(path.join(dir, "state.json"));
      const clock = fastClock();
      await writeFile(lock, JSON.stringify({ holder: "someone-else", at: clock.now() }));
      assert.equal(await withCalendarStateLock(lock, () => Promise.resolve("ran"), clock), "ran");
    });
  });

  it("leaves someone else's live lock in place after waiting it out", async () => {
    await withTempDir(async (dir) => {
      const lock = stateLockPath(path.join(dir, "state.json"));
      const clock = fastClock();
      await writeFile(lock, JSON.stringify({ holder: "someone-else", at: clock.now() }));
      await withCalendarStateLock(lock, () => Promise.resolve(null), clock);
      const held: unknown = JSON.parse(await readFile(lock, "utf-8"));
      assert.equal((held as { holder: string }).holder, "someone-else");
    });
  });

  // A host that died mid-write must not block the others forever. The TTL is
  // sized against the HOLD time (one read plus one atomic write), not against a
  // sync run, which is what lets it be this short.
  it("reclaims a lock whose holder went quiet past the TTL", async () => {
    await withTempDir(async (dir) => {
      const lock = stateLockPath(path.join(dir, "state.json"));
      const clock = fastClock(1_000_000);
      await writeFile(lock, JSON.stringify({ holder: "crashed-host", at: clock.now() - 60_000 }));
      assert.equal(await withCalendarStateLock(lock, () => Promise.resolve("ran"), clock), "ran");
      assert.equal(await pathExists(lock), false);
    });
  });

  // Hand-edited, truncated, or written by an older version. `release` only
  // removes a file whose holder matches, so an unreadable one can never be
  // released by anybody — once it is stale it has to be reclaimed, not waited
  // on. (This test first passed by taking the full timeout, which exposed that
  // the reclaim was missing entirely.)
  it("reclaims an unreadable lock file once it is stale", async () => {
    await withTempDir(async (dir) => {
      const lock = stateLockPath(path.join(dir, "state.json"));
      await writeFile(lock, "not json at all");
      // The age of an unreadable lock comes from its mtime, which is real wall
      // time — so the clock has to be ahead of it, not at zero.
      const clock = fastClock(Date.now() + 60_000);
      assert.equal(await withCalendarStateLock(lock, () => Promise.resolve("ran"), clock), "ran");
      assert.equal(await pathExists(lock), false);
    });
  });

  // `open("wx")` creates the file EMPTY and the payload lands a moment later,
  // so every healthy lock is briefly unreadable. Reclaiming on sight would
  // unlink a live lock mid-creation and hand it to two holders at once — the
  // exact race this module exists to remove (Codex review #2690).
  it("leaves a freshly created lock alone while its payload is still being written", async () => {
    await withTempDir(async (dir) => {
      const lock = stateLockPath(path.join(dir, "state.json"));
      await writeFile(lock, "");
      const clock = fastClock(Date.now());
      assert.equal(await withCalendarStateLock(lock, () => Promise.resolve("ran"), clock), "ran");
      assert.equal(await pathExists(lock), true, "a lock being written must survive another process's acquire attempt");
    });
  });

  it("does not delete a lock that was replaced while we waited", async () => {
    await withTempDir(async (dir) => {
      const lock = stateLockPath(path.join(dir, "state.json"));
      const clock = fastClock();
      await writeFile(lock, JSON.stringify({ holder: "held-by-another", at: clock.now() }));
      await withCalendarStateLock(lock, () => Promise.resolve(null), clock);
      assert.equal(await pathExists(lock), true);
    });
  });
});
