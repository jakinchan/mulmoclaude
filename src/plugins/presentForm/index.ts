import type { ToolPlugin } from "gui-chat-protocol/vue";
import type { PluginRegistration } from "../../tools/types";
import type { FormData, FormArgs } from "@mulmoclaude/form-plugin";
import { plugin as formPlugin } from "@mulmoclaude/form-plugin/vue";
import "@mulmoclaude/form-plugin/style.css";
import { wrapWithScope } from "../scope";
import { TOOL_NAME } from "./definition";

// The form's schema, validation, View, and Preview come from the shared
// @mulmoclaude/form-plugin package. We re-wrap its components in MulmoClaude's scoped
// runtime provider (wrapWithScope) so the package's useRuntime()/locale resolves
// to the host — which is what drives the package's bundled i18n.
//
// Coerce the package's plugin to the host's ToolPlugin type. The package is built
// with its own `vue` dep, so under yarn 4 it resolves a second @vue/runtime-core
// whose `Component` type is nominally distinct from the host's (identical at
// runtime — the built app bundles a single Vue). Without this bridge, passing the
// package's Component into the host-typed wrapWithScope makes tsc compare two giant
// equivalent Component types and blow the stack (TS2321).
const pkg = formPlugin as unknown as ToolPlugin<FormData, FormData, FormArgs>;

// A slot the package doesn't export stays ABSENT rather than becoming an
// explicit `undefined` — `ToolPlugin` treats the two differently.
const presentFormPlugin: ToolPlugin<FormData, FormData, FormArgs> = {
  ...pkg,
  ...(pkg.viewComponent ? { viewComponent: wrapWithScope("form", pkg.viewComponent) } : {}),
  ...(pkg.previewComponent ? { previewComponent: wrapWithScope("form", pkg.previewComponent) } : {}),
};
export { TOOL_NAME };

export const REGISTRATION: PluginRegistration = {
  toolName: TOOL_NAME,
  entry: presentFormPlugin,
};
