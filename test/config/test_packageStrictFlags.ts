// #2772 put `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` on all
// 59 package tsconfigs; 18 of them are standalone and carry their own copy of
// the two lines. Nothing held that — a 19th standalone config, or a new Vue
// package wired to plain `tsc`, passed CI in silence (#2778).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isRecord } from "../../server/utils/types.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PACKAGES_ROOT = path.join(REPO_ROOT, "packages");
const SKIPPED_DIRS = new Set(["node_modules", "dist", ".git"]);

// Floors, not exact counts: a walker that silently finds nothing would
// otherwise satisfy every assertion below.
const MIN_PACKAGE_CONFIGS = 50;
const MIN_VUE_PACKAGES = 10;

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

interface StrictFlags {
  noUncheckedIndexedAccess?: boolean;
  exactOptionalPropertyTypes?: boolean;
}

interface ConfigCheck {
  file: string;
  bothFlags: boolean;
  problem: string;
}

const readJsonObject = (filePath: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(readFileSync(filePath, "utf-8"));
  if (!isRecord(parsed)) throw new Error(`not a JSON object: ${relativePosix(filePath)}`);
  return parsed;
};

// Unsupported `extends` forms throw rather than resolving to "no flags found",
// so a config this gate cannot follow fails loudly instead of passing blank.
const extendsTargets = (config: Record<string, unknown>, configPath: string): string[] => {
  const declared = config.extends;
  if (declared === undefined) return [];
  const entries = Array.isArray(declared) ? declared : [declared];
  return entries.map((entry) => {
    if (typeof entry !== "string") throw new Error(`non-string extends in ${relativePosix(configPath)}`);
    if (!entry.startsWith(".")) throw new Error(`package-style extends is not resolvable here: "${entry}" in ${relativePosix(configPath)}`);
    return path.resolve(path.dirname(configPath), entry);
  });
};

const ownFlags = (config: Record<string, unknown>): StrictFlags => {
  const options = isRecord(config.compilerOptions) ? config.compilerOptions : {};
  const { noUncheckedIndexedAccess, exactOptionalPropertyTypes } = options;
  return {
    ...(typeof noUncheckedIndexedAccess === "boolean" ? { noUncheckedIndexedAccess } : {}),
    ...(typeof exactOptionalPropertyTypes === "boolean" ? { exactOptionalPropertyTypes } : {}),
  };
};

// The effective value after `extends` resolution, never the literal text: 7 of
// the 59 are `*.build.json` that inherit both flags from a sibling, and 34
// inherit them from `config/tsconfig.packages.json`. A grep would call all 41
// of them violations.
//
// Resolved by hand rather than through the TypeScript compiler API on purpose.
// Importing `typescript` into a linted file pulls the whole compiler `.d.ts`
// into typescript-eslint's type-aware program: it took `yarn lint` from 0.45 GB
// to 2.05 GB peak and OOM-killed both macOS CI runners. Output was verified
// equal to `parseJsonConfigFileContent` across all 59 configs.
const resolveFlags = (configPath: string, seen: Set<string>): StrictFlags => {
  if (seen.has(configPath)) throw new Error(`extends cycle at ${relativePosix(configPath)}`);
  seen.add(configPath);
  const config = readJsonObject(configPath);
  const inherited = extendsTargets(config, configPath).reduce<StrictFlags>((merged, target) => ({ ...merged, ...resolveFlags(target, new Set(seen)) }), {});
  return { ...inherited, ...ownFlags(config) };
};

const checkConfig = (configPath: string): ConfigCheck => {
  try {
    const flags = resolveFlags(configPath, new Set());
    return {
      file: relativePosix(configPath),
      bothFlags: flags.noUncheckedIndexedAccess === true && flags.exactOptionalPropertyTypes === true,
      problem: "",
    };
  } catch (error) {
    return { file: relativePosix(configPath), bothFlags: false, problem: error instanceof Error ? error.message : String(error) };
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

// Only packages that are TypeScript projects. `packages/mulmoclaude` bundles
// the host's `.vue` files but has no tsconfig — its `src/` is a gitignored
// build artifact, present locally and absent in a fresh clone.
const findVuePackages = (): VuePackage[] =>
  findFiles(PACKAGES_ROOT, (name) => name === "package.json").flatMap((manifest) => {
    const dir = path.dirname(manifest);
    if (!existsSync(path.join(dir, "tsconfig.json"))) return [];
    if (findFiles(dir, (name) => name.endsWith(".vue")).length === 0) return [];
    return [{ dir: relativePosix(dir), typecheck: readTypecheckScript(manifest) }];
  });

describe("packages/** tsconfig — strictness flags", () => {
  const configs = findFiles(PACKAGES_ROOT, (name) => /^tsconfig.*\.json$/.test(name));

  it("finds the package configs at all", () => {
    assert.ok(configs.length >= MIN_PACKAGE_CONFIGS, `only ${configs.length} package tsconfigs found — the walker is broken`);
  });

  it("enables both flags in every one", () => {
    const missing = configs.map(checkConfig).filter((config) => !config.bothFlags);
    assert.deepEqual(
      missing.map((config) => config.file),
      [],
    );
  });

  it("resolves every one without error", () => {
    const broken = configs.map(checkConfig).filter((config) => config.problem !== "");
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
    const wrongChecker = vuePackages.filter((pkg) => !pkg.typecheck.includes("vue-tsc"));
    assert.deepEqual(
      wrongChecker.map((pkg) => `${pkg.dir}: ${pkg.typecheck || "(no typecheck script)"}`),
      [],
    );
  });
});
