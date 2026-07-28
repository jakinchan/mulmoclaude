// Tests for `POST /api/shutdown` (#2616).
//
// The ordering is the whole point: the response has to reach the browser
// before the process goes away, because the client switches to its
// "stopped" screen on that response. Stopping inside the handler would
// close the socket first and a button that actually worked would look
// like a failed request.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";

import { createShutdownRouter, type ShutdownResponse } from "../../server/api/routes/shutdown.js";
import { API_ROUTES } from "../../src/config/apiRoutes.js";
import { SHUTDOWN_RESPONSE_GRACE_MS } from "../../server/utils/time.js";

interface Recorded {
  body: ShutdownResponse | null;
  respondedAt: number | null;
}

// Pulls the POST handler straight off the router rather than starting a
// server: what matters is the order of two calls, not the transport.
const handlerFor = (router: ReturnType<typeof createShutdownRouter>) => {
  interface Layer {
    route?: { path: string; stack: { method: string; handle: (req: Request, res: Response) => void }[] };
  }
  const layers = (router as unknown as { stack: Layer[] }).stack;
  const layer = layers.find((entry) => entry.route?.path === API_ROUTES.shutdown);
  const handler = layer?.route?.stack.find((entry) => entry.method === "post")?.handle;
  assert.ok(handler, `no POST handler registered at ${API_ROUTES.shutdown}`);
  return handler;
};

const invoke = (router: ReturnType<typeof createShutdownRouter>): Recorded => {
  const recorded: Recorded = { body: null, respondedAt: null };
  const res = {
    json(body: ShutdownResponse) {
      recorded.body = body;
      recorded.respondedAt = Date.now();
      return this;
    },
  } as unknown as Response;
  handlerFor(router)({} as Request, res);
  return recorded;
};

describe("POST /api/shutdown", () => {
  it("answers before it stops anything", () => {
    let stoppedAt: number | null = null;
    const router = createShutdownRouter({ stop: () => (stoppedAt = Date.now()), delayMs: 0 });
    const recorded = invoke(router);

    assert.deepEqual(recorded.body, { stopping: true });
    assert.equal(stoppedAt, null, "the process was stopped inside the handler — the response would never arrive");
  });

  it("stops once the response has had its moment", async () => {
    let stops = 0;
    const router = createShutdownRouter({ stop: () => (stops += 1), delayMs: 0 });
    invoke(router);
    assert.equal(stops, 0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(stops, 1, "the stop was never scheduled — the button would do nothing");
  });

  it("uses a non-zero grace period in production", () => {
    // A zero delay races the response: the socket can close before the
    // browser reads it, so the click reads as a failure.
    assert.ok(SHUTDOWN_RESPONSE_GRACE_MS > 0);
  });

  it("survives a double click without inventing a second stop path", async () => {
    // `gracefulShutdown` in index.ts guards itself with `isShuttingDown`,
    // so repeated signals are safe. What this pins is that the route does
    // not try to be clever about it and grow its own state.
    let stops = 0;
    const router = createShutdownRouter({ stop: () => (stops += 1), delayMs: 0 });
    invoke(router);
    invoke(router);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(stops, 2, "each request schedules its own signal; deduplication belongs to gracefulShutdown");
  });
});
