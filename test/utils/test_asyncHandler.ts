// Unit tests for the route-handler error wrapper.
//
// The module had no tests at all. The branch this file exists for —
// "the handler throws AFTER the response has started" — is currently
// unreachable through the real routes (none of the 14 `asyncHandler` call
// sites stream), so nothing else in the suite would notice if it regressed.
//
// Why the branch matters despite being unreachable: measured against this
// repo's Express (5.2.1), returning without forwarding leaves the request
// hanging — the client waits indefinitely for a body that never ends.
// Forwarding to `next(err)` lets finalhandler destroy the socket in
// milliseconds. The first streaming route added here would otherwise inherit
// a silent hang.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { asyncHandler } from "../../server/utils/asyncHandler.js";

/** Minimal stand-ins. The wrapper only touches `req.path`, `res.headersSent`
 *  and `res.status().json()`, and its generics are bounded to exactly that —
 *  so a fake carrying those members is a faithful double, not a shortcut.
 *
 *  These are passed as explicit type arguments below. That is the point, not a
 *  workaround: the bounds accept any shape satisfying what the wrapper
 *  dereferences, so a test can drive it without constructing a real Express
 *  `Request` / `Response`. Omitting the arguments falls back to the Express
 *  defaults and correctly rejects these fakes. */
function makeRes(headersSent: boolean) {
  const sent: { status?: number; body?: { error: string } } = {};
  return {
    headersSent,
    sent,
    status(code: number) {
      sent.status = code;
      return {
        json(body: { error: string }) {
          sent.body = body;
          return undefined;
        },
      };
    },
  };
}

interface FakeReq {
  path: string;
}
type FakeRes = ReturnType<typeof makeRes>;

const req: FakeReq = { path: "/api/thing" };

describe("asyncHandler — handler resolves", () => {
  it("does not touch the response", async () => {
    const res = makeRes(false);
    let ran = false;
    await asyncHandler<FakeReq, FakeRes>("test", "fallback", async () => {
      ran = true;
    })(req, res, () => assert.fail("next must not be called on success"));
    assert.equal(ran, true);
    assert.equal(res.sent.status, undefined);
  });
});

describe("asyncHandler — handler throws before the response starts", () => {
  it("sends a 500 carrying the fallback message", async () => {
    const res = makeRes(false);
    await asyncHandler<FakeReq, FakeRes>("test", "fallback message", async () => {
      throw new Error("boom");
    })(req, res, () => assert.fail("next must not be called when headers are unsent"));
    assert.equal(res.sent.status, 500);
    assert.deepEqual(res.sent.body, { error: "fallback message" });
  });

  // The wrapper logs the raw error server-side but must never put it on the
  // wire — raw text leaks stack shape, file paths and library internals.
  it("never leaks the thrown error's message to the client", async () => {
    const res = makeRes(false);
    await asyncHandler<FakeReq, FakeRes>("test", "safe fallback", async () => {
      throw new Error("ENOENT: /Users/secret/path/db.sqlite");
    })(req, res, () => {});
    assert.deepEqual(res.sent.body, { error: "safe fallback" });
    assert.ok(!JSON.stringify(res.sent).includes("secret"));
  });

  // `errorMessage(err)` has to cope with a non-Error rejection — a library
  // can reject with a string. Thrown via a variable rather than a literal so
  // `no-throw-literal` stays on for real code.
  it("handles a non-Error throw without crashing", async () => {
    const res = makeRes(false);
    const bare: unknown = "a bare string";
    await asyncHandler<FakeReq, FakeRes>("test", "fallback", async () => {
      throw bare;
    })(req, res, () => {});
    assert.equal(res.sent.status, 500);
  });
});

describe("asyncHandler — handler throws after the response started", () => {
  // The regression this change is for. Returning here instead of forwarding
  // is what left the request hanging.
  it("forwards the error to next() instead of returning", async () => {
    const res = makeRes(true);
    const thrown = new Error("mid-stream failure");
    let forwarded: unknown = null;
    await asyncHandler<FakeReq, FakeRes>("test", "fallback", async () => {
      throw thrown;
    })(req, res, (err?: unknown) => {
      forwarded = err;
    });
    assert.equal(forwarded, thrown, "the original error must reach Express, not a substitute");
  });

  it("does not attempt a second status write", async () => {
    const res = makeRes(true);
    await asyncHandler<FakeReq, FakeRes>("test", "fallback", async () => {
      throw new Error("boom");
    })(req, res, () => {});
    assert.equal(res.sent.status, undefined, "writing a status after headersSent would throw ERR_HTTP_HEADERS_SENT");
    assert.equal(res.sent.body, undefined);
  });

  // Express reads `next(<falsy>)` as plain `next()` — "keep routing", not
  // "fail" — so forwarding a falsy throw verbatim skips the error flow and
  // hangs, which is the exact bug this branch exists to prevent. Measured at
  // over 2.5s before the guard. `Promise.reject()` with no argument rejects
  // with `undefined`, so this is reachable, not theoretical.
  const falsyThrows: [string, unknown][] = [
    ["undefined", undefined],
    ["null", null],
    ["zero", 0],
    ["empty string", ""],
    ["false", false],
  ];
  for (const [label, value] of falsyThrows) {
    it(`forwards a truthy Error when the handler throws ${label}`, async () => {
      const res = makeRes(true);
      let forwarded: unknown = "not called";
      await asyncHandler<FakeReq, FakeRes>("test-ns", "fallback", async () => {
        throw value;
      })(req, res, (err?: unknown) => {
        forwarded = err;
      });
      assert.ok(forwarded, `next() must receive a truthy value, got ${String(forwarded)}`);
      assert.ok(forwarded instanceof Error);
      assert.match((forwarded as Error).message, /test-ns: handler threw a falsy value/);
    });
  }

  it("forwards a truthy non-Error throw unchanged", async () => {
    const res = makeRes(true);
    const bare: unknown = "a bare string";
    let forwarded: unknown = null;
    await asyncHandler<FakeReq, FakeRes>("test", "fallback", async () => {
      throw bare;
    })(req, res, (err?: unknown) => {
      forwarded = err;
    });
    assert.equal(forwarded, bare, "a truthy value already routes to Express's error flow — do not rewrite it");
  });
});
