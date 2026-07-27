// Executable entry the .app hands control to once node is reachable.
// Kept separate from start.mjs so the logic stays importable by tests
// without launching anything.

import { execFileSync } from "node:child_process";

import { launcherLogPath, startLauncher } from "./start.mjs";

// Absolute last resort. Everything expected has a browser page; this
// only fires if the launcher itself broke, and even then the user gets
// a sentence and a path instead of an icon that blinks and does nothing.
function alertNatively(title, body) {
  try {
    execFileSync("/usr/bin/osascript", ["-e", "on run {t, m}", "-e", "display alert t message m as critical", "-e", "end run", title, body], {
      stdio: "ignore",
    });
  } catch {
    // Nothing left to try.
  }
}

try {
  await startLauncher();
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  alertNatively("MulmoClaude", `${detail}\n\n${launcherLogPath()}`);
  process.exit(1);
}
