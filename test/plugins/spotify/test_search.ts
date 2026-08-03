// Unit tests for the search dispatch handler. Verifies URL
// construction (categories, limit, query encoding) + correct
// per-category normalisation. Mocks `runtime.fetch`; no live
// Spotify API calls.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { searchSpotify } from "../../../packages/plugins/spotify-plugin/src/search.js";
import type { SpotifyTokens } from "../../../packages/plugins/spotify-plugin/src/types.js";

const NOW = () => new Date("2026-05-05T00:00:00.000Z");
const validTokens: SpotifyTokens = {
  accessToken: "at-current",
  refreshToken: "rt-current",
  expiresAt: "2026-05-05T05:00:00.000Z",
  scopes: ["user-library-read"],
};

interface CallRecord {
  url: string;
}

function makeFakeRuntime(responses: Response[]) {
  const calls: CallRecord[] = [];
  const queue = [...responses];
  return {
    runtime: {
      fetch: async (url: string) => {
        calls.push({ url });
        const next = queue.shift();
        if (!next) throw new Error(`fetch over-called (call ${calls.length})`);
        return next;
      },
      files: {
        config: {
          exists: async () => false,
          read: async () => "",
          readBytes: async () => new Uint8Array(),
          write: async () => {},
          readDir: async () => [],
          stat: async () => ({ mtimeMs: 0, size: 0 }),
          unlink: async () => {},
        },
        data: {
          exists: async () => false,
          read: async () => "",
          readBytes: async () => new Uint8Array(),
          write: async () => {},
          readDir: async () => [],
          stat: async () => ({ mtimeMs: 0, size: 0 }),
          unlink: async () => {},
        },
      },
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      pubsub: { publish: () => {} },
      locale: "en",
      fetchJson: async () => {
        throw new Error("not used");
      },
    },
    calls,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function onlyCall(calls: CallRecord[]): CallRecord {
  const [call] = calls;
  assert.ok(call, "expected runtime.fetch to have been called");
  return call;
}

describe("searchSpotify — URL construction", () => {
  it("includes all four types when `types` is undefined (default)", async () => {
    const handle = makeFakeRuntime([jsonResponse({})]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await searchSpotify({ runtime: handle.runtime as any, clientId: "cid", tokens: validTokens, now: NOW }, "Bach", undefined, undefined);
    assert.match(onlyCall(handle.calls).url, /type=track,artist,album,playlist/);
    assert.match(onlyCall(handle.calls).url, /q=Bach/);
    assert.match(onlyCall(handle.calls).url, /limit=10/);
  });

  it("respects an explicit `types` array", async () => {
    const handle = makeFakeRuntime([jsonResponse({})]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await searchSpotify({ runtime: handle.runtime as any, clientId: "cid", tokens: validTokens, now: NOW }, "test", ["artist"], 5);
    assert.match(onlyCall(handle.calls).url, /type=artist(?!,)/);
    assert.match(onlyCall(handle.calls).url, /limit=5/);
  });

  it("URL-encodes a query with spaces / special characters", async () => {
    const handle = makeFakeRuntime([jsonResponse({})]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await searchSpotify({ runtime: handle.runtime as any, clientId: "cid", tokens: validTokens, now: NOW }, "Daft Punk & friends", undefined, undefined);
    // URLSearchParams encodes space as `+`
    assert.match(onlyCall(handle.calls).url, /q=Daft\+Punk\+%26\+friends/);
  });
});

describe("searchSpotify — response normalisation", () => {
  it("normalises tracks under `tracks.items[]` and ONLY the requested categories", async () => {
    const handle = makeFakeRuntime([
      jsonResponse({
        tracks: { items: [{ id: "t1", name: "Track One", artists: [{ name: "Artist" }], album: { name: "Album" } }] },
        artists: { items: [{ id: "a1", name: "Should Not Appear" }] }, // not requested
      }),
    ]);
    const result = await searchSpotify(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { runtime: handle.runtime as any, clientId: "cid", tokens: validTokens, now: NOW },
      "test",
      ["track"],
      undefined,
    );
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    const { tracks } = result.data;
    assert.ok(tracks);
    assert.equal(tracks.length, 1);
    const [firstTrack] = tracks;
    assert.ok(firstTrack);
    assert.equal(firstTrack.name, "Track One");
    // Artists key must be absent because the caller didn't request it.
    assert.equal("artists" in result.data, false);
  });

  it("returns empty arrays for requested categories that returned zero items", async () => {
    const handle = makeFakeRuntime([jsonResponse({ tracks: { items: [] }, artists: { items: [] } })]);
    const result = await searchSpotify(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { runtime: handle.runtime as any, clientId: "cid", tokens: validTokens, now: NOW },
      "no hits",
      ["track", "artist"],
      undefined,
    );
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.deepEqual(result.data.tracks, []);
    assert.deepEqual(result.data.artists, []);
  });

  it("forwards client errors unchanged (mirrors fetchLiked)", async () => {
    const handle = makeFakeRuntime([new Response("server err", { status: 500 })]);
    const result = await searchSpotify(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { runtime: handle.runtime as any, clientId: "cid", tokens: validTokens, now: NOW },
      "anything",
      undefined,
      undefined,
    );
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.error.kind, "spotify_api_error");
  });
});
