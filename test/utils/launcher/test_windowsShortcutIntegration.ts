// Windows-only integration for the generated shortcut.
//
// Everything else about the Windows launcher is asserted from pure
// functions on any OS. These are the parts only Windows can answer.
//
// Three of the four items that were written off as "human only" in
// docs/manual-testing.md §12 are reachable here, because the CAUSE is
// checkable even when the appearance is not:
//
//   icon renders    → the pixels are decodable and not blank at each size
//   no SmartScreen  → the artifacts carry no Mark-of-the-Web (the very
//                     attribute SmartScreen keys on)
//   version manager → a real handover, with node found through a PATH
//                     entry that looks like nvm-windows/fnm/Volta
//
// What stays human: what a window LOOKS like. Runs inside the existing
// `lint_test (Windows)` job.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("what §12 called human-only (Windows)", () => {
  it("the icon has real pixels at every size Explorer asks for", windowsOnly, async () => {
    // "Renders in Explorer" cannot be asserted, but the failure people
    // actually hit — a blank or undecodable icon — can. Each size is
    // pulled out of the container and sampled for opaque pixels.
    await withTempRoot(async ({ rootDir, shortcutPath }) => {
      await createWindowsShortcut({ rootDir, shortcutPath });
      const iconPath = join(rootDir, "icon.ico").replace(/'/g, "''");
      const output = powershell(
        [
          "Add-Type -AssemblyName System.Drawing",
          "$results = @()",
          "foreach ($size in 16,32,48,256) {",
          `  $icon = New-Object System.Drawing.Icon('${iconPath}', $size, $size)`,
          "  $bmp = $icon.ToBitmap()",
          "  $opaque = 0",
          "  for ($x = 0; $x -lt $bmp.Width; $x += 4) {",
          "    for ($y = 0; $y -lt $bmp.Height; $y += 4) {",
          "      if ($bmp.GetPixel($x, $y).A -gt 0) { $opaque++ }",
          "    }",
          "  }",
          '  $results += "$($bmp.Width)x$($bmp.Height):$opaque"',
          "}",
          "Write-Output ($results -join ' ')",
        ].join("\n"),
      );
      // e.g. "16x16:16 32x32:64 48x48:144 256x256:4096"
      const sampled = output.split(" ").map((entry) => {
        const [dimensions, opaque] = entry.split(":");
        return { dimensions, opaque: Number(opaque) };
      });
      assert.equal(sampled.length, 4, output);
      sampled.forEach(({ dimensions, opaque }) => {
        assert.ok(opaque > 0, `${dimensions} decoded to a fully transparent image — Explorer would show nothing (${output})`);
      });
    });
  });

  it("nothing it writes carries a Mark-of-the-Web, which is what SmartScreen keys on", windowsOnly, async () => {
    // The claim in the changelog is that a locally generated file is not
    // flagged. That rests entirely on the absence of the Zone.Identifier
    // alternate data stream, and that is directly checkable.
    await withTempRoot(async ({ rootDir, shortcutPath }) => {
      await createWindowsShortcut({ rootDir, shortcutPath });
      const targets = [shortcutPath, join(rootDir, "utils", "launcher", "windows", "launch.vbs"), join(rootDir, "icon.ico")];
      targets.forEach((target) => {
        const streams = powershell(
          `$found = Get-Item -LiteralPath '${target.replace(/'/g, "''")}' -Stream * -ErrorAction SilentlyContinue | Where-Object { $_.Stream -eq 'Zone.Identifier' }; Write-Output $found.Count`,
        );
        assert.equal(streams, "0", `${target} carries a Zone.Identifier stream — SmartScreen would have something to react to`);
      });
    });
  });

  it("hands over to node found on PATH the way a version manager puts it there", windowsOnly, async () => {
    // CI runs a plain toolchain, so nvm-windows/fnm/Volta were written off
    // as untestable. What they actually do is put a node.exe on the user's
    // PATH — which is reproducible: a directory that is not the system one,
    // holding node.exe, reachable only through PATH.
    //
    // The real launch.vbs runs; only run.mjs is swapped for a probe, so the
    // app never starts but the whole stub path is exercised.
    await withTempRoot(async ({ rootDir, shortcutPath }) => {
      await createWindowsShortcut({ rootDir, shortcutPath });
      const marker = join(rootDir, "handover.json");
      writeFileSync(
        join(rootDir, "utils", "launcher", "run.mjs"),
        ["import { writeFileSync } from 'node:fs';", `writeFileSync(String.raw\`${marker}\`, JSON.stringify({ execPath: process.execPath }));`].join("\n"),
      );

      const versionManagerDir = join(rootDir, "nvm-like", "v24.0.0", "bin");
      const escaped = (value: string) => value.replace(/'/g, "''");
      powershell(
        [
          `New-Item -ItemType Directory -Force -Path '${escaped(versionManagerDir)}' | Out-Null`,
          `Copy-Item (Get-Command node).Source -Destination '${escaped(join(versionManagerDir, "node.exe"))}'`,
          // Only the fake version-manager dir plus the system ones: if the
          // stub resolved node any other way, the marker would name it.
          `$env:PATH = '${escaped(versionManagerDir)};' + $env:SystemRoot + '\\System32;' + $env:SystemRoot`,
          `Start-Process -FilePath '${escaped(shortcutPath)}'`,
        ].join("\n"),
      );

      const deadline = Date.now() + POWERSHELL_TIMEOUT_MS;
      while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 500));
      assert.ok(existsSync(marker), "the stub never reached run.mjs — node was not found on the version-manager PATH");

      const { execPath } = JSON.parse(readFileSync(marker, "utf8")) as { execPath: string };
      assert.equal(execPath.toLowerCase(), join(versionManagerDir, "node.exe").toLowerCase(), `handed over to the wrong node: ${execPath}`);
    });
  });
});
