// `projectRecordFields` is the ONE projection behind the server store layer and
// the remote-view page builder, so "what does a projected record still carry?"
// is a contract both sides depend on. These pin the boundaries the
// entries-rebuild → prune-a-copy rewrite had to preserve: the record's own type,
// the caller's input, and the rule that nothing outside `fields` survives.
import { test } from "node:test";
import assert from "node:assert/strict";

import { projectRecordFields } from "../../src/collection/core/project.ts";

const records = [{ id: "a", title: "T", note: "drop-me", n: 1 }, { id: "b" }, { id: "c", title: null, nested: { x: [1, 2] } }];

test("no `fields` passes the records through untouched (same array identity)", () => {
  assert.equal(projectRecordFields(records, undefined, "id"), records);
});

test("keeps only the requested fields plus the primary key", () => {
  assert.deepEqual(projectRecordFields(records, ["title"], "id"), [{ id: "a", title: "T" }, { id: "b" }, { id: "c", title: null }]);
  assert.deepEqual(projectRecordFields(records, [], "id"), [{ id: "a" }, { id: "b" }, { id: "c" }]);
  assert.deepEqual(projectRecordFields(records, ["nope"], "id"), [{ id: "a" }, { id: "b" }, { id: "c" }]);
});

test("does not mutate the records it was given", () => {
  projectRecordFields(records, ["title"], "id");
  assert.deepEqual(records[0], { id: "a", title: "T", note: "drop-me", n: 1 });
});

test("a symbol-keyed property is dropped — a symbol can never be a requested field", () => {
  // Pruning a shallow copy is what keeps the record's type, but the spread also
  // copies enumerable SYMBOL keys, which `Object.keys` would not have seen.
  // Leaving one would hand the caller data it did not select (CodeRabbit, #2730).
  const marker = Symbol("marker");
  const [projected] = projectRecordFields([{ id: "a", title: "T", [marker]: "leaked" }], ["title"], "id");
  assert.deepEqual(Object.getOwnPropertySymbols(projected), [], "no symbol survives the projection");
  assert.deepEqual(projected, { id: "a", title: "T" });
});
