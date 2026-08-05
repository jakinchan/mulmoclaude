// The host-NEUTRAL per-user config file shared by MulmoClaude and
// MulmoTerminal. It lives OUTSIDE any workspace, in the same `~/.config/mulmo`
// directory the Google grant already uses (`../google/paths.ts`), for the same
// reason: one machine, one set of cross-app preferences, surviving workspace
// resets and never synced.
//
// Deliberately NOT `~/mulmoclaude/config/settings.json` (that is per-workspace
// and MulmoClaude-owned) and NOT `~/.mulmoterminal/config.json` (that is the
// terminal's own file). Neither app owns this one.
//
// The `home` parameter exists so tests can thread a fake home.
import { homedir } from "node:os";
import { join } from "node:path";

export function mulmoConfigDir(home?: string): string {
  return join(home ?? homedir(), ".config", "mulmo");
}

export function mulmoGlobalConfigPath(home?: string): string {
  return join(mulmoConfigDir(home), "config.json");
}
