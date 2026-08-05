// MulmoClaude's implementation of the markdown plugin's host-capability
// surface (task #6). Builds a `MarkdownHostApp` over MulmoClaude's
// existing backends (Puppeteer PDF, Gemini image-fill, the
// artifacts/documents store, workspace Marp themes) and registers it as
// the built-in "markdown" dispatch handler. Imported for side effect at
// boot (server/index.ts) so the markdown View's
// `useRuntime().dispatch({ kind })` resolves.
//
// These are THIN adapters: each method delegates to the same server
// function the legacy REST routes used, so behaviour can't drift. At
// extraction (Phase 3) `core`/`contract` move into
// `@mulmoclaude/markdown-plugin` and this file stays behind as
// MulmoClaude's host adapter.

import { executeMarkdown, isMarkdownDispatchArgs } from "@mulmoclaude/markdown-plugin";
import type { MarkdownHostApp } from "@mulmoclaude/markdown-plugin";
import { loadDocumentBookmarkPattern } from "@mulmoclaude/core/global-config";
import { saveMarkdown } from "../utils/files/markdown-store.js";
import { loadDocument, overwriteDocument } from "../utils/files/document-store.js";
import { publishFileChange } from "../events/file-change.js";
import { listMarpThemes } from "../workspace/marp-themes.js";
import { renderMarkdownPdf } from "../api/routes/pdf.js";
import { fillMarkdownImagePlaceholders } from "../utils/files/markdown-image-fill.js";
import { describeKind, registerBuiltinDispatch } from "./builtin-dispatch.js";

/** Scope name — matches `wrapWithScope("markdown", …)` in
 *  `src/plugins/markdown/index.ts`, which is what the View's
 *  `useRuntime().dispatch` uses as the `:pkg` path segment. */
const MARKDOWN_SCOPE = "markdown";

const markdownHostApp: MarkdownHostApp = {
  async loadDoc(path) {
    // Any `.md` the tool was pointed at, not just this app's own
    // `artifacts/documents/*.md` — see `document-store.ts` for what that
    // widening does and does not allow.
    return { content: await loadDocument(path) };
  },
  async saveDoc(path, markdown) {
    await overwriteDocument(path, markdown);
    // Fire-and-forget: refresh sibling tabs / agents watching this file.
    void publishFileChange(path);
    return { path };
  },
  async saveNewDoc(prefix, markdown) {
    // The package's context.app create path (MulmoTerminal); MulmoClaude's
    // own tool-call create still uses POST /api/markdown, but implementing
    // this keeps the host app conformant + usable either way.
    const path = await saveMarkdown(markdown, prefix);
    return { path };
  },
  async marpThemes() {
    return { themes: listMarpThemes() };
  },
  async exportPdf(options) {
    const buffer = await renderMarkdownPdf({
      markdown: options.markdown,
      marp: options.marp,
      baseDir: options.baseDir,
      format: options.format,
      stripFrontmatter: options.stripFrontmatter,
    });
    // base64 so the result survives the JSON dispatch hop; the View
    // decodes it back to a Blob for download.
    return { pdfBase64: buffer.toString("base64") };
  },
  async fillImages(markdown) {
    return { markdown: await fillMarkdownImagePlaceholders(markdown) };
  },
  async bookmarkPattern() {
    // `~/.config/mulmo/config.json` — deliberately NOT the workspace's
    // `config/settings.json`: the same value has to reach MulmoTerminal, and
    // the two apps share a machine rather than a workspace.
    return { pattern: await loadDocumentBookmarkPattern() };
  },
};

// `args` is whatever the View put on the wire. `executeMarkdown` switches on
// `kind` and forwards the rest to the host app unchecked, so narrowing here is
// what keeps a malformed payload from reaching a backend as `undefined`.
registerBuiltinDispatch(MARKDOWN_SCOPE, (args) => {
  if (!isMarkdownDispatchArgs(args)) {
    throw new Error(`markdown plugin: unrecognised dispatch payload (kind=${describeKind(args)})`);
  }
  return executeMarkdown({ app: markdownHostApp }, args);
});
