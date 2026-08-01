// Endpoint-level regression tests for the dispatch route.
//
// `test_bodyFields.ts` pins the readers in isolation; these drive the real
// Express router so the reader → handler → service wiring is covered too.
// The malformed-`period` cases are the ones that matter: before #2692 a
// string period returned HTTP 200 with an all-zero balance sheet for a book
// holding real balances, and a half-formed month object 500'd.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import type { Server } from "node:http";

import { configureAccountingServer } from "../../src/server/context.js";
import { createAccountingRouter } from "../../src/server/router.js";
import { ACCOUNTING_ACTIONS, ACCOUNTING_API } from "../../src/shared/index.js";

const OPENING_CASH = 500;

interface DispatchResult {
  status: number;
  body: Record<string, unknown>;
}

const silentLogger = { error() {}, warn() {}, info() {}, debug() {} };

let server: Server;
let baseUrl: string;
let workspaceRoot: string;
let bookId: string;

const dispatch = async (payload: Record<string, unknown>): Promise<DispatchResult> => {
  const response = await fetch(`${baseUrl}${ACCOUNTING_API.dispatch.path}`, {
    method: ACCOUNTING_API.dispatch.method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
};

const listen = async (app: express.Express): Promise<Server> =>
  new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });

before(async () => {
  workspaceRoot = mkdtempSync(path.join(tmpdir(), "mulmo-acct-router-"));
  configureAccountingServer({ workspaceRoot, logger: silentLogger });

  const app = express();
  app.use(express.json());
  app.use(createAccountingRouter());
  server = await listen(app);
  const address = server.address();
  assert.ok(address !== null && typeof address === "object", "server must be listening on a TCP port");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const created = await dispatch({ action: ACCOUNTING_ACTIONS.createBook, name: "Router Test Co" });
  assert.equal(created.status, 200);
  const { book } = created.body;
  assert.ok(book !== null && typeof book === "object" && "id" in book && typeof book.id === "string");
  bookId = book.id;

  // Real balances, so an "empty report" answer is distinguishable from a
  // correct one — the silent-200 bug returned all zeros here.
  const opened = await dispatch({
    action: ACCOUNTING_ACTIONS.setOpeningBalances,
    bookId,
    asOfDate: "2026-01-01",
    lines: [
      { accountCode: "1000", debit: OPENING_CASH },
      { accountCode: "3000", credit: OPENING_CASH },
    ],
  });
  assert.equal(opened.status, 200);
});

after(() => {
  server?.close();
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
});

describe("getReport period validation", () => {
  it("returns a populated balance sheet for a well-formed month period", async () => {
    const { status, body } = await dispatch({
      action: ACCOUNTING_ACTIONS.getReport,
      kind: "balance",
      bookId,
      period: { kind: "month", period: "2026-01" },
    });
    assert.equal(status, 200);
    // Guards the fix from the other side: the report must carry the real
    // opening cash, not the all-zero sheet the cast used to produce.
    assert.match(JSON.stringify(body), new RegExp(`"balance":${OPENING_CASH}`));
  });

  it("rejects a period that is a string instead of the union object", async () => {
    // Regression: this returned 200 with an all-zero balance sheet.
    const { status, body } = await dispatch({
      action: ACCOUNTING_ACTIONS.getReport,
      kind: "balance",
      bookId,
      period: "2026-01",
    });
    assert.equal(status, 400);
    assert.match(String(body.error), /period is required/);
  });

  it("rejects a half-formed month period", async () => {
    // Regression: `period.period` was undefined, so the report layer threw
    // `Cannot read properties of undefined (reading 'split')` and 500'd.
    const { status, body } = await dispatch({
      action: ACCOUNTING_ACTIONS.getReport,
      kind: "pl",
      bookId,
      period: { kind: "month" },
    });
    assert.equal(status, 400);
    assert.match(String(body.error), /period is required/);
  });

  it("rejects a range period missing an endpoint", async () => {
    const { status } = await dispatch({
      action: ACCOUNTING_ACTIONS.getReport,
      kind: "pl",
      bookId,
      period: { kind: "range", from: "2026-01-01" },
    });
    assert.equal(status, 400);
  });

  it("still allows ledger without a period", async () => {
    const { status } = await dispatch({
      action: ACCOUNTING_ACTIONS.getReport,
      kind: "ledger",
      bookId,
      accountCode: "1000",
    });
    assert.equal(status, 200);
  });
});

describe("bookId reading", () => {
  it("treats a non-string bookId as absent", async () => {
    // Previously cast to `string | undefined`, so a number reached
    // `resolveBookId` and came back as "book 42 not found".
    const { status, body } = await dispatch({ action: ACCOUNTING_ACTIONS.getAccounts, bookId: 42 });
    assert.equal(status, 400);
    assert.match(String(body.error), /bookId is required/);
  });

  it("still resolves a well-formed bookId", async () => {
    const { status } = await dispatch({ action: ACCOUNTING_ACTIONS.getAccounts, bookId });
    assert.equal(status, 200);
  });
});
