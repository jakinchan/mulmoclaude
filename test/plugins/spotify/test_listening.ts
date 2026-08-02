// Unit tests for the listening-data handlers. Verify that each
// kind hits the right Spotify endpoint and that the response is
// normalised into the View-friendly shape. The fake runtime mirrors
// the `FileOps` shape from gui-chat-protocol and stages canned
// responses for `runtime.fetch`.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { fetchLiked, fetchNowPlaying, fetchPlaylistTracks, fetchPlaylists, fetchRecent } from "../../../packages/plugins/spotify-plugin/src/listening.js";
import type { SpotifyTokens } from "../../../packages/plugins/spotify-plugin/src/types.js";

// Pinned clock + an `expiresAt` well past it so the proactive-refresh
// path never fires during these tests (which only stage one fetch per
// call). A real plugin runtime obviously uses real time.
const NOW = () => new Date("2026-05-05T00:00:00.000Z");
const FUTURE_FAR = "2026-05-05T05:00:00.000Z";

const validTokens: SpotifyTokens = {
  accessToken: "at-current",
  refreshToken: "rt-current",
  expiresAt: FUTURE_FAR,
  scopes: ["user-library-read"],
};

interface CallRecord {
  url: string;
  method?: string | undefined;
}

function makeFakeRuntime(responses: Response[]) {
  const calls: CallRecord[] = [];
  const queue = [...responses];
  return {
    runtime: {
      fetch: async (url: string, init?: { method?: string }) => {
        calls.push({ url, method: init?.method });
        const next = queue.shift();
        if (!next) throw new Error(`fetch over-called (call ${calls.length}, url=${url})`);
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("fetchLiked", () => {
  it("calls /v1/me/tracks with the requested limit and normalises the response", async () => {
    const handle = makeFakeRuntime([
      jsonResponse({
        items: [
          { track: { id: "a", name: "Track A", artists: [{ name: "Artist" }], album: { name: "Alb" }, duration_ms: 1000 } },
          { track: { id: "b", name: "Track B" } },
        ],
      }),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchLiked({ runtime: handle.runtime as any, clientId: "cid", tokens: validTokens, now: NOW }, 25);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(handle.calls[0].url, "https://api.spotify.com/v1/me/tracks?limit=25");
    assert.equal(result.data.length, 2);
    assert.equal(result.data[0].name, "Track A");
  });

  it("forwards client errors instead of throwing", async () => {
    const handle = makeFakeRuntime([new Response("server err", { status: 500 })]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchLiked({ runtime: handle.runtime as any, clientId: "cid", tokens: validTokens, now: NOW }, 50);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.error.kind, "spotify_api_error");
  });
});

describe("fetchPlaylists", () => {
  it("calls /v1/me/playlists and normalises the response (single page, no `next`)", async () => {
    const handle = makeFakeRuntime([
      jsonResponse({
        items: [
          { id: "p1", name: "Mix 1", tracks: { total: 10 } },
          { id: "p2", name: "Mix 2", tracks: { total: 5 } },
        ],
        next: null,
      }),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchPlaylists({ runtime: handle.runtime as any, clientId: "cid", tokens: validTokens, now: NOW });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(handle.calls.length, 1);
    assert.equal(handle.calls[0].url, "https://api.spotify.com/v1/me/playlists?limit=50&offset=0");
    assert.equal(result.data.length, 2);
    assert.equal(result.data[0].trackCount, 10);
  });

  it("walks pages while Spotify returns a `next` URL", async () => {
    const handle = makeFakeRuntime([
      jsonResponse({
        items: [{ id: "p1", name: "Page 1 #1", tracks: { total: 1 } }],
        next: "https://api.spotify.com/v1/me/playlists?limit=50&offset=50",
      }),
      jsonResponse({
        items: [{ id: "p2", name: "Page 2 #1", tracks: { total: 2 } }],
        next: null,
      }),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchPlaylists({ runtime: handle.runtime as any, clientId: "cid", tokens: validTokens, now: NOW });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(handle.calls.length, 2);
    assert.equal(handle.calls[0].url, "https://api.spotify.com/v1/me/playlists?limit=50&offset=0");
    assert.equal(handle.calls[1].url, "https://api.spotify.com/v1/me/playlists?limit=50&offset=50");
    assert.equal(result.data.length, 2);
    assert.deepEqual(
      result.data.map((entry) => entry.id),
      ["p1", "p2"],
    );
  });
});

describe("fetchPlaylistTracks", () => {
  it("encodes the playlistId and forwards the limit", async () => {
    const handle = makeFakeRuntime([jsonResponse({ items: [{ track: { id: "a", name: "T" } }] })]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchPlaylistTracks({ runtime: handle.runtime as any, clientId: "cid", tokens: validTokens, now: NOW }, "p1?weird/id", 60);
    assert.equal(result.ok, true);
    assert.equal(handle.calls[0].url, "https://api.spotify.com/v1/playlists/p1%3Fweird%2Fid/tracks?limit=60");
  });
});

describe("fetchRecent", () => {
  it("preserves played_at timestamps", async () => {
    const handle = makeFakeRuntime([
      jsonResponse({
        items: [{ track: { id: "a", name: "T1" }, played_at: "2026-05-05T10:00:00.000Z" }],
      }),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchRecent({ runtime: handle.runtime as any, clientId: "cid", tokens: validTokens, now: NOW }, 50);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(handle.calls[0].url, "https://api.spotify.com/v1/me/player/recently-played?limit=50");
    assert.equal(result.data[0].playedAt, "2026-05-05T10:00:00.000Z");
  });
});

describe("fetchNowPlaying", () => {
  it("returns the unwrapped track from a 200 response with `item`", async () => {
    const handle = makeFakeRuntime([jsonResponse({ item: { id: "a", name: "Now", artists: [{ name: "Artist" }] }, is_playing: true })]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchNowPlaying({ runtime: handle.runtime as any, clientId: "cid", tokens: validTokens, now: NOW });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.data?.name, "Now");
  });

  it("returns null on 204 No Content (nothing playing)", async () => {
    const handle = makeFakeRuntime([new Response(null, { status: 204 })]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchNowPlaying({ runtime: handle.runtime as any, clientId: "cid", tokens: validTokens, now: NOW });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.data, null);
  });

  it("forwards SpotifyClientError unchanged (mirrors fetchLiked's negative case)", async () => {
    const handle = makeFakeRuntime([new Response("server err", { status: 500 })]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchNowPlaying({ runtime: handle.runtime as any, clientId: "cid", tokens: validTokens, now: NOW });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.error.kind, "spotify_api_error");
  });

  it("returns null when the 200 response has no `item` field (podcast / show context)", async () => {
    const handle = makeFakeRuntime([jsonResponse({ currently_playing_type: "ad" })]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchNowPlaying({ runtime: handle.runtime as any, clientId: "cid", tokens: validTokens, now: NOW });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.data, null);
  });
});
