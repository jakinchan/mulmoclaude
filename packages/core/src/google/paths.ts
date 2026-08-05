// Google OAuth material lives OUTSIDE the workspace: the client secret is
// machine-only (never synced) and the refresh token must survive workspace
// resets — same reasoning as the gcloud / gh CLI model. The dir is the
// host-NEUTRAL `~/.config/mulmo` because this engine is shared by both
// MulmoClaude and MulmoTerminal, which deliberately share one grant per
// machine. The `home` parameter exists so tests can thread a fake home.
import { homedir } from "node:os";
import { join } from "node:path";
import { mulmoConfigDir } from "../global-config/paths.js";

/** Same directory as every other cross-app per-user file — see
 *  `../global-config/paths.ts`, which owns the spelling. */
export function googleConfigDir(home?: string): string {
  return mulmoConfigDir(home);
}

/** Pre-0.20.1 token dir (mulmoclaude-branded); reads migrate away from it. */
export function legacyGoogleTokenPath(home?: string): string {
  return join(home ?? homedir(), ".config", "mulmoclaude", "google-token.json");
}

export function googleTokenPath(home?: string): string {
  return join(googleConfigDir(home), "google-token.json");
}

export function googleSecretsDir(home?: string): string {
  return join(home ?? homedir(), ".secrets");
}
