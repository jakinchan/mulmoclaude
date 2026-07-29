// The `/htmlfile` scheme, both halves at once: the client builds a URL
// (`src/config/htmlFileUrl.ts`), the server turns it back into a file
// (`server/utils/files/htmlFileRequest.ts`). They are separate modules that
// only agree by construction, so the round-trip is the test that matters —
// a scope segment renamed on one side and not the other would otherwise
// surface as an iframe that silently 404s.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "path";
import { htmlFileUrl, HTML_FILE_MOUNT } from "@mulmoclaude/html-plugin";
import { resolveHtmlFileRequestPath } from "@mulmoclaude/core/files";

const WORKSPACE = "/tmp/ws-root";

/** What express hands the mount: the URL with the mount prefix stripped. */
function requestPathFor(url: string): string {
  return url.slice(HTML_FILE_MOUNT.length);
}

function roundTrip(filePath: string): string | null {
  const url = htmlFileUrl(filePath);
  if (url === null) return null;
  return resolveHtmlFileRequestPath(WORKSPACE, requestPathFor(url));
}

describe("htmlFileUrl", () => {
  it("scopes workspace-relative and absolute paths differently", () => {
    assert.equal(htmlFileUrl("docs/report.html"), "/htmlfile/ws/docs/report.html");
    assert.equal(htmlFileUrl("/Users/x/p/page.html"), "/htmlfile/abs/Users/x/p/page.html");
  });

  // Windows spellings, recognised on every platform because the value may come
  // from a remote host. A single leading backslash is root-relative, not a
  // workspace path — `path.resolve` on Windows sends it to the drive root.
  it("scopes Windows drive and root-relative paths as absolute", () => {
    assert.equal(htmlFileUrl("C:\\proj\\page.html"), "/htmlfile/abs/C%3A/proj/page.html");
    assert.equal(htmlFileUrl("\\dir\\page.html"), "/htmlfile/abs/dir/page.html");
  });

  it("encodes segments so spaces and reserved characters survive", () => {
    assert.equal(htmlFileUrl("docs/my report.html"), "/htmlfile/ws/docs/my%20report.html");
    assert.equal(htmlFileUrl("docs/a?b.html"), "/htmlfile/ws/docs/a%3Fb.html");
  });

  it("returns null for non-HTML, traversal, empty and NUL-bearing values", () => {
    assert.equal(htmlFileUrl("docs/report.md"), null);
    assert.equal(htmlFileUrl("../secret.html"), null);
    assert.equal(htmlFileUrl("docs/../../secret.html"), null);
    assert.equal(htmlFileUrl(""), null);
    assert.equal(htmlFileUrl(null), null);
    assert.equal(htmlFileUrl("docs/a\0.html"), null);
  });
});

describe("resolveHtmlFileRequestPath", () => {
  it("round-trips a workspace-relative page", () => {
    assert.equal(roundTrip("docs/report.html"), path.resolve(WORKSPACE, "docs/report.html"));
  });

  it("round-trips an absolute page", () => {
    assert.equal(roundTrip("/Users/x/p/page.html"), path.resolve("/Users/x/p/page.html"));
  });

  it("round-trips a page whose name needs encoding", () => {
    assert.equal(roundTrip("docs/my report.html"), path.resolve(WORKSPACE, "docs/my report.html"));
  });

  it("refuses an unknown scope segment", () => {
    assert.equal(resolveHtmlFileRequestPath(WORKSPACE, "/etc/passwd.html"), null);
    assert.equal(resolveHtmlFileRequestPath(WORKSPACE, "/page.html"), null);
  });

  it("refuses traversal, empty and dotfile segments", () => {
    assert.equal(resolveHtmlFileRequestPath(WORKSPACE, "/ws/../../etc/passwd.html"), null);
    assert.equal(resolveHtmlFileRequestPath(WORKSPACE, "/abs/etc/../../x.html"), null);
    assert.equal(resolveHtmlFileRequestPath(WORKSPACE, "/ws//page.html"), null);
    assert.equal(resolveHtmlFileRequestPath(WORKSPACE, "/ws/.hidden/page.html"), null);
    assert.equal(resolveHtmlFileRequestPath(WORKSPACE, "/ws/.env.html"), null);
  });

  it("refuses a malformed percent escape rather than throwing", () => {
    assert.equal(resolveHtmlFileRequestPath(WORKSPACE, "/ws/%ZZ.html"), null);
  });

  // Segmentation happens BEFORE decoding, so an encoded separator would
  // otherwise smuggle path boundaries past the `..` / dotfile checks and only
  // split apart inside `path.resolve`.
  it("refuses encoded separators that would smuggle extra segments", () => {
    assert.equal(resolveHtmlFileRequestPath(WORKSPACE, "/ws/a%2F..%2F..%2Ftmp%2Fx.html"), null);
    assert.equal(resolveHtmlFileRequestPath(WORKSPACE, "/ws/a%5C..%5Cx.html"), null);
    assert.equal(resolveHtmlFileRequestPath(WORKSPACE, "/abs/etc%2F..%2F..%2Fx.html"), null);
    assert.equal(resolveHtmlFileRequestPath(WORKSPACE, "/ws/%2E%2E/x.html"), null);
    assert.equal(resolveHtmlFileRequestPath(WORKSPACE, "/ws/sub%2F.hidden.html"), null);
  });

  // `classifyFilePath` recognises `C:\proj\x.html` on every platform (the value
  // may come from a remote host), but only this platform's `path` can say where
  // it lands. On POSIX it would resolve under the process cwd — a different
  // file than anyone named — so the resolver refuses rather than guessing.
  it("refuses a Windows-drive path on a POSIX host", { skip: process.platform === "win32" }, () => {
    assert.equal(resolveHtmlFileRequestPath(WORKSPACE, "/abs/C%3A/proj/page.html"), null);
  });

  it("refuses a scope with no path after it", () => {
    assert.equal(resolveHtmlFileRequestPath(WORKSPACE, "/ws"), null);
    assert.equal(resolveHtmlFileRequestPath(WORKSPACE, "/abs/"), null);
  });
});
