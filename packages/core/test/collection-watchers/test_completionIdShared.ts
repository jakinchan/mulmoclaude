// The completion-bell id is a DISK FORMAT: both apps read one
// `<ws>/data/notifier/active.json`, so every form it has ever had must keep
// parsing, forever. This pins the three forms after shared collections were
// added — the two that already existed byte-for-byte, and the new one.
import { test } from "node:test";
import assert from "node:assert/strict";

import { completionLegacyId, parseCompletionLegacyId } from "../../src/collection-watchers/reconciler.ts";

test("with no root the id is the pre-multi-root format, byte for byte", () => {
  // A single-workspace host's existing entries must keep matching, or every
  // pending record bells a second time.
  assert.equal(completionLegacyId("tasks", "t1"), "collection-completion:tasks:t1");
});

test("a root is included only when one was supplied", () => {
  assert.equal(completionLegacyId("tasks", "t1", "/work/proj"), "collection-completion:@/work/proj\u0000tasks:t1");
  // Canonicalised here as well as at the watcher's claim: `/proj/` reaching
  // reconcileItem directly would otherwise publish a second, uncleardable bell.
  assert.equal(completionLegacyId("tasks", "t1", "/work/proj/"), completionLegacyId("tasks", "t1", "/work/proj"));
});

test("a shared collection gets a mark of its own, not the rootless form", () => {
  // A shared `cid` may well be a slug some project already owns. Reusing the
  // rootless form would dedupe the two into one bell.
  const shared = completionLegacyId("tasks", "t1", undefined, "salon");
  assert.equal(shared, "collection-completion:#salon\u0000tasks:t1");
  assert.notEqual(shared, completionLegacyId("tasks", "t1"));
  assert.notEqual(shared, completionLegacyId("tasks", "t1", "/work/proj"));
});

test("two apps owning the same cid hold two bells", () => {
  assert.notEqual(completionLegacyId("bookings", "b1", undefined, "salon"), completionLegacyId("bookings", "b1", undefined, "clinic"));
});

test("an id cannot carry both a root and an app", () => {
  // Preferring one silently would put a LOCAL bell in the shared namespace,
  // where every root's sweep skips it and nobody can ever clear it.
  assert.throws(() => completionLegacyId("tasks", "t1", "/work/proj", "salon"), /both a root/);
});

test("all three forms parse", () => {
  assert.deepEqual(parseCompletionLegacyId("collection-completion:tasks:t1"), { slug: "tasks", itemId: "t1" });
  assert.deepEqual(parseCompletionLegacyId("collection-completion:@/work/proj\u0000tasks:t1"), { root: "/work/proj", slug: "tasks", itemId: "t1" });
  assert.deepEqual(parseCompletionLegacyId("collection-completion:#salon\u0000tasks:t1"), { aid: "salon", slug: "tasks", itemId: "t1" });
});

test("an itemId containing a colon survives the round trip", () => {
  const parsed = parseCompletionLegacyId(completionLegacyId("tasks", "2026-08-10T10:00", undefined, "salon"));
  assert.deepEqual(parsed, { aid: "salon", slug: "tasks", itemId: "2026-08-10T10:00" });
});

test("a rooted id read back from disk is canonicalised on the way out too", () => {
  // The sweep compares the parsed root against a canonical one. An entry
  // written by hand or by an older build with a trailing separator would
  // otherwise never match: the verdict would be "another root's, skip" and
  // nobody could ever clear that bell.
  assert.deepEqual(parseCompletionLegacyId("collection-completion:@/work/proj/\u0000tasks:t1"), { root: "/work/proj", slug: "tasks", itemId: "t1" });
});

test("a string from somewhere else parses to null", () => {
  for (const bad of ["", "tasks:t1", "collection-completion:notrailing", "collection-completion:@no-sep-tasks:t1"]) {
    assert.equal(parseCompletionLegacyId(bad), null, bad);
  }
});
