import "../../../server/workspace/collections/configure.js"; // configure @mulmoclaude/core/collection host binding for tests
// The view-data CORS contract + the token-scoped mutate-action rate
// limiter. A sandboxed custom view's mutate call is a non-simple
// cross-origin POST — if `Access-Control-Allow-Methods` omits POST the
// browser kills the preflight before any handler runs (Codex on PR
// #2105), so the method list is pinned here.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";

import { VIEW_DATA_CORS_METHODS, viewDataCors, makeViewActionRateLimiter } from "../../../server/api/routes/collections.js";

function fakeRes() {
  const headers: Record<string, string> = {};
  let statusCode = 0;
  let body: unknown;
  const res = {
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
    status: (code: number) => {
      statusCode = code;
      return res;
    },
    json: (payload: unknown) => {
      body = payload;
      return res;
    },
  } as unknown as Response;
  return { res, headers, status: () => statusCode, body: () => body };
}

describe("viewDataCors", () => {
  it("allows every method the view-data surface uses, including the mutate-action POST", () => {
    const { res, headers } = fakeRes();
    let nexted = false;
    viewDataCors({} as Request, res, (() => {
      nexted = true;
    }) as NextFunction);
    assert.equal(nexted, true);
    assert.equal(headers["Access-Control-Allow-Methods"], VIEW_DATA_CORS_METHODS);
    for (const method of ["GET", "PUT", "POST", "OPTIONS"]) {
      assert.ok(VIEW_DATA_CORS_METHODS.includes(method), `${method} must be preflight-allowed`);
    }
    const allowedHeaders = headers["Access-Control-Allow-Headers"];
    assert.ok(allowedHeaders);
    assert.ok(allowedHeaders.includes("Authorization"));
  });
});

describe("makeViewActionRateLimiter", () => {
  const request = (caller: string, slug: string) => ({ ip: caller, params: { slug } }) as unknown as Request<{ slug?: string }>;
  const call = (limiter: ReturnType<typeof makeViewActionRateLimiter>, req: Request<{ slug?: string }>) => {
    const { res, status } = fakeRes();
    let nexted = false;
    limiter(req, res, (() => {
      nexted = true;
    }) as NextFunction);
    return { nexted, status: status() };
  };

  it("passes under the limit, 429s over it, and resets after the window", () => {
    let clock = 0;
    const limiter = makeViewActionRateLimiter(2, 1000, () => clock);
    assert.equal(call(limiter, request("caller-a", "s")).nexted, true);
    assert.equal(call(limiter, request("caller-a", "s")).nexted, true);
    const third = call(limiter, request("caller-a", "s"));
    assert.equal(third.nexted, false);
    assert.equal(third.status, 429);
    clock = 1001; // window elapsed — the counter resets
    assert.equal(call(limiter, request("caller-a", "s")).nexted, true);
  });

  it("counts per ip + slug — another caller/collection is independent", () => {
    const limiter = makeViewActionRateLimiter(1, 1000, () => 0);
    assert.equal(call(limiter, request("caller-a", "a")).nexted, true);
    assert.equal(call(limiter, request("caller-a", "a")).status, 429);
    assert.equal(call(limiter, request("caller-a", "b")).nexted, true);
    assert.equal(call(limiter, request("caller-b", "a")).nexted, true);
  });
});
