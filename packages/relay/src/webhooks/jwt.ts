// Shared Bearer-JWT parsing + RSA signature verification for the webhook
// platforms that authenticate inbound requests with a JWT (Google Chat,
// Microsoft Teams). These were byte-identical copies across both files and
// sit on the auth boundary, so a single source keeps a hardening fix from
// having to be applied twice. Each platform still owns its own claim
// validation and JWKS fetch/cache — only the parse and the crypto.subtle
// signature check live here.

import { isRecord, splitJwtSegments } from "@mulmoclaude/common";

export interface ParsedJwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signInput: string;
  sig: Uint8Array;
}

// Minimal RSA JWK public-key shape that crypto.subtle.importKey accepts —
// each platform's own JWKS entry (which may carry extra fields such as Teams'
// `endorsements`) is structurally assignable to this.
export interface JwkPublicKey {
  kty: string;
  n: string;
  e: string;
  alg?: string;
  kid?: string;
}

export function b64UrlDecode(str: string): Uint8Array {
  // Restore the standard-alphabet chars and the `=` padding that base64url
  // omits before atob, which only accepts padded standard base64.
  const padded = str
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(str.length + ((4 - (str.length % 4)) % 4), "=");
  return Uint8Array.from(atob(padded), (chr) => chr.charCodeAt(0));
}

function decodeSegment(segment: string): unknown {
  return JSON.parse(new TextDecoder().decode(b64UrlDecode(segment)));
}

// null means "not a well-formed JWT" — callers treat that as a rejection.
export function parseJwt(token: string): ParsedJwt | null {
  const segments = splitJwtSegments(token);
  if (segments === null) return null;
  const { headerSegment, payloadSegment, signatureSegment } = segments;
  try {
    const header = decodeSegment(headerSegment);
    const payload = decodeSegment(payloadSegment);
    // RFC 7519 requires both segments to be JSON objects. A scalar or array
    // would read as "every claim absent" in the per-platform validators —
    // a rejection either way, just a later and less obvious one.
    if (!isRecord(header) || !isRecord(payload)) return null;
    return { header, payload, signInput: `${headerSegment}.${payloadSegment}`, sig: b64UrlDecode(signatureSegment) };
  } catch {
    return null;
  }
}

export function jwtKid(jwt: ParsedJwt): string {
  return typeof jwt.header.kid === "string" ? jwt.header.kid : "";
}

export function jwtHashAlg(jwt: ParsedJwt): "SHA-256" | "SHA-384" | "SHA-512" {
  const alg = typeof jwt.header.alg === "string" ? jwt.header.alg : "RS256";
  if (alg === "RS256") return "SHA-256";
  if (alg === "RS384") return "SHA-384";
  // Any other value falls through to SHA-512, preserving the original inline
  // ternary in both callers.
  return "SHA-512";
}

// The caller must have already validated the claims and selected `jwk` by kid.
export async function verifyJwtSignature(jwt: ParsedJwt, jwk: JwkPublicKey): Promise<boolean> {
  const pubKey = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: jwtHashAlg(jwt) }, false, ["verify"]);
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", pubKey, jwt.sig, new TextEncoder().encode(jwt.signInput));
}
