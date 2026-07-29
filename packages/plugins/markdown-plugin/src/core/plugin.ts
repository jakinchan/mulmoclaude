import type { ToolContext, ToolResult, ToolPluginCore } from "gui-chat-protocol";
import { TOOL_NAME, TOOL_DEFINITION, isDocumentPath, type MarkdownToolData, type MarkdownArgs } from "../plugins/markdown/definition";
import { executeMarkdown, type MarkdownExecuteContext } from "../plugins/markdown/core";
import type { MarkdownDispatchArgs, MarkdownHostApp } from "../plugins/markdown/contract";

const PRESENT_ACK = "The document has been presented to the user in a rendered markdown view.";

const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** Present a document already on disk without re-saving — any `.md`, not only
 *  the ones this tool wrote. `loadDoc` doubles as the existence check (the host
 *  app has no separate `exists`, a read is what the View does next anyway) and
 *  as the host's policy gate: whether a given path is reachable at all is the
 *  host's judgement, and a refusal surfaces here as "not found". Edits the user
 *  applies in the View dispatch `saveDoc` against this same path, so they land
 *  on the original file.
 *
 *  `data.markdown` repeats the path for pre-`docPath` readers; `documentPathOf`
 *  is what current ones consult. */
async function presentExistingDocument(app: MarkdownHostApp, path: string, title: string): Promise<ToolResult<MarkdownToolData>> {
  if (!isDocumentPath(path)) {
    return {
      message: "path must be a .md file path, without `.` / `..` segments",
      instructions: "Acknowledge the error and retry with a valid path to an existing .md file, or inline `markdown`.",
    };
  }
  try {
    await app.loadDoc(path);
  } catch (err) {
    return {
      message: `Cannot open ${path}: ${err instanceof Error ? err.message : String(err)}`,
      instructions: "Acknowledge that the document could not be opened and retry with a path that exists or inline `markdown`.",
    };
  }
  return { message: `Presented existing document${title ? `: ${title}` : ""}`, data: { markdown: path, docPath: path }, instructions: PRESENT_ACK };
}

/** Persist new markdown under a fresh artifact path, then present it. */
async function saveAndPresentDocument(app: MarkdownHostApp, args: MarkdownArgs): Promise<ToolResult<MarkdownToolData>> {
  const { title, markdown, filenamePrefix } = args;
  const filled = (await app.fillImages(markdown ?? "")).markdown;
  const { path } = await app.saveNewDoc(filenamePrefix ?? "document", filled);
  return {
    message: `Document created${title ? `: ${title}` : ""}`,
    // `data` is the host's render-gate signal + the view's source.
    data: { markdown: path, docPath: path, filenamePrefix },
    instructions: PRESENT_ACK,
  };
}

/** `markdown` and `path` are mutually exclusive: inline markdown is written to
 *  a fresh `artifacts/documents/**` path, `path` presents an existing document
 *  in place. Same contract as presentHtml's `html` / `path`. */
async function createDocument(context: MarkdownExecuteContext, args: MarkdownArgs): Promise<ToolResult<MarkdownToolData>> {
  const { app } = context;
  if (!app) {
    throw new Error("markdown plugin: context.app (MarkdownHostApp) was not provided by the host");
  }
  const { title, markdown, path } = args;
  if (nonEmptyString(path) && nonEmptyString(markdown)) {
    return {
      message: "provide either `markdown` or `path`, not both",
      instructions: "Acknowledge the error and retry with exactly one of `markdown` or `path`.",
    };
  }
  if (nonEmptyString(path)) {
    return presentExistingDocument(app, path, title);
  }
  if (nonEmptyString(markdown)) {
    return saveAndPresentDocument(app, args);
  }
  return { message: "provide either `markdown` or `path`", instructions: "Acknowledge the error and retry with inline `markdown` or an existing `path`." };
}

const DISPATCH_KINDS: ReadonlySet<string> = new Set(["loadDoc", "saveDoc", "marpThemes", "exportPdf", "fillImages"]);

function hasKind(value: unknown): value is MarkdownDispatchArgs {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === "string" && DISPATCH_KINDS.has(kind);
}

/**
 * Single server-side entry. Two callers land here:
 *   - the View's `useRuntime().dispatch({ kind, … })` (load/save/pdf/themes/fill)
 *   - the LLM tool-call create path (`{ title, markdown, filenamePrefix }`, no kind)
 * Host backends arrive on `context.app` (gui-chat-protocol ToolContext.app).
 */
export const executeDocument = async (context: ToolContext, args: MarkdownArgs | MarkdownDispatchArgs): Promise<ToolResult<MarkdownToolData>> => {
  // The host injects MarkdownHostApp on context.app; bridge the nominal
  // ToolContextApp → MarkdownHostApp gap (runtime shape matches).
  const ctx = context as unknown as MarkdownExecuteContext;
  if (hasKind(args)) {
    // Dispatch results aren't ToolResults; the host route JSON-forwards
    // them verbatim and the View typed each call at its dispatch site.
    return executeMarkdown(ctx, args) as Promise<ToolResult<MarkdownToolData>>;
  }
  return createDocument(ctx, args);
};

export const pluginCore: ToolPluginCore<MarkdownToolData, MarkdownToolData, MarkdownArgs> = {
  toolDefinition: TOOL_DEFINITION,
  execute: executeDocument as ToolPluginCore<MarkdownToolData, MarkdownToolData, MarkdownArgs>["execute"],
  generatingMessage: "Creating document...",
  isEnabled: () => true,
};

export { TOOL_NAME, TOOL_DEFINITION };
