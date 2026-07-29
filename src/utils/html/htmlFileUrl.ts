// URL scheme for serving an HTML page that is NOT an `artifacts/html/**`
// artifact — presentHtml's `path` form can point at any page on disk, and the
// View's iframe needs a URL for it.
//
// Why a PATH-shaped URL rather than `/api/html-view?path=…`: the iframe loads
// the page with `src=`, so the browser resolves the page's own relative refs
// (`<img src="../images/x.png">`) against this URL. A query parameter would put
// every page at the same URL path, and `../images/x.png` would resolve against
// `/api/`, breaking every relative reference. Mirrors why `/artifacts/html`
// exists at all (see plans/done/feat-files-html-preview-relative-paths.md).
//
// The scope segment (`ws` / `abs`) is what lets a workspace-relative and an
// absolute path share one mount without ambiguity — a leading `/` cannot
// survive in a URL path segment, and `..`-normalisation in the browser would
// eat any marker we tried to encode as an empty segment.
//
// Kept in `src/utils/html` (browser-safe, no node imports) so the client builder
// and the server's parser (`server/utils/files/htmlFileRequest.ts`) stay two
// halves of one documented scheme.

export const HTML_FILE_MOUNT = "/htmlfile";
export const HTML_FILE_SCOPE_WORKSPACE = "ws";
export const HTML_FILE_SCOPE_ABSOLUTE = "abs";

const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;

function isAbsolutePathValue(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\\\") || WINDOWS_DRIVE_RE.test(value);
}

/**
 * Browser URL for an HTML file the host will serve through the `/htmlfile`
 * mount, or null when the value is not a usable HTML path.
 *
 * UNC paths (`\\server\share\page.html`) round-trip as if they were rooted
 * POSIX paths, so they are not supported — a deliberate omission rather than a
 * silent mis-serve, since the mount's realpath check will simply 404.
 */
export function htmlFileUrlFor(filePath: string | null | undefined): string | null {
  if (!filePath || filePath.includes("\0")) return null;
  const lower = filePath.toLowerCase();
  if (!lower.endsWith(".html") && !lower.endsWith(".htm")) return null;
  const normalized = filePath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) return null;
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  const scope = isAbsolutePathValue(filePath) ? HTML_FILE_SCOPE_ABSOLUTE : HTML_FILE_SCOPE_WORKSPACE;
  return `${HTML_FILE_MOUNT}/${scope}/${segments.map(encodeURIComponent).join("/")}`;
}
