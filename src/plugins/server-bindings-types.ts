// Server-side MCP binding types + the META→endpoint resolver,
// extracted so both the codegen-generated barrel
// (`_generated/server-bindings.ts`) and the user-facing barrel
// (`server.ts`) can import them without a circular dependency.
//
// Browser-safe: no Vue / no Node-only imports — same constraint as
// `meta-types.ts`. Imported from server-side code via tsx.

import type { ToolDefinition } from "gui-chat-protocol";
import { isRecord } from "@mulmoclaude/common";
import { API_ROUTES } from "../config/apiRoutes";
import type { PluginMeta } from "./meta-types";

export interface ServerPluginBinding {
  /** ToolDefinition object — the plugin's MCP-facing schema. The
   *  `name` field is the lookup key for the MCP tool registry. */
  readonly def: ToolDefinition;
  /** Where the MCP bridge POSTs tool calls for this plugin. */
  readonly endpoint: string;
}

/** Resolve a plugin's MCP-dispatch URL from its META: looks up
 *  `apiNamespace`+`apiRoutes[mcpDispatch]` in the host's API_ROUTES
 *  registry and returns the composed `url`. Throws on a META that
 *  doesn't declare both fields — the binding can't dispatch without
 *  them. The lookup-by-namespace lets the host pick up route shape
 *  changes (path / verb edits) without `BUILT_IN_SERVER_BINDINGS`
 *  needing to know the URL. */
export function mcpEndpoint(meta: PluginMeta): string {
  if (!meta.apiNamespace || !meta.mcpDispatch) {
    throw new Error(`Plugin "${meta.toolName}" cannot register MCP binding: missing apiNamespace or mcpDispatch in META`);
  }
  const url = findRouteUrl(meta.apiNamespace, meta.mcpDispatch);
  if (url === undefined) {
    throw new Error(`Plugin "${meta.toolName}" mcpDispatch route "${meta.mcpDispatch}" not found under API_ROUTES.${meta.apiNamespace}`);
  }
  return url;
}

/** `API_ROUTES` is an intersection of literal-typed records, so it carries no
 *  index signature and a namespace known only at runtime cannot be used to
 *  subscript it. Walk the entries instead and read back only the one field this
 *  module consumes. */
function findRouteUrl(namespace: string, routeKey: string): string | undefined {
  const namespaces: [string, unknown][] = Object.entries(API_ROUTES);
  const namespaceValue = namespaces.find(([key]) => key === namespace)?.[1];
  if (!isRecord(namespaceValue)) return undefined;
  const route = namespaceValue[routeKey];
  return isRecord(route) && typeof route.url === "string" ? route.url : undefined;
}
