import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { settleWithin } from "../../server/utils/promise.js";

const NEVER = new Promise<void>(() => {});

describe("settleWithin", () => {
  it("returns as soon as the promise resolves, well before the deadline", async () => {
    const started = Date.now();
    await settleWithin(Promise.resolve("done"), 5_000);
    assert.ok(Date.now() - started < 1_000, "must not wait out the timeout when the promise already settled");
  });

  // The caller asked to stop waiting, not to learn the outcome — a rejection
  // must not propagate out of the wait.
  it("treats a rejection as settled", async () => {
    const started = Date.now();
    await settleWithin(Promise.reject(new Error("boom")), 5_000);
    assert.ok(Date.now() - started < 1_000, "a rejection must end the wait, not run out the clock");
  });

  it("gives up at the deadline when the promise never settles", async () => {
    const started = Date.now();
    await settleWithin(NEVER, 50);
    assert.ok(Date.now() - started >= 40, "must have waited for the deadline");
  });
});
