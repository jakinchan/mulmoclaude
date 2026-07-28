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
  return { beat, clock, writes, stale, errors };
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
    const { beat, writes, errors } = makeBeat();
    beat.announce(true);
    writes[0].reject(new Error("permission-denied"));
    await settle();
    assert.deepEqual(errors, ["permission-denied"]);
  });

  it("a rejected write does not count as an acknowledgement", async () => {
    const { beat, clock, writes, stale } = makeBeat();
    beat.announce(true);
    writes[0].reject(new Error("unavailable"));
    await settle();

    clock.nowMs += STALE_AFTER_MS;
    beat.beat();
    assert.deepEqual(stale, [STALE_AFTER_MS]);
  });

  it("an acknowledgement resets the age, so a recovered channel stays online", async () => {
    const { beat, clock, writes, stale } = makeBeat();
    beat.announce(true);
    clock.nowMs += STALE_AFTER_MS - 1;
    writes[0].resolve();
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
    const { beat, writes, errors } = makeBeat();
    beat.announce(true);
    writes[0].reject("just a string");
    await settle();
    assert.deepEqual(errors, ["just a string"]);
  });
});
