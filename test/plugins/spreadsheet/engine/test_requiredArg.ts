// #2736: adopting `noUncheckedIndexedAccess` turned every `args[N]` in a
// function handler into `string | undefined`. `requiredArg` is the single reader
// that resolves it — and the reason it can be a *reader* rather than a default
// is that the evaluator validates the registry's `minArgs` before any handler
// runs. These tests pin both halves of that contract.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { functionRegistry, requiredArg, tooFewArgumentsError, type FunctionContext } from "../../../../src/plugins/spreadsheet/engine/registry.ts";
import "../../../../src/plugins/spreadsheet/engine/functions/index.ts";
import { substituteCellRefs, findCellRefs } from "../../../../src/plugins/spreadsheet/engine/evaluator.ts";

const stubContext = (functionName: string): FunctionContext => ({
  functionName,
  getCellValue: () => 1,
  getRangeValues: () => [1, 2, 3],
  getRangeValuesRaw: () => [1, 2, 3],
  evaluateFormula: () => 1,
});

/** The wording the evaluator uses for an arity violation, which `requiredArg`
 *  must reproduce rather than invent a second message for. */
const TOO_FEW_MESSAGE = /^[A-Z]+ requires at least \d+ arguments?$/;

describe("requiredArg", () => {
  it("returns the argument at the index", () => {
    assert.equal(requiredArg(stubContext("SUM"), ["A1", "B1"], 1), "B1");
  });

  it("throws the evaluator's own arity wording, naming the function and the count it needed", () => {
    assert.throws(() => requiredArg(stubContext("ROUND"), ["A1"], 1), { message: "ROUND requires at least 2 arguments" });
  });

  it("uses the singular for a one-argument minimum, like the evaluator does", () => {
    assert.equal(tooFewArgumentsError("UPPER", 1).message, "UPPER requires at least 1 argument");
    assert.throws(() => requiredArg(stubContext("UPPER"), [], 0), { message: "UPPER requires at least 1 argument" });
  });

  it("never substitutes a default — an absent argument is an error, not a 0 or an empty string", () => {
    assert.throws(() => requiredArg(stubContext("MID"), ["A1", "1"], 2), { message: TOO_FEW_MESSAGE });
  });
});

describe("every registered function's minArgs covers what its handler reads", () => {
  // The audit behind #2736's spreadsheet pass, kept as a permanent guard: a
  // registration whose minArgs is LOWER than the highest index its handler reads
  // unguarded is a crash path reachable from a user formula, because the
  // evaluator's arity gate would let that call through. Calling each handler
  // with exactly minArgs arguments makes `requiredArg` the detector.
  functionRegistry.getAllFunctions().forEach((definition) => {
    it(`${definition.name} reads no argument beyond its declared minimum`, () => {
      const minArgs = definition.minArgs ?? 0;
      const args = Array.from({ length: minArgs }, () => "A1");
      try {
        definition.handler(args, stubContext(definition.name));
      } catch (error) {
        // A handler may fail for unrelated reasons (a stub range is not a real
        // table); only the arity wording means minArgs under-declares.
        const message = error instanceof Error ? error.message : String(error);
        assert.doesNotMatch(message, TOO_FEW_MESSAGE, `${definition.name} read past its declared minArgs=${minArgs}`);
      }
    });
  });
});

describe("substituteCellRefs", () => {
  // #2357: a global string replace rewrote every occurrence of the SHORTER
  // reference first, so A10 became "<A1's value>0" and the cell showed a
  // plausible wrong number. Substituting back to front is what prevents it.
  it("substitutes back to front, so a longer reference is not broken by a shorter prefix", () => {
    const expr = "A1+A10";
    const result = substituteCellRefs(expr, findCellRefs(expr), (ref) => (ref === "A1" ? "5" : "7"));
    assert.equal(result, "5+7");
  });

  it("leaves the caller's span list untouched", () => {
    const spans = findCellRefs("A1+B2");
    substituteCellRefs("A1+B2", spans, () => "0");
    assert.deepEqual(
      spans.map((span) => span.ref),
      ["A1", "B2"],
    );
  });

  it("returns the expression unchanged when there is nothing to substitute", () => {
    assert.equal(
      substituteCellRefs("1+2", [], () => "9"),
      "1+2",
    );
  });

  it("propagates a throw from the renderer, so an errored reference still poisons the expression", () => {
    const expr = "A1+1";
    assert.throws(
      () =>
        substituteCellRefs(expr, findCellRefs(expr), () => {
          throw new Error("#DIV/0!");
        }),
      { message: "#DIV/0!" },
    );
  });
});
