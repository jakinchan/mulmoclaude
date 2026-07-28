// Unit tests for the command-dispatch lookup (resolveCommandHandler):
//   - a registered method name returns its handler
//   - an unregistered method name returns undefined (→ unknown_method)
//   - proto-key regression (#2319): a method name written by an untrusted remote
//     terminal that collides with an Object.prototype member must NOT resolve to
//     an inherited function and run as if it were registered
//   - boundary: a handler legitimately registered under a proto-collision name
//     is still returned (own property wins)
//
// The lookup is extracted as a pure helper so it is tested directly, without a
// Firestore mock for processCommand.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  LISTEN_RETRY_WINDOW_MS,
  backoffDelayMs,
  classifyListenerError,
  resolveCommandHandler,
  shouldGiveUpListening,
} from "../../src/remote-host/server/hostRunner.js";
import type { CommandHandlers } from "../../src/remote-host/index.js";

const handlers: CommandHandlers = {
  listCollections: () => null,
  startChat: () => null,
};

describe("resolveCommandHandler", () => {
  it("returns the handler for a registered method", () => {
    assert.equal(resolveCommandHandler(handlers, "listCollections"), handlers.listCollections);
  });

  it("returns undefined for an unregistered method", () => {
    assert.equal(resolveCommandHandler(handlers, "nope"), undefined);
  });

  for (const proto of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
    it(`returns undefined for the prototype key "${proto}"`, () => {
      // A bare `handlers[proto]` would resolve to an Object.prototype member.
      assert.equal(resolveCommandHandler(handlers, proto), undefined);
    });
  }

  it("returns a handler legitimately registered under a proto-collision name (boundary)", () => {
    const ownToString: CommandHandlers["toString"] = () => "real";
    const withOwn: CommandHandlers = { ...handlers, toString: ownToString };
    assert.equal(resolveCommandHandler(withOwn, "toString"), ownToString);
  });
});

describe("classifyListenerError", () => {
  for (const code of ["unavailable", "deadline-exceeded", "internal", "cancelled", "aborted", "resource-exhausted"]) {
    it(`treats "${code}" as transient (re-subscribe worthwhile)`, () => {
      assert.equal(classifyListenerError({ code }), "transient");
    });
  }

  // #2633: the SDK refreshes tokens by itself, so an expired one is fixed by
  // trying again. Stopping the host on the first expiry left it unreachable
  // until someone re-connected from the browser.
  it('treats "unauthenticated" as transient — the token refreshes on retry', () => {
    assert.equal(classifyListenerError({ code: "unauthenticated" }), "transient");
  });

  // A revoked grant is not re-listenable: no amount of retrying restores it.
  it('treats "permission-denied" as fatal', () => {
    assert.equal(classifyListenerError({ code: "permission-denied" }), "fatal");
  });

  it("treats an unrecognized code as fatal (never loop forever on the unknown)", () => {
    assert.equal(classifyListenerError({ code: "not-a-real-code" }), "fatal");
  });

  it("treats a non-Firestore error (no string code) as fatal", () => {
    assert.equal(classifyListenerError(new Error("boom")), "fatal");
    assert.equal(classifyListenerError(null), "fatal");
    assert.equal(classifyListenerError({ code: 42 }), "fatal");
  });
});

describe("backoffDelayMs", () => {
  it("grows exponentially from the base delay", () => {
    assert.equal(backoffDelayMs(0), 1_000);
    assert.equal(backoffDelayMs(1), 2_000);
    assert.equal(backoffDelayMs(2), 4_000);
    assert.equal(backoffDelayMs(3), 8_000);
  });

  it("saturates at the cap for large attempts", () => {
    assert.equal(backoffDelayMs(10), 30_000);
    assert.equal(backoffDelayMs(20), 30_000);
  });
});

// #2633: the give-up rule used to be a retry COUNT (5 tries ≈ 31s of backoff),
// which any laptop sleep outlasts — after which the host never re-subscribed.
describe("shouldGiveUpListening", () => {
  const startedAt = 1_000_000;

  it("keeps retrying through an outage far longer than the old 31s retry budget", () => {
    assert.equal(shouldGiveUpListening(startedAt, startedAt + 31_000), false);
    assert.equal(shouldGiveUpListening(startedAt, startedAt + 4 * 60_000), false);
  });

  it("gives up once the window has elapsed", () => {
    assert.equal(shouldGiveUpListening(startedAt, startedAt + LISTEN_RETRY_WINDOW_MS + 1), true);
  });

  it("treats exactly the window as elapsed (boundary)", () => {
    assert.equal(shouldGiveUpListening(startedAt, startedAt + LISTEN_RETRY_WINDOW_MS - 1), false);
    assert.equal(shouldGiveUpListening(startedAt, startedAt + LISTEN_RETRY_WINDOW_MS), true);
  });

  it("measures from the FIRST failure, so a failing ladder cannot extend its own deadline", () => {
    // Five minutes of failures, each one 30s apart: the last attempt is recent,
    // but the outage is not — that distinction is the whole point of the change.
    const lastAttemptAt = startedAt + LISTEN_RETRY_WINDOW_MS - 30_000;
    assert.equal(shouldGiveUpListening(startedAt, lastAttemptAt + 30_000), true);
  });
});
