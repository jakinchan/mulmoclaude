// A presented collection card names a slug; the host then re-resolves that slug
// through whatever binding is current when the card RENDERS. In a multi-root
// host that may be a different project than the one the card was made in, so a
// card built in project A can read project B's data. The payload therefore
// carries a host-opaque scope, and reconciliation keys on it.
//
// The other half is back-compat: with no scope, the payload and every
// reconciliation decision must be exactly what a single-workspace host already
// produces — including the ABSENCE of the property, which JSON serialization
// and deepEqual both notice.
import { test } from "node:test";
import assert from "node:assert/strict";

import { collectionCardKey, sameCollectionCard, executePresentCollection } from "../../src/collection/core/presentCollection.ts";

test("with no scope the card key is the slug, and two same-slug cards are one card", () => {
  assert.equal(collectionCardKey({ collectionSlug: "tasks" }), "tasks");
  assert.equal(sameCollectionCard({ collectionSlug: "tasks" }, { collectionSlug: "tasks" }), true);
  assert.equal(sameCollectionCard({ collectionSlug: "tasks" }, { collectionSlug: "notes" }), false);
});

test("two same-slug cards from different scopes do NOT collapse into one", () => {
  const inA = { collectionSlug: "tasks", scope: "proj-a" };
  const inB = { collectionSlug: "tasks", scope: "proj-b" };
  assert.equal(sameCollectionCard(inA, inB), false);
  assert.equal(sameCollectionCard(inA, { collectionSlug: "tasks", scope: "proj-a" }), true);
  // A scoped card is not the same card as an unscoped one either — "the host's
  // default root" is a scope of its own, not a wildcard.
  assert.equal(sameCollectionCard(inA, { collectionSlug: "tasks" }), false);
});

test("the executed payload omits scope entirely when none was injected", async () => {
  const result = await executePresentCollection({}, { collectionSlug: "tasks" });
  assert.deepEqual(result.data, { collectionSlug: "tasks" });
  assert.equal(JSON.stringify(result.data), '{"collectionSlug":"tasks"}');

  const withItem = await executePresentCollection({}, { collectionSlug: "tasks", itemId: "t1" });
  assert.deepEqual(withItem.data, { collectionSlug: "tasks", itemId: "t1" });
});

test("an injected scope rides through to the card payload", async () => {
  const result = await executePresentCollection({}, { collectionSlug: "tasks", itemId: "t1", scope: " proj-a " });
  assert.deepEqual(result.data, { collectionSlug: "tasks", itemId: "t1", scope: "proj-a" });
  // The LLM-visible copy carries it too, so a repeat call addresses the same
  // project rather than silently falling back to the selected one.
  assert.deepEqual(result.jsonData, result.data);
});

test("a blank scope is treated as absent, never as a distinct project", async () => {
  const result = await executePresentCollection({}, { collectionSlug: "tasks", scope: "   " });
  assert.deepEqual(result.data, { collectionSlug: "tasks" });
});
