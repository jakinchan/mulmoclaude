// Generates the Windows launcher: an install directory holding the
// launcher modules, plus a .lnk pointing at the .vbs stub.
//
// The macOS side could write its own artifact because a .app is just a
// directory. A .lnk is a binary format, so it is produced by the one
// thing every Windows install has that can write one: the WScript.Shell
// COM object, driven from PowerShell. Measured on a real runner before
// this was written — created, read back, and launched (see
// plans/feat-2613-launcher-windows.md).

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderNodeMissingText } from "../node-missing-text.mjs";
import { pickLauncherLocale } from "../messages.mjs";
import { buildIco } from "./icon.mjs";
import { windowsMessageFileTargets } from "./locale.mjs";

const LAUNCHER_SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const UTILS_SRC_DIR = join(LAUNCHER_SRC_DIR, "..");

export const SHORTCUT_FILE_NAME = "MulmoClaude.lnk";
const STUB_RELATIVE_PATH = join("utils", "launcher", "windows", "launch.vbs");
const ICON_FILE_NAME = "icon.ico";

// Same list the macOS bundle carries, mirroring the repo layout so
// run.mjs's `../port.mjs` resolves. The shell stub differs per OS and
// is written separately.
const BUNDLED_FILES = [
  "launcher/run.mjs",
  "launcher/start.mjs",
  "launcher/detect-server.mjs",
  "launcher/launcher-page.mjs",
  "launcher/messages.mjs",
  "launcher/platform.mjs",
  "launcher/preflight.mjs",
  "port.mjs",
];

function copyBundledFiles(rootDir) {
  const utilsDir = join(rootDir, "utils");
  BUNDLED_FILES.forEach((relative) => {
    const target = join(utilsDir, relative);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(UTILS_SRC_DIR, relative), target);
  });
  const stubTarget = join(rootDir, STUB_RELATIVE_PATH);
  mkdirSync(dirname(stubTarget), { recursive: true });
  copyFileSync(join(LAUNCHER_SRC_DIR, "windows", "launch.vbs"), stubTarget);
}

/**
 * Message files are named by primary language id so the .vbs can pick
 * one with arithmetic alone — see windows/locale.mjs. `en.txt` is the
 * fallback the stub reaches for when a machine's language is not one
 * the launcher ships.
 * @param {string} rootDir
 * @returns {void}
 */
export function writeWindowsMessages(rootDir) {
  const dir = join(rootDir, "messages");
  mkdirSync(dir, { recursive: true });
  // UTF-16LE with a BOM: the stub opens these as Unicode, which is what
  // keeps translated prose intact without a codepage guess.
  const BOM = "\ufeff";
  const write = (name, locale) => writeFileSync(join(dir, name), `${BOM}${renderNodeMissingText(locale)}`, "utf16le");
  windowsMessageFileTargets().forEach(({ primaryLanguageId, locale }) => write(`lcid-${primaryLanguageId}.txt`, locale));
  write("en.txt", pickLauncherLocale(""));
}

/**
 * PowerShell source that writes one .lnk. Built as a string so the
 * quoting can be asserted without a Windows machine — a shortcut whose
 * arguments lost their quotes points at nothing, and the failure would
 * only ever show up as a double-click that does nothing.
 * @param {{ shortcutPath: string, stubPath: string, iconPath: string | null, workingDir: string }} options
 * @returns {string}
 */
export function shortcutPowerShell({ shortcutPath, stubPath, iconPath, workingDir }) {
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  // wscript takes the stub path as its argument; the inner quotes are
  // needed because %LOCALAPPDATA% carries the account name and may
  // contain spaces. `,0` selects the first icon in the .ico.
  const quotedStubPath = `"${stubPath}"`;
  const iconLocation = iconPath === null ? null : `${iconPath},0`;
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    "$shell = New-Object -ComObject WScript.Shell",
    `$link = $shell.CreateShortcut(${quote(shortcutPath)})`,
    '$link.TargetPath = "$env:SystemRoot\\System32\\wscript.exe"',
    `$link.Arguments = ${quote(quotedStubPath)}`,
    `$link.WorkingDirectory = ${quote(workingDir)}`,
    "$link.Description = 'MulmoClaude'",
  ];
  if (iconLocation !== null) lines.push(`$link.IconLocation = ${quote(iconLocation)}`);
  lines.push("$link.Save()");
  return lines.join("\n");
}

function runPowerShell(script) {
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "pipe" });
}

/**
 * Write (or overwrite) the launcher at `rootDir` and a .lnk at
 * `shortcutPath`.
 * @param {{ rootDir: string, shortcutPath: string }} options
 * @returns {Promise<{ shortcutPath: string, iconWritten: boolean }>}
 */
export async function createWindowsShortcut({ rootDir, shortcutPath }) {
  rmSync(rootDir, { recursive: true, force: true });
  mkdirSync(rootDir, { recursive: true });
  copyBundledFiles(rootDir);
  writeWindowsMessages(rootDir);

  const iconPath = join(rootDir, ICON_FILE_NAME);
  const iconWritten = await buildIco(iconPath);

  mkdirSync(dirname(shortcutPath), { recursive: true });
  runPowerShell(
    shortcutPowerShell({
      shortcutPath,
      stubPath: join(rootDir, STUB_RELATIVE_PATH),
      iconPath: iconWritten ? iconPath : null,
      workingDir: rootDir,
    }),
  );

  return { shortcutPath, iconWritten };
}
