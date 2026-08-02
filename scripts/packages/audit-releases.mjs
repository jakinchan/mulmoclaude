#!/usr/bin/env node
// Which publishable workspaces differ from what npm actually serves?
//
// A version equal to npm's latest does NOT mean the source matches the published
// tarball — only the release tag answers that, which is why a missing tag is itself
// reported rather than treated as "clean". This exists because the ReDoS fix in
// @mulmoclaude/markdown-utils sat unpublished for days with nothing saying so.
//
// Usage: node scripts/packages/audit-releases.mjs [--code-only]
//   --code-only  show only workspaces that need a decision
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const WORKSPACE_ROOTS = ["packages", "packages/bridges", "packages/plugins", "packages/services"];
const COMMAND_TIMEOUT_MS = 60_000;

// package.json keys that change what npm serves. `devDependencies` and `scripts` do
// not: they describe how the package is built here, not what a consumer receives.
const RELEASE_MANIFEST_KEYS = [
  "version",
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
  "exports",
  "files",
  "main",
  "module",
  "types",
  "typings",
  "bin",
  "engines",
  "sideEffects",
  "publishConfig",
];

// `dist/` is the thing npm ships and is gitignored, so drift has to be judged from what
// FEEDS it: `src/` (compiled) and `bin/` (copied). Everything else is taken from the
// package's own `files` declaration rather than assumed — a package that ships `assets/`
// or anything else says so there. README is included by npm whether or not `files`
// lists it, so an edit there changes the published artifact too.
const BUILD_INPUT_DIRS = ["src", "bin"];
const shippedRoots = (pkg) =>
  (Array.isArray(pkg.files) ? pkg.files : [])
    .map((entry) =>
      entry
        .replace(/^\.\//, "")
        .replace(/\/?\*+.*$/, "")
        .replace(/\/$/, ""),
    )
    .filter(Boolean);

const isReleasePath = (pkg, file) => {
  const relative = file.startsWith(`${pkg.dir}/`) ? file.slice(pkg.dir.length + 1) : file;
  if (path.basename(relative).toLowerCase().startsWith("readme")) return true;
  const under = (root) => relative === root || relative.startsWith(`${root}/`);
  return BUILD_INPUT_DIRS.some(under) || shippedRoots(pkg).some(under);
};

const codeOnly = process.argv.includes("--code-only");

// Distinguishes "the command said nothing" from "the command failed". Conflating them
// is how a registry blip would have been reported as `unpublished`, and a failed
// `git diff` as `clean` — an audit that answers "nothing to do" when it means "I could
// not tell" is worse than no audit (CodeRabbit, #2644).
const run = (file, args) => {
  try {
    return { ok: true, out: execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: COMMAND_TIMEOUT_MS }).trim() };
  } catch (error) {
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    // The last line of npm's stderr is the path to its debug log, which says nothing;
    // the line naming the code is the one worth showing.
    const meaningful = stderr.split("\n").find((line) => /error/i.test(line) && !line.includes("_logs/"));
    return { ok: false, out: "", error: (meaningful || error?.message || "command failed").trim(), raw: stderr };
  }
};

const readManifest = (dir) => {
  const manifest = path.join(dir, "package.json");
  return existsSync(manifest) ? { dir, ...JSON.parse(readFileSync(manifest, "utf8")) } : null;
};

const workspaces = WORKSPACE_ROOTS.filter((root) => existsSync(root))
  .flatMap((root) => readdirSync(root).map((entry) => readManifest(path.join(root, entry))))
  .filter((pkg) => pkg && !pkg.private && pkg.name)
  .sort((left, right) => left.name.localeCompare(right.name));

const tagList = run("git", ["tag", "--list"]);
if (!tagList.ok) {
  // Without the tag list every published package would read as `untagged`, which is a
  // fabricated finding rather than a missing one (Codex, #2644).
  console.error(`audit aborted: could not read git tags — ${tagList.error}`);
  process.exit(1);
}
const tags = new Set(tagList.out.split("\n"));

// A manifest diff only matters when a key a consumer sees actually moved.
const manifestChangedKeys = (pkg, tag) => {
  const published = run("git", ["show", `${tag}:${pkg.dir}/package.json`]);
  if (!published.ok) return { unknown: true, keys: [] };
  const before = JSON.parse(published.out);
  const current = JSON.parse(readFileSync(path.join(pkg.dir, "package.json"), "utf8"));
  const keys = RELEASE_MANIFEST_KEYS.filter((key) => JSON.stringify(before[key]) !== JSON.stringify(current[key]));
  return { unknown: false, keys };
};

const classify = (pkg, latest) => {
  const tag = `${pkg.name}@${latest.out}`;
  if (!latest.ok) return { state: "error", detail: `npm lookup failed: ${latest.error}` };
  if (!latest.out) return { state: "unpublished", detail: "not on npm" };
  if (!tags.has(tag)) return { state: "untagged", detail: `no ${tag} tag — drift cannot be measured` };

  const diff = run("git", ["diff", "--name-only", tag, "HEAD", "--", pkg.dir]);
  if (!diff.ok) return { state: "error", detail: `git diff failed: ${diff.error}` };
  const changed = diff.out.split("\n").filter(Boolean);
  if (changed.length === 0) return { state: "clean", detail: "" };

  const source = changed.filter((file) => file !== `${pkg.dir}/package.json` && isReleasePath(pkg, file));
  if (source.length > 0) return { state: "code drift", detail: `${source.length} shipped file(s): ${source[0]}${source.length > 1 ? " …" : ""}` };

  if (changed.includes(`${pkg.dir}/package.json`)) {
    const { unknown, keys } = manifestChangedKeys(pkg, tag);
    if (unknown) return { state: "error", detail: "could not read the published package.json from the tag" };
    if (keys.length > 0) return { state: "manifest drift", detail: `published fields changed: ${keys.join(", ")}` };
  }
  return { state: "clean", detail: `${changed.length} file(s) changed, none of which feed the tarball (per this package\u2019s own \`files\`)` };
};

const NEEDS_DECISION = new Set(["code drift", "manifest drift", "untagged", "unpublished", "error"]);

const rows = workspaces.map((pkg) => {
  const latest = run("npm", ["view", pkg.name, "version", "--registry", "https://registry.npmjs.org/"]);
  // `npm view` exits non-zero for a package that was never published; that is an
  // answer, not a failure, so it is mapped back before classification.
  const resolved = !latest.ok && /E?404|not found/i.test(`${latest.error ?? ""}${latest.raw ?? ""}`) ? { ok: true, out: "" } : latest;
  return { name: pkg.name, local: pkg.version ?? "?", latest: resolved.out || "—", ...classify(pkg, resolved) };
});

const attention = rows.filter((row) => NEEDS_DECISION.has(row.state));
const shown = codeOnly ? attention : rows;
const width = Math.max(...shown.map((row) => row.name.length), 8, 0);

if (shown.length > 0) {
  console.log(`${"package".padEnd(width)}  ${"local".padEnd(8)} ${"npm".padEnd(8)} ${"state".padEnd(15)} detail`);
  console.log("-".repeat(width + 46));
}
for (const row of shown) {
  const bump = row.local !== row.latest && row.latest !== "—" ? " <== version ahead of npm" : "";
  console.log(`${row.name.padEnd(width)}  ${row.local.padEnd(8)} ${row.latest.padEnd(8)} ${row.state.padEnd(15)} ${row.detail}${bump}`);
}

console.log(`\n${rows.length} publishable workspaces · ${attention.length} need a decision`);
if (attention.some((row) => row.state === "error")) {
  console.error("audit incomplete: at least one workspace could not be checked");
  process.exitCode = 1;
}
