import type { FileOps, ToolPluginCore, ToolResult } from "gui-chat-protocol";
import { TOOL_DEFINITION } from "./definition";
import { htmlArtifactPath, isHtmlArtifactPath, isPresentableHtmlPath, toArtifactsRelative } from "./paths";
import type { HtmlArgs, PresentHtmlData, UpdateHtmlArgs } from "./types";

/** Host capabilities the html core needs, delivered through the GENERIC
 *  gui-chat-protocol runtime — only `files.artifacts` (the shared,
 *  user-browsable output area). No html-specific host method: all save /
 *  validate logic lives in this package. The host route additionally
 *  publishes a file-change event (host pubsub infra), which is orthogonal. */
export interface HtmlExecuteContext {
  files: {
    /** Rooted at `<workspace>/artifacts` — where NEW pages are written. */
    artifacts: FileOps;
    /** Reads / writes a page the caller named by path: workspace-relative or,
     *  where the host allows it, absolute. Supplied by hosts that let
     *  presentHtml open pages outside `artifacts/html/`; without it, `path`
     *  keeps its original `artifacts/html/**` -only meaning, so an older host
     *  degrades to the previous behaviour instead of mis-resolving. */
    byPath?: FileOps;
  };
}

const PRESENT_ACK = "Acknowledge that the HTML page has been presented to the user.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function toolError(message: string, instructions: string): ToolResult<PresentHtmlData> {
  return { message, instructions };
}

function presented(message: string, data: PresentHtmlData): ToolResult<PresentHtmlData> {
  return { message, data, instructions: PRESENT_ACK };
}

/** The FileOps that owns a given page, plus the path in that FileOps' terms.
 *  An `artifacts/html/**` page keeps going through `files.artifacts` — that is
 *  the only capability an older host provides, and it is what writes there —
 *  while anything else needs the host's `files.byPath`. */
function locate(context: HtmlExecuteContext, filePath: string): { files: FileOps; rel: string } | null {
  if (isHtmlArtifactPath(filePath)) return { files: context.files.artifacts, rel: toArtifactsRelative(filePath) };
  const byPath = context.files.byPath;
  if (byPath && isPresentableHtmlPath(filePath)) return { files: byPath, rel: filePath };
  return null;
}

/** Present an HTML page already on disk without re-saving — an artifact this
 *  tool wrote, or (where the host provides `files.byPath`) any page on disk.
 *  Validates the path shape + existence through the generic FileOps. */
async function presentExisting(context: HtmlExecuteContext, relativePath: string, title: string | undefined): Promise<ToolResult<PresentHtmlData>> {
  const target = locate(context, relativePath);
  if (!target) {
    return toolError(
      "path must be an existing .html file, without `.` / `..` segments",
      "Acknowledge the error and retry with a valid path to an existing .html file, or inline `html`.",
    );
  }
  const exists = await target.files.exists(target.rel);
  if (!exists) {
    return toolError(`No HTML file exists at ${relativePath}`, "Acknowledge that the file was not found and retry with a path that exists or inline `html`.");
  }
  return presented(`Presented existing HTML at ${relativePath}`, { title, filePath: relativePath });
}

/** Persist a new HTML document under a fresh artifact path, then present it. */
async function saveAndPresent(context: HtmlExecuteContext, html: string, title: string | undefined): Promise<ToolResult<PresentHtmlData>> {
  const { relPath, filePath } = htmlArtifactPath(title);
  await context.files.artifacts.write(relPath, html);
  return presented(`Saved HTML to ${filePath}`, { title, filePath });
}

/**
 * Save-or-present the presentHtml tool call. `html` and `path` are mutually
 * exclusive: inline `html` is written to a fresh `artifacts/html/**` path;
 * `path` presents an existing page in place. Always resolves to a ToolResult
 * (validation failures surface as `message`-only results, never throws) so the
 * host route is a thin adapter — same contract as chart-plugin's executeChart.
 */
export async function executeHtml(context: HtmlExecuteContext, args: HtmlArgs): Promise<ToolResult<PresentHtmlData>> {
  if (!isRecord(args)) {
    return toolError("presentHtml args must be an object with `html` or `path`", "Acknowledge the error and retry with { html } or { path }.");
  }
  const { html, path: htmlPath, title } = args;
  const titleStr = typeof title === "string" ? title : undefined;

  // `html` and `path` are mutually exclusive (the tool prompt says "either,
  // not both") — reject both-set rather than letting one silently win.
  if (nonEmptyString(htmlPath) && nonEmptyString(html)) {
    return toolError("provide either `html` or `path`, not both", "Acknowledge the error and retry with exactly one of `html` or `path`.");
  }
  if (nonEmptyString(htmlPath)) {
    return presentExisting(context, htmlPath, titleStr);
  }
  if (nonEmptyString(html)) {
    return saveAndPresent(context, html, titleStr);
  }
  return toolError("provide either `html` or `path`", "Acknowledge the error and retry with inline `html` or an existing `path`.");
}

/** Result of an in-place overwrite — discriminated so the host route can map
 *  it to its existing `{ path }` / 400 / 500 HTTP shape without re-validating. */
export type UpdateHtmlResult = { ok: true; filePath: string } | { ok: false; error: string };

/**
 * Overwrite an existing HTML page in place (the View's source editor). Writes
 * through the generic `files.artifacts` capability after the same containment
 * guard as `presentExisting`. Returns a discriminated result instead of
 * throwing on bad input so the caller keeps its 400-vs-500 distinction.
 */
export async function executeHtmlUpdate(context: HtmlExecuteContext, args: UpdateHtmlArgs): Promise<UpdateHtmlResult> {
  if (!isRecord(args) || !nonEmptyString(args.html)) {
    return { ok: false, error: "html is required" };
  }
  const target = nonEmptyString(args.relativePath) ? locate(context, args.relativePath) : null;
  if (!target) {
    return { ok: false, error: "invalid html relativePath" };
  }
  // Overwrite only: presentHtml's `path` form presents a page that already
  // exists, so a write to a vanished path is a stale View, not a save.
  if (!(await target.files.exists(target.rel))) {
    return { ok: false, error: `no HTML file exists at ${args.relativePath}` };
  }
  await target.files.write(target.rel, args.html);
  return { ok: true, filePath: args.relativePath };
}

/** Non-Vue plugin core for runtime hosts (e.g. MulmoTerminal) that register the
 *  package's `./vue` plugin directly. MulmoClaude consumes only View/Preview +
 *  TOOL_DEFINITION and builds its own ToolPlugin, so it doesn't use this. The
 *  create path runs server-side against the generic `{ files: { artifacts } }`
 *  context the host supplies on `ToolContext`. */
export const pluginCore: ToolPluginCore<PresentHtmlData, PresentHtmlData, HtmlArgs> = {
  toolDefinition: TOOL_DEFINITION,
  execute: executeHtml as unknown as ToolPluginCore<PresentHtmlData, PresentHtmlData, HtmlArgs>["execute"],
  generatingMessage: "Presenting HTML page…",
  isEnabled: () => true,
};
