// Collects CSP violations reported by sandboxed views (#1989). A view whose
// resource is blocked posts an `mc-csp-violation` message up to the host; we
// dedupe by blocked host + directive, cap the list, and expose it so the UI
// can surface an actionable notice ("add this host to config/csp.json")
// instead of the resource failing silently. Host-global (a single window
// listener) so it works no matter which view triggered it. The message is
// informational and carries no capability, so a loose validation is fine.

import { ref, readonly } from "vue";
import { isRecord } from "../utils/types";

export interface CspViolation {
  /** Origin of the blocked resource, e.g. `https://www.google.com` — this is
   *  the exact host the user would add to `config/csp.json`. */
  host: string;
  /** The blocked directive, e.g. `frame-src`. */
  directive: string;
}

const MAX_VIOLATIONS = 5;
const violationsState = ref<CspViolation[]>([]);

export const cspViolations = readonly(violationsState);

export function dismissCspViolations(): void {
  violationsState.value = [];
}

function originOf(uri: string): string {
  try {
    return new URL(uri).origin;
  } catch {
    return uri;
  }
}

interface ViolationMessage {
  type: string;
  nonce?: unknown;
  blockedURI?: unknown;
  violatedDirective?: unknown;
  effectiveDirective?: unknown;
}

// Per-render nonces the host handed to legitimate custom-view srcdocs. A
// violation report is trusted only if it echoes one of these. A nested,
// hostile iframe inside a view has an opaque origin too, but it runs in a
// SEPARATE document and cannot read the parent view's `window.__MC_VIEW`, so
// it cannot forge the nonce — closing the spoofed-banner hole that an
// `event.origin === "null"` check alone leaves open. Bounded so a long session
// can't grow it without limit.
const MAX_LIVE_NONCES = 64;
const liveNonces = new Set<string>();

export function registerViewNonce(nonce: string): void {
  if (!nonce) return;
  liveNonces.add(nonce);
  while (liveNonces.size > MAX_LIVE_NONCES) {
    const oldest = liveNonces.values().next().value;
    if (oldest === undefined) break;
    liveNonces.delete(oldest);
  }
}

function isViolationMessage(data: unknown): data is ViolationMessage {
  return isRecord(data) && data.type === "mc-csp-violation";
}

// Pure: turn a raw `mc-csp-violation` payload into a `{ host, directive }` the
// UI can act on, or `null` when it's not a fixable-by-config violation.
// Exported for unit tests.
export function parseCspViolationMessage(data: unknown): CspViolation | null {
  if (!isViolationMessage(data)) return null;
  const blockedURI = typeof data.blockedURI === "string" ? data.blockedURI : "";
  const rawDirective =
    typeof data.violatedDirective === "string" ? data.violatedDirective : typeof data.effectiveDirective === "string" ? data.effectiveDirective : "";
  // `inline` / `eval` violations aren't fixable by adding a host to config, so
  // don't surface them as "add this host" notices.
  if (!blockedURI || blockedURI === "inline" || blockedURI === "eval") return null;
  return { host: originOf(blockedURI), directive: rawDirective.split(" ")[0] || "" };
}

function recordViolation(violation: CspViolation): void {
  if (violationsState.value.some((entry) => entry.host === violation.host && entry.directive === violation.directive)) return;
  violationsState.value = [violation, ...violationsState.value].slice(0, MAX_VIOLATIONS);
  const directiveSuffix = violation.directive ? ` (${violation.directive})` : "";
  console.warn(`[csp] blocked ${violation.host}${directiveSuffix}. To allow it, add the host to config/csp.json — but only if you trust it.`);
}

// Decide whether a `message` event is a trusted CSP-violation report and, if
// so, extract the actionable `{ host, directive }`. Trust requires BOTH:
//   1. opaque origin (`event.origin === "null"`) — our custom views run
//      `sandbox="allow-scripts"`, so a legitimate report always arrives opaque;
//      this alone rejects an ALLOWED external iframe (e.g. a Maps embed).
//   2. a live per-render nonce the host handed only to legitimate views — this
//      rejects a nested hostile (also-opaque) iframe that can't read the nonce.
// Exported (with an injected nonce predicate) for unit tests.
export function decideViolation(origin: string, data: unknown, isLiveNonce: (nonce: string) => boolean): CspViolation | null {
  if (origin !== "null") return null;
  if (!isViolationMessage(data)) return null;
  const nonce = typeof data.nonce === "string" ? data.nonce : "";
  if (!isLiveNonce(nonce)) return null;
  return parseCspViolationMessage(data);
}

function onMessage(event: MessageEvent): void {
  const violation = decideViolation(event.origin, event.data, (nonce) => liveNonces.has(nonce));
  if (violation) recordViolation(violation);
}

let installed = false;
export function installCspViolationListener(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  // eslint-disable-next-line sonarjs/post-message -- `onMessage` delegates to `decideViolation`, which drops anything whose `event.origin` is not the opaque `"null"` AND whose nonce is not in the live per-render allowlist.
  window.addEventListener("message", onMessage);
}
