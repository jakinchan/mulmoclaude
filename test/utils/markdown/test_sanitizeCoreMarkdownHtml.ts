// Tests for `@mulmoclaude/core/plugin-vue`'s `sanitizeMarkdownHtml` — the copy
// the markdown plugin's View uses before injecting `marked` output with
// `v-html`.
//
// This became load-bearing when presentDocument's `path` argument was widened
// to any `.md` on disk: the view can now render a file that came with a cloned
// repository, so raw HTML in it is untrusted input to the app's origin (which
// holds the session and can reach `/api/*`). The host's own wrapper is covered
// by `test_sanitize.ts`; this pins the plugin-facing one, including that the
// wiki's YouTube embed still survives.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// `dompurify` reads `window` at module load, and tests run in Node — wire JSDOM
// into globals BEFORE importing the wrapper (same as `test_sanitize.ts`).
const dom = new JSDOM("<!doctype html><html><body></body></html>");
(globalThis as { window?: unknown; document?: unknown }).window = dom.window;
(globalThis as { window?: unknown; document?: unknown }).document = dom.window.document;

const { sanitizeMarkdownHtml } = await import("@mulmoclaude/core/plugin-vue");

describe("core sanitizeMarkdownHtml — untrusted markdown", () => {
  it("strips an inline event handler", () => {
    const output = sanitizeMarkdownHtml('<p><img src="x" onerror="fetch(\'/api/steal\')"></p>');
    assert.doesNotMatch(output, /onerror/i);
    assert.match(output, /<img/);
  });

  it("strips a script element", () => {
    const output = sanitizeMarkdownHtml("<p>hi</p><script>alert(1)</script>");
    assert.doesNotMatch(output, /<script/i);
    assert.match(output, /hi/);
  });

  it("strips a javascript: link target", () => {
    const output = sanitizeMarkdownHtml('<a href="javascript:alert(1)">click</a>');
    assert.doesNotMatch(output, /javascript:/i);
  });

  it("strips an SVG script payload", () => {
    const output = sanitizeMarkdownHtml("<svg><script>alert(1)</script></svg>");
    assert.doesNotMatch(output, /<script/i);
  });

  it("strips an iframe pointing anywhere but the YouTube embed host", () => {
    assert.doesNotMatch(sanitizeMarkdownHtml('<iframe src="https://evil.example/x"></iframe>'), /<iframe/);
  });

  it("keeps ordinary markdown output, including task-list checkboxes", () => {
    const output = sanitizeMarkdownHtml('<ul><li><input type="checkbox" checked data-task-line="3"> done</li></ul>');
    assert.match(output, /<input/);
    assert.match(output, /data-task-line="3"/);
  });

  it("keeps the canonical youtube-nocookie embed the wiki renderer emits", () => {
    const output = sanitizeMarkdownHtml('<iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ" allowfullscreen></iframe>');
    assert.match(output, /<iframe/);
    assert.match(output, /youtube-nocookie\.com\/embed\/dQw4w9WgXcQ/);
  });
});
