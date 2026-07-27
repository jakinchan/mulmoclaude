// Windows-only integration for the generated shortcut.
//
// Everything else about the Windows launcher is asserted from pure
// functions on any OS. These are the parts only Windows can answer: a
// .lnk is a binary format written by a COM object, and whether the .ico
// we assemble by hand is actually loadable is Windows' opinion, not
// ours. Runs inside the existing `lint_test (Windows)` job.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWindowsShortcut } from "../../../server/utils/launcher/windows/create-launcher.mjs";

const windowsOnly = { skip: process.platform !== "win32" };

// A hand-assembled .ico that Windows refuses would show up as a blank
// icon in Explorer and nowhere else — no error, no log line.
const POWERSHELL_TIMEOUT_MS = 60_000;

const powershell = (script: string): string =>
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: POWERSHELL_TIMEOUT_MS,
  }).trim();

const withTempRoot = async (body: (paths: { rootDir: string; shortcutPath: string }) => Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), "mulmoclaude-lnk-"));
  try {
    await body({ rootDir: join(dir, "launcher"), shortcutPath: join(dir, "shortcut", "MulmoClaude.lnk") });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe("createWindowsShortcut (Windows)", () => {
  it("writes a .lnk that points at the stub through wscript", windowsOnly, async () => {
    await withTempRoot(async ({ rootDir, shortcutPath }) => {
      const created = await createWindowsShortcut({ rootDir, shortcutPath });
      assert.ok(existsSync(created.shortcutPath), "no .lnk was written");

      // Read the shortcut back through the same COM object Explorer uses,
      // rather than trusting the PowerShell we generated.
      const script = [
        "$shell = New-Object -ComObject WScript.Shell",
        `$link = $shell.CreateShortcut('${shortcutPath.replace(/'/g, "''")}')`,
        "Write-Output $link.TargetPath",
        "Write-Output $link.Arguments",
      ].join("\n");
      const [target, args] = powershell(script).split(/\r?\n/);

      assert.match(target, /wscript\.exe$/i, "a console window would appear if this were node.exe or cmd.exe");
      assert.match(args, /launch\.vbs"$/, "the stub path must stay quoted — %LOCALAPPDATA% contains the account name");
      assert.ok(existsSync(args.replace(/^"|"$/g, "")), "the shortcut points at a stub that is not there");
    });
  });

  it("produces an .ico that Windows itself can load", windowsOnly, async () => {
    await withTempRoot(async ({ rootDir, shortcutPath }) => {
      const { iconWritten } = await createWindowsShortcut({ rootDir, shortcutPath });
      assert.equal(iconWritten, true);
      const iconPath = join(rootDir, "icon.ico");
      const size = powershell(
        ["Add-Type -AssemblyName System.Drawing", `$icon = New-Object System.Drawing.Icon('${iconPath.replace(/'/g, "''")}')`, "Write-Output $icon.Width"].join(
          "\n",
        ),
      );
      assert.ok(Number(size) > 0, `System.Drawing could not read the icon (got ${size})`);
    });
  });

  it("ships the modules run.mjs imports, with the layout that makes ../port.mjs resolve", windowsOnly, async () => {
    await withTempRoot(async ({ rootDir, shortcutPath }) => {
      await createWindowsShortcut({ rootDir, shortcutPath });
      [
        "utils/launcher/run.mjs",
        "utils/launcher/start.mjs",
        "utils/launcher/platform.mjs",
        "utils/port.mjs",
        "utils/launcher/windows/launch.vbs",
        "messages/en.txt",
      ].forEach((relative) => assert.ok(existsSync(join(rootDir, ...relative.split("/"))), `missing ${relative}`));
    });
  });
});
