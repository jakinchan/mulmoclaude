import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  fetchRegistryIndex,
  resetRegistryCache,
  CACHE_TTL_MS,
  STALE_RETRY_BACKOFF_MS,
  type FetchIndexResult,
  type RegistryDescriptor,
} from "../../src/collection/registry/server/client.ts";
import type { RegistryIndex } from "../../src/collection/registry/registryIndex.ts";

const okIndex: RegistryIndex = { schemaVersion: 1, generatedAt: "t", registry: "r", collections: [] };
const okResult: FetchIndexResult = { ok: true, index: okIndex, stale: false };
const failResult: FetchIndexResult = { ok: false, status: 503, error: "down" };

const officialDescriptor: RegistryDescriptor = {
  name: "official",
  indexUrl: "https://example.test/official/index.json",
  rawBaseUrl: "https://example.test/official-raw",
};

const customDescriptor: RegistryDescriptor = {
  name: "myorg",
  indexUrl: "https://example.test/myorg/index.json",
  rawBaseUrl: "https://example.test/myorg-raw",
};

function makeLoader(results: FetchIndexResult[]) {
  let index = 0;
  let calls = 0;
  const load = (): Promise<FetchIndexResult> => {
    calls += 1;
    const result = results[Math.min(index++, results.length - 1)];
    if (!result) throw new Error("makeLoader requires a non-empty result list");
    return Promise.resolve(result);
  };
  return { load, calls: () => calls };
}

describe("fetchRegistryIndex caching + backoff", () => {
  beforeEach(() => resetRegistryCache());

  it("serves from cache within the TTL without re-loading", async () => {
    const loader = makeLoader([okResult]);
    const first = await fetchRegistryIndex(officialDescriptor, { nowMs: 0, loader: loader.load });
    assert.ok(first.ok && !first.stale);
    const second = await fetchRegistryIndex(officialDescriptor, { nowMs: 1000, loader: loader.load });
    assert.ok(second.ok && !second.stale);
    assert.equal(loader.calls(), 1);
  });

  it("errors when the load fails and no cache exists", async () => {
    const loader = makeLoader([failResult]);
    const result = await fetchRegistryIndex(officialDescriptor, { nowMs: 0, loader: loader.load });
    assert.equal(result.ok, false);
  });

  it("throttles network retries during an outage, serving stale in between", async () => {
    const loader = makeLoader([okResult, failResult, failResult, failResult]);
    await fetchRegistryIndex(officialDescriptor, { nowMs: 0, loader: loader.load }); // seed cache (call 1)

    const stale1 = await fetchRegistryIndex(officialDescriptor, { nowMs: CACHE_TTL_MS + 1, loader: loader.load });
    assert.ok(stale1.ok && stale1.stale, "past TTL + failing upstream → stale");
    assert.equal(loader.calls(), 2, "network attempted once on first stale serve");

    const stale2 = await fetchRegistryIndex(officialDescriptor, { nowMs: CACHE_TTL_MS + 1000, loader: loader.load });
    assert.ok(stale2.ok && stale2.stale);
    assert.equal(loader.calls(), 2, "within backoff → no network attempt");

    const stale3 = await fetchRegistryIndex(officialDescriptor, { nowMs: CACHE_TTL_MS + 1 + STALE_RETRY_BACKOFF_MS, loader: loader.load });
    assert.ok(stale3.ok && stale3.stale);
    assert.equal(loader.calls(), 3, "after backoff window → network retried");
  });

  it("clears the backoff after a successful reload", async () => {
    const loader = makeLoader([okResult, failResult, okResult]);
    await fetchRegistryIndex(officialDescriptor, { nowMs: 0, loader: loader.load }); // cache (1)
    await fetchRegistryIndex(officialDescriptor, { nowMs: CACHE_TTL_MS + 1, loader: loader.load }); // fail → stale + backoff (2)
    const recovered = await fetchRegistryIndex(officialDescriptor, { nowMs: CACHE_TTL_MS + 1 + STALE_RETRY_BACKOFF_MS, loader: loader.load }); // ok (3)
    assert.ok(recovered.ok && !recovered.stale);
    const cached = await fetchRegistryIndex(officialDescriptor, { nowMs: CACHE_TTL_MS + 2 + STALE_RETRY_BACKOFF_MS, loader: loader.load });
    assert.ok(cached.ok && !cached.stale);
    assert.equal(loader.calls(), 3, "fresh cache hit, no extra load");
  });

  it("caches per-registry — a failing custom registry doesn't poison the official cache", async () => {
    // The whole point of multi-registry support: if myorg goes down, the official
    // registry keeps serving fresh data without inheriting myorg's failure backoff.
    const officialLoader = makeLoader([okResult]);
    const customLoader = makeLoader([failResult]);
    const official = await fetchRegistryIndex(officialDescriptor, { nowMs: 0, loader: officialLoader.load });
    assert.ok(official.ok && !official.stale);
    const custom = await fetchRegistryIndex(customDescriptor, { nowMs: 0, loader: customLoader.load });
    assert.equal(custom.ok, false, "custom registry's failure is local to its cache slot");

    // Official remains served from cache, untouched.
    const officialAgain = await fetchRegistryIndex(officialDescriptor, { nowMs: 1000, loader: officialLoader.load });
    assert.ok(officialAgain.ok && !officialAgain.stale);
    assert.equal(officialLoader.calls(), 1);
  });

  it("invalidates the cache when the registry's URL changes under the same name", async () => {
    // CodeRabbit review on #1837: if the user edits `indexUrl` (or rawBase) in
    // config but keeps the same `name`, the cache must not keep serving the old
    // upstream's entries — otherwise the catalog (cached) and import/preview
    // (resolves rawBase from current config) drift.
    const loader = makeLoader([
      { ok: true, index: { ...okIndex, generatedAt: "v1" }, stale: false },
      { ok: true, index: { ...okIndex, generatedAt: "v2" }, stale: false },
    ]);
    const first = await fetchRegistryIndex(customDescriptor, { nowMs: 0, loader: loader.load });
    assert.ok(first.ok && first.index.generatedAt === "v1");
    // Re-fetch with the same name but a new indexUrl → MUST hit the network again.
    const renamed: RegistryDescriptor = { ...customDescriptor, indexUrl: "https://example.test/myorg-v2/index.json" };
    const second = await fetchRegistryIndex(renamed, { nowMs: 1000, loader: loader.load });
    assert.ok(second.ok && second.index.generatedAt === "v2", "new URL ⇒ fresh fetch, not stale cache");
    assert.equal(loader.calls(), 2);
  });
});
