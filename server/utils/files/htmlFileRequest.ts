// Server half of the `/htmlfile` scheme (client half: `src/config/htmlFileUrl.ts`).
// Turns a request path into the absolute file to serve, or null.
//
// This mount is deliberately NOT contained to a root: presentHtml's `path` form
// may name any HTML page on disk, and serving it is the point. What still holds:
//
//   - only `ws` (workspace-relative) and `abs` (absolute) scopes exist; anything
//     else 404s, so a bare `/htmlfile/etc/passwd` is not a path at all.
//   - no `.` / `..` / empty segment survives, so a vetted URL cannot be
//     re-pointed by traversal, and no dotfile segment is reachable (same policy
//     as `resolveArtifactRequestPath`, which the artifact mounts share).
//   - extension allowlist, realpath and regular-file checks stay with the mount
//     in `server/index.ts`, which is also where the CSP header is set.
//
// The trust boundary is unchanged from the `/artifacts/html` mount: the
// loopback-only listener plus `requireSameOrigin`. Bearer auth does not apply
// (this is not under `/api`) for the same reason it does not there — an iframe
// `src` request cannot carry an Authorization header.

import path from "path";
import { HTML_FILE_SCOPE_ABSOLUTE, HTML_FILE_SCOPE_WORKSPACE } from "@mulmoclaude/html-plugin";

const WINDOWS_DRIVE_ONLY_RE = /^[a-zA-Z]:$/;

function decodeSegments(reqPath: string): string[] | null {
  try {
    return reqPath
      .replace(/^\//, "")
      .split("/")
      .map((segment) => decodeURIComponent(segment));
  } catch {
    // Malformed escape (`%ZZ`) — fail closed rather than bubbling a URIError.
    return null;
  }
}

/** Absolute path for a `/htmlfile/<scope>/<segments…>` request, or null when
 *  the URL is malformed, uses an unknown scope, or touches a `.` / `..` /
 *  dotfile segment. `workspaceRoot` should already be a realpath. */
export function resolveHtmlFileRequestPath(workspaceRoot: string, reqPath: string): string | null {
  const decoded = decodeSegments(reqPath);
  if (decoded === null || decoded.length < 2) return null;
  const [scope, ...rest] = decoded;
  if (scope !== HTML_FILE_SCOPE_WORKSPACE && scope !== HTML_FILE_SCOPE_ABSOLUTE) return null;
  if (rest.length === 0) return null;
  if (rest.some((segment) => segment === "" || segment === "." || segment === ".." || segment.startsWith(".") || segment.includes("\0"))) {
    return null;
  }
  if (scope === HTML_FILE_SCOPE_WORKSPACE) return path.resolve(workspaceRoot, ...rest);
  // `abs/C:/proj/page.html` — the drive letter arrives as its own segment, so
  // rejoin it before resolving; everything else is rooted at `/`.
  return WINDOWS_DRIVE_ONLY_RE.test(rest[0]) ? path.resolve(rest.join("/")) : path.resolve("/", ...rest);
}
