// Executable entry the generated launcher hands control to once node is
// reachable. Kept separate from start.mjs so the logic stays importable
// by tests without launching anything.

import { execFileSync } from "node:child_process";

// Absolute last resort. Everything expected has a browser page; this
// only fires if the launcher itself broke, and even then the user gets
// a sentence instead of an icon that blinks and does nothing.
function alertNatively(title, body) {
  try {
    if (process.platform === "win32") {
      // No osascript here, and the stub that got us this far is already
      // gone — PowerShell is the one dialog every install can show.
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show($env:MC_BODY, $env:MC_TITLE)",
        ],
        { stdio: "ignore", env: { ...process.env, MC_TITLE: title, MC_BODY: body } },
      );
      return;
    }
    execFileSync("/usr/bin/osascript", ["-e", "on run {t, m}", "-e", "display alert t message m as critical", "-e", "end run", title, body], {
      stdio: "ignore",
    });
  } catch {
    // Nothing left to try.
  }
}

// A module missing from the generated launcher is not a bug the user can
// act on except in one way, and it is the one that works: generate it
// again. Said plainly, because the raw ERR_MODULE_NOT_FOUND names an
// absolute path inside a bundle they never opened.
function describeFailure(error) {
  const detail = error instanceof Error ? error.message : String(error);
  if (error?.code === "ERR_MODULE_NOT_FOUND") {
    return `This launcher is missing part of itself, so it cannot start.\n\nRe-create it:\n  npx mulmoclaude@latest create-shortcut\n\n${detail}`;
  }
  return detail;
}

// The import is INSIDE the try on purpose. As a static import it was
// resolved before this body ran, so a module missing from the bundle
// skipped the whole safety net and the icon simply blinked and vanished
// — the exact outcome the comment above claims to prevent (#2625).
try {
  const { launcherLogPath, startLauncher } = await import("./start.mjs");
  try {
    await startLauncher();
  } catch (error) {
    alertNatively("MulmoClaude", `${describeFailure(error)}\n\n${launcherLogPath()}`);
    process.exit(1);
  }
} catch (error) {
  // Reached only when start.mjs itself could not be loaded, so there is
  // no launcherLogPath() to call and no log to point at: nothing ever
  // ran to write one.
  alertNatively("MulmoClaude", describeFailure(error));
  process.exit(1);
}
