// Frontend-side helper that turns an `mcp__<server>__<tool>` name
// into a structured hint the right-sidebar can render alongside an
// MCP tool's error body (#1354).
//
// The hint is *user-facing only* — pulled from the same `mcpCatalog`
// the Settings UI uses, so it stays consistent with whatever the
// user installed via Settings. Non-MCP tools and custom (off-catalog)
// servers return `null` and the UI falls back to the plain error
// chip.

import { findCatalogEntry, requiredKeysOf } from "../../config/mcpCatalog";

export interface McpHint {
  /** Catalog id parsed from the tool name (`notion`, `github`, …). */
  server: string;
  /** i18n key for the server's localised display name. Render via
   *  `t(displayNameKey)` in the consuming component. */
  displayNameKey: string;
  /** External setup-guide URL when the catalog entry provides one. */
  setupGuideUrl?: string;
  /** Sorted list of `configSchema[].key` values the catalog marks
   *  `required: true`. Empty when the entry has no required fields. */
  requiredKeys: string[];
}

// Allow `[A-Za-z0-9_-]+` for the server segment so a future catalog
// id with an underscore (none today, all current ids use `-`) is
// still recognised. The greedy match works because `findCatalogEntry`
// is the actual gatekeeper — anything that fails the catalog lookup
// returns `null` upstream regardless of how the regex grouped it.
// (Sourcery review on #1357.)
const MCP_TOOL_NAME_PATTERN = /^mcp__([A-Za-z0-9_-]+)__/;

/** Returns a structured hint when `toolName` references an MCP
 *  server present in the catalog; `null` otherwise. */
export function extractMcpHint(toolName: string): McpHint | null {
  const server = MCP_TOOL_NAME_PATTERN.exec(toolName)?.[1];
  if (server === undefined) return null;
  const entry = findCatalogEntry(server);
  if (entry === null) return null;
  const requiredKeys = [...requiredKeysOf(entry)].sort();
  const hint: McpHint = {
    server,
    displayNameKey: entry.displayName,
    requiredKeys,
  };
  if (entry.setupGuideUrl) hint.setupGuideUrl = entry.setupGuideUrl;
  return hint;
}
