// Branch coverage for the shared `presentDocument` executor — the
// host-agnostic create path in `@mulmoclaude/markdown-plugin`
// (`src/core/plugin.ts`), which MulmoTerminal and any other host reach
// through `pluginCore.execute`.
//
// `markdown` and `path` are mutually exclusive (same contract as
// presentHtml's `html` / `path`), so the cases that matter are the
// pairings the LLM can produce: both, neither, a bad path, a path whose
// file is missing, and each valid form. The host app is a stub — these
// assertions are about the dispatcher's decisions, not about any host's
// storage.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeDocument, type MarkdownHostApp } from "@mulmoclaude/markdown-plugin";
import type { ToolContext } from "gui-chat-protocol";

const EXISTING = "artifacts/documents/2026/07/existing-abc123.md";

interface StubCalls {
  loadDoc: string[];
  saveNewDoc: { prefix: string; markdown: string }[];
  fillImages: string[];
}

/** `missing` is the set of paths whose `loadDoc` rejects, standing in for
 *  a file that is not on disk. */
function stubApp(missing: ReadonlySet<string> = new Set()): { app: MarkdownHostApp; calls: StubCalls } {
  const calls: StubCalls = { loadDoc: [], saveNewDoc: [], fillImages: [] };
  const app: MarkdownHostApp = {
    async loadDoc(path) {
      calls.loadDoc.push(path);
      if (missing.has(path)) throw new Error(`ENOENT: ${path}`);
      return { content: "# existing\n" };
    },
    async saveDoc(path) {
      return { path };
    },
    async saveNewDoc(prefix, markdown) {
      calls.saveNewDoc.push({ prefix, markdown });
      return { path: `artifacts/documents/2026/07/${prefix}-new123.md` };
    },
    async marpThemes() {
      return { themes: [] };
    },
    async exportPdf() {
      return { pdfBase64: "" };
    },
    async fillImages(markdown) {
      calls.fillImages.push(markdown);
      return { markdown };
    },
  };
  return { app, calls };
}

function contextFor(app: MarkdownHostApp): ToolContext {
  return { app } as unknown as ToolContext;
}

describe("presentDocument core — markdown / path mutual exclusion", () => {
  it("rejects both `markdown` and `path`", async () => {
    const { app, calls } = stubApp();
    const result = await executeDocument(contextFor(app), { title: "T", markdown: "# hi", path: EXISTING });

    assert.equal(result.data, undefined, "a rejected call must not present anything");
    assert.match(result.message, /not both/);
    assert.deepEqual(calls.saveNewDoc, [], "nothing should be saved");
    assert.deepEqual(calls.loadDoc, [], "nothing should be loaded");
  });

  it("rejects neither `markdown` nor `path`", async () => {
    const { app, calls } = stubApp();
    const result = await executeDocument(contextFor(app), { title: "T" });

    assert.equal(result.data, undefined);
    assert.match(result.message, /either `markdown` or `path`/);
    assert.deepEqual(calls.saveNewDoc, []);
  });
});

describe("presentDocument core — `path` form", () => {
  it("presents an existing document without re-saving it", async () => {
    const { app, calls } = stubApp();
    const result = await executeDocument(contextFor(app), { title: "Report", path: EXISTING });

    assert.equal(result.data?.markdown, EXISTING, "data.markdown carries the caller's path verbatim");
    assert.equal(result.data?.docPath, EXISTING, "docPath is what current readers consult");
    assert.deepEqual(calls.saveNewDoc, [], "the `path` form must not write a copy");
    assert.deepEqual(calls.loadDoc, [EXISTING], "existence is probed through loadDoc");
  });

  it("rejects a traversal path before touching the host", async () => {
    const { app, calls } = stubApp();
    const result = await executeDocument(contextFor(app), { title: "T", path: "artifacts/documents/../../secrets.md" });

    assert.equal(result.data, undefined);
    assert.match(result.message, /`\.` \/ `\.\.` segments/);
    assert.deepEqual(calls.loadDoc, [], "a bad path must not reach the host's file layer");
  });

  it("rejects a non-markdown path", async () => {
    const { app, calls } = stubApp();
    const result = await executeDocument(contextFor(app), { title: "T", path: "docs/design.txt" });

    assert.equal(result.data, undefined);
    assert.deepEqual(calls.loadDoc, []);
  });

  // The widening this file exists to pin: a document the tool did NOT write
  // (a repo file, an absolute path) is presented the same way as one it did.
  it("presents a document outside artifacts/documents/", async () => {
    const { app, calls } = stubApp();
    const result = await executeDocument(contextFor(app), { title: "T", path: "docs/design.md" });

    assert.equal(result.data?.docPath, "docs/design.md");
    assert.deepEqual(calls.saveNewDoc, [], "no copy is written");
    assert.deepEqual(calls.loadDoc, ["docs/design.md"]);
  });

  it("presents an absolute path", async () => {
    const { app } = stubApp();
    const result = await executeDocument(contextFor(app), { title: "T", path: "/Users/x/project/README.md" });

    assert.equal(result.data?.docPath, "/Users/x/project/README.md");
  });

  it("reports a document the host refuses to open rather than presenting it", async () => {
    const missing = "artifacts/documents/2026/07/gone-zzz999.md";
    const { app, calls } = stubApp(new Set([missing]));
    const result = await executeDocument(contextFor(app), { title: "T", path: missing });

    assert.equal(result.data, undefined, "a missing file must not render as a presented document");
    assert.match(result.message, /Cannot open/);
    assert.deepEqual(calls.loadDoc, [missing]);
  });
});

describe("presentDocument core — `markdown` form", () => {
  it("fills images and saves under the given prefix", async () => {
    const { app, calls } = stubApp();
    const result = await executeDocument(contextFor(app), { title: "T", markdown: "# hi", filenamePrefix: "my-report" });

    assert.equal(result.data?.markdown, "artifacts/documents/2026/07/my-report-new123.md");
    assert.deepEqual(calls.fillImages, ["# hi"]);
    assert.deepEqual(calls.saveNewDoc, [{ prefix: "my-report", markdown: "# hi" }]);
  });

  // `filenamePrefix` became conditional when `path` arrived — JSON Schema
  // cannot say "required only with `markdown`", so a caller reading
  // `required` may legitimately omit it. Both hosts default rather than
  // fail; this pins that the two agree.
  it("defaults the prefix when it is omitted", async () => {
    const { app, calls } = stubApp();
    const result = await executeDocument(contextFor(app), { title: "T", markdown: "# hi" });

    assert.ok(result.data?.markdown, "a missing prefix must still produce a document");
    assert.equal(calls.saveNewDoc[0]?.prefix, "document");
  });
});
