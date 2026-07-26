// Guards for the dispatch envelope.
//
// A dispatch payload arrives from the View over the host's HTTP surface, so it
// is untyped data. Hosts used to assert it (`args as unknown as
// HtmlDispatchArgs`) — these guards replace that, and they only earn their
// keep if they actually reject the malformed shapes an assertion waved
// through, which is what this file pins.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isHtmlDispatchArgs, isPackHtmlArgs } from "../src/core/contract";

describe("isPackHtmlArgs", () => {
  it("accepts a well-formed packHtml payload", () => {
    assert.equal(isPackHtmlArgs({ kind: "packHtml", path: "artifacts/html/a.html" }), true);
  });

  it("rejects a different kind", () => {
    assert.equal(isPackHtmlArgs({ kind: "loadHtml", path: "artifacts/html/a.html" }), false);
  });

  it("rejects a missing or non-string path", () => {
    assert.equal(isPackHtmlArgs({ kind: "packHtml" }), false);
    assert.equal(isPackHtmlArgs({ kind: "packHtml", path: 42 }), false);
    assert.equal(isPackHtmlArgs({ kind: "packHtml", path: null }), false);
  });

  it("rejects non-objects", () => {
    for (const value of [null, undefined, "packHtml", 7, []]) {
      assert.equal(isPackHtmlArgs(value), false, `expected ${JSON.stringify(value)} to be rejected`);
    }
  });
});

describe("isHtmlDispatchArgs", () => {
  it("accepts loadHtml with a path", () => {
    assert.equal(isHtmlDispatchArgs({ kind: "loadHtml", path: "artifacts/html/a.html" }), true);
  });

  it("accepts saveHtml with a path and html", () => {
    assert.equal(isHtmlDispatchArgs({ kind: "saveHtml", path: "artifacts/html/a.html", html: "<p>hi</p>" }), true);
  });

  // The case with teeth: `html` absent would reach `files.artifacts.write` as
  // `undefined` and blank the artifact. An empty string is a legitimate
  // "clear the file", so only the TYPE is checked, not truthiness.
  it("rejects saveHtml without html", () => {
    assert.equal(isHtmlDispatchArgs({ kind: "saveHtml", path: "artifacts/html/a.html" }), false);
  });

  it("accepts saveHtml with an empty html string", () => {
    assert.equal(isHtmlDispatchArgs({ kind: "saveHtml", path: "artifacts/html/a.html", html: "" }), true);
  });

  it("rejects a non-string html", () => {
    assert.equal(isHtmlDispatchArgs({ kind: "saveHtml", path: "artifacts/html/a.html", html: 42 }), false);
  });

  it("rejects a missing or non-string path", () => {
    assert.equal(isHtmlDispatchArgs({ kind: "loadHtml" }), false);
    assert.equal(isHtmlDispatchArgs({ kind: "loadHtml", path: 42 }), false);
  });

  it("rejects an unknown kind", () => {
    assert.equal(isHtmlDispatchArgs({ kind: "deleteHtml", path: "artifacts/html/a.html" }), false);
  });

  // `packHtml` is handled host-side, before the package router — it must not
  // be admitted here or it would reach `executeHtmlDispatch`, which has no
  // branch for it.
  it("rejects packHtml (host intercepts it; the package router has no branch)", () => {
    assert.equal(isHtmlDispatchArgs({ kind: "packHtml", path: "artifacts/html/a.html" }), false);
  });

  it("rejects non-objects", () => {
    for (const value of [null, undefined, "loadHtml", 7, []]) {
      assert.equal(isHtmlDispatchArgs(value), false, `expected ${JSON.stringify(value)} to be rejected`);
    }
  });
});
