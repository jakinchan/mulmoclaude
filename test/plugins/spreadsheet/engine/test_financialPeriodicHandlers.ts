// IPMT and PPMT now share one arg-parsing factory, makePeriodicComponentHandler
// (#2482). These drive both THROUGH the engine — the layer the factory lives in —
// so a swapped compute call or a mis-parsed optional arg (fv / type) is caught.
// The pure computeIpmt / computePpmt tests exercise the math, not the handler.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SpreadsheetEngine, type SheetData } from "../../../../src/plugins/spreadsheet/engine/index.ts";
import { cellAt } from "./cellAccess.ts";

const evalA1 = (formula: string): unknown => {
  const sheet: SheetData = { name: "S", data: [[{ v: formula }]] };
  return cellAt(new SpreadsheetEngine().calculate(sheet).data, 0, 0);
};

const closeTo = (actual: unknown, expected: number, eps = 0.01): boolean => typeof actual === "number" && Math.abs(actual - expected) <= eps;

describe("IPMT / PPMT through the engine (shared handler factory)", () => {
  it("IPMT(0.005, 1, 360, 250000) is the interest-only first payment (-1250)", () => {
    assert.ok(closeTo(evalA1("=IPMT(0.005, 1, 360, 250000)"), -1250, 1e-6), `got ${String(evalA1("=IPMT(0.005, 1, 360, 250000)"))}`);
  });

  it("PPMT(0.005, 1, 360, 250000) is the principal-only first payment (~ -248.88)", () => {
    assert.ok(closeTo(evalA1("=PPMT(0.005, 1, 360, 250000)"), -248.88), `got ${String(evalA1("=PPMT(0.005, 1, 360, 250000)"))}`);
  });

  it("IPMT and PPMT stay distinct — the factory did not collapse them onto one compute", () => {
    assert.notEqual(evalA1("=IPMT(0.005, 2, 360, 250000)"), evalA1("=PPMT(0.005, 2, 360, 250000)"));
  });

  it("parses the optional type arg: IPMT at period 1, begin-of-period, is 0", () => {
    assert.equal(evalA1("=IPMT(0.005, 1, 360, 250000, 0, 1)"), 0);
  });
});
