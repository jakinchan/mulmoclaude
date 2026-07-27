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
  if (value === undefined) return { ok: false, reason: "--dir requires a directory path" };
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
 * @param {string[]} argv
 * @param {{ version: string, log?: (message: string) => void, error?: (message: string) => void }} context
 * @returns {Promise<number>} process exit code
 */
export async function runCreateShortcut(argv, { version, log = console.log, error = console.error }) {
  if (process.platform !== "darwin") {
    error(`create-shortcut currently supports macOS only (this is ${process.platform}).`);
    return 1;
  }
  const parsed = parseCreateShortcutArgs(argv);
  if (!parsed.ok) {
    error(parsed.reason);
    return 1;
  }
  const { dir, assumeYes } = parsed;
  const installDir = dir ?? defaultInstallDir();
  const bundlePath = join(installDir, BUNDLE_NAME);

  if (!assumeYes && !(await confirmTarget(bundlePath, log))) {
    log("Cancelled.");
    return 0;
  }

  mkdirSync(installDir, { recursive: true });
  const { iconWritten } = await createAppBundle({ bundlePath, name: APP_NAME, version });
  log(`✓ ${bundlePath}`);
  if (!iconWritten) log("  (icon could not be generated — the bundle uses the generic app icon)");
  log(`  Double-click it to start MulmoClaude. Re-run this command after upgrading to refresh the bundle.`);
  return 0;
}

async function confirmTarget(bundlePath, log) {
  const exists = existsSync(bundlePath);
  log(exists ? `${bundlePath} already exists and will be replaced.` : `Create ${bundlePath}?`);
  return confirm(exists ? "Replace it?" : "Continue?");
}
