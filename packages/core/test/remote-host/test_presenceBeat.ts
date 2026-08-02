// Unit tests for the presence heartbeat's liveness sensor (createPresenceBeat):
//   - a beat writes while the last acknowledgement is fresh
//   - a write that NEVER settles goes stale — the case a rejection counter misses,
//     because Firestore queues an undeliverable write instead of rejecting it
//   - a rejected write is reported with its reason AND does not count as an ack
//   - an acknowledgement resets the age, so a recovered channel is not declared dead
//   - once stale, the beat reports instead of queueing yet another write
//   - boundary: exactly `staleAfterMs` of silence is already stale
//
// The Firestore write is injected, so these run with a fake clock and promises the
// test controls — no Firebase, no waiting out a three-minute window.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createPresenceBeat, type PresenceBeatDeps } from "../../src/remote-host/server/presenceBeat.js";

const STALE_AFTER_MS = 180_000;

// Let the injected write's `.then` handlers run: the ack lands in a microtask.
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface WriteRecord {
  online: boolean;
  resolve: () => void;
  // `unknown`, not `Error`: Firestore is not the only thing that can reject, and
  // the beat has to report whatever it is rather than swallow it.
  reject: (reason: unknown) => void;
}

// A beat whose writes stay pending until the test decides their fate, plus the
// clock it reads. `writes` is every write attempted, newest last.
const makeBeat = (overrides: Partial<PresenceBeatDeps> = {}) => {
  const clock = { nowMs: 1_000_000 };
  const writes: WriteRecord[] = [];
  const stale: number[] = [];
  const errors: string[] = [];
  const beat = createPresenceBeat({
    write: (online) =>
      new Promise<void>((resolve, reject) => {
        writes.push({ online, resolve: () => resolve(), reject });
      }),
    onStale: (silentMs) => stale.push(silentMs),
    onError: (message) => errors.push(message),
    staleAfterMs: STALE_AFTER_MS,
    now: () => clock.nowMs,
    ...overrides,
  });
  // A missing write means the beat never attempted one — fail there, not on `.reject` of undefined.
  const writeAt = (index: number): WriteRecord => {
    const write = writes[index];
    assert.ok(write, `expected a write at index ${index}, got ${writes.length}`);
    return write;
  };
  return { beat, clock, writes, writeAt, stale, errors };
};

describe("createPresenceBeat", () => {
  it("announces while the last acknowledgement is fresh", async () => {
    const { beat, clock, writes, stale } = makeBeat();
    clock.nowMs += STALE_AFTER_MS - 1;
    beat.beat();
    assert.deepEqual(
      writes.map((write) => write.online),
      [true],
    );
    assert.deepEqual(stale, []);
  });

  it("goes stale on a write that never settles — the offline case, which never rejects", async () => {
    const { beat, clock, writes, stale } = makeBeat();
    beat.announce(true);
    await settle();
    // The write is still pending: Firestore holds an undeliverable mutation rather
    // than failing it, so nothing on this side has been told anything.
    assert.equal(writes.length, 1);
    assert.deepEqual(stale, []);

    clock.nowMs += STALE_AFTER_MS;
    beat.beat();
    assert.deepEqual(stale, [STALE_AFTER_MS]);
  });

  it("reports a rejected write with its reason", async () => {
    const { beat, writeAt, errors } = makeBeat();
    beat.announce(true);
    writeAt(0).reject(new Error("permission-denied"));
    await settle();
    assert.deepEqual(errors, ["permission-denied"]);
  });

  it("a rejected write does not count as an acknowledgement", async () => {
    const { beat, clock, writeAt, stale } = makeBeat();
    beat.announce(true);
    writeAt(0).reject(new Error("unavailable"));
    await settle();

    clock.nowMs += STALE_AFTER_MS;
    beat.beat();
    assert.deepEqual(stale, [STALE_AFTER_MS]);
  });

  it("an acknowledgement resets the age, so a recovered channel stays online", async () => {
    const { beat, clock, writes, writeAt, stale } = makeBeat();
    beat.announce(true);
    clock.nowMs += STALE_AFTER_MS - 1;
    writeAt(0).resolve();
    await settle();

    // Another full window minus a tick since that ack: still fresh.
    clock.nowMs += STALE_AFTER_MS - 1;
    beat.beat();
    assert.deepEqual(stale, []);
    assert.equal(writes.length, 2);
  });

  it("stops writing once stale — another mutation would only queue behind the stuck ones", async () => {
    const { beat, clock, writes, stale } = makeBeat();
    beat.announce(true);
    clock.nowMs += STALE_AFTER_MS;
    beat.beat();
    beat.beat();
    assert.equal(writes.length, 1);
    assert.equal(stale.length, 2);
  });

  it("treats exactly staleAfterMs of silence as stale (boundary)", async () => {
    const { beat, clock, stale } = makeBeat();
    clock.nowMs += STALE_AFTER_MS - 1;
    beat.beat();
    assert.deepEqual(stale, []);

    clock.nowMs += 1;
    beat.beat();
    assert.deepEqual(stale, [STALE_AFTER_MS]);
  });

  it("reports a non-Error rejection as text rather than dropping it", async () => {
    const { beat, writeAt, errors } = makeBeat();
    beat.announce(true);
    writeAt(0).reject("just a string");
    await settle();
    assert.deepEqual(errors, ["just a string"]);
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
    const { beat, clock, writes } = makeBeat({ onStale: boom });
    clock.nowMs += STALE_AFTER_MS;
    assert.doesNotThrow(() => beat.beat());

    // A later ack clears the staleness, and the next beat writes again.
    beat.announce(true);
    writes.at(-1)?.resolve();
    await settle();
    beat.beat();
    assert.equal(writes.length, 2); // the announce above, then this beat
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
      staleAfterMs: STALE_AFTER_MS,
    });
    assert.doesNotThrow(() => beat.beat());
    assert.deepEqual(errors, ["firestore is gone"]);
  });
});
