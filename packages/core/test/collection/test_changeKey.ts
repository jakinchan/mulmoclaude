// A change payload names a collection, and a host fans live updates out on it.
// `collectionChangeKey` is the ONE place that decides what an absent field
// means, so no host has to: a payload with `aid` is a shared collection, one
// without is local, and a local payload with no `root` means the host's
// configured root — which is why a single-workspace host's payloads still say
// nothing about roots at all.
import { test } from "node:test";
import assert from "node:assert/strict";

import { collectionChangeKey, collectionChangePayload, sharedCollectionChangePayload } from "../../src/collection/server/host.ts";
import { collectionKeyId } from "../../src/collection/core/collectionKey.ts";

const HOST_ROOT = "/work/host";

test("a payload with no root resolves against the host's root", () => {
  const payload = collectionChangePayload({ slug: "tasks", ids: ["t1"], op: "upsert" }, undefined);
  assert.deepEqual(collectionChangeKey(payload, HOST_ROOT), { kind: "local", root: HOST_ROOT, slug: "tasks" });
});

test("a payload with an explicit root resolves against that one", () => {
  const payload = collectionChangePayload({ slug: "tasks" }, "/work/proj/");
  // Canonical on both sides: a direct write against `/work/proj/` and the
  // watcher's own publish for `/work/proj` must land on ONE channel.
  assert.deepEqual(collectionChangeKey(payload, HOST_ROOT), { kind: "local", root: "/work/proj", slug: "tasks" });
});

test("a shared payload carries the app, never a root", () => {
  const payload = sharedCollectionChangePayload({ slug: "bookings", ids: ["b1"], op: "upsert" }, "salon");
  assert.equal(Object.hasOwn(payload, "root"), false);
  assert.deepEqual(collectionChangeKey(payload, HOST_ROOT), { kind: "shared", aid: "salon", cid: "bookings" });
});

test("the fan-out cannot cross a project or an app", () => {
  // The failure this exists to prevent: two projects each owning `tasks`
  // refreshing each other's open views, and a shared `tasks` refreshing both.
  const projA = collectionChangeKey(collectionChangePayload({ slug: "tasks" }, "/work/a"), HOST_ROOT);
  const projB = collectionChangeKey(collectionChangePayload({ slug: "tasks" }, "/work/b"), HOST_ROOT);
  const shared = collectionChangeKey(sharedCollectionChangePayload({ slug: "tasks" }, "salon"), HOST_ROOT);
  const ids = new Set([projA, projB, shared].map(collectionKeyId));
  assert.equal(ids.size, 3);
});

test("a single-workspace host's payload shape is unchanged", () => {
  // deepEqual is deepSTRICTEqual: an own `aid: undefined` key would fail this,
  // which is the point — the field must not appear at all.
  assert.deepEqual(collectionChangePayload({ slug: "tasks", ids: ["t1"], op: "upsert" }, undefined), { slug: "tasks", ids: ["t1"], op: "upsert" });
});
