import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ChatService } from "@mulmobridge/chat-service";
import { attemptSocketSend, createResponseQueue, handleRelayMessage, stopRelay, type RelayState } from "../../server/events/relay-client.js";

type RelayFn = ChatService["relay"];
type RelayParams = Parameters<RelayFn>[0];

// Structural mirror of the module-private RelayResponse — lets the
// tests capture/assert responses without widening the public surface.
interface RelayResponseLike {
  platform: string;
  chatId: string;
  text: string;
  replyToken?: string | undefined;
}

// Mirror of MAX_RESPONSE_QUEUE in relay-client.ts (kept private there).
const QUEUE_CAP = 100;

interface LogCall {
  level: "info" | "warn" | "error";
  prefix: string;
  msg: string;
  data?: Record<string, unknown> | undefined;
}

function createFakeLogger() {
  const calls: LogCall[] = [];
  const record =
    (level: LogCall["level"]) =>
    (prefix: string, msg: string, data?: Record<string, unknown>): void => {
      calls.push({ level, prefix, msg, data });
    };
  const logger = { info: record("info"), warn: record("warn"), error: record("error") };
  const findByMsg = (msg: string): LogCall | undefined => calls.find((call) => call.msg === msg);
  const countByMsg = (msg: string): number => calls.filter((call) => call.msg === msg).length;
  return { logger, calls, findByMsg, countByMsg };
}

const validMessage = {
  id: "msg-1",
  platform: "line",
  senderId: "u-1",
  chatId: "c-1",
  text: "hello",
  receivedAt: "2026-07-09T00:00:00Z",
  replyToken: "tok-1",
};

const capture = () => {
  const responses: RelayResponseLike[] = [];
  const sendResponse = (res: RelayResponseLike): void => {
    responses.push(res);
  };
  return { responses, sendResponse };
};

describe("handleRelayMessage", () => {
  it("invalid JSON → warns and calls neither relay nor sendResponse", async () => {
    const { logger, findByMsg } = createFakeLogger();
    let relayCalls = 0;
    const relay: RelayFn = async () => {
      relayCalls += 1;
      return { kind: "ok", reply: "x" };
    };
    const { responses, sendResponse } = capture();

    await handleRelayMessage("{ not json", { relay, logger, sendResponse });

    assert.equal(relayCalls, 0);
    assert.equal(responses.length, 0);
    const warn = findByMsg("invalid JSON from relay");
    assert.equal(warn?.level, "warn");
    assert.equal(warn?.data?.length, "{ not json".length);
  });

  it("malformed message → warns and calls neither relay nor sendResponse", async () => {
    const { logger, findByMsg } = createFakeLogger();
    let relayCalls = 0;
    const relay: RelayFn = async () => {
      relayCalls += 1;
      return { kind: "ok", reply: "x" };
    };
    const { responses, sendResponse } = capture();

    // Valid JSON but missing required `text` / `chatId`.
    await handleRelayMessage(JSON.stringify({ id: "x", platform: "line" }), { relay, logger, sendResponse });

    assert.equal(relayCalls, 0);
    assert.equal(responses.length, 0);
    assert.equal(findByMsg("malformed relay message")?.level, "warn");
  });

  it("happy path → forwards to relay and sends the formatted reply", async () => {
    const { logger } = createFakeLogger();
    const captured: RelayParams[] = [];
    const relay: RelayFn = async (params) => {
      captured.push(params);
      return { kind: "ok", reply: "pong" };
    };
    const { responses, sendResponse } = capture();

    await handleRelayMessage(JSON.stringify(validMessage), { relay, logger, sendResponse });

    assert.equal(captured.length, 1);
    const [params] = captured;
    assert.ok(params);
    assert.equal(params.transportId, "relay");
    assert.equal(params.externalChatId, "line__c-1");
    assert.equal(params.text, "hello");
    assert.equal(typeof params.bridgeOptions, "object");
    assert.notEqual(params.bridgeOptions, null);

    assert.deepEqual(responses, [{ platform: "line", chatId: "c-1", text: "pong", replyToken: "tok-1" }]);
  });

  it("error-kind result → sends the 'Error: <message>' reply", async () => {
    const { logger } = createFakeLogger();
    const relay: RelayFn = async () => ({ kind: "error", status: 500, message: "nope" });
    const { responses, sendResponse } = capture();

    await handleRelayMessage(JSON.stringify(validMessage), { relay, logger, sendResponse });

    assert.equal(responses.length, 1);
    const [response] = responses;
    assert.ok(response);
    assert.equal(response.text, "Error: nope");
    assert.equal(response.replyToken, "tok-1");
  });

  it("relay throws → sends the fallback error reply and logs the failure", async () => {
    const { logger, findByMsg } = createFakeLogger();
    const relay: RelayFn = async () => {
      throw new Error("boom");
    };
    const { responses, sendResponse } = capture();

    await handleRelayMessage(JSON.stringify(validMessage), { relay, logger, sendResponse });

    assert.deepEqual(responses, [{ platform: "line", chatId: "c-1", text: "Error: failed to process message", replyToken: "tok-1" }]);
    const err = findByMsg("relay processing failed");
    assert.equal(err?.level, "error");
    assert.equal(err?.data?.id, "msg-1");
    assert.match(String(err?.data?.error), /boom/);
  });

  it("preserves an absent replyToken", async () => {
    const { logger } = createFakeLogger();
    const relay: RelayFn = async () => ({ kind: "ok", reply: "pong" });
    const { responses, sendResponse } = capture();
    const noToken = { ...validMessage };
    delete (noToken as { replyToken?: string }).replyToken;

    await handleRelayMessage(JSON.stringify(noToken), { relay, logger, sendResponse });

    assert.equal(responses.length, 1);
    const [response] = responses;
    assert.ok(response);
    assert.equal(response.replyToken, undefined);
  });
});

const makeResponse = (num: number): RelayResponseLike => ({ platform: "line", chatId: `c-${num}`, text: `t-${num}` });

// A trySend stub whose result is scripted per call. Records every
// response it was handed, in order.
function scriptedTrySend(results: boolean[]) {
  const seen: RelayResponseLike[] = [];
  let idx = 0;
  const trySend = (response: RelayResponseLike): boolean => {
    seen.push(response);
    const result = results[idx] ?? false;
    idx += 1;
    return result;
  };
  return { trySend, seen };
}

// A trySend that always accepts and records what it drained.
function drainingTrySend() {
  const delivered: RelayResponseLike[] = [];
  const trySend = (response: RelayResponseLike): boolean => {
    delivered.push(response);
    return true;
  };
  return { trySend, delivered };
}

// A trySend whose transport can be opened/closed at runtime: while
// closed it rejects (returns false) like a disconnected socket; while
// open it accepts and records. Models the flush-after-reconnect path.
function gatedTrySend() {
  const gate = { open: false };
  const delivered: RelayResponseLike[] = [];
  const trySend = (response: RelayResponseLike): boolean => {
    if (!gate.open) return false;
    delivered.push(response);
    return true;
  };
  return { trySend, delivered, gate };
}

describe("createResponseQueue", () => {
  it("send delivers straight through when trySend returns true", () => {
    const { logger, calls } = createFakeLogger();
    const { trySend, delivered } = drainingTrySend();
    const queue = createResponseQueue({ logger, trySend });

    queue.send(makeResponse(1));

    assert.deepEqual(delivered, [makeResponse(1)]);
    assert.equal(calls.length, 0);

    // Nothing was queued, so a subsequent flush drains nothing (trySend
    // is not called again; `delivered` is unchanged).
    queue.flush();
    assert.deepEqual(delivered, [makeResponse(1)]);
  });

  it("send queues and logs the queueSize when trySend returns false", () => {
    const { logger, findByMsg } = createFakeLogger();
    const rejecting = scriptedTrySend([false]);
    const queue = createResponseQueue({ logger, trySend: rejecting.trySend });

    queue.send(makeResponse(1));

    assert.deepEqual(rejecting.seen, [makeResponse(1)]);
    const log = findByMsg("response queued (not connected)");
    assert.equal(log?.level, "error");
    assert.equal(log?.data?.queueSize, 1);
    assert.equal(log?.data?.chatId, "c-1");
  });

  it("send then flush drains the queued item once the transport accepts", () => {
    const { logger } = createFakeLogger();
    const { trySend, delivered, gate } = gatedTrySend();
    const queue = createResponseQueue({ logger, trySend });

    queue.send(makeResponse(1));
    assert.equal(delivered.length, 0);

    gate.open = true;
    queue.flush();
    assert.deepEqual(delivered, [makeResponse(1)]);
  });

  it("enqueue drops the oldest response at the cap", () => {
    const { logger, findByMsg, countByMsg } = createFakeLogger();
    const { trySend, delivered } = drainingTrySend();
    const queue = createResponseQueue({ logger, trySend });

    for (let num = 1; num <= QUEUE_CAP; num += 1) queue.enqueue(makeResponse(num));
    // The (cap + 1)-th enqueue evicts the oldest (c-1) before pushing.
    queue.enqueue(makeResponse(QUEUE_CAP + 1));

    assert.equal(countByMsg("response queue full, dropping oldest"), 1);
    assert.equal(findByMsg("response queue full, dropping oldest")?.data?.chatId, `c-${QUEUE_CAP + 1}`);

    queue.flush();
    assert.equal(delivered.length, QUEUE_CAP);
    const [oldestDelivered] = delivered;
    const newestDelivered = delivered[QUEUE_CAP - 1];
    assert.ok(oldestDelivered);
    assert.ok(newestDelivered);
    assert.equal(oldestDelivered.chatId, "c-2");
    assert.equal(newestDelivered.chatId, `c-${QUEUE_CAP + 1}`);
    assert.ok(!delivered.some((res) => res.chatId === "c-1"));
  });

  it("flush stops at the first failed trySend and does not try later items", () => {
    const { logger } = createFakeLogger();
    // Accept c-1, reject c-2 (and would-be c-3).
    const first = scriptedTrySend([true, false, false]);
    const queue = createResponseQueue({ logger, trySend: first.trySend });

    queue.enqueue(makeResponse(1));
    queue.enqueue(makeResponse(2));
    queue.enqueue(makeResponse(3));

    queue.flush();
    // Tried c-1 (ok, shifted) then c-2 (rejected → break). c-3 never tried.
    assert.deepEqual(
      first.seen.map((res) => res.chatId),
      ["c-1", "c-2"],
    );
    // Retention + FIFO order of the unsent tail is covered by the
    // "flush preserves order" test below (needs a re-openable transport).
  });

  it("flush preserves order of unsent items across successive flushes", () => {
    const { logger } = createFakeLogger();
    const { trySend, delivered, gate } = gatedTrySend();
    const queue = createResponseQueue({ logger, trySend });

    queue.enqueue(makeResponse(1));
    queue.enqueue(makeResponse(2));
    queue.enqueue(makeResponse(3));

    // Transport closed: flush sends nothing, loses nothing.
    queue.flush();
    assert.equal(delivered.length, 0);

    // Transport open: flush drains everything in FIFO order.
    gate.open = true;
    queue.flush();
    assert.deepEqual(
      delivered.map((res) => res.chatId),
      ["c-1", "c-2", "c-3"],
    );
  });

  it("flush on an empty queue does nothing", () => {
    const { logger, calls } = createFakeLogger();
    let tryCalls = 0;
    const trySend = (): boolean => {
      tryCalls += 1;
      return true;
    };
    const queue = createResponseQueue({ logger, trySend });

    queue.flush();

    assert.equal(tryCalls, 0);
    assert.equal(calls.length, 0);
  });

  it("send-failure requeue path: enqueue re-adds a response that trySend later drains", () => {
    // Mirrors what connectRelay's trySend does on an async send error:
    // it calls queue.enqueue(response). Verify the item is retained and
    // drains in order on the next flush.
    const { logger } = createFakeLogger();
    const { trySend, delivered, gate } = gatedTrySend();
    const queue = createResponseQueue({ logger, trySend });

    queue.enqueue(makeResponse(1)); // simulated requeue after send failure
    gate.open = true;
    queue.flush();

    assert.deepEqual(delivered, [makeResponse(1)]);
  });
});

// ── attemptSocketSend / stopRelay direct tests ───────────────

interface FakeSocket {
  readyState: number;
  send: (payload: string, callback: (err: Error | undefined) => void) => void;
  close: (code?: number, reason?: string) => void;
  sent: string[];
  closed: { code?: number | undefined; reason?: string | undefined }[];
}

// WebSocket.OPEN is 1 per the RFC 6455 spec and the `ws` npm package.
const OPEN = 1;

function makeFakeSocket(overrides: Partial<FakeSocket> = {}): FakeSocket {
  const socket: FakeSocket = {
    readyState: OPEN,
    sent: [],
    closed: [],
    send: (payload, callback) => {
      socket.sent.push(payload);
      callback(undefined);
    },
    close: (code, reason) => {
      socket.closed.push({ code, reason });
    },
    ...overrides,
  };
  return socket;
}

function makeResp(seq: number): { platform: string; chatId: string; text: string } {
  return { platform: "line", chatId: `c-${seq}`, text: `body-${seq}` };
}

describe("attemptSocketSend", () => {
  it("returns false and does not send when state.socket is null (queue-instead path)", () => {
    const { logger } = createFakeLogger();
    const state: RelayState = { socket: null, reconnectMs: 1000, reconnectTimer: null, stopped: false };
    let enqueued = 0;
    const result = attemptSocketSend(state, makeResp(1), logger, () => {
      enqueued += 1;
    });
    assert.equal(result, false);
    assert.equal(enqueued, 0);
  });

  it("returns false when the socket exists but readyState is not OPEN", () => {
    const { logger } = createFakeLogger();
    const socket = makeFakeSocket({ readyState: 0 }); // CONNECTING
    const state: RelayState = { socket: socket as unknown as RelayState["socket"], reconnectMs: 1000, reconnectTimer: null, stopped: false };
    const result = attemptSocketSend(state, makeResp(1), logger, () => {});
    assert.equal(result, false);
    assert.equal(socket.sent.length, 0);
  });

  it("returns true and writes the JSON payload when the socket is OPEN", () => {
    const { logger } = createFakeLogger();
    const socket = makeFakeSocket();
    const state: RelayState = { socket: socket as unknown as RelayState["socket"], reconnectMs: 1000, reconnectTimer: null, stopped: false };
    const result = attemptSocketSend(state, makeResp(7), logger, () => {});
    assert.equal(result, true);
    const [sentPayload] = socket.sent;
    assert.ok(sentPayload);
    assert.deepEqual(JSON.parse(sentPayload), makeResp(7));
  });

  it("re-enqueues via onEnqueue when the async send callback reports an error and state.stopped is false", () => {
    const { logger, findByMsg } = createFakeLogger();
    const socket = makeFakeSocket({
      send: (_payload, callback) => callback(new Error("write EPIPE")),
    });
    const state: RelayState = { socket: socket as unknown as RelayState["socket"], reconnectMs: 1000, reconnectTimer: null, stopped: false };
    let enqueued = 0;
    attemptSocketSend(state, makeResp(1), logger, () => {
      enqueued += 1;
    });
    assert.equal(enqueued, 1);
    assert.equal(findByMsg("send failed, requeueing")?.level, "warn");
  });

  it("does NOT re-enqueue when the async send error fires after state.stopped flipped true (shutting-down race)", () => {
    // Fixes the corner case where a disconnect interleaves with an in-flight
    // send; re-adding to the queue after stopRelay would just leak entries.
    const { logger } = createFakeLogger();
    const socket = makeFakeSocket({
      send: (_payload, callback) => callback(new Error("closing")),
    });
    const state: RelayState = { socket: socket as unknown as RelayState["socket"], reconnectMs: 1000, reconnectTimer: null, stopped: true };
    let enqueued = 0;
    attemptSocketSend(state, makeResp(1), logger, () => {
      enqueued += 1;
    });
    assert.equal(enqueued, 0);
  });

  it("returns false when socket.send synchronously throws (e.g. socket already closed)", () => {
    const { logger } = createFakeLogger();
    const socket = makeFakeSocket({
      send: () => {
        throw new Error("socket closed");
      },
    });
    const state: RelayState = { socket: socket as unknown as RelayState["socket"], reconnectMs: 1000, reconnectTimer: null, stopped: false };
    const result = attemptSocketSend(state, makeResp(1), logger, () => {});
    assert.equal(result, false);
  });
});

describe("stopRelay", () => {
  it("flips stopped, clears the timer, closes the socket with code 1000, and logs 'stopped'", () => {
    const { logger, findByMsg } = createFakeLogger();
    const socket = makeFakeSocket();
    const timer = setTimeout(() => {}, 999_999);
    const state: RelayState = { socket: socket as unknown as RelayState["socket"], reconnectMs: 1000, reconnectTimer: timer, stopped: false };
    stopRelay(state, logger);
    assert.equal(state.stopped, true);
    assert.equal(state.reconnectTimer, null);
    assert.equal(state.socket, null);
    assert.deepEqual(socket.closed[0], { code: 1000, reason: "shutdown" });
    assert.equal(findByMsg("stopped")?.level, "info");
  });

  it("is a no-op-except-logging when nothing is armed (state already stopped-like)", () => {
    // Guards the reverse-of-happy-path: a caller that shuts down before
    // the first connect() must not throw on the null socket / null timer.
    const { logger, findByMsg } = createFakeLogger();
    const state: RelayState = { socket: null, reconnectMs: 1000, reconnectTimer: null, stopped: false };
    stopRelay(state, logger);
    assert.equal(state.stopped, true);
    assert.equal(findByMsg("stopped")?.level, "info");
  });

  it("guarantees stopped is set BEFORE any close side-effect, so a close-event-driven reconnect is guarded", () => {
    // Simulates the ordering the WebSocket spec forces on us: `close()`
    // schedules the close event. If a caller queried state.stopped inside
    // that handler, it must already read true.
    const { logger } = createFakeLogger();
    let stoppedAtCloseTime: boolean | null = null;
    const state: RelayState = { socket: null, reconnectMs: 1000, reconnectTimer: null, stopped: false };
    const socket = makeFakeSocket({
      close: () => {
        stoppedAtCloseTime = state.stopped;
      },
    });
    state.socket = socket as unknown as RelayState["socket"];
    stopRelay(state, logger);
    assert.equal(stoppedAtCloseTime, true, "stopped must be true by the time socket.close() runs");
  });
});
