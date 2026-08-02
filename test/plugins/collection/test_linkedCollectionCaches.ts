// Unit tests for the linked-collection cache layer
// (packages/plugins/collection-plugin/src/vue/useLinkedCollectionCaches.ts).
// The composable's fan-out fetch is factored into the pure, injectable
// `fetchLinkedCaches` (+ `linkedTargets`) so the two highest-risk behaviors —
// best-effort target isolation and the stale-write guard — are pinned directly
// with stubs, no vue reactivity or host binding required.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type {
  CollectionDetail,
  CollectionDetailResponse,
  CollectionItem,
  CollectionSchema,
  CollectionFieldSpec as FieldSpec,
  CollectionFieldType as FieldType,
} from "@mulmoclaude/core/collection";
import type { CollectionApiResult } from "../../../packages/plugins/collection-plugin/src/vue/uiContext";
import { fetchLinkedCaches, linkedTargets } from "../../../packages/plugins/collection-plugin/src/vue/useLinkedCollectionCaches";

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

const makeDetail = (slug: string, schema: CollectionSchema, items: CollectionItem[]): CollectionDetailResponse => {
  const collection: CollectionDetail = { slug, title: slug, icon: "list", source: "user", schema };
  return { collection, items };
};

const ok = (data: CollectionDetailResponse): CollectionApiResult<CollectionDetailResponse> => ({ ok: true, data });
const fail = (): CollectionApiResult<CollectionDetailResponse> => ({ ok: false, error: "boom", status: 500 });

const nameSchema = makeSchema({ id: field("text"), name: field("text") });
const peopleDetail = (): CollectionDetailResponse =>
  makeDetail("people", nameSchema, [
    { id: "a", name: "Alice" },
    { id: "b", name: "Bob" },
  ]);
const profilesDetail = (): CollectionDetailResponse => makeDetail("profiles", nameSchema, [{ id: "me", name: "Me Inc" }]);

const refAndEmbedSchema = makeSchema({
  author: field("ref", { to: "people" }),
  billFrom: field("embed", { to: "profiles", id: "me" }),
});

describe("linkedTargets", () => {
  it("unions ref + embed targets and de-duplicates a target that is both", () => {
    const schema = makeSchema({
      author: field("ref", { to: "people" }),
      billFrom: field("embed", { to: "profiles", id: "me" }),
      self: field("embed", { to: "people", idField: "authorId" }),
    });
    const targets = linkedTargets(schema);
    assert.deepEqual([...targets.refTargets].sort(), ["people"]);
    assert.deepEqual([...targets.embedTargets].sort(), ["people", "profiles"]);
    assert.deepEqual([...targets.allTargets].sort(), ["people", "profiles"]);
  });
  it("returns empty sets for a schema with no linked fields", () => {
    const targets = linkedTargets(makeSchema({ note: field("text") }));
    assert.equal(targets.allTargets.length, 0);
    assert.equal(targets.refTargets.size, 0);
    assert.equal(targets.embedTargets.size, 0);
  });
});

describe("fetchLinkedCaches", () => {
  it("builds ref + record + embed caches from resolved targets", async () => {
    const fetchDetail = async (slug: string): Promise<CollectionApiResult<CollectionDetailResponse>> => {
      if (slug === "people") return ok(peopleDetail());
      if (slug === "profiles") return ok(profilesDetail());
      return fail();
    };
    const snap = await fetchLinkedCaches(linkedTargets(refAndEmbedSchema), fetchDetail, () => "cur", "cur");
    assert.ok(snap);
    assert.deepEqual(snap.refCache.people, { a: "Alice", b: "Bob" });
    const peopleRecords = snap.refRecordCache.people;
    assert.ok(peopleRecords);
    assert.deepEqual(Object.keys(peopleRecords).sort(), ["a", "b"]);
    // profiles is embed-only, so it lands in embedCache but never refCache.
    assert.equal(snap.refCache.profiles, undefined);
    assert.equal(snap.embedCache.profiles?.items.length, 1);
  });

  it("is best-effort: a target whose fetch REJECTS is skipped, others still load", async () => {
    const fetchDetail = async (slug: string): Promise<CollectionApiResult<CollectionDetailResponse>> => {
      if (slug === "people") return ok(peopleDetail());
      throw new Error("network down"); // profiles rejects
    };
    const snap = await fetchLinkedCaches(linkedTargets(refAndEmbedSchema), fetchDetail, () => "cur", "cur");
    assert.ok(snap); // the rejection did not abort the fan-out
    assert.deepEqual(snap.refCache.people, { a: "Alice", b: "Bob" });
    assert.equal(snap.embedCache.profiles, undefined);
  });

  it("skips a target that resolves { ok: false } without aborting others", async () => {
    const fetchDetail = async (slug: string): Promise<CollectionApiResult<CollectionDetailResponse>> => {
      if (slug === "people") return ok(peopleDetail());
      return fail(); // profiles: ok:false
    };
    const snap = await fetchLinkedCaches(linkedTargets(refAndEmbedSchema), fetchDetail, () => "cur", "cur");
    assert.ok(snap);
    assert.deepEqual(snap.refCache.people, { a: "Alice", b: "Bob" });
    assert.equal(snap.embedCache.profiles, undefined);
  });

  it("drops the write when the open collection differs at check time (stale-write guard)", async () => {
    const fetchDetail = async (): Promise<CollectionApiResult<CollectionDetailResponse>> => ok(peopleDetail());
    const snap = await fetchLinkedCaches(linkedTargets(refAndEmbedSchema), fetchDetail, () => "other", "expected");
    assert.equal(snap, null);
  });

  it("guards against a slug that changes DURING the fetch fan-out", async () => {
    let current = "expected";
    const fetchDetail = async (): Promise<CollectionApiResult<CollectionDetailResponse>> => {
      current = "newer"; // a quicker subsequent load moved on while we awaited
      return ok(peopleDetail());
    };
    const snap = await fetchLinkedCaches(linkedTargets(refAndEmbedSchema), fetchDetail, () => current, "expected");
    assert.equal(snap, null); // proves the guard reads currentSlug AFTER the await
  });

  it("populates both refCache and embedCache for a target that is ref'd AND embedded", async () => {
    const dualSchema = makeSchema({
      author: field("ref", { to: "people" }),
      self: field("embed", { to: "people", idField: "authorId" }),
    });
    const fetchDetail = async (slug: string): Promise<CollectionApiResult<CollectionDetailResponse>> => (slug === "people" ? ok(peopleDetail()) : fail());
    const snap = await fetchLinkedCaches(linkedTargets(dualSchema), fetchDetail, () => "s", "s");
    assert.ok(snap);
    assert.deepEqual(snap.refCache.people, { a: "Alice", b: "Bob" });
    assert.equal(snap.embedCache.people?.items.length, 2);
  });

  it("returns an empty snapshot for zero targets when not stale", async () => {
    const fetchDetail = async (): Promise<CollectionApiResult<CollectionDetailResponse>> => {
      throw new Error("fetch should not be called for a link-less schema");
    };
    const snap = await fetchLinkedCaches(linkedTargets(makeSchema({ note: field("text") })), fetchDetail, () => "s", "s");
    assert.deepEqual(snap, { refCache: {}, refRecordCache: {}, embedCache: {} });
  });
});
