// Path helpers for presentHtml artifacts. The generic build primitives (slug,
// YYYY/MM partition, the `""`/`.`/`..` traversal guard) live in the shared,
// browser-safe `@mulmoclaude/core/artifacts` (#2405); only the html-specific
// rules (`.html` extension, `artifacts/html/` prefix, preview URL) stay here.
// All filesystem access happens through the host's generic `files.artifacts`
// FileOps (rooted at `<workspace>/artifacts`).

import {
  ARTIFACTS_ROOT,
  buildArtifactRelPath,
  classifyFilePath,
  hasDotfileSegment,
  hasUnsafePathSegment,
  isAbsoluteFilePathValue,
  slugifyArtifact,
  toWorkspaceArtifactPath,
} from "@mulmoclaude/core/artifacts";

const HTML_DIR = "html";
const HTML_FALLBACK_SLUG = "page";

/** Lowercase-hyphen slug, capped, leading/trailing hyphens stripped; falls back
 *  to `fallback` for empty/undefined/non-ASCII input. */
export function slugify(title: string | undefined, fallback = HTML_FALLBACK_SLUG): string {
  return slugifyArtifact(title, fallback);
}

export interface HtmlPath {
  /** Path relative to the artifacts root — what `files.artifacts.write` takes
   *  (e.g. `html/2026/06/the-cell-1718765432101.html`). */
  relPath: string;
  /** Workspace-relative path for display / tool-result data
   *  (e.g. `artifacts/html/2026/06/the-cell-1718765432101.html`). */
  filePath: string;
}

/** Build a fresh, collision-safe artifact path for a new HTML page. */
export function htmlArtifactPath(title: string | undefined, now: Date = new Date()): HtmlPath {
  const relPath = buildArtifactRelPath({ dir: HTML_DIR, title, ext: ".html", fallback: HTML_FALLBACK_SLUG, now });
  return { relPath, filePath: toWorkspaceArtifactPath(relPath) };
}

/**
 * Strict guard for a workspace-relative path the caller claims is an existing
 * HTML artifact. Rejects anything outside `artifacts/html/`, non-`.html`, or
 * with traversal / non-canonical segments — the primary defence before a
 * `files.artifacts` read/write (the FileOps path is the strip of this, below).
 */
export function isHtmlArtifactPath(value: string): boolean {
  if (!value.startsWith(`${ARTIFACTS_ROOT}/${HTML_DIR}/`)) return false;
  if (!value.endsWith(".html")) return false;
  return !hasUnsafePathSegment(value);
}

/** Convert a workspace-relative artifacts path (`artifacts/html/…`) to the
 *  `files.artifacts`-relative form (`html/…`) that FileOps expects. Assumes
 *  the input already passed `isHtmlArtifactPath`. */
export function toArtifactsRelative(workspaceRelPath: string): string {
  return workspaceRelPath.startsWith(`${ARTIFACTS_ROOT}/`) ? workspaceRelPath.slice(ARTIFACTS_ROOT.length + 1) : workspaceRelPath;
}

/**
 * Default browser URL for a presented page, derived purely from its `filePath`.
 * An artifact keeps the `/artifacts/html/…` mount both hosts already serve
 * (`artifacts/html/2026/04/p.html` → `/artifacts/html/2026/04/p.html`,
 * per-segment URL-encoded); anything else — the `path` form's repo file or
 * absolute path — falls through to the `/htmlfile` scheme below.
 *
 * The View uses this when the host hasn't injected a `previewUrl`, so
 * already-presented results (whose stored data predates that field) still
 * render. A host serving these at different URLs injects `previewUrl` to
 * override. Returns null for non-HTML paths.
 */
export function htmlArtifactPreviewUrl(filePath: string | null): string | null {
  if (!filePath) return null;
  const lower = filePath.toLowerCase();
  if (!lower.endsWith(".html") && !lower.endsWith(".htm")) return null;
  const prefix = `${ARTIFACTS_ROOT}/${HTML_DIR}/`;
  if (!filePath.startsWith(prefix)) return htmlFileUrl(filePath);
  // Reject traversal / non-canonical segments so the derived URL can never point
  // the iframe outside artifacts/html/ — defence-in-depth even though `filePath`
  // is normally produced by `htmlArtifactPath` / validated by `presentExisting`.
  if (hasUnsafePathSegment(filePath)) return null;
  const rest = filePath.slice(prefix.length);
  if (rest.length === 0) return null;
  return `/${ARTIFACTS_ROOT}/${HTML_DIR}/${rest.split("/").map(encodeURIComponent).join("/")}`;
}

/** The `path` argument's gate: ANY HTML page, not just the ones this tool
 *  wrote — a workspace-relative path (`docs/report.html`) or, where the host
 *  permits it, an absolute one. Lexical only; the host's `files.byPath`
 *  capability is what decides which of those it will actually open.
 *
 *  Dotfile segments are refused even though they name perfectly real files:
 *  the mount that hands the page to the iframe rejects them (the same
 *  `dotfiles: "deny"` policy the artifact mounts carry), so accepting one here
 *  would report success for a page that can never render. */
export function isPresentableHtmlPath(value: string): boolean {
  return classifyFilePath(value, [".html", ".htm"]) !== null && !hasDotfileSegment(value);
}

// ── Serving a page that is NOT an artifact ───────────────────────────────────
//
// presentHtml's `path` form accepts any page on disk, so the View's iframe needs
// a URL for one. Both hosts serve the same `/htmlfile/<scope>/<segments…>`
// scheme, and it is defined HERE so the URL the View asks for and the file the
// host resolves cannot drift apart.
//
// Path-shaped rather than `?path=`: the iframe loads the page with `src=`, so
// the browser resolves the page's own relative refs (`<img src="../img/x.png">`)
// against this URL. A query parameter would put every page at the same URL path
// and break every relative reference — the same reason `/artifacts/html` is a
// path mount (plans/done/feat-files-html-preview-relative-paths.md).
//
// The scope segment is what lets a workspace-relative and an absolute path share
// one mount: a leading `/` cannot survive as a URL path segment, and the
// browser's `..`-normalisation would eat any marker encoded as an empty one.

export const HTML_FILE_MOUNT = "/htmlfile";
export const HTML_FILE_SCOPE_WORKSPACE = "ws";
export const HTML_FILE_SCOPE_ABSOLUTE = "abs";

/**
 * Browser URL for a page served through the `/htmlfile` mount, or null when the
 * value is not a usable HTML path.
 *
 * UNC paths (`\\server\share\page.html`) would round-trip as if they were rooted
 * POSIX paths, so they are not supported — the host's file check simply 404s
 * rather than serving the wrong file.
 */
export function htmlFileUrl(filePath: string | null | undefined): string | null {
  if (!filePath || filePath.includes("\0")) return null;
  const lower = filePath.toLowerCase();
  if (!lower.endsWith(".html") && !lower.endsWith(".htm")) return null;
  const segments = filePath
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) return null;
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  // The mount refuses dotfile segments, so a URL for one would only 404.
  if (hasDotfileSegment(filePath)) return null;
  const scope = isAbsoluteFilePathValue(filePath) ? HTML_FILE_SCOPE_ABSOLUTE : HTML_FILE_SCOPE_WORKSPACE;
  return `${HTML_FILE_MOUNT}/${scope}/${segments.map(encodeURIComponent).join("/")}`;
}
