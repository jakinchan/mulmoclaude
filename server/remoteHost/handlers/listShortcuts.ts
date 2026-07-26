// listShortcuts command handler (remote-host phase 2).
//
// Returns the user's pinned launcher shortcuts (favorites), mirroring
// GET /api/shortcuts → { shortcuts: Shortcut[] }. Read-only: editing the pin
// list stays desktop-only.
import { readShortcuts } from "../../utils/files/shortcuts-io.js";
import { toJsonObject } from "../commandChannel.js";
import type { CommandHandler, JsonObject } from "../commandChannel.js";

export interface ListShortcutsDeps {
  read: typeof readShortcuts;
}

export const createListShortcuts =
  (deps: ListShortcutsDeps): CommandHandler =>
  // Handler receives the command's params; listShortcuts takes none (the `__`
  // prefix marks it intentionally unused per the lint config).
  async (__params: JsonObject) => {
    const shortcuts = await deps.read();
    return toJsonObject({ shortcuts });
  };

export const listShortcuts = createListShortcuts({ read: readShortcuts });
