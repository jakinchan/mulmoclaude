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

import { collectionCardKey, sameCollectionCard, executePresentCollection, withCardScope } from "../../src/collection/core/presentCollection.ts";

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

test("a scope in the TOOL ARGS is dropped — the model does not get to pick the project", async () => {
  // Tool args are a model-controlled channel. A model that could name the scope
  // could name another project's, and the card — plus any token minted for it —
  // would address a project the user never opened in this conversation.
  const result = await executePresentCollection({}, { collectionSlug: "tasks", itemId: "t1", scope: "proj-b" });
  assert.deepEqual(result.data, { collectionSlug: "tasks", itemId: "t1" });
  assert.deepEqual(result.jsonData, result.data);
});

test("the host stamps the scope afterwards, and only then", async () => {
  const result = await executePresentCollection({}, { collectionSlug: "tasks", itemId: "t1" });
  const scoped = withCardScope(result.data as never, " proj-a ");
  assert.deepEqual(scoped, { collectionSlug: "tasks", itemId: "t1", scope: "proj-a" });
});

test("a blank or absent scope leaves the payload without the property at all", async () => {
  const base = { collectionSlug: "tasks" };
  assert.deepEqual(withCardScope(base, undefined), base);
  assert.deepEqual(withCardScope(base, "   "), base);
  assert.equal(JSON.stringify(withCardScope(base, undefined)), '{"collectionSlug":"tasks"}');
});
