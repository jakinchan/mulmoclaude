import type { Component } from "vue";
import type { PluginRegistration, ToolPlugin } from "../../tools/types";
import type { ToolResult } from "gui-chat-protocol";
import { View, Preview, type PresentHtmlData } from "@mulmoclaude/html-plugin/vue";
// Lib mode doesn't auto-inject the package's compiled scoped styles; the
// consumer must import them — same as @mulmoclaude/{markdown,form,chart}-plugin.
import "@mulmoclaude/html-plugin/style.css";
import toolDefinition, { TOOL_NAME, type HtmlEndpoints } from "./definition";
import { pluginEndpoints } from "../api";
import { wrapWithScope } from "../scope";
import { apiCall } from "../../utils/api";
import { makeUuid } from "../../utils/id";
import { htmlPreviewUrlFor } from "../../composables/useContentDisplay";

// Re-exported from the shared package so anything importing the result-data
// shape from "./index" keeps working while the type stays single-sourced.
export type { PresentHtmlData };

const presentHtmlPlugin: ToolPlugin<PresentHtmlData> = {
  toolDefinition,

  async execute(_context, args) {
    const endpoints = pluginEndpoints<HtmlEndpoints>("html");
    const { method, url } = endpoints.create;
    const result = await apiCall<ToolResult<PresentHtmlData>>(url, { method, body: args });
    if (!result.ok) {
      return {
        toolName: TOOL_NAME,
        uuid: makeUuid(),
        message: result.error,
      };
    }
    const body = result.data;
    // Inject the host-served preview URL so the host-agnostic package View can
    // point its iframe at the file's real URL (relative asset refs resolve
    // against it). Only for `artifacts/html/…`, which MulmoClaude serves from a
    // static mount; a page outside it falls through to the package's own
    // `/htmlfile` URL, a scheme both hosts serve.
    const data = body.data ? { ...body.data, previewUrl: htmlPreviewUrlFor(body.data.filePath) ?? undefined } : body.data;
    return {
      ...body,
      data,
      toolName: TOOL_NAME,
      uuid: makeUuid(),
    };
  },

  isEnabled: () => true,
  generatingMessage: "Presenting HTML page…",
  // gui-chat-protocol's Component type is externalized but yarn-4's dual-@vue can
  // make the package's nominal types distinct; coerce once here (same as chart).
  viewComponent: wrapWithScope("html", View as unknown as Component),
  previewComponent: wrapWithScope("html", Preview as unknown as Component),
};
export { TOOL_NAME };

export const REGISTRATION: PluginRegistration = {
  toolName: TOOL_NAME,
  entry: presentHtmlPlugin,
};
