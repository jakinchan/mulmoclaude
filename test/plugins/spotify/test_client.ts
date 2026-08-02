// Unit tests for `packages/plugins/spotify-plugin/src/client.ts` — proactive
// refresh near expiry, 401 → refresh → retry-once, no-second-refresh
// on retry's 401, 429 Retry-After parsing, error surfacing.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseRetryAfterSec, spotifyApi } from "../../../packages/plugins/spotify-plugin/src/client.js";
import type { SpotifyTokens } from "../../../packages/plugins/spotify-plugin/src/types.js";

interface FakeRuntimeOpts {
  responses: Response[];
}

/** Build a faux `PluginRuntime` covering only the surface
 *  `client.ts` touches (`fetch` + `files.config.write` + `log`). */
function makeFakeRuntime(opts: FakeRuntimeOpts) {
  const calls: { url: string; method?: string | undefined; headers?: Record<string, string> | undefined; body?: string | undefined }[] = [];
  const written: SpotifyTokens[] = [];
  const queue = [...opts.responses];
  return {
    runtime: {
      fetch: async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
        calls.push({ url, method: init?.method, headers: init?.headers, body: init?.body });
        const next = queue.shift();
        if (!next) throw new Error(`fetch over-called (call ${calls.length}, url=${url})`);
        return next;
      },
      files: {
        config: {
          exists: async () => false,
          read: async () => "",
          readBytes: async () => new Uint8Array(),
          write: async (rel: string, content: string | Uint8Array) => {
            if (rel === "tokens.json") {
              const text = typeof content === "string" ? content : new TextDecoder().decode(content);
              written.push(JSON.parse(text) as SpotifyTokens);
            }
          },
          readDir: async () => [],
          stat: async () => ({ mtimeMs: 0, size: 0 }),
          unlink: async () => {},
        },
        // `client.ts` only writes through `files.config`; `data` is
        // wired in the real runtime but never touched by the API
        // client. Provided as a stub for type compat.
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
      log: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      pubsub: { publish: () => {} },
      locale: "en",
      fetchJson: async () => {
        throw new Error("not used");
      },
    },
    calls,
    written,
  };
}

const FUTURE = "2026-05-05T05:00:00.000Z";
const ALMOST_NOW = "2026-05-05T00:00:10.000Z";
const NOW = () => new Date("2026-05-05T00:00:00.000Z");

const validTokens: SpotifyTokens = {
  accessToken: "at-current",
  refreshToken: "rt-current",
  expiresAt: FUTURE,
  scopes: ["user-library-read"],
};

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

describe("spotifyApi — happy path", () => {
  it("returns parsed JSON on a 200 and forwards the bearer header", async () => {
    const handle = makeFakeRuntime({ responses: [jsonResponse({ id: "user123" })] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await spotifyApi<{ id: string }>(handle.runtime as any, "cid", validTokens, "GET", "/v1/me", {}, NOW);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.deepEqual(result.data, { id: "user123" });
    assert.equal(handle.calls[0].url, "https://api.spotify.com/v1/me");
    assert.equal(handle.calls[0].headers?.Authorization, "Bearer at-current");
  });

  it("returns null data on 204 No Content", async () => {
    const handle = makeFakeRuntime({ responses: [new Response(null, { status: 204 })] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await spotifyApi(handle.runtime as any, "cid", validTokens, "GET", "/v1/me/player/currently-playing", {}, NOW);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.data, null);
  });
});

describe("spotifyApi — 401 → refresh → retry once", () => {
  it("refreshes after a 401 and retries the original call with the new token", async () => {
    const handle = makeFakeRuntime({
      responses: [new Response("", { status: 401 }), jsonResponse({ access_token: "at-new", expires_in: 3600 }), jsonResponse({ id: "user123" })],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await spotifyApi(handle.runtime as any, "cid", validTokens, "GET", "/v1/me", {}, NOW);
    assert.equal(result.ok, true);
    assert.equal(handle.calls.length, 3);
    assert.equal(handle.calls[1].url, "https://accounts.spotify.com/api/token");
    assert.equal(handle.calls[2].headers?.Authorization, "Bearer at-new");
    assert.equal(handle.written.length, 1);
    assert.equal(handle.written[0].refreshToken, "rt-current"); // preserved (Spotify didn't return a new one)
  });

  it("does NOT loop a second refresh when the retry also returns 401", async () => {
    const handle = makeFakeRuntime({
      responses: [new Response("", { status: 401 }), jsonResponse({ access_token: "at-new", expires_in: 3600 }), new Response("", { status: 401 })],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await spotifyApi(handle.runtime as any, "cid", validTokens, "GET", "/v1/me", {}, NOW);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.error.kind, "auth_expired");
    assert.equal(handle.calls.length, 3);
  });

  it("surfaces auth_expired when refresh returns 4xx (token rejected)", async () => {
    const handle = makeFakeRuntime({ responses: [new Response("", { status: 401 }), new Response("invalid_grant", { status: 400 })] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await spotifyApi(handle.runtime as any, "cid", validTokens, "GET", "/v1/me", {}, NOW);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.error.kind, "auth_expired");
    assert.equal(handle.written.length, 0);
  });
});

// CodeRabbit review on PR #1166 caught that pre-PR-#1188-or-similar,
// every refresh-path failure (network blip, Spotify 5xx, JSON parse)
// was reported as `auth_expired`, prompting the user to reconnect even
// when their credential was fine. The split below pins which
// classifications go to `transient_error` (retry later) vs
// `auth_expired` (reconnect required).
describe("spotifyApi — refresh-path classification (auth_expired vs transient_error)", () => {
  it("classifies a network/timeout failure during refresh as transient_error", async () => {
    // Two responses queued, but the SECOND queued slot is a thrown
    // error: the fake runtime's `fetch` throws when the queue's next
    // entry is missing, so we leave only one response and let the
    // refresh fetch trip the throw branch.
    const handle = makeFakeRuntime({ responses: [new Response("", { status: 401 })] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await spotifyApi(handle.runtime as any, "cid", validTokens, "GET", "/v1/me", {}, NOW);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.error.kind, "transient_error");
  });

  it("classifies a 5xx from Spotify's token endpoint as transient_error", async () => {
    const handle = makeFakeRuntime({ responses: [new Response("", { status: 401 }), new Response("upstream", { status: 503 })] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await spotifyApi(handle.runtime as any, "cid", validTokens, "GET", "/v1/me", {}, NOW);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.error.kind, "transient_error");
    assert.match(result.error.detail, /503/);
  });

  it("classifies a 408 Request Timeout on refresh as transient_error", async () => {
    // The refresh request never reached Spotify (proxy / network
    // timeout) — credential wasn't actually checked, so forcing
    // re-auth would be wrong. (Codex review on PR #1226.)
    const handle = makeFakeRuntime({ responses: [new Response("", { status: 401 }), new Response("", { status: 408 })] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await spotifyApi(handle.runtime as any, "cid", validTokens, "GET", "/v1/me", {}, NOW);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.error.kind, "transient_error");
    assert.match(result.error.detail, /408/);
  });

  it("classifies a 429 Too Many Requests on refresh as transient_error", async () => {
    // Spotify's rate limiter — credential is fine, the caller just
    // needs to back off. Forcing re-auth would silently lose the
    // working refresh token.
    const handle = makeFakeRuntime({ responses: [new Response("", { status: 401 }), new Response("", { status: 429 })] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await spotifyApi(handle.runtime as any, "cid", validTokens, "GET", "/v1/me", {}, NOW);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.error.kind, "transient_error");
    assert.match(result.error.detail, /429/);
  });

  it("classifies a non-JSON 2xx body from token endpoint as transient_error", async () => {
    // Some proxies / middlewares return HTML on their own 2xx page.
    const htmlResponse = new Response("<html>maintenance</html>", { status: 200, headers: { "content-type": "text/html" } });
    const handle = makeFakeRuntime({ responses: [new Response("", { status: 401 }), htmlResponse] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await spotifyApi(handle.runtime as any, "cid", validTokens, "GET", "/v1/me", {}, NOW);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.error.kind, "transient_error");
  });

  it("keeps auth_expired when refresh response is JSON but missing access_token / expires_in", async () => {
    const handle = makeFakeRuntime({ responses: [new Response("", { status: 401 }), jsonResponse({ error: "invalid_grant" })] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await spotifyApi(handle.runtime as any, "cid", validTokens, "GET", "/v1/me", {}, NOW);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.error.kind, "auth_expired");
  });

  it("classifies a 5xx hit during PROACTIVE refresh (pre-call) as transient_error", async () => {
    // Token is within the 30s expiry leeway, so the FIRST fetch is
    // the refresh attempt — no preceding 401 round-trip.
    const handle = makeFakeRuntime({ responses: [new Response("", { status: 502 })] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await spotifyApi(handle.runtime as any, "cid", { ...validTokens, expiresAt: ALMOST_NOW }, "GET", "/v1/me", {}, NOW);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.error.kind, "transient_error");
  });
});

describe("spotifyApi — proactive refresh near expiry", () => {
  it("refreshes BEFORE the API call when the token is within 30s of expiry", async () => {
    const handle = makeFakeRuntime({ responses: [jsonResponse({ access_token: "at-new", expires_in: 3600 }), jsonResponse({ id: "user123" })] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await spotifyApi(handle.runtime as any, "cid", { ...validTokens, expiresAt: ALMOST_NOW }, "GET", "/v1/me", {}, NOW);
    assert.equal(result.ok, true);
    assert.equal(handle.calls[0].url, "https://accounts.spotify.com/api/token");
    assert.equal(handle.calls[1].url, "https://api.spotify.com/v1/me");
  });
});

describe("spotifyApi — non-auth errors", () => {
  it("surfaces 429 with Retry-After parsed", async () => {
    const handle = makeFakeRuntime({ responses: [new Response("", { status: 429, headers: { "Retry-After": "12" } })] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await spotifyApi(handle.runtime as any, "cid", validTokens, "GET", "/v1/me", {}, NOW);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.deepEqual(result.error, { kind: "rate_limited", retryAfterSec: 12 });
  });

  it("falls back to 60 on a non-numeric Retry-After (no NaN propagation)", async () => {
    const handle = makeFakeRuntime({ responses: [new Response("", { status: 429, headers: { "Retry-After": "soon" } })] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await spotifyApi(handle.runtime as any, "cid", validTokens, "GET", "/v1/me", {}, NOW);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.deepEqual(result.error, { kind: "rate_limited", retryAfterSec: 60 });
  });

  it("surfaces 5xx as spotify_api_error", async () => {
    const handle = makeFakeRuntime({ responses: [new Response("internal", { status: 500 })] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await spotifyApi(handle.runtime as any, "cid", validTokens, "GET", "/v1/me", {}, NOW);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.error.kind, "spotify_api_error");
  });
});

describe("parseRetryAfterSec", () => {
  it("returns the integer for delta-seconds", () => {
    assert.equal(parseRetryAfterSec("12"), 12);
    assert.equal(parseRetryAfterSec("  30  "), 30);
  });

  it("falls back to 60 on invalid input", () => {
    assert.equal(parseRetryAfterSec(null), 60);
    assert.equal(parseRetryAfterSec(""), 60);
    assert.equal(parseRetryAfterSec("soon"), 60);
    assert.equal(parseRetryAfterSec("12abc"), 60);
    assert.equal(parseRetryAfterSec("0"), 60);
    assert.equal(parseRetryAfterSec("-5"), 60);
  });

  it("converts an HTTP-date in the future to delta-seconds", () => {
    const futureDate = new Date(Date.now() + 30_000).toUTCString();
    const result = parseRetryAfterSec(futureDate);
    assert.ok(result >= 28 && result <= 31, `expected ~30, got ${result}`);
  });

  it("falls back to 60 on an HTTP-date in the past", () => {
    const pastDate = new Date(Date.now() - 60_000).toUTCString();
    assert.equal(parseRetryAfterSec(pastDate), 60);
  });
});
