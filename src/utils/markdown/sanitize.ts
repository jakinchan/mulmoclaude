// The host's markdown surfaces (skill bodies, catalog previews, text responses)
// sanitize `marked.parse` output through the same wrapper the markdown plugin's
// View uses, so one policy covers every place this app injects rendered
// markdown with `v-html`.
//
// The policy — DOMPurify's strict defaults plus the single YouTube-embed iframe
// shape the wiki renderer emits — and its rationale live in
// `@mulmoclaude/core/plugin-vue`. This module is only the host-side name the
// existing call sites already import.

export { sanitizeMarkdownHtml, _resetSanitizeForTests } from "@mulmoclaude/core/plugin-vue";
