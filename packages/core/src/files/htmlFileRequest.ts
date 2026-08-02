// Server half of the `/htmlfile` scheme (client half: `src/config/htmlFileUrl.ts`).
// Turns a request path into the absolute file to serve, or null.
//
// Shared by both hosts so the URL the View asks for and the file a host resolves
// cannot drift apart.
//
// This mount is deliberately NOT contained to a root: presentHtml's `path` form
// may name any HTML page on disk, and serving it is the point. What still holds:
//
//   - only `ws` (workspace-relative) and `abs` (absolute) scopes exist; anything
//     else 404s, so a bare `/htmlfile/etc/passwd` is not a path at all.
//   - no `.` / `..` / empty segment survives, so a vetted URL cannot be
//     re-pointed by traversal, and no dotfile segment is reachable (same policy
//     as `resolveArtifactRequestPath`, which the artifact mounts share).
//   - extension allowlist, realpath and regular-file checks stay with the host's
//     mount, which is also where the CSP header and rate limit are applied.
//
// The trust boundary is whatever the host applies to its `/artifacts/html`
// mount — in MulmoClaude, the loopback-only listener plus `requireSameOrigin`
// (bearer auth does not apply outside `/api`, and an iframe `src` request cannot
// carry an Authorization header anyway).

import path from "node:path";
// The scope constants are re-declared rather than imported: core must not
// depend on a plugin (dependencies flow the other way). `html-plugin`'s
// `htmlFileUrl` builds the URLs these parse, and the round-trip test in the host
// is what keeps the two halves honest.
const HTML_FILE_SCOPE_WORKSPACE = "ws";
const HTML_FILE_SCOPE_ABSOLUTE = "abs";

const WINDOWS_DRIVE_ONLY_RE = /^[a-zA-Z]:$/;

function decodeSegments(reqPath: string): string[] | null {
  let decoded: string[];
  try {
    decoded = reqPath
      .replace(/^\//, "")
      .split("/")
      .map((segment) => decodeURIComponent(segment));
  } catch {
    // Malformed escape (`%ZZ`) — fail closed rather than bubbling a URIError.
    return null;
  }
  // Segmentation happens on the ENCODED path, so a `%2F` (or `%5C`) becomes a
  // separator only after this decode — `a%2F..%2F..%2Ftmp%2Fx.html` would arrive
  // as one segment that the `..` check below never sees, and then split apart
  // inside `path.resolve`. A decoded segment that still contains a separator is
  // never legitimate here, so refuse it.
  return decoded.some((segment) => segment.includes("/") || segment.includes("\\")) ? null : decoded;
}

/** Absolute path for a `/htmlfile/<scope>/<segments…>` request, or null when
 *  the URL is malformed, uses an unknown scope, or touches a `.` / `..` /
 *  dotfile segment. `workspaceRoot` should already be a realpath. */
export function resolveHtmlFileRequestPath(workspaceRoot: string, reqPath: string): string | null {
  const decoded = decodeSegments(reqPath);
  if (decoded === null || decoded.length < 2) return null;
  const [scope, ...rest] = decoded;
  if (scope !== HTML_FILE_SCOPE_WORKSPACE && scope !== HTML_FILE_SCOPE_ABSOLUTE) return null;
  const [firstRest] = rest;
  if (firstRest === undefined) return null;
  if (rest.some((segment) => segment === "" || segment === "." || segment === ".." || segment.startsWith(".") || segment.includes("\0"))) {
    return null;
  }
  if (scope === HTML_FILE_SCOPE_WORKSPACE) return path.resolve(workspaceRoot, ...rest);
  // `abs/C:/proj/page.html` — the drive letter arrives as its own segment, so
  // rejoin it before resolving; everything else is rooted at `/`.
  const candidate = WINDOWS_DRIVE_ONLY_RE.test(firstRest) ? rest.join("/") : `/${rest.join("/")}`;
  // Only THIS platform's `path` can say whether that is really absolute: on
  // POSIX, `path.resolve("C:/proj/page.html")` would land under the process cwd
  // rather than at any drive, silently serving the wrong file. Refuse instead.
  return path.isAbsolute(candidate) ? path.resolve(candidate) : null;
}
