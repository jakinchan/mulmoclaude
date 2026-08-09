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
import { AccountingError, addEntries, createBook, listBooks } from "../../src/server/service.js";
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
/** The scoped host's DEFAULT root — a real project whose opaque id is
 *  `null`, which is a different thing from a host with no scoping. */
let rootDefault: string;

// The host's own resolver: an opaque project id from the request body,
// looked up against the host's list. A path is never accepted.
const PROJECT_IDS: Record<string, string> = {};
const resolveWorkspaceRoot = (req: AccountingDispatchRequest): string | undefined => {
  const raw = (req.body as Record<string, unknown>)[ACCOUNTING_PROJECT_FIELD];
  if (typeof raw !== "string") return undefined;
  const root = PROJECT_IDS[raw];
  // What a real host does with an id it cannot look up: refuse the
  // request, rather than quietly serving another project's books.
  if (root === undefined) throw new AccountingError(404, `unknown project ${JSON.stringify(raw)}`);
  return root;
};

/** One place every request in this file goes through, so a network
 *  failure or a non-JSON body fails as itself instead of as a confusing
 *  assertion further down. The status is RETURNED rather than asserted:
 *  several tests here are about a 4xx being a 4xx. */
const request = async (url: string, payload: Record<string, unknown>): Promise<DispatchResult> => {
  let response: Response;
  try {
    response = await fetch(`${url}${ACCOUNTING_API.dispatch.path}`, {
      method: ACCOUNTING_API.dispatch.method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new Error(`accounting dispatch request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) as Record<string, unknown> };
  } catch {
    throw new Error(`accounting dispatch returned ${response.status} with a non-JSON body: ${text.slice(0, 200)}`);
  }
};

const dispatch = (payload: Record<string, unknown>): Promise<DispatchResult> => request(baseUrl, payload);

before(async () => {
  rootA = makeTmp();
  rootB = makeTmp();
  rootDefault = makeTmp();
  PROJECT_IDS.pa = rootA;
  PROJECT_IDS.pb = rootB;
  PROJECT_IDS.pw = rootDefault;

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
      // …so `rootDefault` maps to `null`: the host's default project.
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
    // The collision case itself: ONE id, two projects, different
    // companies. The ids are set through the service because the
    // dispatch route generates them — the point is the pair, not how
    // they were named.
    await createBook({ id: "main", name: "A Ltd" }, rootA);
    await createBook({ id: "main", name: "B Ltd" }, rootB);
    for (const [root, amount] of [
      [rootA, 100],
      [rootB, 250],
    ] as const) {
      await addEntries(
        {
          bookId: "main",
          entries: [
            {
              date: "2026-04-01",
              lines: [
                { accountCode: "1000", debit: amount },
                { accountCode: "4000", credit: amount },
              ],
            },
          ],
        },
        root,
      );
    }

    const listA = await dispatch({ action: ACCOUNTING_ACTIONS.getBooks, [ACCOUNTING_PROJECT_FIELD]: "pa" });
    const listB = await dispatch({ action: ACCOUNTING_ACTIONS.getBooks, [ACCOUNTING_PROJECT_FIELD]: "pb" });
    assert.deepEqual(
      (listA.body.books as { name: string }[]).map((book) => book.name),
      ["A Ltd"],
    );
    assert.deepEqual(
      (listB.body.books as { name: string }[]).map((book) => book.name),
      ["B Ltd"],
    );

    // …and reading the SAME bookId through each project returns that
    // project's numbers, not the other's.
    const amountsFor = async (project: string): Promise<number[]> => {
      const result = await dispatch({ action: ACCOUNTING_ACTIONS.getJournalEntries, bookId: "main", [ACCOUNTING_PROJECT_FIELD]: project });
      const entries = result.body.entries as { lines: { debit?: number }[] }[];
      return entries.flatMap((entry) => entry.lines.map((line) => line.debit ?? 0)).filter((debit) => debit > 0);
    };
    assert.deepEqual(await amountsFor("pa"), [100]);
    assert.deepEqual(await amountsFor("pb"), [250]);

    // Each write landed under its own root's directory.
    for (const root of [rootA, rootB]) {
      assert.ok(existsSync(path.join(root, "data", "accounting", "books", "main", "journal")));
    }
  });

  it("openBook stamps the host's opaque scope onto the card envelope", async () => {
    const created = await dispatch({ action: ACCOUNTING_ACTIONS.createBook, name: "Books B", [ACCOUNTING_PROJECT_FIELD]: "pb" });
    assert.equal(created.status, 200);
    const bookId = created.body.bookId as string;
    const opened = await dispatch({ action: ACCOUNTING_ACTIONS.openBook, bookId, [ACCOUNTING_PROJECT_FIELD]: "pb" });
    assert.equal(opened.status, 200);
    assert.equal(opened.body.scope, "pb");
  });

  it("a default-root card still records its identity, as an explicit null", async () => {
    // Absent would mean "ask the host what is active when you mount",
    // and a host that switches project between the tool result and the
    // render would then point this card at the new one.
    const created = await dispatch({ action: ACCOUNTING_ACTIONS.createBook, name: "Head Office", [ACCOUNTING_PROJECT_FIELD]: "pw" });
    const opened = await dispatch({ action: ACCOUNTING_ACTIONS.openBook, bookId: created.body.bookId, [ACCOUNTING_PROJECT_FIELD]: "pw" });
    assert.equal(opened.status, 200);
    assert.equal("scope" in opened.body, true, "a scoped host always records the card's project");
    assert.equal(opened.body.scope, null);
  });

  it("channel names are namespaced by the scope, never by a path", async () => {
    const { pubsub, channels } = recordingPubSub();
    initAccountingEventPublisher(pubsub);
    await dispatch({ action: ACCOUNTING_ACTIONS.createBook, name: "Channel A", [ACCOUNTING_PROJECT_FIELD]: "pa" });
    assert.deepEqual(channels, ["accounting:pa:#books"]);
    assert.ok(!channels.some((channel) => channel.includes(rootA)));
  });

  it("a project id the host cannot look up is a 4xx, not a 500", async () => {
    const response = await dispatch({ action: ACCOUNTING_ACTIONS.getBooks, [ACCOUNTING_PROJECT_FIELD]: "no-such-project" });
    assert.equal(response.status, 404);
    assert.match(String(response.body.error), /unknown project/);
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
    const created = await request(soloUrl, { action: ACCOUNTING_ACTIONS.createBook, name: "Solo" });
    assert.deepEqual(channels, ["accounting:books"]);

    const opened = await request(soloUrl, { action: ACCOUNTING_ACTIONS.openBook, bookId: created.body.bookId });
    assert.equal("scope" in opened.body, false, "a single-root host's envelope must be byte-identical to today's");
  });

  it("a project id in the body is ignored when the host wired no resolver", async () => {
    const response = await request(soloUrl, { action: ACCOUNTING_ACTIONS.getBooks, [ACCOUNTING_PROJECT_FIELD]: "pb" });
    const body = response.body as { books: unknown[] };
    // Project B has its own book; this must still be project A's list.
    assert.ok(body.books.some((book) => (book as { name: string }).name === "Solo"));
    assert.ok(!body.books.some((book) => (book as { name: string }).name === "Books B"));
  });
});
