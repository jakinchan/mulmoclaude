// Field-level `default` (#2839): what a NEW record starts on, shared by the
// Add form and `putItems mode:"create"` so the two cannot disagree.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { fieldDefaultValue, schemaDefaults, firstUnknownDefault } from "../../src/collection/core/fieldDefaults";
import type { CollectionFieldSpec, CollectionSchema } from "../../src/collection/core/schema";

const field = (type: string, extra: Record<string, unknown> = {}): CollectionFieldSpec => ({ type, label: type, ...extra }) as CollectionFieldSpec;

const STATUS = field("enum", { values: ["todo", "doing", "done"], default: "todo", required: true });
const PRIORITY = field("enum", { values: ["high", "low"], default: "low" });

const schemaOf = (fields: Record<string, CollectionFieldSpec>): CollectionSchema =>
  ({ title: "T", icon: "list", dataPath: "data/t", primaryKey: "id", fields }) as CollectionSchema;

describe("fieldDefaultValue", () => {
  it("returns the declared default of an enum field", () => {
    assert.equal(fieldDefaultValue(STATUS), "todo");
  });

  it("returns null for an enum without a default, and for non-enum types", () => {
    assert.equal(fieldDefaultValue(field("enum", { values: ["a"] })), null);
    assert.equal(fieldDefaultValue(field("string")), null);
    assert.equal(fieldDefaultValue(field("boolean")), null);
    assert.equal(fieldDefaultValue(field("number", { default: 3 })), null);
  });

  // A file written before #2839 could carry a default the schema no longer
  // offers — the key was silently ignored then, and discovery still loads it.
  // Handing an impossible value to the form would make the save fail for a
  // reason the author cannot see.
  it("returns null when the default is not one of the values", () => {
    assert.equal(fieldDefaultValue(field("enum", { values: ["todo", "done"], default: "未着手" })), null);
  });
});

describe("schemaDefaults", () => {
  it("collects every applicable default, and only those", () => {
    const schema = schemaOf({ id: field("string"), status: STATUS, priority: PRIORITY, note: field("text") });
    assert.deepEqual(schemaDefaults(schema), { status: "todo", priority: "low" });
  });

  it("is empty when no field declares one", () => {
    assert.deepEqual(schemaDefaults(schemaOf({ id: field("string"), name: field("string") })), {});
  });

  // A field may legitimately be named `__proto__` — JSON.parse hands it over as
  // an OWN key, and the schema keeps it. Assigning that name into a plain
  // object would run the prototype setter and drop the default silently
  // (Codex review on #2910). Held in a const so the lookups read as data
  // rather than as the deprecated `__proto__` accessor.
  it("keeps a default on a field named __proto__", () => {
    const PROTO_KEY = "__proto__";
    const fields: Record<string, CollectionFieldSpec> = { [PROTO_KEY]: field("enum", { values: ["todo", "done"], default: "todo" }) };
    const defaults = schemaDefaults(schemaOf(fields));
    assert.equal(Object.hasOwn(defaults, PROTO_KEY), true, "must be an own property, not a prototype write");
    assert.equal(defaults[PROTO_KEY], "todo");
    assert.deepEqual(Object.keys(defaults), [PROTO_KEY]);
  });

  it("skips a default the values do not offer", () => {
    const schema = schemaOf({ status: field("enum", { values: ["todo"], default: "gone" }) });
    assert.deepEqual(schemaDefaults(schema), {});
  });
});

describe("firstUnknownDefault", () => {
  // The WRITE-path check. Deliberately separate from the parse: rejecting at
  // parse time would drop the whole collection out of discovery's index.
  it("names the offending field, its value, and what was allowed", () => {
    const schema = schemaOf({ status: field("enum", { values: ["todo", "done"], default: "未着手" }) });
    assert.deepEqual(firstUnknownDefault(schema), { key: "status", value: "未着手", values: ["todo", "done"] });
  });

  it("returns null for a schema whose defaults are all members", () => {
    assert.equal(firstUnknownDefault(schemaOf({ status: STATUS, priority: PRIORITY })), null);
  });

  it("returns null when no default is declared at all", () => {
    assert.equal(firstUnknownDefault(schemaOf({ status: field("enum", { values: ["todo"] }) })), null);
  });
});
