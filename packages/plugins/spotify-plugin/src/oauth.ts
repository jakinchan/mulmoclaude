// PKCE primitives + in-memory pending-authorization store.
//
// PKCE (RFC 7636) flow:
//   1. Plugin generates a high-entropy `code_verifier` per connect.
//   2. Derives `code_challenge` = base64url(SHA-256(code_verifier)).
//   3. Sends the challenge to Spotify's authorize endpoint plus a
//      single-use `state`.
//   4. Browser comes back with `code` + `state`. Plugin looks up the
//      pending record by state, presents `code_verifier` to the
//      token endpoint.
//   5. Verifier never leaves the host process.
//
// `state` is the CSRF defense — a third-party site can't trick the
// user's browser into completing an OAuth dance the user never
// started here, because the matching state isn't in the store.
//
// Crypto via the global WebCrypto (`globalThis.crypto.{subtle,
// getRandomValues}`). Node 20+ ships WebCrypto on the global, so
// the same code paths work in both runtimes. Importing
// `node:crypto` would force vite to externalise that specifier and
// drag a platform-detect branch into the bundle.
//
// `deriveCodeChallenge` is async because `crypto.subtle.digest` is
// async; the call sites are in async handlers anyway.

import type { PendingAuthorization } from "./types";

/** Scope set requested at OAuth time. Two extra scopes were added
 *  in PR 3 for Player Controls: `user-read-playback-state` (read
 *  active device + playback state) and `user-modify-playback-state`
 *  (play/pause/next/seek/volume/transfer). Existing users from
 *  PR 1/2 will hit `403 Insufficient client scope` on the new
 *  player kinds and need to reconnect. */
export const SPOTIFY_SCOPES: readonly string[] = [
  "playlist-read-private",
  "user-library-read",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "user-read-playback-state",
  "user-read-recently-played",
] as const;

/** Maximum age before a pending authorization is considered stale.
 *  Spotify's authorize page typically redirects back within a
 *  minute; 10 minutes covers slow users without leaking entries
 *  forever. The runtime is sandboxed (no `runtime.now`), so this
 *  uses `Date.now()` directly — pure number, not external state. */
const PENDING_TTL_MS = 10 * 60 * 1000;

const _pendingAuthorizations = new Map<string, PendingAuthorization>();

/** Generate 32 bytes of random entropy as a base64url string.
 *  Used both for `code_verifier` (PKCE) and `state` (CSRF). */
export function generateRandomToken(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/** Derive `code_challenge` from `code_verifier`: SHA-256 then
 *  base64url. Spotify's authorize URL carries this; the token
 *  endpoint receives the verifier and re-derives. */
export async function deriveCodeChallenge(codeVerifier: string): Promise<string> {
  const buffer = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  return base64UrlEncode(new Uint8Array(buffer));
}

/** Encode bytes as RFC 4648 base64url (no padding). The standard
 *  `btoa` produces base64; we replace the URL-unsafe characters and
 *  strip padding to match what Spotify's authorize / token
 *  endpoints expect. */
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Register a fresh pending authorization. Returns the `state` the
 *  caller embeds on the authorize URL. Sweeps stale entries on
 *  every call so the map can't grow unbounded across abandoned
 *  attempts. */
export function registerPendingAuthorization(codeVerifier: string, redirectUri: string, now: Date = new Date()): string {
  sweepStaleAuthorizations(now);
  const state = generateRandomToken();
  _pendingAuthorizations.set(state, {
    codeVerifier,
    redirectUri,
    createdAtMs: now.getTime(),
  });
  return state;
}

/** Look up + consume a pending authorization by `state`. Single-
 *  use: a successful lookup deletes the record so the same state
 *  can't be replayed. Returns null when the state is unknown
 *  (CSRF / stale / replayed). */
export function consumePendingAuthorization(state: string, now: Date = new Date()): PendingAuthorization | null {
  sweepStaleAuthorizations(now);
  const entry = _pendingAuthorizations.get(state);
  if (!entry) return null;
  _pendingAuthorizations.delete(state);
  return entry;
}

function sweepStaleAuthorizations(now: Date): void {
  const cutoff = now.getTime() - PENDING_TTL_MS;
  for (const [state, entry] of _pendingAuthorizations) {
    if (entry.createdAtMs < cutoff) _pendingAuthorizations.delete(state);
  }
}

/** Build the Spotify authorize URL. Pure — no side effects, no
 *  randomness; `state` and `codeChallenge` are passed in so the
 *  caller controls them (for replay registration and tests). */
export function buildAuthorizeUrl(params: { clientId: string; redirectUri: string; scopes: readonly string[]; state: string; codeChallenge: string }): string {
  const search = new URLSearchParams({
    response_type: "code",
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    scope: params.scopes.join(" "),
    state: params.state,
    code_challenge_method: "S256",
    code_challenge: params.codeChallenge,
  });
  return `https://accounts.spotify.com/authorize?${search.toString()}`;
}

/** Test-only access to the in-memory store. */
export const _pendingAuthorizationsForTests = _pendingAuthorizations;

/** Test-only reset — wipe the store between cases. */
export function _resetPendingAuthorizationsForTests(): void {
  _pendingAuthorizations.clear();
}
