// Entry point for `@mulmoclaude/core/global-config` — the host-neutral
// per-user config file (`~/.config/mulmo/config.json`) shared by MulmoClaude
// and MulmoTerminal. Server-only (node:fs); the values it yields are plain
// JSON, so they cross a dispatch hop to a plugin View unchanged.
import { readFile } from "node:fs/promises";
import { mulmoGlobalConfigPath } from "./paths.js";
import { readDocumentBookmarkPattern } from "./schema.js";

export { mulmoConfigDir, mulmoGlobalConfigPath } from "./paths.js";
export { readDocumentBookmarkPattern, MAX_BOOKMARK_PATTERN_LENGTH } from "./schema.js";

/**
 * Parse `~/.config/mulmo/config.json`. Returns `null` when the file is absent
 * or unparseable — both are ordinary states (there is no UI that creates it),
 * and every reader in `./schema` treats `null` as "nothing configured".
 *
 * Not cached: the file is read at most once per view open, and caching would
 * mean a hand-edit needs an app restart to take effect.
 */
export async function readMulmoGlobalConfig(home?: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(mulmoGlobalConfigPath(home), "utf-8"));
  } catch {
    return null;
  }
}

/** Convenience: the configured document-bookmark regex source, or null. */
export async function loadDocumentBookmarkPattern(home?: string): Promise<string | null> {
  return readDocumentBookmarkPattern(await readMulmoGlobalConfig(home));
}
