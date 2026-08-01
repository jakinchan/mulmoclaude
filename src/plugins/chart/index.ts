import type { PluginRegistration, ToolPlugin } from "../../tools/types";
import { View, Preview, TOOL_DEFINITION, type PresentChartData } from "@mulmoclaude/chart-plugin/vue";
// The package's component scoped styles are compiled into a standalone
// stylesheet; Vite lib mode does NOT auto-inject it, so the consumer must
// import it — same as @mulmoclaude/{form,markdown}-plugin.
import "@mulmoclaude/chart-plugin/style.css";
import { TOOL_NAME, type ChartEndpoints } from "./definition";
import { makeRouteExecute } from "../execute";
import { wrapWithScope } from "../scope";

// The chart's schema, validation, View, and Preview come from the shared
// @mulmoclaude/chart-plugin package. MulmoClaude keeps the client-side create
// path (POST /api/chart) — the host route injects the generic `files.artifacts`
// capability and calls the package's executeChart. We re-wrap the package's
// components in MulmoClaude's scoped runtime provider (wrapWithScope) so the
// package's useT()/locale resolves to the host.
const chartPlugin: ToolPlugin<PresentChartData> = {
  toolDefinition: TOOL_DEFINITION,

  execute: makeRouteExecute<ChartEndpoints, PresentChartData>("chart", "create", TOOL_NAME),

  isEnabled: () => true,
  generatingMessage: "Rendering chart…",
  viewComponent: wrapWithScope("chart", View),
  previewComponent: wrapWithScope("chart", Preview),
};
export { TOOL_NAME };

export const REGISTRATION: PluginRegistration = {
  toolName: TOOL_NAME,
  entry: chartPlugin,
};
