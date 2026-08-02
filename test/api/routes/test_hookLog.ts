// Unit tests for the hook-log route.
//
// The route is the bridge from PostToolUse handlers (which run in
// Claude CLI's process space and have no logger access) to the
// server's structured logger. Tests cover validation + that the
// log call happens with the right tagged namespace + level.
//
// Pattern follows test/routes/test_configRoute.ts — extract the
// handler from the Express Router stack and call it directly with
// mock req/res, so no supertest / live-server dependency is needed.

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response, Router } from "express";
import hookLogRoutes from "../../../server/api/routes/hookLog.js";
import { log } from "../../../server/system/logger/index.js";
import { API_ROUTES } from "../../../src/config/apiRoutes.js";

interface LogCall {
  level: "info" | "warn" | "error";
  namespace: string;
  message: string;
  data?: object | undefined;
}

const captured: LogCall[] = [];
const originalInfo = log.info;
const originalWarn = log.warn;
const originalError = log.error;

interface RouterInternals {
  stack: { route?: { path: string; stack: { handle: (req: Request, res: Response) => void }[] } }[];
}

function getPostHandler(router: Router): (req: Request, res: Response) => void {
  const internals = router as unknown as RouterInternals;
  for (const layer of internals.stack) {
    if (layer.route && layer.route.path === API_ROUTES.hooks.log) {
      const [first] = layer.route.stack;
      if (first) return first.handle;
    }
  }
  throw new Error(`POST ${API_ROUTES.hooks.log} handler not found in router stack`);
}

interface MockResponse {
  statusCode: number;
  body: unknown;
  status: (code: number) => MockResponse;
  json: (payload: unknown) => MockResponse;
  end: () => MockResponse;
}

function mockResponse(): MockResponse {
  const res: MockResponse = {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    end() {
      return this;
    },
  };
  return res;
}

async function callHandler(body: unknown): Promise<MockResponse> {
  const handler = getPostHandler(hookLogRoutes);
  const req = { body } as unknown as Request;
  const res = mockResponse();
  await Promise.resolve(handler(req, res as unknown as Response));
  return res;
}

describe("POST /api/hooks/log", () => {
  beforeEach(() => {
    captured.length = 0;
    log.info = (namespace, message, data) => {
      captured.push({ level: "info", namespace, message, data });
    };
    log.warn = (namespace, message, data) => {
      captured.push({ level: "warn", namespace, message, data });
    };
    log.error = (namespace, message, data) => {
      captured.push({ level: "error", namespace, message, data });
    };
  });

  afterEach(() => {
    log.info = originalInfo;
    log.warn = originalWarn;
    log.error = originalError;
  });

  it("logs at info level by default and tags the namespace with `hook:`", async () => {
    const res = await callHandler({ namespace: "skill-bridge", message: "mirrored foo" });
    assert.equal(res.statusCode, 204);
    assert.equal(captured.length, 1);
    const [entry] = captured;
    assert.ok(entry);
    assert.equal(entry.level, "info");
    // The `hook:` prefix lets the user grep for hook-side noise
    // separately from server-side `skill-bridge` log lines (if a
    // server module ever uses that namespace).
    assert.equal(entry.namespace, "hook:skill-bridge");
    assert.equal(entry.message, "mirrored foo");
  });

  it("honours explicit level and forwards data", async () => {
    const res = await callHandler({ namespace: "skill-bridge", message: "mirror failed", level: "error", data: { slug: "foo", op: "write" } });
    assert.equal(res.statusCode, 204);
    const [entry] = captured;
    assert.ok(entry);
    assert.equal(entry.level, "error");
    assert.deepEqual(entry.data, { slug: "foo", op: "write" });
  });

  it("rejects missing namespace / message with 400", async () => {
    const noNs = await callHandler({ message: "x" });
    assert.equal(noNs.statusCode, 400);
    const noMsg = await callHandler({ namespace: "x" });
    assert.equal(noMsg.statusCode, 400);
    assert.equal(captured.length, 0);
  });

  it("clamps unknown levels to info (defaults instead of 400)", async () => {
    // A handler passing an unexpected level shouldn't cause a 400 —
    // the message is more important than the level. Defaults to
    // info so the log line still shows up.
    const res = await callHandler({ namespace: "x", message: "y", level: "debug" });
    assert.equal(res.statusCode, 204);
    const [entry] = captured;
    assert.ok(entry);
    assert.equal(entry.level, "info");
  });
});
