// Every module the generated launcher imports must actually be in it.
//
// `BUNDLED_FILES` is a hand-written list in each generator, and #2625 is
// what that costs: `platform.mjs` was added to the Windows list and
// forgotten in the macOS one, so a freshly generated `.app` died at
// module resolution — before `run.mjs` could show its native alert, so
// the icon just blinked and vanished with no log and no dialog.
//
// The existing test asserted a hard-coded list of expected paths, which
// is the same hand-written list a second time: it agreed with the bug.
// This walks the real import graph instead, so a module added tomorrow
// fails here rather than on a user's machine.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { createAppBundle } from "../../../server/utils/launcher/macos/create-app.mjs";
import { createWindowsShortcut } from "../../../server/utils/launcher/windows/create-launcher.mjs";

// Every syntax that can pull in another file: `from "./x"` (covering
// re-exports too), `import("./x")`, and the bare side-effect form
// `import "./x"`. Missing that last one would make this whole check
// quietly weaker than it claims to be — a launcher module switching to
// it would go unnoticed again. Only relative specifiers matter: bare
// ones are node built-ins, the launcher having no dependencies.
const IMPORT_PATTERN = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.[^"']+)["']/g;

// `{import("./x.d.mts").Foo}` in a JSDoc type annotation is erased before
// anything runs, and the sibling `.d.mts` files are deliberately NOT
// bundled — they describe the modules, they are not part of them.
const isTypeOnly = (specifier: string): boolean => /\.d\.m?ts$/.test(specifier);

interface MissingImport {
  from: string;
  specifier: string;
}

// Walks outward from an entry module, collecting relative imports that
// do not exist on disk. Static analysis rather than a real `import()`:
// importing `run.mjs` would launch the thing.
const unresolvedImports = (entry: string): MissingImport[] => {
  const missing: MissingImport[] = [];
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      if (isTypeOnly(match[1])) continue;
      const target = resolve(dirname(file), match[1]);
      if (existsSync(target)) queue.push(target);
      else missing.push({ from: file, specifier: match[1] });
    }
  }
  return missing;
};

const withTempDir = async (body: (dir: string) => Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), "mulmoclaude-graph-"));
  try {
    await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const report = (missing: MissingImport[]) => missing.map(({ from, specifier }) => `${from} imports ${specifier}`).join("\n");

describe("unresolvedImports — the matcher itself", () => {
  // Written because the first version of this matcher only understood
  // `from "..."` and `import("...")`, so a side-effect import could have
  // hidden a missing module from the very check meant to catch it.
  const eachSyntax: [string, string][] = [
    ["static default", 'import thing from "./missing-a.mjs";'],
    ["static named", 'import { thing } from "./missing-b.mjs";'],
    ["side-effect", 'import "./missing-c.mjs";'],
    ["dynamic", 'const mod = await import("./missing-d.mjs");'],
    ["re-export", 'export { thing } from "./missing-e.mjs";'],
  ];

  eachSyntax.forEach(([label, source]) => {
    it(`sees a missing module imported by ${label}`, async () => {
      await withTempDir(async (dir) => {
        const entry = join(dir, "entry.mjs");
        writeFileSync(entry, `${source}\n`);
        const missing = unresolvedImports(entry);
        assert.equal(missing.length, 1, `${label} was not detected: ${report(missing)}`);
      });
    });
  });

  it("does not chase a specifier that resolves", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "present.mjs"), "export const ok = true;\n");
      const entry = join(dir, "entry.mjs");
      writeFileSync(entry, 'import "./present.mjs";\n');
      assert.deepEqual(unresolvedImports(entry), []);
    });
  });
});

describe("generated bundle import graph", () => {
  it("macOS: every module run.mjs reaches is present in the .app", async () => {
    await withTempDir(async (dir) => {
      const bundlePath = join(dir, "MulmoClaude.app");
      await createAppBundle({ bundlePath, name: "MulmoClaude", version: "9.9.9" });
      const entry = join(bundlePath, "Contents", "Resources", "utils", "launcher", "run.mjs");
      assert.ok(existsSync(entry), "run.mjs is the entry the stub execs — it must be bundled");
      const missing = unresolvedImports(entry);
      assert.deepEqual(missing, [], `the bundle cannot resolve its own imports:\n${report(missing)}`);
    });
  });

  it("Windows: every module run.mjs reaches is present in the install dir", async () => {
    await withTempDir(async (dir) => {
      const rootDir = join(dir, "launcher");
      // The .lnk needs Windows to write it; the file tree does not, and
      // the tree is what this asserts.
      await createWindowsShortcut({ rootDir, shortcutPath: join(dir, "MulmoClaude.lnk") }).catch(() => undefined);
      const entry = join(rootDir, "utils", "launcher", "run.mjs");
      assert.ok(existsSync(entry), "run.mjs is what the .vbs stub hands node — it must be copied");
      const missing = unresolvedImports(entry);
      assert.deepEqual(missing, [], `the launcher cannot resolve its own imports:\n${report(missing)}`);
    });
  });

  it("catches a module that was left out — the check itself must not be vacuous", async () => {
    await withTempDir(async (dir) => {
      const bundlePath = join(dir, "MulmoClaude.app");
      await createAppBundle({ bundlePath, name: "MulmoClaude", version: "9.9.9" });
      const launcherDir = join(bundlePath, "Contents", "Resources", "utils", "launcher");
      // Delete exactly the file #2625 was missing and confirm it is seen.
      rmSync(join(launcherDir, "platform.mjs"));
      const missing = unresolvedImports(join(launcherDir, "run.mjs"));
      assert.ok(missing.length > 0, "removing a bundled module must fail this check");
      assert.ok(
        missing.some(({ specifier }) => specifier.includes("platform.mjs")),
        report(missing),
      );
    });
  });
});
