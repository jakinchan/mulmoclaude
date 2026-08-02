import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { useDirChildrenCache } from "../../src/composables/useDirChildrenCache.ts";
import type { TreeNode } from "../../src/types/fileTree.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function dirNode(path: string, children: TreeNode[]): TreeNode {
  return { name: path || "root", path, type: "dir", children };
}

function fileChild(name: string): TreeNode {
  return { name, path: name, type: "file" };
}

function pathOf(input: Parameters<typeof fetch>[0]): string {
  const raw = typeof input === "string" ? input : input.toString();
  return new URL(raw, "http://localhost").searchParams.get("path") ?? "";
}

interface PendingCall {
  path: string;
  resolve: (res: Response) => void;
}

// A fetch whose responses stay pending until the test resolves them by
// hand — lets us interleave loads and inspect the state in between.
function installControllableFetch(): PendingCall[] {
  const calls: PendingCall[] = [];
  globalThis.fetch = (input) =>
    new Promise<Response>((resolve) => {
      calls.push({ path: pathOf(input), resolve });
    });
  return calls;
}

describe("useDirChildrenCache", () => {
  it("a stale loadDirChildren resolving after a re-invalidation is ignored", async () => {
    const calls = installControllableFetch();
    const cache = useDirChildrenCache();

    const stale = cache.loadDirChildren("a");
    const fresh = cache.reloadDirChildren("a");
    const [staleCall, freshCall] = calls;
    assert.ok(staleCall);
    assert.ok(freshCall);

    staleCall.resolve(jsonResponse(200, dirNode("a", [fileChild("stale")])));
    await stale;
    assert.equal(cache.childrenByPath.value.get("a"), null);
    assert.equal(cache.treeError.value, null);

    freshCall.resolve(jsonResponse(200, dirNode("a", [fileChild("fresh")])));
    await fresh;
    assert.deepEqual(cache.childrenByPath.value.get("a"), [fileChild("fresh")]);
  });

  it("reloadRoot clears cache state, ignores in-flight loads, repopulates from the fresh request", async () => {
    const calls = installControllableFetch();
    const cache = useDirChildrenCache();

    const stale = cache.loadDirChildren("dirA");
    const reload = cache.reloadRoot();
    const [staleCall, reloadCall] = calls;
    assert.ok(staleCall);
    assert.ok(reloadCall);

    staleCall.resolve(jsonResponse(200, dirNode("dirA", [fileChild("old")])));
    await stale;
    assert.equal(cache.childrenByPath.value.has("dirA"), false);

    reloadCall.resolve(jsonResponse(200, dirNode("", [fileChild("root")])));
    await reload;
    assert.deepEqual(cache.childrenByPath.value.get(""), [fileChild("root")]);
    assert.equal(cache.rootNode.value?.path, "");
    assert.deepEqual(cache.rootNode.value?.children, []);
    assert.equal(cache.treeError.value, null);
  });

  it("a failed directory load rolls back only that folder and sets treeError", async () => {
    globalThis.fetch = async (input) => {
      const path = pathOf(input);
      if (path === "boom") return jsonResponse(500, { error: "nope" });
      return jsonResponse(200, dirNode(path, [fileChild(`${path}-child`)]));
    };
    const cache = useDirChildrenCache();

    await cache.loadDirChildren("keep");
    assert.deepEqual(cache.childrenByPath.value.get("keep"), [fileChild("keep-child")]);

    await cache.loadDirChildren("boom");
    assert.equal(cache.childrenByPath.value.has("boom"), false);
    assert.deepEqual(cache.childrenByPath.value.get("keep"), [fileChild("keep-child")]);
    assert.equal(cache.treeError.value, "nope");
  });

  it("loadDirChildren early-returns when the path is already cached", async () => {
    let fetchCount = 0;
    globalThis.fetch = async (input) => {
      fetchCount += 1;
      return jsonResponse(200, dirNode(pathOf(input), []));
    };
    const cache = useDirChildrenCache();

    await cache.loadDirChildren("a");
    await cache.loadDirChildren("a");
    assert.equal(fetchCount, 1);
  });
});
