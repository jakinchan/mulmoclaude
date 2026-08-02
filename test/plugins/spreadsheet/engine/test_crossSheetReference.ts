// Cross-sheet references (`=Data!A1`) must resolve a cell to the SAME value a
// same-sheet reference would. Regression for #2332: the target sheet was being
// resolved through its display-formatted output, so a date serial arrived as
// the string "03/04/2025" and parseFloat read it as 3 — `=Data!A1` returned 3
// and `=DAY(Data!A1)` returned 2. Same-sheet was always correct; these tests
// pin cross-sheet to that same behaviour.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SpreadsheetEngine, type SheetData } from "../../../../src/plugins/spreadsheet/engine/index.ts";
import { rowAt } from "./cellAccess.ts";

const engine = new SpreadsheetEngine();

const calcRow = (target: SheetData, all: SheetData[], row = 0) => rowAt(engine.calculate(target, all).data, row);

describe("cross-sheet date reference (#2332 regression)", () => {
  const data: SheetData = { name: "Data", data: [[{ v: "03/04/2025" }]] };
  const summary: SheetData = { name: "Summary", data: [[{ v: "=DAY(Data!A1)" }, { v: "=Data!A1" }]] };

  it("=DAY(Data!A1) reads the date, not the leading digits", () => {
    assert.equal(calcRow(summary, [data, summary])[0], 4);
  });

  it("=Data!A1 does not collapse to 3", () => {
    assert.notEqual(calcRow(summary, [data, summary])[1], 3);
  });

  it("=Data!A1 matches the identical same-sheet reference", () => {
    const sameSheet: SheetData = { name: "S", data: [[{ v: "03/04/2025" }, { v: "=DAY(A1)" }, { v: "=A1" }]] };
    const same = calcRow(sameSheet, [sameSheet]);
    const cross = calcRow(summary, [data, summary]);
    assert.equal(cross[0], same[1]); // =DAY
    assert.equal(cross[1], same[2]); // =ref -> "03/04/2025"
  });
});

describe("cross-sheet reference — value types read straight across", () => {
  const data: SheetData = {
    name: "Data",
    // date, number, text, empty, a formula that itself produces a date serial
    data: [[{ v: "03/04/2025" }, { v: 42 }, { v: "hello" }, { v: "" }, { v: "=DATE(2025,3,4)" }]],
  };
  const refs: SheetData = {
    name: "Refs",
    data: [[{ v: "=Data!A1" }, { v: "=Data!B1" }, { v: "=Data!C1" }, { v: "=Data!D1" }, { v: "=Data!E1" }]],
  };

  it("resolves each type the way the source cell holds it", () => {
    assert.deepEqual(calcRow(refs, [data, refs]), ["03/04/2025", 42, "hello", 0, "03/04/2025"]);
  });

  it("feeds a cross-sheet date into a date function", () => {
    const derived: SheetData = { name: "D2", data: [[{ v: "=DAY(Data!E1)" }, { v: "=Data!B1*2" }]] };
    assert.deepEqual(calcRow(derived, [data, derived]), [4, 84]);
  });
});

describe("cross-sheet range aggregation stays numeric", () => {
  it("SUM over a cross-sheet range adds the raw numbers", () => {
    const data: SheetData = { name: "D", data: [[{ v: 10 }, { v: 20 }, { v: 30 }]] };
    const sum: SheetData = { name: "S", data: [[{ v: "=SUM(D!A1:C1)" }]] };
    assert.deepEqual(calcRow(sum, [data, sum]), [60]);
  });
});

// resolveSheetData (#2482) folds the sheet-ref match -> cache check -> two-stage
// cache seed -> calculateSheet block that getCellValue and collectRangeValues
// shared. The two-stage seed is the cross-sheet infinite-loop guard: a cyclic
// reference must terminate with an error, not hang. If it hung, these tests would
// never return and the whole suite would time out.
describe("cyclic cross-sheet references terminate instead of hanging", () => {
  it("a 2-sheet cycle (A!A1=B!A1, B!A1=A!A1) resolves to an error", () => {
    const sheetA: SheetData = { name: "A", data: [[{ v: "=B!A1" }]] };
    const sheetB: SheetData = { name: "B", data: [[{ v: "=A!A1" }]] };
    assert.equal(String(calcRow(sheetA, [sheetA, sheetB])[0]), "#ERROR!");
  });

  it("a 3-sheet cycle (A->B->C->A) also terminates with an error", () => {
    const sheetA: SheetData = { name: "A", data: [[{ v: "=B!A1" }]] };
    const sheetB: SheetData = { name: "B", data: [[{ v: "=C!A1" }]] };
    const sheetC: SheetData = { name: "C", data: [[{ v: "=A!A1" }]] };
    assert.equal(String(calcRow(sheetA, [sheetA, sheetB, sheetC])[0]), "#ERROR!");
  });

  it("a valid cross-sheet reference next to the cycle still resolves", () => {
    const data: SheetData = { name: "D", data: [[{ v: 10 }, { v: 20 }]] };
    const main: SheetData = { name: "S", data: [[{ v: "=D!A1" }, { v: "=SUM(D!A1:B1)" }]] };
    assert.deepEqual(calcRow(main, [data, main]), [10, 30]);
  });
});

// A reference to a sheet that does not exist keeps each caller's terminal action
// after the fold: #REF! for a single cell, an empty range for an aggregate.
describe("missing-sheet reference keeps its per-caller terminal behaviour", () => {
  it("a single cross-sheet cell to a missing sheet is #REF!", () => {
    const main: SheetData = { name: "S", data: [[{ v: "=Ghost!A1" }]] };
    assert.equal(String(calcRow(main, [main])[0]), "#REF!");
  });

  it("SUM over a range on a missing sheet contributes nothing (empty range)", () => {
    const main: SheetData = { name: "S", data: [[{ v: "=SUM(Ghost!A1:B1)" }]] };
    assert.equal(calcRow(main, [main])[0], 0);
  });
});
