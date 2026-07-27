// `mulmoclaude create-shortcut` — writes the clickable app bundle.
//
// Runs from a terminal (someone had to type the command), so this half
// talks in plain stdout. Everything the generated bundle says later is
// GUI, because by then there is no terminal to read.

import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import { createAppBundle } from "./macos/create-app.mjs";
import { windowsLocalAppData } from "./platform.mjs";
import { createWindowsShortcut, SHORTCUT_FILE_NAME } from "./windows/create-launcher.mjs";

export const APP_NAME = "MulmoClaude";
const BUNDLE_NAME = `${APP_NAME}.app`;

/**
 * `/Applications` when it is writable, `~/Applications` otherwise —
 * a non-admin account cannot write the former, and failing the whole
 * command over that would be silly when the fallback works identically.
 * @param {{ home?: string, canWrite?: (path: string) => boolean }} [deps]
 * @returns {string}
 */
export function defaultInstallDir({ home = homedir(), canWrite = isWritable } = {}) {
  return canWrite("/Applications") ? "/Applications" : join(home, "Applications");
}

function isWritable(path) {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fails on a `--dir` with no value the way `--port` does in the main
 * CLI entry point. Taking the next token unconditionally turns
 * `create-shortcut --dir --yes` into a literal `--yes/` directory —
 * silently writing the bundle somewhere nobody will find it.
 * @param {string[]} argv
 * @returns {import("./create-shortcut.d.mts").CreateShortcutArgs}
 */
export function parseCreateShortcutArgs(argv) {
  const assumeYes = argv.includes("--yes") || argv.includes("-y");
  const dirIndex = argv.indexOf("--dir");
  if (dirIndex === -1) return { ok: true, dir: null, assumeYes };
  const value = argv[dirIndex + 1];
  if (value === undefined || value.trim().length === 0) return { ok: false, reason: "--dir requires a directory path" };
  if (value.startsWith("-")) return { ok: false, reason: `--dir requires a directory path (got "${value}")` };
  return { ok: true, dir: value, assumeYes };
}

async function confirm(question) {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(`${question} [Y/n] `);
    return answer.trim() === "" || /^y(es)?$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

/**
 * Where the bundle goes, given an explicit `--dir` or none.
 * @param {string | null} dir
 * @returns {{ installDir: string, bundlePath: string }}
 */
export function resolveBundlePath(dir) {
  const installDir = dir ?? defaultInstallDir();
  return { installDir, bundlePath: join(installDir, BUNDLE_NAME) };
}

/**
 * The Start Menu's Programs folder — the closest Windows has to
 * `/Applications`: it is what Start's search looks through, and the
 * user can pin from there. `--dir` overrides it (Desktop, typically).
 * @param {{ env?: Record<string, string | undefined>, home?: string }} [deps]
 * @returns {string}
 */
export function defaultShortcutDir({ env = process.env, home = homedir() } = {}) {
  const roaming = env.APPDATA?.trim() ? env.APPDATA : join(home, "AppData", "Roaming");
  return join(roaming, "Microsoft", "Windows", "Start Menu", "Programs");
}

/**
 * Where the launcher's own files live. `%LOCALAPPDATA%` rather than
 * `%APPDATA%` deliberately: a roaming profile would copy these to
 * another machine, where the shortcut's absolute paths — and the node
 * install they assume — no longer mean anything.
 * @param {{ env?: Record<string, string | undefined>, home?: string }} [deps]
 * @returns {string}
 */
export function windowsLauncherRoot({ env = process.env, home = homedir() } = {}) {
  return join(windowsLocalAppData({ home, env }), APP_NAME);
}

/**
 * @param {string | null} dir
 * @returns {{ installDir: string, shortcutPath: string, rootDir: string }}
 */
export function resolveShortcutPath(dir) {
  const installDir = dir ?? defaultShortcutDir();
  return { installDir, shortcutPath: join(installDir, SHORTCUT_FILE_NAME), rootDir: windowsLauncherRoot() };
}

function reportCreated({ path, iconWritten }, log) {
  log(`✓ ${path}`);
  if (!iconWritten) log("  (icon could not be generated — the launcher uses the generic icon)");
  log("  Double-click it to start MulmoClaude. Re-run this command after upgrading to refresh it.");
}

async function createForDarwin(dir, version, log, assumeYes) {
  const { installDir, bundlePath } = resolveBundlePath(dir);
  if (!assumeYes && !(await confirmTarget(bundlePath, log))) return null;
  mkdirSync(installDir, { recursive: true });
  const { iconWritten } = await createAppBundle({ bundlePath, name: APP_NAME, version });
  return { path: bundlePath, iconWritten };
}

async function createForWindows(dir, log, assumeYes) {
  const { installDir, shortcutPath, rootDir } = resolveShortcutPath(dir);
  if (!assumeYes && !(await confirmTarget(shortcutPath, log))) return null;
  mkdirSync(installDir, { recursive: true });
  const { iconWritten } = await createWindowsShortcut({ rootDir, shortcutPath });
  log(`  launcher files: ${rootDir}`);
  return { path: shortcutPath, iconWritten };
}

/**
 * @param {string[]} argv
 * @param {import("./create-shortcut.d.mts").CreateShortcutContext} context
 * @returns {Promise<number>} process exit code
 */
export async function runCreateShortcut(argv, { version, log = console.log, error = console.error }) {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    error(`create-shortcut supports macOS and Windows only (this is ${process.platform}).`);
    return 1;
  }
  const parsed = parseCreateShortcutArgs(argv);
  if (!parsed.ok) {
    error(parsed.reason);
    return 1;
  }
  const created =
    process.platform === "darwin"
      ? await createForDarwin(parsed.dir, version, log, parsed.assumeYes)
      : await createForWindows(parsed.dir, log, parsed.assumeYes);
  if (!created) {
    log("Cancelled.");
    return 0;
  }
  reportCreated(created, log);
  return 0;
}

async function confirmTarget(bundlePath, log) {
  const exists = existsSync(bundlePath);
  log(exists ? `${bundlePath} already exists and will be replaced.` : `Create ${bundlePath}?`);
  return confirm(exists ? "Replace it?" : "Continue?");
}
