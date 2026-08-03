// #2772 put `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` on all
// 59 package tsconfigs; 18 of them are standalone and carry their own copy of
// the two lines. Nothing held that — a 19th standalone config, or a new Vue
// package wired to plain `tsc`, passed CI in silence (#2778).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { isRecord } from "../../server/utils/types.js";

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PACKAGES_ROOT = path.join(REPO_ROOT, "packages");
const SKIPPED_DIRS = new Set(["node_modules", "dist", ".git"]);
const CONFIG_FILE_NAME = /^tsconfig.*\.json$/;

// Floors, not exact counts: a walker that silently finds nothing would
// otherwise satisfy every assertion below.
const MIN_PACKAGE_CONFIGS = 50;
const MIN_VUE_PACKAGES = 10;

// One `tsc` process per config, so cap how many run at once — an unbounded
// fan-out over ~60 Node processes is what OOM-killed the macOS CI runners.
const TSC_CONCURRENCY = 8;
const SHOW_CONFIG_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

const relativePosix = (absolute: string): string => path.relative(REPO_ROOT, absolute).split(path.sep).join("/");

const findFiles = (dir: string, matches: (name: string) => boolean): string[] => {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findFiles(full, matches));
    else if (matches(entry.name)) found.push(full);
  }
  return found;
};

const chunked = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_unused, index) => items.slice(index * size, index * size + size));

const mapInBatches = async <T, R>(items: T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> =>
  chunked(items, size).reduce<Promise<R[]>>(async (done, batch) => [...(await done), ...(await Promise.all(batch.map(run)))], Promise.resolve([]));

interface ConfigCheck {
  file: string;
  bothFlags: boolean;
  problem: string;
}

// The effective value after `extends` resolution, never the literal text: 7 of
// the 59 are `*.build.json` that inherit both flags from a sibling, and 34
// inherit them from `config/tsconfig.packages.json`. A grep would call all 41
// of them violations.
//
// `tsc --showConfig` IS TypeScript's own resolver, so package-style
// (`"@tsconfig/node20/tsconfig.json"`) and extensionless (`"./tsconfig.base"`)
// targets resolve exactly as they do at compile time. Spawned rather than
// imported on purpose: `import ts from "typescript"` pulls the compiler's
// `.d.ts` into typescript-eslint's type-aware program, which took `yarn lint`
// from 0.45 GB to 2.05 GB peak and OOM-killed both macOS CI runners.
const TSC_BIN = createRequire(import.meta.url).resolve("typescript/bin/tsc");

const effectiveCompilerOptions = async (configPath: string): Promise<Record<string, unknown>> => {
  const { stdout } = await execFileAsync(process.execPath, [TSC_BIN, "--project", configPath, "--showConfig"], {
    cwd: REPO_ROOT,
    maxBuffer: SHOW_CONFIG_MAX_BUFFER_BYTES,
  });
  const parsed: unknown = JSON.parse(stdout);
  if (!isRecord(parsed) || !isRecord(parsed.compilerOptions)) throw new Error("--showConfig produced no compilerOptions");
  return parsed.compilerOptions;
};

// `tsc` reports config errors on stdout and exits non-zero; surface that text
// so an unresolvable `extends` fails loudly instead of reading as "no flags".
const describeFailure = (error: unknown): string => {
  if (isRecord(error) && typeof error.stdout === "string" && error.stdout.trim() !== "") return error.stdout.trim().split("\n").join(" / ");
  return error instanceof Error ? error.message : String(error);
};

const checkConfig = async (configPath: string): Promise<ConfigCheck> => {
  const file = relativePosix(configPath);
  try {
    const options = await effectiveCompilerOptions(configPath);
    return { file, bothFlags: options.noUncheckedIndexedAccess === true && options.exactOptionalPropertyTypes === true, problem: "" };
  } catch (error) {
    return { file, bothFlags: false, problem: describeFailure(error) };
  }
};

interface VuePackage {
  dir: string;
  typecheck: string;
}

const readTypecheckScript = (manifestPath: string): string => {
  const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf-8"));
  if (!isRecord(parsed) || !isRecord(parsed.scripts)) return "";
  const { typecheck } = parsed.scripts;
  return typeof typecheck === "string" ? typecheck : "";
};

const hasTsConfig = (dir: string): boolean => readdirSync(dir, { withFileTypes: true }).some((entry) => entry.isFile() && CONFIG_FILE_NAME.test(entry.name));

// Only packages that are TypeScript projects — any `tsconfig*.json` counts, so
// a package that ships only `tsconfig.app.json` is still held. `packages/mulmoclaude`
// bundles the host's `.vue` files but has no tsconfig at all — its `src/` is a
// gitignored build artifact, present locally and absent in a fresh clone.
const findVuePackages = (): VuePackage[] =>
  findFiles(PACKAGES_ROOT, (name) => name === "package.json").flatMap((manifest) => {
    const dir = path.dirname(manifest);
    if (!hasTsConfig(dir)) return [];
    if (findFiles(dir, (name) => name.endsWith(".vue")).length === 0) return [];
    return [{ dir: relativePosix(dir), typecheck: readTypecheckScript(manifest) }];
  });

const COMMAND_SEPARATORS = /&&|\|\||;|\|/;
const ENV_ASSIGNMENT = /^[A-Za-z_]\w*=/;
const EXECUTABLE_SUFFIX = /\.(cmd|exe|bat)$/;
const COMMAND_WRAPPERS = new Set(["npx", "pnpm", "bunx", "cross-env", "node"]);
const VUE_TSC = "vue-tsc";

const invokedBinary = (tokens: string[]): string => {
  const [head, ...rest] = tokens;
  if (head === undefined || head === "") return "";
  const name = path.basename(head).replace(EXECUTABLE_SUFFIX, "");
  if (ENV_ASSIGNMENT.test(head) || COMMAND_WRAPPERS.has(name)) return invokedBinary(rest);
  return name;
};

// Which binaries the script actually RUNS. A substring test would accept
// `echo vue-tsc`, which typechecks nothing at all.
const invokedBinaries = (script: string): string[] =>
  script
    .split(COMMAND_SEPARATORS)
    .map((command) => invokedBinary(command.trim().split(/\s+/)))
    .filter((name) => name !== "");

describe("packages/** tsconfig — strictness flags", () => {
  const configs = findFiles(PACKAGES_ROOT, (name) => CONFIG_FILE_NAME.test(name));
  const checks = mapInBatches(configs, TSC_CONCURRENCY, checkConfig);

  it("finds the package configs at all", () => {
    assert.ok(configs.length >= MIN_PACKAGE_CONFIGS, `only ${configs.length} package tsconfigs found — the walker is broken`);
  });

  it("enables both flags in every one", async () => {
    const missing = (await checks).filter((config) => !config.bothFlags && config.problem === "");
    assert.deepEqual(
      missing.map((config) => config.file),
      [],
    );
  });

  it("resolves every one without error", async () => {
    const broken = (await checks).filter((config) => config.problem !== "");
    assert.deepEqual(
      broken.map((config) => `${config.file}: ${config.problem}`),
      [],
    );
  });
});

describe("packages/** — .vue sources need a checker that reads them", () => {
  const vuePackages = findVuePackages();

  it("finds the Vue packages at all", () => {
    assert.ok(vuePackages.length >= MIN_VUE_PACKAGES, `only ${vuePackages.length} Vue packages found — the walker is broken`);
  });

  // `tsc` parses no `.vue` file whatsoever, so a package wired to it reports
  // zero errors for templates and `<script setup>` bodies nobody checked.
  it("typechecks each of them with vue-tsc", () => {
    const wrongChecker = vuePackages.filter((pkg) => !invokedBinaries(pkg.typecheck).includes(VUE_TSC));
    assert.deepEqual(
      wrongChecker.map((pkg) => `${pkg.dir}: ${pkg.typecheck || "(no typecheck script)"}`),
      [],
    );
  });
});
