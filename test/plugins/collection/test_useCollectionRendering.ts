// Integration tests for the composition layer
// (packages/plugins/collection-plugin/src/vue/useCollectionRendering.ts).
// Imports the composable via the source path (not the package export) so it
// exercises THIS worktree's wiring: the spread of the cache composable + the
// stateless formatters + the thin renderer closures. Locks the returned shape
// (byte-for-byte member set) and the closure-over-refs behavior the consumers
// depend on.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ref } from "vue";

import { deriveAll } from "@mulmoclaude/core/collection";
import type { CollectionDetail, CollectionSchema, CollectionFieldSpec as FieldSpec, CollectionFieldType as FieldType } from "@mulmoclaude/core/collection";
import { useCollectionRendering } from "../../../packages/plugins/collection-plugin/src/vue/useCollectionRendering";

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

const profileSchema = makeSchema({ id: field("text"), name: field("text") });
const orderSchema = makeSchema({
  id: field("text"),
  qty: field("number"),
  price: field("number"),
  total: field("derived", { formula: "qty * price" }),
  billTo: field("embed", { to: "profiles", idField: "customerId" }),
});
const orderDetail: CollectionDetail = { slug: "orders", title: "Orders", icon: "list", source: "user", schema: orderSchema };

const EXPECTED_MEMBERS = [
  "refCache",
  "refRecordCache",
  "embedCache",
  "resetLinkedCaches",
  "loadLinkedCollections",
  "refDisplay",
  "refOptions",
  "embedOptions",
  "embedViewsFor",
  "backlinksViewsFor",
  "rollupDisplay",
  "deriveRecord",
  "resolveCurrency",
  "currencySymbol",
  "formatMoney",
  "formatCell",
  "detailText",
  "isExternalUrl",
  "artifactUrl",
  "fileRoutePath",
  "tableRows",
  "hasTableRows",
  "formatSubCell",
  "inputTypeFor",
  // A `datetime` whose value the SERVER stamped must not be offered for editing: the
  // `datetime-local` control cannot hold that string, so it renders empty and saving writes the
  // empty value over a field the rules refuse to see move.
  "isServerStamped",
  "stepFor",
  "deriveAll",
  "evaluateDerivedAgainstItem",
  "derivedDisplay",
];

describe("useCollectionRendering (composition)", () => {
  it("returns exactly the CollectionRendering member set — no more, no less", () => {
    const render = useCollectionRendering(ref<CollectionDetail | null>(orderDetail), ref("en-US"));
    for (const key of EXPECTED_MEMBERS) assert.ok(key in render, `missing member: ${key}`);
    assert.deepEqual(Object.keys(render).sort(), [...EXPECTED_MEMBERS].sort());
    // The re-exposed pure helpers are the SAME references (structural passthrough).
    assert.equal(render.deriveAll, deriveAll);
  });

  it("evaluateDerivedAgainstItem reads the live refRecordCache mutated on the returned object", () => {
    const render = useCollectionRendering(ref<CollectionDetail | null>(orderDetail), ref("en-US"));
    render.refRecordCache.value = {}; // qty * price needs no ref records
    const totalSpec = orderSchema.fields.total;
    assert.ok(totalSpec);
    assert.equal(render.evaluateDerivedAgainstItem(totalSpec, "total", { qty: 3, price: 5 }), 15);
  });

  it("embedViewsFor resolves a per-record idField embed from the live embedCache", () => {
    const render = useCollectionRendering(ref<CollectionDetail | null>(orderDetail), ref("en-US"));
    render.embedCache.value = { profiles: { schema: profileSchema, items: [{ id: "you", name: "You LLC" }] } };
    const views = render.embedViewsFor({ customerId: "you" });
    const { billTo } = views;
    assert.ok(billTo);
    assert.equal(billTo.found, true);
    assert.equal(billTo.recordId, "you");
    assert.equal(billTo.rows.find((row) => row.key === "name")?.display, "You LLC");
  });

  it("resetLinkedCaches clears all three caches", () => {
    const render = useCollectionRendering(ref<CollectionDetail | null>(orderDetail), ref("en-US"));
    render.refCache.value = { profiles: { you: "You LLC" } };
    render.refRecordCache.value = { profiles: { you: { id: "you" } } };
    render.embedCache.value = { profiles: { schema: profileSchema, items: [] } };
    render.resetLinkedCaches();
    assert.deepEqual(render.refCache.value, {});
    assert.deepEqual(render.refRecordCache.value, {});
    assert.deepEqual(render.embedCache.value, {});
  });

  it("stepFor / currencySymbol thread through the locale-bound formatters", () => {
    const render = useCollectionRendering(ref<CollectionDetail | null>(orderDetail), ref("en-US"));
    assert.equal(render.stepFor("money"), "0.01");
    assert.equal(render.currencySymbol("USD"), "$");
  });
});
