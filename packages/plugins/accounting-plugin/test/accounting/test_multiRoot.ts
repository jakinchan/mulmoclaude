// Multi-root contract for the accounting engine.
//
// A bookId is unique WITHIN a root and nowhere else. A host that serves
// one root per project directory (MulmoTerminal) therefore needs three
// things this suite pins, and a single-workspace host (MulmoClaude)
// needs all three to be invisible:
//
//   1. every dispatch action reaches the service with the request's own
//      root, so two projects holding a book called `main` never read or
//      write each other's data;
//   2. explicit-root mode (`workspaceRoot: null`) turns a FORGOTTEN root
//      into a throw instead of a silent hit on another project;
//   3. channel names and the openBook envelope carry the host's opaque
//      project scope — and, unscoped, are byte-identical to today's.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import type { Server } from "node:http";

import { configureAccountingServer } from "../../src/server/context.js";
import { createAccountingRouter, type AccountingDispatchRequest } from "../../src/server/router.js";
import { initAccountingEventPublisher, _resetAccountingEventPublisherForTesting } from "../../src/server/eventPublisher.js";
import { listBooks } from "../../src/server/service.js";
import { _resetRebuildQueueForTesting, inspectRebuildQueue, scheduleRebuild } from "../../src/server/snapshotCache.js";
import { ACCOUNTING_ACTIONS, ACCOUNTING_API, ACCOUNTING_PROJECT_FIELD } from "../../src/shared/index.js";

const silentLogger = { error() {}, warn() {}, info() {}, debug() {} };

interface DispatchResult {
  status: number;
  body: Record<string, unknown>;
}

const tmpRoots: string[] = [];
const makeTmp = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "mulmo-acct-multiroot-"));
  tmpRoots.push(dir);
  return dir;
};

const recordingPubSub = (): { pubsub: { publish: (channel: string, payload: unknown) => void }; channels: string[] } => {
  const channels: string[] = [];
  return { pubsub: { publish: (channel) => void channels.push(channel) }, channels };
};

const listen = async (app: express.Express): Promise<Server> =>
  new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });

let server: Server;
let baseUrl: string;
let rootA: string;
let rootB: string;

// The host's own resolver: an opaque project id from the request body,
// looked up against the host's list. A path is never accepted.
const PROJECT_IDS: Record<string, string> = {};
const resolveWorkspaceRoot = (req: AccountingDispatchRequest): string | undefined => {
  const raw = (req.body as Record<string, unknown>)[ACCOUNTING_PROJECT_FIELD];
  return typeof raw === "string" ? PROJECT_IDS[raw] : undefined;
};

const dispatch = async (payload: Record<string, unknown>): Promise<DispatchResult> => {
  const response = await fetch(`${baseUrl}${ACCOUNTING_API.dispatch.path}`, {
    method: ACCOUNTING_API.dispatch.method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

before(async () => {
  rootA = makeTmp();
  rootB = makeTmp();
  PROJECT_IDS.pa = rootA;
  PROJECT_IDS.pb = rootB;

  const app = express();
  app.use(express.json());
  app.use(createAccountingRouter({ resolveWorkspaceRoot }));
  server = await listen(app);
  const address = server.address();
  assert.ok(address !== null && typeof address === "object", "server must be listening on a TCP port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await _resetRebuildQueueForTesting();
  _resetAccountingEventPublisherForTesting();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

describe("explicit-root mode", () => {
  beforeEach(() => {
    configureAccountingServer({
      workspaceRoot: null,
      logger: silentLogger,
      channelScopeForRoot: (root) => (root === rootA ? "pa" : root === rootB ? "pb" : null),
    });
  });

  it("a call with no root throws instead of guessing a project", async () => {
    await assert.rejects(listBooks(), /every call must pass a workspaceRoot/);
  });

  it("the same call with an explicit root succeeds", async () => {
    const { books } = await listBooks(rootA);
    assert.ok(Array.isArray(books));
  });

  it("two roots holding the same book id do not see each other's data", async () => {
    const created = await dispatch({ action: ACCOUNTING_ACTIONS.createBook, name: "Books A", [ACCOUNTING_PROJECT_FIELD]: "pa" });
    assert.equal(created.status, 200);
    const { bookId } = created.body;
    assert.equal(typeof bookId, "string");

    const listA = await dispatch({ action: ACCOUNTING_ACTIONS.getBooks, [ACCOUNTING_PROJECT_FIELD]: "pa" });
    const listB = await dispatch({ action: ACCOUNTING_ACTIONS.getBooks, [ACCOUNTING_PROJECT_FIELD]: "pb" });
    assert.equal((listA.body.books as unknown[]).length, 1);
    assert.deepEqual(listB.body.books, []);

    // …and the write landed only under project A's directory.
    assert.ok(existsSync(path.join(rootA, "data", "accounting", "config.json")));
    assert.ok(!existsSync(path.join(rootB, "data", "accounting", "config.json")));
  });

  it("openBook stamps the host's opaque scope onto the card envelope", async () => {
    const created = await dispatch({ action: ACCOUNTING_ACTIONS.createBook, name: "Books B", [ACCOUNTING_PROJECT_FIELD]: "pb" });
    const bookId = created.body.bookId as string;
    const opened = await dispatch({ action: ACCOUNTING_ACTIONS.openBook, bookId, [ACCOUNTING_PROJECT_FIELD]: "pb" });
    assert.equal(opened.status, 200);
    assert.equal(opened.body.scope, "pb");
  });

  it("channel names are namespaced by the scope, never by a path", async () => {
    const { pubsub, channels } = recordingPubSub();
    initAccountingEventPublisher(pubsub);
    await dispatch({ action: ACCOUNTING_ACTIONS.createBook, name: "Channel A", [ACCOUNTING_PROJECT_FIELD]: "pa" });
    assert.deepEqual(channels, ["accounting:pa:books"]);
    assert.ok(!channels.some((channel) => channel.includes(rootA)));
  });

  it("a rebuild queue is per (root, bookId), so one project cannot drain another's", async () => {
    scheduleRebuild("shared", "2026-01", rootA);
    assert.equal(inspectRebuildQueue("shared", rootA).running, true);
    assert.equal(inspectRebuildQueue("shared", rootB).running, false);
    await _resetRebuildQueueForTesting();
  });
});

describe("single-root back-compat", () => {
  let soloServer: Server;
  let soloUrl: string;

  before(async () => {
    // No resolver, no channelScopeForRoot — MulmoClaude's wiring.
    configureAccountingServer({ workspaceRoot: rootA, logger: silentLogger });
    const app = express();
    app.use(express.json());
    app.use(createAccountingRouter());
    soloServer = await listen(app);
    const address = soloServer.address();
    assert.ok(address !== null && typeof address === "object");
    soloUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => soloServer.close(() => resolve()));
  });

  it("publishes on the unscoped channel names and omits the card scope", async () => {
    const { pubsub, channels } = recordingPubSub();
    initAccountingEventPublisher(pubsub);
    const created = await fetch(`${soloUrl}${ACCOUNTING_API.dispatch.path}`, {
      method: ACCOUNTING_API.dispatch.method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: ACCOUNTING_ACTIONS.createBook, name: "Solo" }),
    });
    const body = (await created.json()) as Record<string, unknown>;
    assert.deepEqual(channels, ["accounting:books"]);

    const opened = await fetch(`${soloUrl}${ACCOUNTING_API.dispatch.path}`, {
      method: ACCOUNTING_API.dispatch.method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: ACCOUNTING_ACTIONS.openBook, bookId: body.bookId }),
    });
    const envelope = (await opened.json()) as Record<string, unknown>;
    assert.equal("scope" in envelope, false, "a single-root host's envelope must be byte-identical to today's");
  });

  it("a project id in the body is ignored when the host wired no resolver", async () => {
    const response = await fetch(`${soloUrl}${ACCOUNTING_API.dispatch.path}`, {
      method: ACCOUNTING_API.dispatch.method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: ACCOUNTING_ACTIONS.getBooks, [ACCOUNTING_PROJECT_FIELD]: "pb" }),
    });
    const body = (await response.json()) as { books: unknown[] };
    // Project B has its own book; this must still be project A's list.
    assert.ok(body.books.some((book) => (book as { name: string }).name === "Solo"));
    assert.ok(!body.books.some((book) => (book as { name: string }).name === "Books B"));
  });
});
