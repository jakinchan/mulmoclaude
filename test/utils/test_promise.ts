import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { settleWithin } from "../../server/utils/promise.js";

const NEVER = new Promise<void>(() => {});

const ONE_SECOND_MS = 1_000;

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

  // The keep-alive is the point, not scaffolding: `settleWithin`'s deadline is
  // unref'd, so with nothing else pending the event loop drains and the await
  // never resumes. Node 22's test runner reports exactly that ("Promise
  // resolution is still pending but the event loop has already resolved");
  // Node 24 happens to tolerate it. Callers are real processes with open
  // handles (the MCP broker has stdin), which is what this stands in for.
  it("gives up at the deadline when the promise never settles", async () => {
    const keepAlive = setInterval(() => {}, ONE_SECOND_MS);
    try {
      const started = Date.now();
      await settleWithin(NEVER, 50);
      assert.ok(Date.now() - started >= 40, "must have waited for the deadline");
    } finally {
      clearInterval(keepAlive);
    }
  });
});
