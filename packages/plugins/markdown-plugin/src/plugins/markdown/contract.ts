// Host-agnostic capability contract for the markdown plugin (task #6 /
// markdown full-fidelity). The plugin's Vue View is decoupled from any
// one host's REST surface: it calls `useRuntime().dispatch({ kind, … })`
// (gui-chat-protocol's `BrowserPluginRuntime.dispatch`), the host routes
// that to the shared core `executeMarkdown(context, args)` (see
// `./core`), and the core reaches host backends through
// `context.app: MarkdownHostApp`.
//
// Each host implements `MarkdownHostApp` over its OWN backends:
//   - MulmoClaude  → `server/plugins/markdown-builtin.ts` (Puppeteer PDF,
//                    Gemini image-fill, artifacts/documents store).
//   - MulmoTerminal → its `server/backends/*` (next session).
//
// This file is the dispatch envelope: its types, plus the runtime guard
// that decides whether an incoming payload IS one of them. It imports
// nothing host-specific, so it lifts verbatim into
// `@mulmoclaude/markdown-plugin` at extraction (Phase 3).

import { isRecord } from "@mulmoclaude/common";

/** A workspace Marp theme: the slug authors reference via frontmatter
 *  `theme: <name>` and the CSS to register on the Marp themeSet. */
export interface MarpThemeEntry {
  readonly name: string;
  readonly css: string;
}

/** Options for a PDF export. `marp` switches to the slide pipeline;
 *  `baseDir` resolves workspace-relative `<img src>` references. */
export interface ExportPdfOptions {
  markdown: string;
  filename: string;
  marp?: boolean;
  baseDir?: string;
  format?: "Letter" | "A4";
  stripFrontmatter?: boolean;
}

/**
 * The host-capability surface a host injects via gui-chat-protocol's
 * `ToolContext.app`. Every method is async + JSON-serialisable in/out
 * so it survives the `dispatch` HTTP hop (which is why `exportPdf`
 * returns base64, not a binary Buffer).
 */
export interface MarkdownHostApp {
  /** Read a workspace-relative document's content. */
  loadDoc: (path: string) => Promise<{ content: string }>;
  /** Overwrite a workspace-relative document; returns the stored path.
   *  Implementations should also publish a file-change event so other
   *  views/tabs refresh (see the `file:<path>` pubsub channel). */
  saveDoc: (path: string, markdown: string) => Promise<{ path: string }>;
  /** Persist a NEW document (the tool-call create path) under a
   *  collision-safe path derived from `prefix`; returns the stored path. */
  saveNewDoc: (prefix: string, markdown: string) => Promise<{ path: string }>;
  /** List the workspace's Marp themes. */
  marpThemes: () => Promise<{ themes: MarpThemeEntry[] }>;
  /** Render markdown (or a Marp deck) to a PDF, returned base64-encoded. */
  exportPdf: (options: ExportPdfOptions) => Promise<{ pdfBase64: string }>;
  /** Replace `__too_be_replaced_image_path__` placeholders with
   *  generated images (degrades to text markers when unavailable). */
  fillImages: (markdown: string) => Promise<{ markdown: string }>;
}

// ── Dispatch envelope (what the View sends through `dispatch`) ───────

export interface LoadDocArgs {
  kind: "loadDoc";
  path: string;
}
export interface SaveDocArgs {
  kind: "saveDoc";
  path: string;
  markdown: string;
}
export interface MarpThemesArgs {
  kind: "marpThemes";
}
export interface ExportPdfArgs extends ExportPdfOptions {
  kind: "exportPdf";
}
export interface FillImagesArgs {
  kind: "fillImages";
  markdown: string;
}

/** Discriminated union of every action the View can `dispatch`. */
export type MarkdownDispatchArgs = LoadDocArgs | SaveDocArgs | MarpThemesArgs | ExportPdfArgs | FillImagesArgs;

/** Maps a dispatch `kind` to its result shape so the View can call
 *  `dispatch<MarkdownDispatchResult["loadDoc"]>(…)` without a cast. */
export interface MarkdownDispatchResult {
  loadDoc: { content: string };
  saveDoc: { path: string };
  marpThemes: { themes: MarpThemeEntry[] };
  exportPdf: { pdfBase64: string };
  fillImages: { markdown: string };
}

// ── Runtime guard ───────────────────────────────────────────────────
//
// A dispatch payload arrives from the View over the host's HTTP surface, so
// it is untyped data. `executeMarkdown` switches on `kind` and passes the
// other fields straight to the host app without checking them, so an absent
// `path` / `markdown` would reach a backend as `undefined` rather than being
// refused here. The guard lives beside the shapes it checks so every host
// narrows the same way instead of asserting by hand.
//
// Takes `unknown`: an interface gets no implicit index signature, so a
// predicate narrowing FROM `Record<string, unknown>` would not type-check.

const isString = (value: unknown): value is string => typeof value === "string";
const isOptional = (value: unknown, check: (candidate: unknown) => boolean): boolean => value === undefined || check(value);

/** Per-kind required-field check. `marpThemes` carries no payload.
 *
 *  A `Map`, not an object literal, because `kind` is attacker-supplied and an
 *  object index reads through the prototype chain. Measured with a literal:
 *  `kind: "constructor"` returned `Object`, whose call yields a truthy object,
 *  so the guard reported VALID; `kind: "toString"` likewise; and
 *  `"__proto__"` / `"hasOwnProperty"` made the guard THROW instead of
 *  returning false, so the caller's `if (!isMarkdownDispatchArgs(…))` never
 *  ran. Same reasoning as the `Map` in `@mulmoclaude/common`. */
const DISPATCH_SHAPE_CHECKS = new Map<string, (args: Record<string, unknown>) => boolean>([
  ["loadDoc", (args) => isString(args.path)],
  ["saveDoc", (args) => isString(args.path) && isString(args.markdown)],
  ["marpThemes", () => true],
  ["fillImages", (args) => isString(args.markdown)],
  [
    "exportPdf",
    (args) =>
      isString(args.markdown) &&
      isString(args.filename) &&
      isOptional(args.marp, (value) => typeof value === "boolean") &&
      isOptional(args.baseDir, isString) &&
      isOptional(args.format, (value) => value === "Letter" || value === "A4") &&
      isOptional(args.stripFrontmatter, (value) => typeof value === "boolean"),
  ],
]);

/** True when `value` is a well-formed dispatch payload for some known kind. */
export function isMarkdownDispatchArgs(value: unknown): value is MarkdownDispatchArgs {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  const check = DISPATCH_SHAPE_CHECKS.get(value.kind);
  return check !== undefined && check(value);
}
