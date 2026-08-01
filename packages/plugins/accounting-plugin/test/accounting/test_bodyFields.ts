import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { describeEntry, optionalRecord, optionalReportPeriod, optionalString } from "../../src/server/bodyFields.js";

describe("optionalString", () => {
  it("passes a string through", () => {
    assert.equal(optionalString("book-1"), "book-1");
  });

  it("keeps the empty string — the service decides whether blank is valid", () => {
    assert.equal(optionalString(""), "");
  });

  it("reads a non-string as absent so the service raises its own error", () => {
    // The router previously wrote `rest.bookId as string | undefined`, so a
    // number reached `resolveBookId` typed as a string. Now it reads as
    // absent and the service answers "bookId is required".
    assert.equal(optionalString(42), undefined);
    assert.equal(optionalString(null), undefined);
    assert.equal(optionalString(undefined), undefined);
    assert.equal(optionalString({ toString: () => "book-1" }), undefined);
    assert.equal(optionalString(["book-1"]), undefined);
  });
});

describe("optionalRecord", () => {
  it("passes a plain object through by reference", () => {
    const value = { id: "b1" };
    assert.equal(optionalRecord(value), value);
  });

  it("rejects arrays, null, and primitives", () => {
    assert.equal(optionalRecord([1, 2]), undefined);
    assert.equal(optionalRecord(null), undefined);
    assert.equal(optionalRecord("book"), undefined);
  });
});

describe("optionalReportPeriod", () => {
  it("rebuilds a month period", () => {
    assert.deepEqual(optionalReportPeriod({ kind: "month", period: "2026-01" }), { kind: "month", period: "2026-01" });
  });

  it("rebuilds a range period", () => {
    assert.deepEqual(optionalReportPeriod({ kind: "range", from: "2026-01-01", to: "2026-03-31" }), {
      kind: "range",
      from: "2026-01-01",
      to: "2026-03-31",
    });
  });

  it("drops fields outside the declared shape", () => {
    // The result is rebuilt, not narrowed, so extra keys can't ride along
    // into the report builders.
    assert.deepEqual(optionalReportPeriod({ kind: "month", period: "2026-01", extra: "x" }), { kind: "month", period: "2026-01" });
  });

  it("reads a half-formed period as absent", () => {
    // `{ kind: "month" }` used to reach buildProfitLoss and produce an
    // `undefined-01` from-date; now the caller raises "period is required".
    assert.equal(optionalReportPeriod({ kind: "month" }), undefined);
    assert.equal(optionalReportPeriod({ kind: "month", period: 202601 }), undefined);
    assert.equal(optionalReportPeriod({ kind: "range", from: "2026-01-01" }), undefined);
  });

  it("reads an unknown kind or a non-object as absent", () => {
    assert.equal(optionalReportPeriod({ kind: "quarter", period: "2026-Q1" }), undefined);
    assert.equal(optionalReportPeriod("2026-01"), undefined);
    assert.equal(optionalReportPeriod(undefined), undefined);
    assert.equal(optionalReportPeriod(null), undefined);
  });
});

describe("describeEntry", () => {
  it("reads id and date off an entry payload", () => {
    assert.deepEqual(describeEntry({ id: "e1", date: "2026-01-05", lines: [] }), { id: "e1", date: "2026-01-05" });
  });

  it("yields both fields undefined for a non-object element", () => {
    // The narration maps over whatever the service returned; a null element
    // must not throw on property access.
    assert.deepEqual(describeEntry(null), { id: undefined, date: undefined });
    assert.deepEqual(describeEntry("e1"), { id: undefined, date: undefined });
  });

  it("drops non-string id and date", () => {
    assert.deepEqual(describeEntry({ id: 7, date: 20260105 }), { id: undefined, date: undefined });
  });
});
