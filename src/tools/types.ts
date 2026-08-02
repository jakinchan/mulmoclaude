import type { ToolPlugin as BaseToolPlugin, InputHandler, ToolContextApp, ToolDefinition } from "gui-chat-protocol/vue";
import type { Component } from "vue";

/**
 * Extended app context with file system access for workspace-aware plugins
 */
export interface MulmoClaudeToolContextApp extends ToolContextApp {
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
  workspacePath: () => string;
}

/**
 * MulmoClaude ToolPlugin — no app-specific server response type needed.
 *
 * IMPORTANT — `execute()` is NEVER called at runtime in MulmoClaude.
 * The frontend registry (see `PluginEntry` below and `src/tools/index.ts`)
 * only consumes `toolDefinition` / `viewComponent` / `previewComponent`.
 * Tool calls flow Claude → MCP (`server/agent/mcp-server.ts`) → the REST
 * endpoint listed in `server/agent/plugin-names.ts:TOOL_ENDPOINTS`,
 * bypassing every `execute()` defined in `src/plugins/<name>/index.ts`.
 *
 * Consequences:
 * - Per-mode dispatch (e.g. branch on which arg is set), arg
 *   normalization, fan-out side effects, and post-success triggers
 *   MUST live in the server route, not in `execute()`. Putting them in
 *   `execute()` looks like it works in dev but silently no-ops in
 *   production because the agent path never reaches the function.
 * - The `execute()` body is kept only to satisfy the gui-chat-protocol
 *   `ToolPlugin` shape (other host apps invoke it). Keeping it as a
 *   one-line `apiPost` pass-through is the convention — no logic there.
 */
export type ToolPlugin<T = unknown, J = unknown, A extends object = object> = BaseToolPlugin<T, J, A, InputHandler, Record<string, unknown>>;

/**
 * View-only plugin entry for the frontend registry.
 * Only the properties actually used on the client side are required.
 * This avoids contravariance issues with execute's args type parameter.
 *
 * Note the deliberate absence of `execute` — see the warning on
 * `ToolPlugin` above for why MulmoClaude does not call it.
 */
export interface PluginEntry {
  toolDefinition: ToolDefinition;
  viewComponent?: Component | undefined;
  previewComponent?: Component | undefined;
}

/**
 * Self-registration record a built-in plugin emits so the central
 * tool registry (`src/tools/index.ts`) can be assembled generically.
 *
 * Co-locates the canonical tool name (read from `TOOL_NAMES`) with
 * the plugin's `PluginEntry`, so a plugin is "self-aware" of which
 * MCP tool name it implements. Renames in `TOOL_NAMES.x` ripple
 * through the registration automatically — no central map to keep
 * in sync.
 *
 * Plugins serving multiple tool names from one module export
 * `REGISTRATIONS: PluginRegistration[]` instead of the singular
 * `REGISTRATION`; the barrel splats the array. (The scheduler module
 * uses this form — it historically served `manageCalendar` +
 * `manageAutomations`; today only `manageAutomations` remains.)
 */
export interface PluginRegistration {
  /** Tool name string the LLM and JSONL files use. Read from
   *  `TOOL_NAMES.<key>` so this is a single source of truth with
   *  the central name list. */
  toolName: string;
  entry: PluginEntry;
}
