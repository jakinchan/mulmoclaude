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

// #2695: the payloads below reached a validator that assumed its
// elements were objects, so the TypeError bubbled to the 500 catch-all —
// out of the code written to turn bad input into a structured 400.
describe("null elements in entries / lines", () => {
  it("rejects a null journal entry with a structured 400", async () => {
    const { status, body } = await dispatch({ action: ACCOUNTING_ACTIONS.addEntries, bookId, entries: [null] });
    assert.equal(status, 400);
    assert.match(String(body.error), /invalid journal entries/);
    // `details` is what lets the LLM repair its own payload — a bare
    // 400 would be no better than the 500 it replaces.
    assert.match(JSON.stringify(body.details), /"index":0/);
  });

  it("rejects a null opening balance line with a structured 400", async () => {
    const { status, body } = await dispatch({
      action: ACCOUNTING_ACTIONS.setOpeningBalances,
      bookId,
      asOfDate: "2026-01-01",
      lines: [null],
    });
    assert.equal(status, 400);
    assert.match(String(body.error), /invalid opening balances/);
    assert.match(JSON.stringify(body.details), /lines\[0\]/);
  });

  it("still rejects a primitive entry and a non-array entries", async () => {
    const primitive = await dispatch({ action: ACCOUNTING_ACTIONS.addEntries, bookId, entries: [42] });
    assert.equal(primitive.status, 400);
    const notArray = await dispatch({ action: ACCOUNTING_ACTIONS.addEntries, bookId, entries: "nope" });
    assert.equal(notArray.status, 400);
    assert.match(String(notArray.body.error), /entries must be a non-empty array/);
  });

  it("keeps the per-field message for a mistyped amount", async () => {
    // Anti-degradation: narrowing happens inside the validator, so this
    // stays specific instead of collapsing to "malformed entries".
    const { status, body } = await dispatch({
      action: ACCOUNTING_ACTIONS.addEntries,
      bookId,
      entries: [
        {
          date: "2026-01-05",
          lines: [
            { accountCode: "1000", debit: "abc" },
            { accountCode: "3000", credit: 5 },
          ],
        },
      ],
    });
    assert.equal(status, 400);
    assert.match(JSON.stringify(body.details), /debit must be a non-negative finite number/);
  });

  it("rejects an account payload missing name / type instead of persisting it", async () => {
    // Previously 200: the account landed on disk with `type` undefined,
    // and every report groups its rows by type.
    // 1777 is outside the default chart, so its absence afterwards is
    // the write not happening rather than a seeded row.
    const { status, body } = await dispatch({ action: ACCOUNTING_ACTIONS.upsertAccount, bookId, account: { code: "1777" } });
    assert.equal(status, 400);
    assert.match(String(body.error), /account name is required/);
    const accounts = await dispatch({ action: ACCOUNTING_ACTIONS.getAccounts, bookId });
    assert.doesNotMatch(JSON.stringify(accounts.body), /"1777"/);
  });

  it("rejects a null account", async () => {
    const { status } = await dispatch({ action: ACCOUNTING_ACTIONS.upsertAccount, bookId, account: null });
    assert.equal(status, 400);
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
