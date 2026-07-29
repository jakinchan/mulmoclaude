// Unit tests for the presence freshness rule (presenceIsFresh) — the judgment the
// phone makes about this host, applied on the host's own side (#2633):
//   - a document written within the staleness window is alive
//   - one older than the window is not: the beats have stopped landing
//   - a Firestore Timestamp is read the same way an epoch number is
//   - three cases are deliberately UNJUDGEABLE (null), because a false "dead"
//     spins a reconnect loop: no document at all, a serverTimestamp still pending,
//     and the runner's own `online: false` goodbye
//
// The rule is pure with an injected `now`, so none of this needs Firestore.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { PRESENCE_STALE_MS, presenceIsFresh, withTimeout } from "../../src/remote-host/server/presenceProbe.js";

const NOW = 1_700_000_000_000;

describe("presenceIsFresh", () => {
  it("calls a recently-written document alive", () => {
    assert.equal(presenceIsFresh({ online: true, updatedAt: NOW - 1_000 }, NOW), true);
  });

  it("calls a document older than the window dead", () => {
    assert.equal(presenceIsFresh({ online: true, updatedAt: NOW - PRESENCE_STALE_MS - 1 }, NOW), false);
  });

  it("treats exactly the staleness window as dead (boundary)", () => {
    assert.equal(presenceIsFresh({ online: true, updatedAt: NOW - PRESENCE_STALE_MS + 1 }, NOW), true);
    assert.equal(presenceIsFresh({ online: true, updatedAt: NOW - PRESENCE_STALE_MS }, NOW), false);
  });

  it("reads a Firestore Timestamp, not just an epoch number", () => {
    const timestamp = { toMillis: () => NOW - 1_000 };
    assert.equal(presenceIsFresh({ online: true, updatedAt: timestamp }, NOW), true);
  });

  it("cannot judge a host that has never announced (no document)", () => {
    assert.equal(presenceIsFresh(undefined, NOW), null);
  });

  it("cannot judge a serverTimestamp that has not resolved yet — a write in flight", () => {
    assert.equal(presenceIsFresh({ online: true, updatedAt: null }, NOW), null);
    assert.equal(presenceIsFresh({ online: true }, NOW), null);
  });

  it("cannot judge the runner's own goodbye — offline on purpose is not broken", () => {
    assert.equal(presenceIsFresh({ online: false, updatedAt: NOW - PRESENCE_STALE_MS - 1 }, NOW), null);
  });

  it("ignores a non-numeric updatedAt rather than guessing", () => {
    assert.equal(presenceIsFresh({ online: true, updatedAt: "yesterday" }, NOW), null);
  });

  // A runner started with a custom `heartbeatMs` beats on a different rhythm, and
  // the probe has to judge against THAT one — the caller passes the runner's own
  // `presenceStaleAfterMs(options)` rather than letting a second copy drift.
  it("judges against the threshold it is given, not only the default", () => {
    const tenSeconds = 10_000;
    assert.equal(presenceIsFresh({ online: true, updatedAt: NOW - 20_000 }, NOW, tenSeconds), false);
    assert.equal(presenceIsFresh({ online: true, updatedAt: NOW - 20_000 }, NOW), true); // fresh under the 3-minute default
  });
});

// A read that never settles would leave the probe un-rearmed — a sensor dying
// quietly, which is exactly the failure mode this module exists to catch.
describe("withTimeout", () => {
  it("passes a value through when the work answers in time", async () => {
    assert.equal(await withTimeout(Promise.resolve("answered"), 1_000), "answered");
  });

  it("rejects when the work never settles", async () => {
    const never = new Promise<string>(() => undefined);
    await assert.rejects(withTimeout(never, 5), /did not answer/);
  });

  it("keeps the work's own failure rather than masking it as a timeout", async () => {
    await assert.rejects(withTimeout(Promise.reject(new Error("unavailable")), 1_000), /unavailable/);
  });
});
