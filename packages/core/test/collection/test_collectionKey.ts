// `CollectionKey` — the identity a collection has as a VALUE.
//
// Two identities coexist: a collection in a directory is `(root, slug)`, and a
// shared one is `(aid, cid)`. The whole reason this is a discriminated union
// rather than a widened `(scope, name)` pair is that the two must never collide
// — a project owning `tasks` and a shared app owning `tasks` are two
// collections — and that a local collection's behaviour is unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  collectionKeyId,
  collectionKeyName,
  isLocalCollectionKey,
  isSharedCollectionKey,
  localCollectionKeyOf,
  parseCollectionKeyId,
  sameCollectionKey,
  sharedCollectionKey,
  type CollectionKey,
} from "../../src/collection/core/collectionKey.ts";

test("a local key and a shared key that share a name are different collections", () => {
  const local = localCollectionKeyOf("/work/proj", "tasks");
  const shared = sharedCollectionKey("salon", "tasks");
  assert.equal(collectionKeyName(local), collectionKeyName(shared));
  assert.equal(sameCollectionKey(local, shared), false);
  assert.notEqual(collectionKeyId(local), collectionKeyId(shared));
});

test("two roots owning the same slug are two collections", () => {
  // The failure the INVARIANT exists to prevent: keyed by slug alone, these
  // two share a cache entry, a channel and a bell.
  const one = localCollectionKeyOf("/work/a", "tasks");
  const other = localCollectionKeyOf("/work/b", "tasks");
  assert.equal(sameCollectionKey(one, other), false);
});

test("two apps owning the same cid are two collections", () => {
  const one = sharedCollectionKey("salon", "bookings");
  const other = sharedCollectionKey("clinic", "bookings");
  assert.equal(sameCollectionKey(one, other), false);
});

test("ids round-trip", () => {
  const keys: CollectionKey[] = [localCollectionKeyOf("/work/proj", "tasks"), sharedCollectionKey("salon", "bookings")];
  for (const key of keys) assert.deepEqual(parseCollectionKeyId(collectionKeyId(key)), key);
});

test("a name containing the separator cannot forge another key", () => {
  // The parts are NUL-separated because NUL cannot occur in a path, a slug, an
  // app id or a collection id. Anything that does contain one is not a key.
  assert.equal(parseCollectionKeyId("local\u0000/work\u0000a\u0000b"), null);
  assert.equal(parseCollectionKeyId("local\u0000/work"), null);
});

test("a string that did not come from collectionKeyId parses to null, not a throw", () => {
  // These are read back from disk and off the wire, where an unrecognised entry
  // is a thing to skip.
  for (const bad of ["", "tasks", "remote\u0000a\u0000b", "local\u0000\u0000slug", "local\u0000/work\u0000"]) {
    assert.equal(parseCollectionKeyId(bad), null, bad);
  }
});

test("a part carrying the separator is refused, not encoded wrongly", () => {
  // Without this, ("a\0b", "c") and ("a", "b\0c") encode to the SAME string:
  // two different collections compare equal and the id parses back to nothing.
  assert.throws(() => localCollectionKeyOf("a\u0000b", "c"), /NUL/);
  assert.throws(() => localCollectionKeyOf("a", "b\u0000c"), /NUL/);
  assert.throws(() => sharedCollectionKey("a\u0000b", "c"), /NUL/);
  assert.throws(() => sharedCollectionKey("a", "b\u0000c"), /NUL/);
});

test("an empty part is refused", () => {
  // It makes the id ambiguous about which part was missing.
  assert.throws(() => localCollectionKeyOf("", "tasks"), /empty/);
  assert.throws(() => localCollectionKeyOf("/work/proj", ""), /empty/);
  assert.throws(() => sharedCollectionKey("", "tasks"), /empty/);
  assert.throws(() => sharedCollectionKey("salon", ""), /empty/);
});

test("the guards narrow", () => {
  const local = localCollectionKeyOf("/work/proj", "tasks");
  const shared = sharedCollectionKey("salon", "bookings");
  assert.equal(isLocalCollectionKey(local) && local.root === "/work/proj", true);
  assert.equal(isSharedCollectionKey(shared) && shared.aid === "salon", true);
  assert.equal(isSharedCollectionKey(local), false);
  assert.equal(isLocalCollectionKey(shared), false);
});
