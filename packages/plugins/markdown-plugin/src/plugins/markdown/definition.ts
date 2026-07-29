import type { ToolDefinition } from "gui-chat-protocol";
import { classifyFilePath } from "@mulmoclaude/core/artifacts";

export const TOOL_NAME = "presentDocument";

export interface MarkdownToolData {
  /** Inline markdown, OR — for results created before `docPath` existed — the
   *  `artifacts/documents/**.md` path of the saved document. Read it through
   *  `documentPathOf`, never by testing this field directly. */
  markdown: string;
  /** The document this result renders, when it is backed by a file. Set for
   *  every result the current executor produces, so an arbitrary document path
   *  (a repo's `README.md`) is never mistaken for inline content. */
  docPath?: string;
  pdfPath?: string;
  filenamePrefix?: string;
}

/** Args the LLM passes when invoking the tool. Two shapes share this
 *  type: the create path (`markdown` + `filenamePrefix`, saved to a
 *  fresh artifact path) and the present-existing path (`path`, rendered
 *  in place). Only `title` is `required` in TOOL_DEFINITION.parameters
 *  because JSON Schema can't express that either-or; the executor
 *  enforces the mutual exclusion. */
export interface MarkdownArgs {
  title: string;
  markdown?: string;
  filenamePrefix?: string;
  path?: string;
}

const DOCUMENTS_PREFIX = "artifacts/documents/";

/** True when the value is a workspace-relative document path rather than
 *  inline content — the `markdown` field's two shapes, and the gate on the
 *  tool's `path` argument.
 *
 *  Canonical form is enforced, not just prefix + extension: this also runs in
 *  hosts that pass the value straight to their file layer, so a prefixed
 *  traversal (`artifacts/documents/../../secrets.md`) must not pass here just
 *  because MulmoClaude happens to re-validate with `isMarkdownPath`. Same
 *  constraints as the host's `makePathValidator`, expressed without node's
 *  `path` because this module is also bundled for the browser. */
export function isFilePath(value: string): boolean {
  if (!value.endsWith(".md")) return false;
  if (!value.startsWith(DOCUMENTS_PREFIX)) return false;
  if (value.includes("..") || value.includes("\0") || value.includes("\\")) return false;
  return value.split("/").every((segment) => segment.length > 0 && segment !== ".");
}

/** The `path` argument's gate: ANY markdown document, not just the ones this
 *  tool wrote — a workspace-relative path (`docs/design.md`) or, where the host
 *  permits it, an absolute one. Lexical only; the host decides what it will
 *  actually open (see `classifyFilePath`). */
export function isDocumentPath(value: string): boolean {
  return classifyFilePath(value, [".md"]) !== null;
}

/** The file a tool result renders, or null when it carries inline markdown.
 *
 *  `docPath` is authoritative. `markdown` is consulted only for results stored
 *  before that field existed, where an `artifacts/documents/**.md` value in it
 *  meant "path" — a test that cannot be widened to arbitrary paths, since
 *  `README.md` is also a perfectly good one-line markdown body. */
export function documentPathOf(data: MarkdownToolData | undefined): string | null {
  const docPath = data?.docPath;
  if (typeof docPath === "string" && isDocumentPath(docPath)) return docPath;
  const raw = data?.markdown;
  return typeof raw === "string" && isFilePath(raw) ? raw : null;
}

export const TOOL_DEFINITION: ToolDefinition = {
  type: "function",
  name: TOOL_NAME,
  description: "Display a document in markdown format — either new markdown (saved) or an existing saved document (by path).",
  prompt:
    `Use the ${TOOL_NAME} tool when the user asks for a document that combines text with embedded images — guides, reports, tutorials, articles, or any structured content with visuals. ` +
    `Prefer this over standalone image generation when the user wants informational content with supporting visuals.\n\n` +
    "Provide EITHER `markdown` + `filenamePrefix` (new content, saved under `artifacts/documents/<YYYY>/<MM>/…`) OR `path` (an existing markdown file), not both. " +
    "`path` opens ANY existing `.md` — a document you saved earlier, a repo's `README.md`, `docs/design.md` — without re-saving a copy, and edits the user makes in the view write back to that same file. " +
    "Use it whenever the user asks to see or work on a markdown file that already exists; do NOT read the file and re-send its content as `markdown`, which would fork it into a copy.\n\n" +
    "Format embedded images as: ![Detailed image prompt](__too_be_replaced_image_path__)\n\n" +
    "── Slide-deck (Marp) mode ──\n" +
    "When the user asks for a slide deck / presentation / スライド, opt into Marp by writing this YAML frontmatter at the very top of the markdown:\n" +
    "---\n" +
    "marp: true\n" +
    "theme: default\n" +
    "size: 16:9\n" +
    "---\n" +
    "Then separate slides with `---` on its own line. The right-pane preview and the Export-PDF button both honour Marp output.\n\n" +
    "Marp image directives (alt-text position) — use these instead of plain ![]() when slide layout matters, because a plain inline image is clipped to ~60% of slide height to leave room for surrounding text:\n" +
    "- ![bg](path)            — full-slide background (does not push other content)\n" +
    "- ![bg fit](path)        — background scaled to fit, no crop\n" +
    "- ![fit](path)           — fit-to-content inline\n" +
    "- ![w:600 h:400](path)   — explicit pixel size\n" +
    "For a GENERATED image WITH a directive you must use THREE slots: the directive in the alt-text slot, the placeholder `__too_be_replaced_image_path__` in the URL slot, AND the image prompt in a quoted markdown TITLE right after the URL:\n" +
    '    ![bg right:45%](__too_be_replaced_image_path__ "A detailed description of the image to generate")\n' +
    "The title is REQUIRED in this form — the alt slot is taken by the directive, so WITHOUT a title there is no prompt and no image is generated. (Plain non-directive images keep the prompt in the alt slot, as shown earlier.)\n\n" +
    "Aspect: `size: 16:9` (default 1280×720) or `size: 4:3` (960×720) — handled natively by Marp. For other shapes MulmoClaude bridges the directive so vertical / square / custom decks work too:\n" +
    "- `size: 9:16` → 1080×1920 portrait\n" +
    "- `size: 16:10` → 1280×800\n" +
    "- `size: 1:1` → 1080×1080 square\n" +
    "- `size: WxH` → any custom pixel canvas (e.g. `size: 1920x1080`)\n" +
    "Themes: `theme: default` | `gaia` | `uncover`. Custom sizes compose on top of whichever theme is chosen.",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Title for the document",
      },
      markdown: {
        type: "string",
        description:
          "The markdown content to display. Provide this (with `filenamePrefix`) OR `path`. Describe embedded images in the following format: ![Detailed image prompt](__too_be_replaced_image_path__). IMPORTANT: For embedded images, you MUST use the EXACT placeholder path '__too_be_replaced_image_path__'.",
      },
      filenamePrefix: {
        type: "string",
        description:
          "Short English filename prefix (without extension). Always send it with `markdown` — it is what makes the saved file findable; omitting it falls back to 'document'. Ignored with `path`. Use lowercase with hyphens, e.g. 'project-summary'. The server sanitizes the value and appends a random id to prevent collisions.",
      },
      path: {
        type: "string",
        description:
          "Path to an existing `.md` file to present without re-saving — workspace-relative (`README.md`, `docs/design.md`, `artifacts/documents/2026/07/report-abc123.md`) or absolute. The user's edits in the view overwrite this file. Provide this OR `markdown`.",
      },
    },
    // `markdown` + `filenamePrefix` and `path` are mutually exclusive, which
    // JSON Schema can't express — the executor validates the pairing.
    required: ["title"],
  },
};

export default TOOL_DEFINITION;
