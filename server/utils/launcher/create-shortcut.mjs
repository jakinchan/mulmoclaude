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
 * @param {string[]} argv
 * @returns {{ dir: string | null, assumeYes: boolean }}
 */
export function parseCreateShortcutArgs(argv) {
  const dirIndex = argv.indexOf("--dir");
  const dir = dirIndex === -1 ? null : (argv[dirIndex + 1] ?? null);
  return { dir, assumeYes: argv.includes("--yes") || argv.includes("-y") };
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
  const { dir, assumeYes } = parseCreateShortcutArgs(argv);
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
