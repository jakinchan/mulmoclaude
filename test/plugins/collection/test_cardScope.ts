// A presented-collection card names the project it was MADE in
// (`PresentCollectionData.scope`, host-stamped). These pin the two halves of
// reading it back: the chat payload parser must not drop the field, and the
// view layer must resolve the card's binding through it — while a payload
// WITHOUT a scope, and a host with no projects at all, keep resolving to
// exactly the global binding they always did (MulmoClaude's only case).

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { collectionCardKey, type PresentCollectionData } from "@mulmoclaude/core/collection";
import { toPresentCollectionData } from "../../../packages/plugins/collection-plugin/src/vue/chat/presentCollectionData";
import { configureCollectionUi, type CollectionUi } from "../../../packages/plugins/collection-plugin/src/vue/uiContext";
import { resolveScopedCollectionUi, resetScopedCollectionUi } from "../../../packages/plugins/collection-plugin/src/vue/scopedUi";

// The contract is ~40 capabilities; a resolution test only needs identity, so
// each binding is a tagged stub cast to the full shape.
const binding = (tag: string, withScope?: (scope: string) => CollectionUi): CollectionUi =>
  ({ tag, ...(withScope ? { withScope } : {}) }) as unknown as CollectionUi;

const tagOf = (resolved: CollectionUi): string => (resolved as unknown as { tag: string }).tag;

/** Parse a payload that is expected to be valid — the card key path only runs
 *  once the slug has already been read out. */
const parsed = (value: unknown): PresentCollectionData => {
  const data = toPresentCollectionData(value);
  assert.ok(data, "payload should parse");
  return data;
};

beforeEach(() => {
  resetScopedCollectionUi();
});

describe("presentCollection card payload — scope", () => {
  it("carries the scope the host stamped", () => {
    assert.deepEqual(toPresentCollectionData({ collectionSlug: "tasks", scope: "proj-a" }), {
      collectionSlug: "tasks",
      itemId: undefined,
      scope: "proj-a",
    });
  });

  it("omits the key entirely with no scope — byte-identical to the single-workspace payload", () => {
    const data = toPresentCollectionData({ collectionSlug: "tasks" });
    assert.equal(data === null, false);
    assert.equal("scope" in (data as object), false, "no scope property at all, not an undefined one");
  });

  it("ignores a blank or non-string scope rather than scoping to nothing", () => {
    assert.equal("scope" in (toPresentCollectionData({ collectionSlug: "tasks", scope: "   " }) as object), false);
    assert.equal("scope" in (toPresentCollectionData({ collectionSlug: "tasks", scope: 7 }) as object), false);
  });
});

describe("resolveScopedCollectionUi", () => {
  it("resolves a scoped card through the host's withScope", () => {
    configureCollectionUi(binding("global", (scope) => binding(`scoped:${scope}`)));
    assert.equal(tagOf(resolveScopedCollectionUi("proj-a")), "scoped:proj-a");
    assert.equal(tagOf(resolveScopedCollectionUi("proj-b")), "scoped:proj-b");
  });

  it("returns the SAME binding for a scope twice, so a re-render doesn't rebuild it", () => {
    let built = 0;
    configureCollectionUi(
      binding("global", (scope) => {
        built += 1;
        return binding(`scoped:${scope}`);
      }),
    );
    const first = resolveScopedCollectionUi("proj-a");
    assert.equal(resolveScopedCollectionUi("proj-a"), first);
    assert.equal(built, 1);
  });

  it("returns the global binding when the card has no scope", () => {
    configureCollectionUi(binding("global", (scope) => binding(`scoped:${scope}`)));
    assert.equal(tagOf(resolveScopedCollectionUi(undefined)), "global");
  });

  it("returns the global binding on a host that doesn't do projects, even for a scoped card", () => {
    // MulmoClaude's shape: one root, no `withScope`. A scope it never stamps
    // must still resolve to the one binding rather than failing.
    configureCollectionUi(binding("global"));
    assert.equal(tagOf(resolveScopedCollectionUi("proj-a")), "global");
  });
});

describe("the mounted view's identity", () => {
  // The card keys `CollectionView` by this. Keyed on the slug alone, a card
  // switched to the same collection in ANOTHER project would keep the mounted
  // view — which reloads only when its slug changes — and show project A's
  // records while its writes resolved through project B's binding.
  it("separates two projects' same-slug cards", () => {
    const inA = parsed({ collectionSlug: "tasks", scope: "proj-a" });
    const inB = parsed({ collectionSlug: "tasks", scope: "proj-b" });
    assert.notEqual(collectionCardKey(inA), collectionCardKey(inB));
  });

  it("is the bare slug with no scope, so a single-workspace card remounts exactly when it used to", () => {
    assert.equal(collectionCardKey(parsed({ collectionSlug: "tasks", itemId: "t1" })), "tasks");
  });
});
