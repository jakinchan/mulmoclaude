// The `/htmlfile` scheme, both halves at once: the client builds a URL
// (`src/config/htmlFileUrl.ts`), the server turns it back into a file
// (`server/utils/files/htmlFileRequest.ts`). They are separate modules that
// only agree by construction, so the round-trip is the test that matters —
// a scope segment renamed on one side and not the other would otherwise
// surface as an iframe that silently 404s.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "path";
import { htmlFileUrlFor, HTML_FILE_MOUNT } from "../../src/utils/html/htmlFileUrl.js";
import { resolveHtmlFileRequestPath } from "../../server/utils/files/htmlFileRequest.js";

const WORKSPACE = "/tmp/ws-root";

/** What express hands the mount: the URL with the mount prefix stripped. */
function requestPathFor(url: string): string {
  return url.slice(HTML_FILE_MOUNT.length);
}

function roundTrip(filePath: string): string | null {
  const url = htmlFileUrlFor(filePath);
  if (url === null) return null;
  return resolveHtmlFileRequestPath(WORKSPACE, requestPathFor(url));
}

describe("htmlFileUrlFor", () => {
  it("scopes workspace-relative and absolute paths differently", () => {
    assert.equal(htmlFileUrlFor("docs/report.html"), "/htmlfile/ws/docs/report.html");
    assert.equal(htmlFileUrlFor("/Users/x/p/page.html"), "/htmlfile/abs/Users/x/p/page.html");
  });

  it("encodes segments so spaces and reserved characters survive", () => {
    assert.equal(htmlFileUrlFor("docs/my report.html"), "/htmlfile/ws/docs/my%20report.html");
    assert.equal(htmlFileUrlFor("docs/a?b.html"), "/htmlfile/ws/docs/a%3Fb.html");
  });

  it("returns null for non-HTML, traversal, empty and NUL-bearing values", () => {
    assert.equal(htmlFileUrlFor("docs/report.md"), null);
    assert.equal(htmlFileUrlFor("../secret.html"), null);
    assert.equal(htmlFileUrlFor("docs/../../secret.html"), null);
    assert.equal(htmlFileUrlFor(""), null);
    assert.equal(htmlFileUrlFor(null), null);
    assert.equal(htmlFileUrlFor("docs/a\0.html"), null);
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

  it("refuses a scope with no path after it", () => {
    assert.equal(resolveHtmlFileRequestPath(WORKSPACE, "/ws"), null);
    assert.equal(resolveHtmlFileRequestPath(WORKSPACE, "/abs/"), null);
  });
});
