// Spotify plugin — server side (issue #1162).
//
// Kinds:
//   - `connect`        — generate authorize URL + register PKCE pending auth
//   - `oauthCallback`  — invoked by the host's generic OAuth callback
//                        endpoint after Spotify redirects the browser back;
//                        validates state, exchanges code for tokens, persists
//   - `status`         — connection state for the View (no token values)
//   - `diagnose`       — verbose diagnostic for the LLM to surface to the
//                        user when something is misconfigured
//   - `configure`      — View-only: persist the user's Client ID
//   - listening data   — `liked` / `playlists` / `playlistTracks` / `recent` /
//                        `nowPlaying`, plus `search`
//   - player controls  — `play` / `pause` / `next` / `previous` / `seek` /
//                        `setVolume` / `transferPlayback` / `getDevices`
//
// This file is the composition root: it binds `runtime.files.config` and the
// PluginRuntime into the engine calls and hands the result to the router in
// `core/dispatch.ts`, which is where the kind → call mapping lives (and is
// testable without a runtime).
//
// Everything that touches disk goes through `runtime.files.config`
// (per-machine secret), every external HTTP call uses `runtime.fetch`
// with an explicit `allowedHosts` allowlist. The eslint preset bans
// `node:fs` / `node:path` / direct `fetch` so platform bypasses
// surface at lint time.

import { definePlugin, type PluginRuntime } from "gui-chat-protocol";

import { TOOL_DEFINITION } from "./definition";
import { DispatchArgsSchema, type DispatchArgs } from "./schemas";
import { executeSpotifyDispatch, type SpotifyApi, type SpotifyCredentials } from "./core/dispatch";
import {
  buildAuthorizeUrl,
  consumePendingAuthorization,
  deriveCodeChallenge,
  generateRandomToken,
  registerPendingAuthorization,
  SPOTIFY_SCOPES,
} from "./oauth";
import { readClientConfig, readTokens, writeClientConfig, writeTokens } from "./tokens";
import { ONE_SECOND_MS } from "./time";
import type { SpotifyTokens } from "./types";
import { fetchLiked, fetchNowPlaying, fetchPlaylistTracks, fetchPlaylists, fetchRecent } from "./listening";
import { searchSpotify } from "./search";
import { clearProfileCache, getProfile } from "./profile";
import { playerGetDevices, playerNext, playerPause, playerPlay, playerPrevious, playerSeek, playerSetVolume, playerTransfer } from "./playback";

export { TOOL_DEFINITION };

// Short, URL-safe alias the host registers as
// `/api/plugins/runtime/oauth-callback/:alias`. Spotify's Dashboard
// rejects redirect URIs that contain percent-encoded path characters
// (the natural shape when `:pkg` is `@mulmoclaude/spotify-plugin`), so
// each OAuth-using runtime plugin declares its own alphanumeric alias.
// Collisions with other plugins are detected at boot and surfaced as
// startup diagnostics.
export const OAUTH_CALLBACK_ALIAS = "spotify";

const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_TOKEN_HOST = "accounts.spotify.com";

const TOKEN_EXCHANGE_TIMEOUT_MS = 15 * ONE_SECOND_MS;

interface RawTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

async function exchangeCodeForTokens(
  runtime: PluginRuntime,
  params: { code: string; clientId: string; codeVerifier: string; redirectUri: string },
): Promise<SpotifyTokens> {
  const response = await runtime.fetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: params.clientId,
      code_verifier: params.codeVerifier,
    }).toString(),
    timeoutMs: TOKEN_EXCHANGE_TIMEOUT_MS,
    allowedHosts: [SPOTIFY_TOKEN_HOST],
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Spotify token endpoint returned ${response.status}: ${body.slice(0, 300)}`);
  }
  const raw = (await response.json()) as RawTokenResponse;
  if (typeof raw.access_token !== "string" || raw.access_token.length === 0) {
    throw new Error("Spotify response missing access_token");
  }
  if (typeof raw.refresh_token !== "string" || raw.refresh_token.length === 0) {
    throw new Error("Spotify response missing refresh_token");
  }
  if (typeof raw.expires_in !== "number" || !Number.isFinite(raw.expires_in)) {
    throw new Error("Spotify response missing expires_in");
  }
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token,
    expiresAt: new Date(Date.now() + raw.expires_in * ONE_SECOND_MS).toISOString(),
    scopes: typeof raw.scope === "string" ? raw.scope.split(" ").filter(Boolean) : [...SPOTIFY_SCOPES],
  };
}

/** Bind the host runtime into every engine call, so the router deals only in
 *  `{ clientId, tokens }` and the plugin's config dir stays an implementation
 *  detail of this file. */
function bindApi(runtime: PluginRuntime): SpotifyApi {
  const config = runtime.files.config;
  const deps = (credentials: SpotifyCredentials) => ({ runtime, ...credentials });
  return {
    readClientConfig: () => readClientConfig(config),
    writeClientConfig: (clientConfig) => writeClientConfig(config, clientConfig),
    readTokens: () => readTokens(config),
    writeTokens: (tokens) => writeTokens(config, tokens),
    clearProfileCache: () => clearProfileCache(config),

    exchangeCodeForTokens: (params) => exchangeCodeForTokens(runtime, params),

    generateRandomToken,
    deriveCodeChallenge,
    registerPendingAuthorization,
    consumePendingAuthorization,
    buildAuthorizeUrl,

    getProfile: (credentials) => getProfile(deps(credentials)),
    fetchLiked: (credentials, limit) => fetchLiked(deps(credentials), limit),
    fetchPlaylists: (credentials) => fetchPlaylists(deps(credentials)),
    fetchPlaylistTracks: (credentials, playlistId, limit) => fetchPlaylistTracks(deps(credentials), playlistId, limit),
    fetchRecent: (credentials, limit) => fetchRecent(deps(credentials), limit),
    fetchNowPlaying: (credentials) => fetchNowPlaying(deps(credentials)),
    searchSpotify: (credentials, query, types, limit) => searchSpotify(deps(credentials), query, types, limit),
    playerPlay: (credentials, args) => playerPlay(deps(credentials), args),
    playerPause: (credentials, deviceId) => playerPause(deps(credentials), deviceId),
    playerNext: (credentials, deviceId) => playerNext(deps(credentials), deviceId),
    playerPrevious: (credentials, deviceId) => playerPrevious(deps(credentials), deviceId),
    playerSeek: (credentials, positionMs, deviceId) => playerSeek(deps(credentials), positionMs, deviceId),
    playerSetVolume: (credentials, volumePercent, deviceId) => playerSetVolume(deps(credentials), volumePercent, deviceId),
    playerTransfer: (credentials, deviceId, play) => playerTransfer(deps(credentials), deviceId, play),
    playerGetDevices: (credentials) => playerGetDevices(deps(credentials)),
  };
}

export default definePlugin((pluginRuntime) => {
  const { log, pubsub } = pluginRuntime;
  const api = bindApi(pluginRuntime);
  return {
    TOOL_DEFINITION,

    async manageSpotify(rawArgs: unknown) {
      const parsed = DispatchArgsSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          ok: false,
          error: "invalid_args",
          message: `Invalid arguments: ${parsed.error.issues[0]?.message ?? "unknown"}`,
        };
      }
      const args: DispatchArgs = parsed.data;
      return await executeSpotifyDispatch({ api, log, pubsub }, args);
    },
  };
});
