// Unit tests for the tiny derived-formula evaluator
// (src/utils/collections/derivedFormula.ts). The evaluator is a
// pure module specifically so the parser/eval quirks are pinned
// here, independently from any Vue rendering layer.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { evaluateDerived } from "@mulmoclaude/core/collection";

describe("evaluateDerived — literals + arithmetic", () => {
  it("returns a bare number literal", () => {
    assert.equal(evaluateDerived("42", { record: {} }), 42);
    assert.equal(evaluateDerived("0", { record: {} }), 0);
    assert.equal(evaluateDerived("1.5", { record: {} }), 1.5);
    assert.equal(evaluateDerived(".25", { record: {} }), 0.25);
  });

  it("respects standard arithmetic precedence", () => {
    assert.equal(evaluateDerived("1 + 2 * 3", { record: {} }), 7);
    assert.equal(evaluateDerived("(1 + 2) * 3", { record: {} }), 9);
    assert.equal(evaluateDerived("10 - 4 - 2", { record: {} }), 4); // left-associative
    assert.equal(evaluateDerived("100 / 4 / 5", { record: {} }), 5);
    assert.equal(evaluateDerived("2 + 3 * 4 - 1", { record: {} }), 13);
  });

  it("handles parens nested deeply", () => {
    assert.equal(evaluateDerived("((1 + 2) * (3 + 4))", { record: {} }), 21);
  });
});

describe("evaluateDerived — identifiers", () => {
  it("resolves a top-level field by name", () => {
    assert.equal(evaluateDerived("subtotal", { record: { subtotal: 100 } }), 100);
    assert.equal(evaluateDerived("subtotal + tax", { record: { subtotal: 100, tax: 10 } }), 110);
  });

  it("coerces numeric strings to numbers", () => {
    assert.equal(evaluateDerived("rate", { record: { rate: "12.5" } }), 12.5);
  });

  it("returns null when a referenced field is missing", () => {
    assert.equal(evaluateDerived("subtotal", { record: {} }), null);
  });

  it("returns null when a referenced field is non-numeric", () => {
    assert.equal(evaluateDerived("subtotal", { record: { subtotal: "abc" } }), null);
    assert.equal(evaluateDerived("subtotal", { record: { subtotal: true } }), null);
  });
});

describe("evaluateDerived — sum()", () => {
  const lineItems = [
    { quantity: 10, rate: 100 },
    { quantity: 2, rate: 250 },
    { quantity: 5, rate: 50 },
  ];

  it("sums a single column", () => {
    const record = { lineItems: [{ amount: 100 }, { amount: 250 }, { amount: 50 }] };
    assert.equal(evaluateDerived("sum(lineItems[].amount)", { record }), 400);
  });

  it("sums the product of two columns", () => {
    // 10*100 + 2*250 + 5*50 = 1000 + 500 + 250 = 1750
    assert.equal(evaluateDerived("sum(lineItems[].quantity * lineItems[].rate)", { record: { lineItems } }), 1750);
  });

  it("returns 0 when the table is missing or empty", () => {
    assert.equal(evaluateDerived("sum(lineItems[].amount)", { record: {} }), 0);
    assert.equal(evaluateDerived("sum(lineItems[].amount)", { record: { lineItems: [] } }), 0);
  });

  it("integrates with surrounding arithmetic (subtotal-tax-total pattern)", () => {
    const record = { lineItems, taxRate: 0.1 };
    // subtotal = 1750
    assert.equal(evaluateDerived("sum(lineItems[].quantity * lineItems[].rate)", { record }), 1750);
    // tax = subtotal * taxRate, computed against the post-subtotal context
    assert.equal(evaluateDerived("subtotal * taxRate", { record: { subtotal: 1750, taxRate: 0.1 } }), 175);
    // total = subtotal + tax
    assert.equal(evaluateDerived("subtotal + tax", { record: { subtotal: 1750, tax: 175 } }), 1925);
  });

  it("returns null when a column value is non-numeric inside sum", () => {
    const record = { lineItems: [{ quantity: 10, rate: "bad" }] };
    assert.equal(evaluateDerived("sum(lineItems[].quantity * lineItems[].rate)", { record }), null);
  });

  it("rejects mismatched tables inside one sum (would be ambiguous)", () => {
    const record = { foo: [{ x: 1 }], bar: [{ y: 1 }] };
    assert.equal(evaluateDerived("sum(foo[].x * bar[].y)", { record }), null);
  });
});

describe("evaluateDerived — long operator chains parse without stack growth", () => {
  // A formula is user input, so chain length must not decide whether parsing
  // overflows the stack and fails soft to null.
  const SUM_FACTOR_COUNT = 20_000;
  // `+` / `*` chains build a left-leaning AST that the evaluator walks
  // recursively, so they stay far below that (separate, pre-existing) limit.
  const TERM_COUNT = 2_000;

  it("parses a sum() with 20k factors instead of failing soft to null", () => {
    const record = { items: [{ v: 1, k: 3 }] };
    const formula = `sum(items[].k${" * items[].v".repeat(SUM_FACTOR_COUNT - 1)})`;
    assert.equal(evaluateDerived(formula, { record }), 3);
  });

  it("parses a long '+' chain", () => {
    assert.equal(evaluateDerived(`1${" + 1".repeat(TERM_COUNT - 1)}`, { record: {} }), TERM_COUNT);
  });

  it("parses a long '*' chain", () => {
    assert.equal(evaluateDerived(`7${" * 1".repeat(TERM_COUNT - 1)}`, { record: {} }), 7);
  });

  it("parses a long '-' / '/' chain (left-associative to the end)", () => {
    assert.equal(evaluateDerived(`${TERM_COUNT}${" - 1".repeat(TERM_COUNT - 1)}`, { record: {} }), 1);
    assert.equal(evaluateDerived(`8${" / 1".repeat(TERM_COUNT - 1)}`, { record: {} }), 8);
  });
});

describe("evaluateDerived — ref dereference (<field>.<col>)", () => {
  // A my-portfolio row: `ticker` is a ref field whose stored value is
  // the slug "AAPL"; the caller resolves it into ctx.refs.
  const refs = { ticker: { price: 200, shares: 50 } };

  it("reads a numeric column off the resolved target record", () => {
    assert.equal(evaluateDerived("ticker.price", { record: { ticker: "AAPL" }, refs }), 200);
  });

  it("multiplies a local field by a referenced column (value = shares * ticker.price)", () => {
    assert.equal(evaluateDerived("shares * ticker.price", { record: { ticker: "AAPL", shares: 10 }, refs }), 2000);
  });

  it("works inside larger arithmetic and parens", () => {
    assert.equal(evaluateDerived("(ticker.price + 50) * 2", { record: { ticker: "AAPL" }, refs }), 500);
  });

  it("coerces a numeric-string column", () => {
    assert.equal(evaluateDerived("ticker.price", { record: { ticker: "AAPL" }, refs: { ticker: { price: "12.5" } } }), 12.5);
  });

  it("returns null when the ref is unresolved (dangling slug → null)", () => {
    assert.equal(evaluateDerived("ticker.price", { record: { ticker: "ZZZZ" }, refs: { ticker: null } }), null);
  });

  it("returns null when refs is absent entirely", () => {
    assert.equal(evaluateDerived("ticker.price", { record: { ticker: "AAPL" } }), null);
  });

  it("returns null when the referenced column is missing or non-numeric", () => {
    assert.equal(evaluateDerived("ticker.peRatio", { record: { ticker: "AAPL" }, refs }), null);
    assert.equal(evaluateDerived("ticker.price", { record: { ticker: "AAPL" }, refs: { ticker: { price: "n/a" } } }), null);
  });

  it("does not mistake a top-level field for a ref deref", () => {
    // No `.` ⇒ plain identifier path, unchanged.
    assert.equal(evaluateDerived("shares", { record: { shares: 7 }, refs }), 7);
  });

  it("returns null on a malformed deref (trailing dot / missing column)", () => {
    assert.equal(evaluateDerived("ticker.", { record: { ticker: "AAPL" }, refs }), null);
  });
});

describe("evaluateDerived — error handling", () => {
  it("returns null on parse error (unexpected char)", () => {
    assert.equal(evaluateDerived("1 + @ + 2", { record: {} }), null);
  });

  it("returns null on parse error (trailing junk)", () => {
    assert.equal(evaluateDerived("1 + 2 garbage", { record: {} }), null);
  });

  it("returns null on parse error (mismatched parens)", () => {
    assert.equal(evaluateDerived("(1 + 2", { record: {} }), null);
    assert.equal(evaluateDerived("1 + 2)", { record: {} }), null);
  });

  it("returns null on divide by zero", () => {
    assert.equal(evaluateDerived("10 / 0", { record: {} }), null);
  });

  it("returns null on division by missing field", () => {
    assert.equal(evaluateDerived("10 / divisor", { record: { divisor: 0 } }), null);
  });

  it("returns null when sum() argument shape is wrong", () => {
    assert.equal(evaluateDerived("sum(lineItems)", { record: { lineItems: [] } }), null);
    assert.equal(evaluateDerived("sum()", { record: {} }), null);
  });

  it("rejects unsupported function calls", () => {
    assert.equal(evaluateDerived("avg(lineItems[].amount)", { record: {} }), null);
  });

  it("rejects string concatenation / boolean operators / comparisons", () => {
    assert.equal(evaluateDerived("1 == 1", { record: {} }), null);
    assert.equal(evaluateDerived("a && b", { record: { a: 1, b: 2 } }), null);
  });
});
