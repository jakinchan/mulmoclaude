// Tests for the Player Controls handlers (PR 3). Verifies URL
// shape (method, query params, body) for each kind and the
// device-list normalisation. Mocks `runtime.fetch`; no live API.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  playerGetDevices,
  playerNext,
  playerPause,
  playerPlay,
  playerPrevious,
  playerSeek,
  playerSetVolume,
  playerTransfer,
} from "../../../packages/plugins/spotify-plugin/src/playback.js";
import type { SpotifyTokens } from "../../../packages/plugins/spotify-plugin/src/types.js";

const NOW = () => new Date("2026-05-05T00:00:00.000Z");
const validTokens: SpotifyTokens = {
  accessToken: "at-current",
  refreshToken: "rt-current",
  expiresAt: "2026-05-05T05:00:00.000Z",
  scopes: ["user-modify-playback-state"],
};

interface CallRecord {
  url: string;
  method?: string | undefined;
  body?: string | undefined;
}

function makeFakeRuntime(responses: Response[]) {
  const calls: CallRecord[] = [];
  const queue = [...responses];
  return {
    runtime: {
      fetch: async (url: string, init?: { method?: string; body?: string }) => {
        calls.push({ url, method: init?.method, body: init?.body });
        const next = queue.shift();
        if (!next) throw new Error("fetch over-called");
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

function noContent(): Response {
  return new Response(null, { status: 204 });
}

function onlyCall(calls: CallRecord[]): CallRecord {
  const [call] = calls;
  assert.ok(call, "expected runtime.fetch to have been called");
  return call;
}

describe("playerPlay", () => {
  it("PUTs /v1/me/player/play with NO body for plain resume", async () => {
    const handle = makeFakeRuntime([noContent()]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await playerPlay({ runtime: handle.runtime as any, clientId: "cid", tokens: validTokens, now: NOW }, {});
    assert.equal(onlyCall(handle.calls).method, "PUT");
    assert.equal(onlyCall(handle.calls).url, "https://api.spotify.com/v1/me/player/play");
    assert.equal(onlyCall(handle.calls).body, undefined);
  });

  it("includes context_uri in the body when provided", async () => {
    const handle = makeFakeRuntime([noContent()]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await playerPlay({ runtime: handle.runtime as any, clientId: "cid", tokens: validTokens, now: NOW }, { contextUri: "spotify:playlist:abc" });
    assert.deepEqual(JSON.parse(onlyCall(handle.calls).body ?? "{}"), { context_uri: "spotify:playlist:abc" });
  });

  it("includes uris[] in the body for trackUris (mutually exclusive with contextUri)", async () => {
    const handle = makeFakeRuntime([noContent()]);
    await playerPlay(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { runtime: handle.runtime as any, clientId: "cid", tokens: validTokens, now: NOW },
      { trackUris: ["spotify:track:a", "spotify:track:b"] },
    );
    assert.deepEqual(JSON.parse(onlyCall(handle.calls).body ?? "{}"), { uris: ["spotify:track:a", "spotify:track:b"] });
  });

  it("appends device_id query param when targeting a specific device", async () => {
    const handle = makeFakeRuntime([noContent()]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await playerPlay({ runtime: handle.runtime as any, clientId: "cid", tokens: validTokens, now: NOW }, { deviceId: "dev1" });
    assert.match(onlyCall(handle.calls).url, /\?device_id=dev1$/);
  });
});

describe("playerPause / next / previous", () => {
  it("pause uses PUT /v1/me/player/pause", async () => {
    const handle = makeFakeRuntime([noContent()]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await playerPause({ runtime: handle.runtime as any, clientId: "cid", tokens: validTokens, now: NOW });
    assert.equal(onlyCall(handle.calls).method, "PUT");
    assert.equal(onlyCall(handle.calls).url, "https://api.spotify.com/v1/me/player/pause");
  });

  it("next uses POST /v1/me/player/next", async () => {
    const handle = makeFakeRuntime([noContent()]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await playerNext({ runtime: handle.runtime as any, clientId: "cid", tokens: validTokens, now: NOW });
    assert.equal(onlyCall(handle.calls).method, "POST");
    assert.equal(onlyCall(handle.calls).url, "https://api.spotify.com/v1/me/player/next");
  });

  it("previous uses POST /v1/me/player/previous", async () => {
    const handle = makeFakeRuntime([noContent()]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await playerPrevious({ runtime: handle.runtime as any, clientId: "cid", tokens: validTokens, now: NOW });
    assert.equal(onlyCall(handle.calls).method, "POST");
    assert.equal(onlyCall(handle.calls).url, "https://api.spotify.com/v1/me/player/previous");
  });
});

describe("playerSeek + playerSetVolume", () => {
  it("seek puts position_ms in the URL query", async () => {
    const handle = makeFakeRuntime([noContent()]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await playerSeek({ runtime: handle.runtime as any, clientId: "cid", tokens: validTokens, now: NOW }, 30_000);
    assert.match(onlyCall(handle.calls).url, /\/seek\?position_ms=30000/);
    assert.equal(onlyCall(handle.calls).method, "PUT");
  });

  it("setVolume puts volume_percent in the URL query", async () => {
    const handle = makeFakeRuntime([noContent()]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await playerSetVolume({ runtime: handle.runtime as any, clientId: "cid", tokens: validTokens, now: NOW }, 75);
    assert.match(onlyCall(handle.calls).url, /\/volume\?volume_percent=75/);
  });
});

describe("playerTransfer", () => {
  it("PUTs /v1/me/player with device_ids body", async () => {
    const handle = makeFakeRuntime([noContent()]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await playerTransfer({ runtime: handle.runtime as any, clientId: "cid", tokens: validTokens, now: NOW }, "device-x", undefined);
    assert.equal(onlyCall(handle.calls).method, "PUT");
    assert.equal(onlyCall(handle.calls).url, "https://api.spotify.com/v1/me/player");
    assert.deepEqual(JSON.parse(onlyCall(handle.calls).body ?? "{}"), { device_ids: ["device-x"] });
  });

  it("includes play: true when requested", async () => {
    const handle = makeFakeRuntime([noContent()]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await playerTransfer({ runtime: handle.runtime as any, clientId: "cid", tokens: validTokens, now: NOW }, "device-x", true);
    assert.deepEqual(JSON.parse(onlyCall(handle.calls).body ?? "{}"), { device_ids: ["device-x"], play: true });
  });
});

describe("playerGetDevices — normalisation", () => {
  it("collapses Spotify devices[] to NormalisedDevice[]", async () => {
    const handle = makeFakeRuntime([
      new Response(
        JSON.stringify({
          devices: [
            { id: "d1", name: "iPhone", type: "Smartphone", is_active: true, volume_percent: 60 },
            { id: "d2", name: "MacBook", type: "Computer", is_active: false },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await playerGetDevices({ runtime: handle.runtime as any, clientId: "cid", tokens: validTokens, now: NOW });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.data.length, 2);
    assert.deepEqual(result.data[0], { id: "d1", name: "iPhone", type: "Smartphone", isActive: true, volumePercent: 60 });
    assert.deepEqual(result.data[1], { id: "d2", name: "MacBook", type: "Computer", isActive: false });
  });

  it("preserves restricted devices that have a null/missing `id` (Codex review on PR #1171)", async () => {
    const handle = makeFakeRuntime([
      new Response(
        JSON.stringify({
          devices: [
            { id: null, name: "Restricted Speaker", type: "Speaker", is_active: false },
            { name: "AnonymousId", type: "Computer", is_active: false }, // missing id field
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await playerGetDevices({ runtime: handle.runtime as any, clientId: "cid", tokens: validTokens, now: NOW });
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.data.length, 2);
    const [restricted, anonymous] = result.data;
    assert.ok(restricted);
    assert.ok(anonymous);
    assert.equal(restricted.id, null);
    assert.equal(restricted.name, "Restricted Speaker");
    assert.equal(anonymous.id, null);
  });

  it("still drops devices with no `name` (a nameless device is not useful to surface)", async () => {
    const handle = makeFakeRuntime([
      new Response(JSON.stringify({ devices: [{ id: "d1", type: "Speaker", is_active: false }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await playerGetDevices({ runtime: handle.runtime as any, clientId: "cid", tokens: validTokens, now: NOW });
    if (!result.ok) throw new Error("unreachable");
    assert.deepEqual(result.data, []);
  });

  it("returns [] when Spotify returns no devices field", async () => {
    const handle = makeFakeRuntime([new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } })]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await playerGetDevices({ runtime: handle.runtime as any, clientId: "cid", tokens: validTokens, now: NOW });
    if (!result.ok) throw new Error("unreachable");
    assert.deepEqual(result.data, []);
  });
});
