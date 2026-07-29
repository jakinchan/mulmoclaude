#!/usr/bin/env node
// Which publishable workspaces differ from what npm actually serves?
//
// A version equal to npm's latest does NOT mean the source matches the published
// tarball — only the release tag answers that, which is why a missing tag is itself
// reported rather than treated as "clean". This exists because the ReDoS fix in
// @mulmoclaude/markdown-utils sat unpublished for days with nothing saying so.
//
// Usage: node scripts/packages/audit-releases.mjs [--code-only]
//   --code-only  hide workspaces whose only drift is package.json (dependency bumps)
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const WORKSPACE_ROOTS = ["packages", "packages/bridges", "packages/plugins", "packages/services"];
const codeOnly = process.argv.includes("--code-only");

const run = (file, args) => {
  try {
    return execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
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

const tags = new Set(run("git", ["tag", "--list"]).split("\n"));

// Drift is classified, not just counted: a devDependency bump is not a release trigger,
// a change under src/ is.
const classify = (pkg, latest) => {
  const tag = `${pkg.name}@${latest}`;
  if (!latest) return { state: "unpublished", detail: "not on npm" };
  if (!tags.has(tag)) return { state: "untagged", detail: `no ${tag} tag — drift cannot be measured` };
  const changed = run("git", ["diff", "--name-only", tag, "HEAD", "--", pkg.dir]).split("\n").filter(Boolean);
  if (changed.length === 0) return { state: "clean", detail: "" };
  const code = changed.filter((file) => !file.endsWith("package.json"));
  return code.length > 0
    ? { state: "code drift", detail: `${code.length} source file(s): ${code[0]}${code.length > 1 ? " …" : ""}` }
    : { state: "manifest only", detail: "package.json only (dependency bumps)" };
};

const rows = workspaces.map((pkg) => {
  const latest = run("npm", ["view", pkg.name, "version", "--registry", "https://registry.npmjs.org/"]);
  return { name: pkg.name, local: pkg.version ?? "?", latest: latest || "—", ...classify(pkg, latest) };
});

const shown = codeOnly ? rows.filter((row) => row.state !== "clean" && row.state !== "manifest only") : rows;
const width = Math.max(...shown.map((row) => row.name.length), 8);

console.log(`${"package".padEnd(width)}  ${"local".padEnd(8)} ${"npm".padEnd(8)} ${"state".padEnd(14)} detail`);
console.log("-".repeat(width + 45));
for (const row of shown) {
  const bump = row.local !== row.latest && row.latest !== "—" ? " <== version ahead of npm" : "";
  console.log(`${row.name.padEnd(width)}  ${row.local.padEnd(8)} ${row.latest.padEnd(8)} ${row.state.padEnd(14)} ${row.detail}${bump}`);
}

const needsAttention = rows.filter((row) => row.state === "code drift" || row.state === "untagged");
console.log(`\n${rows.length} publishable workspaces · ${needsAttention.length} need a decision (code drift or missing tag)`);
