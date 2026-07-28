import type { ToolDefinition } from "gui-chat-protocol";

export const TOOL_NAME = "presentDocument";

export interface MarkdownToolData {
  markdown: string;
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

/** True when the `markdown` field is a workspace-relative file path
 *  rather than inline content. Accepts the canonical
 *  `artifacts/documents/*.md` prefix. */
export function isFilePath(value: string): boolean {
  if (!value.endsWith(".md")) return false;
  return value.startsWith("artifacts/documents/");
}

export const TOOL_DEFINITION: ToolDefinition = {
  type: "function",
  name: TOOL_NAME,
  description: "Display a document in markdown format — either new markdown (saved) or an existing saved document (by path).",
  prompt:
    `Use the ${TOOL_NAME} tool when the user asks for a document that combines text with embedded images — guides, reports, tutorials, articles, or any structured content with visuals. ` +
    `Prefer this over standalone image generation when the user wants informational content with supporting visuals.\n\n` +
    "Provide EITHER `markdown` + `filenamePrefix` (new content, saved under `artifacts/documents/<YYYY>/<MM>/…`) OR `path` (the workspace-relative path of a document you already wrote under `artifacts/documents/`), not both. " +
    "`path` presents that existing document without re-saving a copy, and edits the user makes in the view write back to that same file.\n\n" +
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
          "Short English filename prefix (without extension), required with `markdown`. Use lowercase with hyphens, e.g. 'project-summary'. The server sanitizes the value and appends a random id to prevent collisions.",
      },
      path: {
        type: "string",
        description:
          "Workspace-relative path to an existing markdown file under `artifacts/documents/` to present without re-saving (e.g. `artifacts/documents/2026/07/report-abc123.md`). Provide this OR `markdown`.",
      },
    },
    // `markdown` + `filenamePrefix` and `path` are mutually exclusive, which
    // JSON Schema can't express — the executor validates the pairing.
    required: ["title"],
  },
};

export default TOOL_DEFINITION;
