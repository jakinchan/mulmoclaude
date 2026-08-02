#!/usr/bin/env node
// CLI entry — `npx create-mulmoclaude-plugin <name>`.
//
// Single positional argument: the plugin's npm package name. Writes
// a self-contained plugin directory in cwd and prints next-step
// instructions. No interactive prompts (Phase 1).

import { realpathSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { directoryNameFor, validatePluginName } from "./validate.js";
import { applyPlaceholders, TEMPLATE_FILES } from "./template.js";

const USAGE = `Usage: npx create-mulmoclaude-plugin <package-name>

Examples:
  npx create-mulmoclaude-plugin my-plugin
  npx create-mulmoclaude-plugin @example/cool-plugin

Creates a directory matching the package name (or the local part of a
scoped name) in the current directory, populated with a runnable
counter sample plugin. Edit src/* to evolve into your own plugin.`;

interface CliResult {
  exitCode: number;
}

export async function runCli(argv: readonly string[], cwd: string, write: (output: string) => void): Promise<CliResult> {
  const positional = argv.filter((arg) => !arg.startsWith("-"));
  const [packageName] = positional;
  if (packageName === undefined) {
    write(`${USAGE}\n`);
    return { exitCode: 1 };
  }
  if (positional.length > 1) {
    write(`Expected exactly one package name, got ${positional.length}: ${positional.join(", ")}\n`);
    write(`${USAGE}\n`);
    return { exitCode: 1 };
  }
  const validation = validatePluginName(packageName);
  if (!validation.ok) {
    write(`Invalid package name: ${validation.reason}\n`);
    write(`${USAGE}\n`);
    return { exitCode: 1 };
  }
  const dirName = directoryNameFor(packageName);
  const target = path.resolve(cwd, dirName);
  if (await pathExists(target)) {
    write(`Refusing to overwrite existing path: ${target}\n`);
    return { exitCode: 1 };
  }
  await scaffoldInto(target, packageName);
  write(formatSuccessMessage(dirName, packageName));
  return { exitCode: 0 };
}

async function scaffoldInto(target: string, packageName: string): Promise<void> {
  await mkdir(target, { recursive: true });
  for (const entry of TEMPLATE_FILES) {
    const filePath = path.join(target, entry.path);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, applyPlaceholders(entry.content, packageName), "utf-8");
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function formatSuccessMessage(dirName: string, packageName: string): string {
  return [
    "",
    `✓ Created ${dirName}/`,
    "",
    "Next:",
    "",
    `  cd ${dirName}`,
    "  yarn install",
    "  yarn build",
    "",
    "  # Link into mulmoclaude for local dev (PR2 of receptron/mulmoclaude#1159 will replace this with a UI install-from-path mode):",
    "  yarn link",
    `  cd ../mulmoclaude && yarn link ${packageName}`,
    "",
    "  # Publish when ready:",
    "  npm publish",
    "",
    "Read the README in the new directory for the full dev loop.",
    "",
  ].join("\n");
}

// Only run the CLI when invoked directly. Importing `index.ts` from
// tests should not exit the process. Compare resolved paths (handles
// Windows separators, symlinks via npm bin shims, and any future
// `dist/index.mjs` build target).
export function entryMatchesModule(entry: string | undefined, moduleUrl: string): boolean {
  if (!entry) return false;
  try {
    return realpathSync(entry) === fileURLToPath(moduleUrl);
  } catch {
    return false;
  }
}

if (entryMatchesModule(process.argv[1], import.meta.url)) {
  runCli(process.argv.slice(2), process.cwd(), (text) => process.stdout.write(text))
    .then((result) => {
      process.exit(result.exitCode);
    })
    .catch((error) => {
      process.stderr.write(`Unexpected error: ${String(error)}\n`);
      process.exit(1);
    });
}
