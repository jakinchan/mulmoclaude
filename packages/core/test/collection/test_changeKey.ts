// A change payload names a collection, and a host fans live updates out on it.
// `collectionChangeKey` is the ONE place that decides what an absent field
// means, so no host has to: a payload with `aid` is a shared collection, one
// without is local, and a local payload with no `root` means the host's
// configured root — which is why a single-workspace host's payloads still say
// nothing about roots at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  collectionChangeKey,
  collectionChangePayload,
  sharedCollectionChangePayload,
  type LocalCollectionChange,
  type SharedCollectionChange,
} from "../../src/collection/server/host.ts";
import { collectionKeyId } from "../../src/collection/core/collectionKey.ts";
import { testRoot } from "../helpers/testRoot.ts";

// Platform-shaped, because `collectionChangeKey` canonicalises through
// `path.resolve` — a POSIX literal is not a fixed point of that on Windows.
const HOST_ROOT = testRoot("work", "host");
const PROJ = testRoot("work", "proj");

test("a payload with no root resolves against the host's root", () => {
  const payload = collectionChangePayload({ slug: "tasks", ids: ["t1"], op: "upsert" }, undefined);
  assert.deepEqual(collectionChangeKey(payload, HOST_ROOT), { kind: "local", root: HOST_ROOT, slug: "tasks" });
});

test("a payload with an explicit root resolves against that one", () => {
  const payload = collectionChangePayload({ slug: "tasks" }, `${PROJ}${path.sep}`);
  // Canonical on both sides: a direct write against a root with a trailing
  // separator and the watcher's own publish without one must land on ONE channel.
  assert.deepEqual(collectionChangeKey(payload, HOST_ROOT), { kind: "local", root: PROJ, slug: "tasks" });
});

test("a shared payload carries the app, never a root", () => {
  const payload = sharedCollectionChangePayload({ slug: "bookings", ids: ["b1"], op: "upsert" }, "salon");
  assert.equal(Object.hasOwn(payload, "root"), false);
  assert.deepEqual(collectionChangeKey(payload, HOST_ROOT), { kind: "shared", aid: "salon", cid: "bookings" });
});

test("the fan-out cannot cross a project or an app", () => {
  // The failure this exists to prevent: two projects each owning `tasks`
  // refreshing each other's open views, and a shared `tasks` refreshing both.
  const projA = collectionChangeKey(collectionChangePayload({ slug: "tasks" }, testRoot("work", "a")), HOST_ROOT);
  const projB = collectionChangeKey(collectionChangePayload({ slug: "tasks" }, testRoot("work", "b")), HOST_ROOT);
  const shared = collectionChangeKey(sharedCollectionChangePayload({ slug: "tasks" }, "salon"), HOST_ROOT);
  const ids = new Set([projA, projB, shared].map(collectionKeyId));
  assert.equal(ids.size, 3);
});

test("a payload cannot carry both a root and an app", () => {
  // Compile-time, because that is where it has to be stopped: a payload with
  // both would be read as SHARED by collectionChangeKey, which drops the root
  // and fans the update out on the wrong channel. @ts-expect-error fails the
  // typecheck if the two arms ever stop being mutually exclusive.
  // @ts-expect-error - aid is never on a local change
  const bothLocal: LocalCollectionChange = { slug: "tasks", root: "/work/a", aid: "salon" };
  // @ts-expect-error - root is never on a shared change
  const bothShared: SharedCollectionChange = { slug: "tasks", aid: "salon", root: "/work/a" };
  assert.equal(bothLocal.slug, bothShared.slug);
  // And if one reaches the decision point anyway -- a JS caller, a cast,
  // something off a wire -- it throws rather than being guessed into one
  // channel or the other, because a misrouted fan-out is invisible.
  // @ts-expect-error - the base of a local payload has no aid
  const built = collectionChangePayload({ slug: "tasks", aid: "salon" }, testRoot("work", "a"));
  assert.throws(() => collectionChangeKey(built, HOST_ROOT), /both an app/);
});

test("a shared payload refuses a name no channel could encode", () => {
  // Loud here rather than swallowed later: the host's publisher catches so that
  // a failed publish cannot crash the write, which would turn this into "live
  // updates quietly stopped".
  assert.throws(() => sharedCollectionChangePayload({ slug: "sales:2026" }, "salon"), /not a valid collection name/);
  assert.throws(() => sharedCollectionChangePayload({ slug: "tasks" }, "sa/lon"), /not a valid collection name/);
});

test("a single-workspace host's payload shape is unchanged", () => {
  // deepEqual is deepSTRICTEqual: an own `aid: undefined` key would fail this,
  // which is the point — the field must not appear at all.
  assert.deepEqual(collectionChangePayload({ slug: "tasks", ids: ["t1"], op: "upsert" }, undefined), { slug: "tasks", ids: ["t1"], op: "upsert" });
});
