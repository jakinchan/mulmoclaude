// #2772 put `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` on all
// 59 package tsconfigs; 18 of them are standalone and carry their own copy of
// the two lines. Nothing held that — a 19th standalone config, or a new Vue
// package wired to plain `tsc`, passed CI in silence (#2778).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import typescript from "typescript";

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

interface ConfigCheck {
  file: string;
  bothFlags: boolean;
  errors: string[];
}

// The effective value after `extends` resolution, never the literal text: 7 of
// the 59 are `*.build.json` that inherit both flags from a sibling, and 34
// inherit them from `config/tsconfig.packages.json`. A grep would call all 41
// of them violations.
const checkConfig = (configPath: string): ConfigCheck => {
  const read = typescript.readConfigFile(configPath, typescript.sys.readFile);
  const parsed = typescript.parseJsonConfigFileContent(read.config ?? {}, typescript.sys, path.dirname(configPath));
  const diagnostics = read.error ? [read.error, ...parsed.errors] : parsed.errors;
  const failures = diagnostics.filter((diagnostic) => diagnostic.category === typescript.DiagnosticCategory.Error);
  return {
    file: relativePosix(configPath),
    bothFlags: parsed.options.noUncheckedIndexedAccess === true && parsed.options.exactOptionalPropertyTypes === true,
    errors: failures.map((diagnostic) => typescript.flattenDiagnosticMessageText(diagnostic.messageText, " ")),
  };
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

  it("parses every one without error", () => {
    const broken = configs.map(checkConfig).filter((config) => config.errors.length > 0);
    assert.deepEqual(
      broken.map((config) => `${config.file}: ${config.errors.join("; ")}`),
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
