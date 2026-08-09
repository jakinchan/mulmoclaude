// Unit tests for the presence heartbeat's liveness sensor (createPresenceBeat):
//   - a beat writes while the last acknowledgement is fresh
//   - a write that NEVER settles goes stale — the case a rejection counter misses,
//     because Firestore queues an undeliverable write instead of rejecting it
//   - a rejected write is reported with its reason AND does not count as an ack
//   - an acknowledgement resets the count, so a recovered channel is not declared dead
//   - once stale, the beat reports instead of queueing yet another write
//   - boundary: exactly `staleAfterBeats` beats is already stale
//   - regression (#2845): wall-clock time alone never makes it stale, however much
//     of it passes, because beats that never RAN are not beats that failed
//
// The Firestore write is injected, so these run with a fake clock and promises the
// test controls — no Firebase, no waiting out a three-minute window.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createPresenceBeat, type PresenceBeat, type PresenceBeatDeps } from "../../src/remote-host/server/presenceBeat.js";

const STALE_AFTER_BEATS = 3;
const HEARTBEAT_MS = 60_000;

// Let the injected write's `.then` handlers run: the ack lands in a microtask.
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface WriteRecord {
  online: boolean;
  resolve: () => void;
  // `unknown`, not `Error`: Firestore is not the only thing that can reject, and
  // the beat has to report whatever it is rather than swallow it.
  reject: (reason: unknown) => void;
}

interface FakeClock {
  nowMs: number;
}

// A write that settles only when the test says so — which is the point: Firestore
// holds an undeliverable mutation rather than failing it.
const pendingWrite =
  (writes: WriteRecord[]) =>
  (online: boolean): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      writes.push({ online, resolve: () => resolve(), reject });
    });

// A missing write means the beat never attempted one — fail there, not on `.reject` of undefined.
const writeAtOf =
  (writes: WriteRecord[]) =>
  (index: number): WriteRecord => {
    const write = writes[index];
    assert.ok(write, `expected a write at index ${index}, got ${writes.length}`);
    return write;
  };

// The timer firing on schedule: one beat per heartbeat, the clock moving with it.
const beatTimesOf =
  (clock: FakeClock, beat: PresenceBeat) =>
  (count: number): void => {
    Array.from({ length: count }).forEach(() => {
      clock.nowMs += HEARTBEAT_MS;
      beat.beat();
    });
  };

// A beat whose writes stay pending until the test decides their fate, plus the
// clock it reads. `writes` is every write attempted, newest last.
const makeBeat = (overrides: Partial<PresenceBeatDeps> = {}) => {
  const clock: FakeClock = { nowMs: 1_000_000 };
  const writes: WriteRecord[] = [];
  const stale: number[] = [];
  const errors: string[] = [];
  const beat = createPresenceBeat({
    write: pendingWrite(writes),
    onStale: (silentMs) => stale.push(silentMs),
    onError: (message) => errors.push(message),
    staleAfterBeats: STALE_AFTER_BEATS,
    now: () => clock.nowMs,
    ...overrides,
  });
  return { beat, beatTimes: beatTimesOf(clock, beat), clock, writes, writeAt: writeAtOf(writes), stale, errors };
};

describe("createPresenceBeat", () => {
  it("announces while the last acknowledgement is fresh", () => {
    const { beatTimes, writes, stale } = makeBeat();
    beatTimes(1);
    assert.deepEqual(
      writes.map((write) => write.online),
      [true],
    );
    assert.deepEqual(stale, []);
  });

  it("goes stale on a write that never settles — the offline case, which never rejects", async () => {
    const { beat, beatTimes, writes, stale } = makeBeat();
    beat.announce(true);
    await settle();
    // The write is still pending: Firestore holds an undeliverable mutation rather
    // than failing it, so nothing on this side has been told anything.
    assert.equal(writes.length, 1);
    assert.deepEqual(stale, []);

    beatTimes(STALE_AFTER_BEATS);
    assert.equal(stale.length, 1);
  });

  it("reports how long the silence lasted, for the log line", () => {
    const { beatTimes, stale } = makeBeat();
    beatTimes(STALE_AFTER_BEATS);
    assert.deepEqual(stale, [STALE_AFTER_BEATS * HEARTBEAT_MS]);
  });

  it("reports a rejected write with its reason", async () => {
    const { beat, writeAt, errors } = makeBeat();
    beat.announce(true);
    writeAt(0).reject(new Error("permission-denied"));
    await settle();
    assert.deepEqual(errors, ["permission-denied"]);
  });

  it("a rejected write does not count as an acknowledgement", async () => {
    const { beat, beatTimes, writeAt, stale } = makeBeat();
    beat.announce(true);
    writeAt(0).reject(new Error("unavailable"));
    await settle();

    beatTimes(STALE_AFTER_BEATS);
    assert.equal(stale.length, 1);
  });

  it("an acknowledgement resets the count, so a recovered channel stays online", async () => {
    const { beatTimes, writes, writeAt, stale } = makeBeat();
    beatTimes(STALE_AFTER_BEATS - 1); // one beat short of stale
    assert.deepEqual(stale, []);

    writeAt(0).resolve();
    await settle();

    // A full window minus one beat since that ack: still fresh.
    beatTimes(STALE_AFTER_BEATS - 1);
    assert.deepEqual(stale, []);
    assert.equal(writes.length, 2 * (STALE_AFTER_BEATS - 1));
  });

  it("stops writing once stale — another mutation would only queue behind the stuck ones", () => {
    const { beatTimes, writes, stale } = makeBeat();
    beatTimes(STALE_AFTER_BEATS + 1);
    // The beats before the threshold wrote; the two at and past it did not.
    assert.equal(writes.length, STALE_AFTER_BEATS - 1);
    assert.equal(stale.length, 2);
  });

  it("treats exactly staleAfterBeats beats as stale (boundary)", () => {
    const { beatTimes, stale } = makeBeat();
    beatTimes(STALE_AFTER_BEATS - 1);
    assert.deepEqual(stale, []);

    beatTimes(1);
    assert.equal(stale.length, 1);
  });

  it("reports a non-Error rejection as text rather than dropping it", async () => {
    const { beat, writeAt, errors } = makeBeat();
    beat.announce(true);
    writeAt(0).reject("just a string");
    await settle();
    assert.deepEqual(errors, ["just a string"]);
  });
});

// #2845. A host reported "no presence write acknowledged for 459s" with a working
// network: 459 is not a number the old sensor could reach while its 60s timer was
// firing (three beats put it at 180s and it never got further), so the beats had
// not run at all — the machine had been asleep, or the clock had stepped. Measuring
// elapsed time cannot tell "nothing was attempted" from "everything failed";
// counting the beats that ran can only ever mean the latter.
describe("createPresenceBeat — time that passes without beats is not an outage", () => {
  it("stays online across an hour of wall clock in which no beat ran", async () => {
    const { beat, beatTimes, clock, writes, stale } = makeBeat();
    beat.announce(true);
    await settle();

    clock.nowMs += 60 * 60_000; // asleep, stalled, or the clock stepped

    beatTimes(1);
    assert.deepEqual(stale, [], "a gap in the beats is not evidence that any write failed");
    assert.equal(writes.length, 2, "the beat after the gap writes, rather than declaring the host dead");
  });

  it("still goes stale after the gap if the channel really is down", () => {
    const { beatTimes, clock, stale } = makeBeat();
    clock.nowMs += 60 * 60_000;
    beatTimes(STALE_AFTER_BEATS);
    assert.equal(stale.length, 1);
  });
});

// The heartbeat runs on a timer and its callbacks belong to the host. A throw from
// one of them would surface as an uncaught exception (from `beat`) or an unhandled
// rejection (from the write chain) — killing the command channel over a broken
// observer, which is a worse outcome than the one being reported.
describe("createPresenceBeat — a broken observer must not take the host down", () => {
  const boom = () => {
    throw new Error("observer blew up");
  };

  it("survives an onStale that throws, and keeps beating afterwards", async () => {
    const { beat, beatTimes, writes } = makeBeat({ onStale: boom });
    beatTimes(STALE_AFTER_BEATS);
    assert.doesNotThrow(() => beat.beat());

    // A later ack clears the staleness, and the next beat writes again.
    beat.announce(true);
    writes.at(-1)?.resolve();
    await settle();
    const writesBefore = writes.length;
    beatTimes(1);
    assert.equal(writes.length, writesBefore + 1);
  });

  it("survives an onError that throws (an unhandled rejection would end the process)", async () => {
    const { beat, writes, writeAt } = makeBeat({ onError: boom });
    beat.announce(true);
    writeAt(0).reject(new Error("permission-denied"));
    await settle();
    assert.equal(writes.length, 1);
  });

  it("reports a write that throws synchronously instead of letting it escape the timer", () => {
    const errors: string[] = [];
    const beat = createPresenceBeat({
      write: () => {
        throw new Error("firestore is gone");
      },
      onStale: () => undefined,
      onError: (message) => errors.push(message),
      staleAfterBeats: STALE_AFTER_BEATS,
    });
    assert.doesNotThrow(() => beat.beat());
    assert.deepEqual(errors, ["firestore is gone"]);
  });
});
