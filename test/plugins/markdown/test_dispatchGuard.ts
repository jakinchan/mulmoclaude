// Guard for the markdown dispatch envelope.
//
// A dispatch payload arrives from the View over the host's HTTP surface, so it
// is untyped data. The host used to assert it (`args as unknown as
// MarkdownDispatchArgs`), and `executeMarkdown` switches on `kind` and hands
// the remaining fields straight to the host app WITHOUT checking them — so an
// absent `path` reached a backend as `undefined` rather than being refused.
//
// (Lives here rather than in the package: markdown-plugin has no in-package
// test runner — `test/plugins/markdown/` is where its host-side tests already
// live.)

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isMarkdownDispatchArgs } from "@mulmoclaude/markdown-plugin";

describe("isMarkdownDispatchArgs — accepts well-formed payloads", () => {
  it("accepts loadDoc with a path", () => {
    assert.equal(isMarkdownDispatchArgs({ kind: "loadDoc", path: "artifacts/documents/a.md" }), true);
  });

  it("accepts saveDoc with a path and markdown", () => {
    assert.equal(isMarkdownDispatchArgs({ kind: "saveDoc", path: "artifacts/documents/a.md", markdown: "# hi" }), true);
  });

  // The only kind with no payload — it must not require fields it never has.
  it("accepts marpThemes with no other fields", () => {
    assert.equal(isMarkdownDispatchArgs({ kind: "marpThemes" }), true);
  });

  it("accepts fillImages with markdown", () => {
    assert.equal(isMarkdownDispatchArgs({ kind: "fillImages", markdown: "# hi" }), true);
  });

  it("accepts exportPdf with only its required fields", () => {
    assert.equal(isMarkdownDispatchArgs({ kind: "exportPdf", markdown: "# hi", filename: "a.pdf" }), true);
  });

  it("accepts exportPdf with every optional field supplied", () => {
    const args = { kind: "exportPdf", markdown: "# hi", filename: "a.pdf", marp: true, baseDir: "artifacts", format: "A4", stripFrontmatter: false };
    assert.equal(isMarkdownDispatchArgs(args), true);
  });
});

describe("isMarkdownDispatchArgs — rejects what the assertion used to admit", () => {
  it("rejects a missing required field", () => {
    assert.equal(isMarkdownDispatchArgs({ kind: "loadDoc" }), false);
    assert.equal(isMarkdownDispatchArgs({ kind: "saveDoc", path: "a.md" }), false);
    assert.equal(isMarkdownDispatchArgs({ kind: "fillImages" }), false);
    assert.equal(isMarkdownDispatchArgs({ kind: "exportPdf", markdown: "# hi" }), false);
  });

  it("rejects a wrongly-typed required field", () => {
    assert.equal(isMarkdownDispatchArgs({ kind: "loadDoc", path: 42 }), false);
    assert.equal(isMarkdownDispatchArgs({ kind: "saveDoc", path: "a.md", markdown: null }), false);
  });

  // An optional field that IS present must still be the right type — otherwise
  // the guard would pass junk straight through to the PDF pipeline.
  it("rejects a wrongly-typed optional field", () => {
    const base = { kind: "exportPdf", markdown: "# hi", filename: "a.pdf" };
    assert.equal(isMarkdownDispatchArgs({ ...base, marp: "yes" }), false);
    assert.equal(isMarkdownDispatchArgs({ ...base, baseDir: 1 }), false);
    assert.equal(isMarkdownDispatchArgs({ ...base, stripFrontmatter: "no" }), false);
  });

  it("rejects a format outside the supported set", () => {
    const base = { kind: "exportPdf", markdown: "# hi", filename: "a.pdf" };
    assert.equal(isMarkdownDispatchArgs({ ...base, format: "A4" }), true);
    assert.equal(isMarkdownDispatchArgs({ ...base, format: "Letter" }), true);
    assert.equal(isMarkdownDispatchArgs({ ...base, format: "A3" }), false);
  });

  it("rejects an unknown kind", () => {
    assert.equal(isMarkdownDispatchArgs({ kind: "deleteDoc", path: "a.md" }), false);
  });

  it("rejects a missing or non-string kind", () => {
    assert.equal(isMarkdownDispatchArgs({ path: "a.md" }), false);
    assert.equal(isMarkdownDispatchArgs({ kind: 7 }), false);
  });

  it("rejects non-objects", () => {
    for (const value of [null, undefined, "loadDoc", 7, []]) {
      assert.equal(isMarkdownDispatchArgs(value), false, `expected ${JSON.stringify(value)} to be rejected`);
    }
  });

  // `kind` is attacker-supplied, so looking it up must not read through the
  // prototype chain. Measured against the object-literal version this guard
  // first shipped with: `"constructor"` and `"toString"` returned truthy (the
  // guard reported VALID), and `"__proto__"` / `"hasOwnProperty"` made it
  // THROW — so the caller's `if (!isMarkdownDispatchArgs(…))` never ran at
  // all. A `Map` has no such keys.
  it("rejects Object.prototype key names as kinds", () => {
    for (const kind of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "isPrototypeOf"]) {
      assert.equal(isMarkdownDispatchArgs({ kind, path: "a.md", markdown: "# hi", filename: "a.pdf" }), false, `expected kind="${kind}" to be rejected`);
    }
  });

  it("does not throw on a prototype key name (a guard that throws is not a guard)", () => {
    for (const kind of ["__proto__", "hasOwnProperty"]) {
      assert.doesNotThrow(() => isMarkdownDispatchArgs({ kind }), `kind="${kind}" must return false, not throw`);
    }
  });
});
