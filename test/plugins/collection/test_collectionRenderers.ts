// Unit tests for the state-parameterized pure renderers
// (packages/plugins/collection-plugin/src/vue/useCollectionRendering.renderers.ts).
// These take resolved cache values + locale as explicit args (no vue refs), so
// they pin the embed-view / ref-label / derived-formula logic the composable
// wires with thin closures.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { CollectionSchema, CollectionFieldSpec as FieldSpec, CollectionFieldType as FieldType, EmbedCache, RefCache } from "@mulmoclaude/core/collection";
import {
  buildEmbedViews,
  embedOptionsFor,
  evaluateDerived,
  formatEmbedValue,
  lookupRefDisplay,
  refOptionsFor,
  renderDerived,
  renderSubCell,
  resolveEmbed,
} from "../../../packages/plugins/collection-plugin/src/vue/useCollectionRendering.renderers";

// Fixture builder: assembles a spec dynamically (often deliberately partial),
// so it casts rather than satisfying the discriminated union per-variant.
const field = (type: FieldType, extra: Record<string, unknown> = {}): FieldSpec => ({ type, label: type, ...extra }) as FieldSpec;

const makeSchema = (fields: Record<string, FieldSpec>, primaryKey = "id"): CollectionSchema => ({
  title: "Test",
  icon: "list",
  dataPath: "collections/test",
  primaryKey,
  fields,
});

const specOf = (schema: CollectionSchema, key: string): FieldSpec => {
  const spec = schema.fields[key];
  assert.ok(spec, `schema has no field: ${key}`);
  return spec;
};

const profileSchema = makeSchema({ id: field("text"), name: field("text"), fee: field("money", { currency: "USD" }) });
const embedCache: EmbedCache = {
  profiles: {
    schema: profileSchema,
    items: [
      { id: "me", name: "Me Inc", fee: 100 },
      { id: "you", name: "You LLC", fee: 200 },
    ],
  },
};

describe("lookupRefDisplay", () => {
  it("returns the mapped label, falling back to the slug", () => {
    const cache: RefCache = { people: { a: "Alice" } };
    assert.equal(lookupRefDisplay(cache, "people", "a"), "Alice");
    assert.equal(lookupRefDisplay(cache, "people", "z"), "z");
    assert.equal(lookupRefDisplay(cache, "missing", "a"), "a");
  });
});

describe("refOptionsFor", () => {
  it("sorts options by label; empty for an unknown target", () => {
    const cache: RefCache = { people: { b: "Bravo", a: "Alpha" } };
    assert.deepEqual(refOptionsFor(cache, "people"), [
      { slug: "a", display: "Alpha" },
      { slug: "b", display: "Bravo" },
    ]);
    assert.deepEqual(refOptionsFor(cache, "nope"), []);
  });
});

describe("embedOptionsFor", () => {
  it("builds sorted options from the embed cache; empty for an unknown target", () => {
    assert.deepEqual(embedOptionsFor(embedCache, "profiles"), [
      { slug: "me", display: "Me Inc" },
      { slug: "you", display: "You LLC" },
    ]);
    assert.deepEqual(embedOptionsFor(embedCache, "nope"), []);
  });
});

describe("resolveEmbed", () => {
  it("returns null schema/item for a non-embed field", () => {
    assert.deepEqual(resolveEmbed(field("text"), null, embedCache), { schema: null, item: null });
  });
  it("returns null when the per-record id resolves to nothing", () => {
    assert.deepEqual(resolveEmbed(field("embed", { to: "profiles", idField: "x" }), {}, embedCache), { schema: null, item: null });
  });
  it("finds the target record by fixed id", () => {
    const res = resolveEmbed(field("embed", { to: "profiles", id: "me" }), null, embedCache);
    assert.equal(res.item?.name, "Me Inc");
    assert.equal(res.schema, profileSchema);
  });
  it("returns null item when the target collection is not cached", () => {
    assert.deepEqual(resolveEmbed(field("embed", { to: "missing", id: "me" }), null, embedCache), { schema: null, item: null });
  });
});

describe("formatEmbedValue", () => {
  it("currency-formats a money field", () => {
    assert.ok(formatEmbedValue(field("money", { currency: "USD" }), 9, null, "en-US").includes("9"));
  });
  it("detailText for a non-money field, em-dash for empty", () => {
    assert.equal(formatEmbedValue(field("text"), "hi", null, "en-US"), "hi");
    assert.equal(formatEmbedValue(field("text"), "", null, "en-US"), "—");
  });
});

describe("buildEmbedViews", () => {
  it("resolves a per-record idField embed to the row-specific target", () => {
    const schema = makeSchema({ billTo: field("embed", { to: "profiles", idField: "customerId", label: "Bill To" }) });
    const views = buildEmbedViews(schema, embedCache, { customerId: "you" }, "en-US");
    const { billTo } = views;
    assert.ok(billTo);
    assert.equal(billTo.found, true);
    assert.equal(billTo.recordId, "you");
    assert.equal(billTo.targetSlug, "profiles");
    assert.equal(billTo.rows.find((row) => row.key === "name")?.display, "You LLC");
    assert.ok(billTo.rows.find((row) => row.key === "fee")?.display.includes("200"));
  });

  it("resolves a fixed-id embed and skips empty sub-fields", () => {
    const schema = makeSchema({ from: field("embed", { to: "profiles", id: "me" }) });
    const cacheWithBlank: EmbedCache = { profiles: { schema: profileSchema, items: [{ id: "me", name: "Me Inc", fee: "" }] } };
    const views = buildEmbedViews(schema, cacheWithBlank, null, "en-US");
    const { from } = views;
    assert.ok(from);
    assert.equal(from.found, true);
    assert.equal(
      from.rows.some((row) => row.key === "fee"),
      false,
    );
    assert.equal(
      from.rows.some((row) => row.key === "name"),
      true,
    );
  });

  it("marks found=false when the idField points at a missing record", () => {
    const schema = makeSchema({ billTo: field("embed", { to: "profiles", idField: "customerId" }) });
    const views = buildEmbedViews(schema, embedCache, { customerId: "ghost" }, "en-US");
    const { billTo } = views;
    assert.ok(billTo);
    assert.equal(billTo.found, false);
    assert.deepEqual(billTo.rows, []);
    assert.equal(billTo.recordId, "ghost");
  });

  it("returns an empty object when the schema is null (no collection loaded)", () => {
    assert.deepEqual(buildEmbedViews(null, embedCache, null, "en-US"), {});
  });

  it("ignores non-embed fields", () => {
    const schema = makeSchema({ title: field("text"), amount: field("money") });
    assert.deepEqual(buildEmbedViews(schema, embedCache, null, "en-US"), {});
  });
});

describe("renderSubCell", () => {
  const refCache: RefCache = { people: { a: "Alice" } };
  it("currency-formats a money sub-field", () => {
    assert.ok(renderSubCell(field("money", { currency: "USD" }), 5, null, refCache, "en-US").includes("5"));
  });
  it("resolves a ref sub-field to its display label", () => {
    assert.equal(renderSubCell(field("ref", { to: "people" }), "a", null, refCache, "en-US"), "Alice");
  });
  it("falls through to formatCell for an empty ref value", () => {
    assert.equal(renderSubCell(field("ref", { to: "people" }), "", null, refCache, "en-US"), "—");
  });
  it("passes other types through formatCell", () => {
    assert.equal(renderSubCell(field("text"), "hi", null, refCache, "en-US"), "hi");
  });
});

describe("evaluateDerived", () => {
  const schema = makeSchema({
    id: field("text"),
    qty: field("number"),
    price: field("number"),
    total: field("derived", { formula: "qty * price" }),
  });
  it("evaluates a derived formula against the item", () => {
    assert.equal(evaluateDerived(specOf(schema, "total"), "total", { qty: 3, price: 4 }, schema, {}), 12);
  });
  it("returns null for a field without a formula", () => {
    assert.equal(evaluateDerived(field("number"), "qty", { qty: 3 }, schema, {}), null);
  });
  it("returns null when the schema is null", () => {
    assert.equal(evaluateDerived(specOf(schema, "total"), "total", {}, null, {}), null);
  });
  it("returns null when the computed result is non-numeric", () => {
    const stringSchema = makeSchema({ id: field("text"), note: field("text"), d: field("derived", { formula: "note" }) });
    assert.equal(evaluateDerived(specOf(stringSchema, "d"), "d", { note: "hello" }, stringSchema, {}), null);
  });
});

describe("renderDerived", () => {
  it("renders an em-dash for null / undefined", () => {
    assert.equal(renderDerived(field("derived"), null, null, "en-US"), "—");
    assert.equal(renderDerived(field("derived"), undefined, null, "en-US"), "—");
  });
  it("currency-formats a money display", () => {
    assert.ok(renderDerived(field("derived", { display: "money", currency: "USD" }), 1234.5, {}, "en-US").includes("1,234.50"));
  });
  it("formats via the display type, defaulting to number", () => {
    assert.equal(renderDerived(field("derived", { display: "number" }), 42, null, "en-US"), "42");
    assert.equal(renderDerived(field("derived"), 7, null, "en-US"), "7");
  });
});
