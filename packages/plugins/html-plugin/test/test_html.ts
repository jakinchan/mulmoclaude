import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { executeHtml, executeHtmlUpdate, type HtmlExecuteContext } from "../src/core/plugin";
import { executeHtmlDispatch, type HtmlDispatchContext } from "../src/core/dispatch";
import { htmlArtifactPath, htmlArtifactPreviewUrl, isHtmlArtifactPath, toArtifactsRelative, slugify } from "../src/core/paths";

// Minimal in-memory FileOps stand-in. Only the methods the html core touches
// (`read`, `write`, `exists`) are implemented; the rest throw so an accidental
// new dependency surfaces loudly in tests. Backs both `files.artifacts` and the
// `files.byPath` capability the widened `path` form needs.
const fakeFileOps = (store: Map<string, string>) => makeStoreOps(store);

function makeFakeArtifacts(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  const artifacts = makeStoreOps(store);
  return { store, context: { files: { artifacts } } as unknown as HtmlExecuteContext };
}

function makeStoreOps(store: Map<string, string>) {
  return {
    async read(rel: string) {
      const hit = store.get(rel);
      if (hit === undefined) throw new Error(`ENOENT ${rel}`);
      return hit;
    },
    async write(rel: string, content: string | Uint8Array) {
      store.set(rel, typeof content === "string" ? content : Buffer.from(content).toString("utf8"));
    },
    async exists(rel: string) {
      return store.has(rel);
    },
    async readBytes() {
      throw new Error("not implemented");
    },
    async readDir() {
      throw new Error("not implemented");
    },
    async stat() {
      throw new Error("not implemented");
    },
    async unlink() {
      throw new Error("not implemented");
    },
  };
}

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    assert.equal(slugify("The Cell!"), "the-cell");
  });
  it("falls back for empty / undefined", () => {
    assert.equal(slugify(undefined), "page");
    assert.equal(slugify("   "), "page");
    assert.equal(slugify("***", "fb"), "fb");
  });
});

describe("isHtmlArtifactPath", () => {
  it("accepts a canonical artifacts/html path", () => {
    assert.ok(isHtmlArtifactPath("artifacts/html/2026/06/the-cell-1.html"));
  });
  it("rejects non-html, wrong root, traversal, empty segments", () => {
    assert.equal(isHtmlArtifactPath("artifacts/html/x.txt"), false);
    assert.equal(isHtmlArtifactPath("artifacts/images/x.html"), false);
    assert.equal(isHtmlArtifactPath("artifacts/html/../secret.html"), false);
    assert.equal(isHtmlArtifactPath("artifacts/html//x.html"), false);
    assert.equal(isHtmlArtifactPath("html/x.html"), false);
  });
});

describe("toArtifactsRelative", () => {
  it("strips the artifacts/ prefix", () => {
    assert.equal(toArtifactsRelative("artifacts/html/2026/06/x.html"), "html/2026/06/x.html");
  });
});

describe("htmlArtifactPath", () => {
  it("partitions by UTC YYYY/MM and pairs relPath with workspace filePath", () => {
    const { relPath, filePath } = htmlArtifactPath("The Cell", new Date(Date.UTC(2026, 5, 19, 12, 0, 0)));
    assert.match(relPath, /^html\/2026\/06\/the-cell-\d+\.html$/);
    assert.equal(filePath, `artifacts/${relPath}`);
  });
});

describe("executeHtml", () => {
  it("saves inline html and returns its filePath", async () => {
    const { store, context } = makeFakeArtifacts();
    const result = await executeHtml(context, { html: "<!DOCTYPE html><html></html>", title: "Hi" });
    const { data } = result;
    assert.ok(data);
    assert.match(data.filePath, /^artifacts\/html\/\d{4}\/\d{2}\/hi-\d+\.html$/);
    assert.equal(store.get(toArtifactsRelative(data.filePath)), "<!DOCTYPE html><html></html>");
  });

  it("presents an existing path without re-saving", async () => {
    const { store, context } = makeFakeArtifacts({ "html/2026/06/lesson-1.html": "<x>" });
    const result = await executeHtml(context, { path: "artifacts/html/2026/06/lesson-1.html" });
    const { data } = result;
    assert.ok(data);
    assert.equal(data.filePath, "artifacts/html/2026/06/lesson-1.html");
    assert.equal(store.size, 1); // nothing written
  });

  it("errors on a missing existing path", async () => {
    const { context } = makeFakeArtifacts();
    const result = await executeHtml(context, { path: "artifacts/html/2026/06/nope.html" });
    assert.ok(!("data" in result) || !result.data);
    assert.match(result.message, /No HTML file exists/);
  });

  it("rejects both html and path", async () => {
    const { context } = makeFakeArtifacts();
    const result = await executeHtml(context, { html: "<x>", path: "artifacts/html/x.html" });
    assert.match(result.message, /not both/);
  });

  it("rejects neither", async () => {
    const { context } = makeFakeArtifacts();
    const result = await executeHtml(context, {});
    assert.match(result.message, /provide either/);
  });

  // Without a `files.byPath` capability the host has not opted into pages
  // outside `artifacts/html/`, so `path` keeps its original meaning — an older
  // host degrades to the previous behaviour rather than mis-resolving.
  it("rejects a non-artifact path when the host provides no byPath FileOps", async () => {
    const { context } = makeFakeArtifacts({ "../etc/passwd": "x" });
    const result = await executeHtml(context, { path: "artifacts/secrets/x.html" });
    assert.match(result.message, /\.html file/);
    assert.equal(result.data, undefined);
  });

  it("presents a page outside artifacts/html/ through byPath", async () => {
    const { context } = makeFakeArtifacts();
    const byPath = fakeFileOps(new Map([["docs/report.html", "<p>hi</p>"]]));
    const result = await executeHtml({ files: { ...context.files, byPath } }, { path: "docs/report.html", title: "T" });
    assert.equal(result.data?.filePath, "docs/report.html");
  });

  // Accepting a path the preview mount will not serve would report success for
  // a page that can never render.
  it("rejects a dotfile path even though it names a real file", async () => {
    const { context } = makeFakeArtifacts();
    const byPath = fakeFileOps(new Map([[".hidden/page.html", "<p>hi</p>"]]));
    const result = await executeHtml({ files: { ...context.files, byPath } }, { path: ".hidden/page.html" });
    assert.equal(result.data, undefined);
  });

  it("still rejects traversal when byPath is available", async () => {
    const { context } = makeFakeArtifacts();
    const byPath = fakeFileOps(new Map());
    const result = await executeHtml({ files: { ...context.files, byPath } }, { path: "docs/../../secret.html" });
    assert.equal(result.data, undefined);
  });
});

describe("htmlArtifactPreviewUrl", () => {
  it("derives the served URL from a clean filePath (per-segment encoded)", () => {
    assert.equal(htmlArtifactPreviewUrl("artifacts/html/2026/06/the cell.html"), "/artifacts/html/2026/06/the%20cell.html");
  });
  it("returns null for non-html and for traversal inside the artifact root", () => {
    assert.equal(htmlArtifactPreviewUrl("artifacts/html/x.json"), null);
    assert.equal(htmlArtifactPreviewUrl("artifacts/html/../secret.html"), null);
    assert.equal(htmlArtifactPreviewUrl("artifacts/html//x.html"), null);
    assert.equal(htmlArtifactPreviewUrl(null), null);
  });

  // A page outside the artifact root is no longer "not ours" — the `path` form
  // presents any page on disk, and both hosts serve those from `/htmlfile`.
  it("falls through to the /htmlfile scheme for a page outside artifacts/html/", () => {
    assert.equal(htmlArtifactPreviewUrl("docs/report.html"), "/htmlfile/ws/docs/report.html");
    assert.equal(htmlArtifactPreviewUrl("/Users/x/p/page.html"), "/htmlfile/abs/Users/x/p/page.html");
    assert.equal(htmlArtifactPreviewUrl("docs/../../secret.html"), null);
  });
});

describe("executeHtmlDispatch", () => {
  function dispatchCtx(seed: Record<string, string> = {}) {
    const store = new Map<string, string>(Object.entries(seed));
    const artifacts = {
      async read(rel: string) {
        const hit = store.get(rel);
        if (hit === undefined) throw new Error(`ENOENT ${rel}`);
        return hit;
      },
      async write(rel: string, content: string | Uint8Array) {
        store.set(rel, typeof content === "string" ? content : Buffer.from(content).toString("utf8"));
      },
    };
    return { store, context: { files: { artifacts } } as unknown as HtmlDispatchContext };
  }

  it("loadHtml reads the page bytes", async () => {
    const { context } = dispatchCtx({ "html/2026/06/p.html": "<x>" });
    assert.deepEqual(await executeHtmlDispatch(context, { kind: "loadHtml", path: "artifacts/html/2026/06/p.html" }), { html: "<x>" });
  });

  it("saveHtml writes and echoes the path", async () => {
    const { store, context } = dispatchCtx();
    const result = await executeHtmlDispatch(context, { kind: "saveHtml", path: "artifacts/html/2026/06/p.html", html: "<y>" });
    assert.deepEqual(result, { path: "artifacts/html/2026/06/p.html" });
    assert.equal(store.get("html/2026/06/p.html"), "<y>");
  });

  it("rejects a bad path and a non-string saveHtml body", async () => {
    const { context } = dispatchCtx();
    await assert.rejects(() => executeHtmlDispatch(context, { kind: "loadHtml", path: "artifacts/evil/p.html" }), /\.html file/);
    await assert.rejects(() => executeHtmlDispatch(context, { kind: "loadHtml", path: 42 as unknown as string }), /\.html file/);
    await assert.rejects(
      () => executeHtmlDispatch(context, { kind: "saveHtml", path: "artifacts/html/2026/06/p.html", html: 5 as unknown as string }),
      /html.*string/,
    );
  });
});

describe("executeHtmlUpdate", () => {
  it("overwrites an existing page in place", async () => {
    const { store, context } = makeFakeArtifacts({ "html/2026/06/p.html": "old" });
    const result = await executeHtmlUpdate(context, { relativePath: "artifacts/html/2026/06/p.html", html: "new" });
    assert.deepEqual(result, { ok: true, filePath: "artifacts/html/2026/06/p.html" });
    assert.equal(store.get("html/2026/06/p.html"), "new");
  });

  it("rejects missing html and bad paths", async () => {
    const { context } = makeFakeArtifacts();
    assert.deepEqual(await executeHtmlUpdate(context, { relativePath: "artifacts/html/x.html", html: "" }), { ok: false, error: "html is required" });
    assert.deepEqual(await executeHtmlUpdate(context, { relativePath: "artifacts/evil/x.html", html: "y" }), { ok: false, error: "invalid html relativePath" });
  });
});
