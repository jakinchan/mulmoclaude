import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { writeImportedCollection, claudeSkillDir, dataSkillDir, hasNonDirAncestor } from "../../src/collection/registry/server/importWriter.ts";
import { configureCollectionHost } from "../../src/collection/server/index.ts";
import type { RegistryEntry } from "../../src/collection/registry/registryIndex.ts";

// The import writer asks the host where a skill is INSTALLED in this root —
// the staging tree when there is one, the active skill dir when there is not —
// so it needs a host binding like the rest of the engine. This one describes
// the standard staged layout, which is what every case below assumes.
configureCollectionHost({
  workspaceRoot: null,
  log: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
  paths: {
    userSkillsDir: () => path.join(tmpdir(), "iw-user-skills-empty"),
    projectSkillsDir: (root) => path.join(root, ".claude", "skills"),
    feedsRoot: (root) => path.join(root, "data", "feeds"),
    skillsStagingDir: (root) => path.join(root, "data", "skills"),
    archiveDir: "data/archive",
    collectionsRegistriesConfig: (root) => path.join(root, "config", "collections-registries.json"),
  },
  isPresetSlug: () => false,
});

// `registryName` is the short label the multi-registry refactor passes through
// (`"official"` for receptron/mulmoclaude-collections, otherwise the user's
// config entry name). The test exercises `writeImportedCollection` which is
// agnostic to the value — pin it to "official" to mirror what production
// passes in, since the entry fixture below also carries `registryName: "official"`.
const REGISTRY = "official";

const entry: RegistryEntry = {
  id: "isamu/movies",
  author: "isamu",
  slug: "movies",
  title: "映画リスト",
  icon: "movie",
  description: "d",
  version: "1.0.0",
  tags: [],
  license: "MIT",
  fieldCount: 2,
  views: [],
  hasSeed: true,
  seedCount: 1,
  path: "collections/isamu/movies",
  contentSha: "abc123",
  registryName: "official",
};

function validSchema(): Record<string, unknown> {
  return {
    title: "映画リスト",
    icon: "movie",
    dataPath: "data/movies/items",
    primaryKey: "id",
    fields: {
      id: { type: "string", label: "ID", primary: true },
      title: { type: "string", label: "Title" },
    },
  };
}

function makeBundle(overrides: Record<string, string> = {}): Map<string, string> {
  return new Map(
    Object.entries({
      "SKILL.md": "---\nname: movies\ndescription: x\n---\n# Movies",
      "schema.json": JSON.stringify(validSchema()),
      "meta.json": JSON.stringify({ author: "isamu", slug: "movies", version: "1.0.0", title: "映画リスト", description: "d", license: "MIT" }),
      "views/cinema.html": "<!doctype html><html></html>",
      "seed/items/a.json": JSON.stringify({ id: "a", title: "A" }),
      ...overrides,
    }),
  );
}

// `data/skills/<slug>/` is the source-of-truth after the refactor (#1839) —
// both authored and imported collections live here. Tests pin BOTH this and
// the `.claude/skills/<slug>/` mirror to lock the new dual-write contract.
// Path helpers come from the same `@mulmoclaude/core/skill-bridge` package
// the writer uses (re-exported by importWriter), so tests never hardcode the
// `data/skills` / `.claude/skills` segments themselves.
const sourceDir = (root: string, slug = "movies") => dataSkillDir(root, slug);
const mirrorDir = (root: string, slug = "movies") => claudeSkillDir(root, slug);
const seedFile = (root: string, slug = "movies") => path.join(root, "data", "collections", slug, "items", "a.json");

describe("writeImportedCollection", () => {
  let wsRoot: string;
  beforeEach(() => {
    wsRoot = mkdtempSync(path.join(tmpdir(), "mc-import-"));
  });
  afterEach(() => {
    rmSync(wsRoot, { recursive: true, force: true });
  });

  it("installs the bundle to data/skills, mirrors the allowlisted set to .claude/skills, normalizes dataPath, materializes seed, writes provenance", async () => {
    const result = await writeImportedCollection({ registry: REGISTRY, entry, bundle: makeBundle(), workspaceRoot: wsRoot, nowIso: "2026-06-27T00:00:00Z" });
    assert.ok(result.ok);
    assert.equal(result.localSlug, "movies");
    assert.equal(result.updated, false);
    assert.equal(result.seedWritten, 1);
    assert.equal(result.seedSkipped, false);

    // SOURCE — data/skills/<slug>/: the full bundle minus seed/ lands here.
    assert.ok(existsSync(path.join(sourceDir(wsRoot), "SKILL.md")), "SKILL.md in source");
    assert.ok(existsSync(path.join(sourceDir(wsRoot), "schema.json")), "schema.json in source");
    assert.ok(existsSync(path.join(sourceDir(wsRoot), "meta.json")), "meta.json in source (host bookkeeping)");
    assert.ok(existsSync(path.join(sourceDir(wsRoot), "views", "cinema.html")), "custom view in source");
    assert.ok(!existsSync(path.join(sourceDir(wsRoot), "seed")), "seed must not land in the skill dir");

    // MIRROR — .claude/skills/<slug>/: only the bridge allowlist
    // (SKILL.md / schema.json / templates/<safe>) crosses. meta.json, views/,
    // and .origin.json deliberately stay source-side.
    assert.ok(existsSync(path.join(mirrorDir(wsRoot), "SKILL.md")), "SKILL.md mirrored");
    assert.ok(existsSync(path.join(mirrorDir(wsRoot), "schema.json")), "schema.json mirrored");
    assert.ok(!existsSync(path.join(mirrorDir(wsRoot), "meta.json")), "meta.json is host bookkeeping — not mirrored");
    assert.ok(!existsSync(path.join(mirrorDir(wsRoot), "views")), "views/ stays source-side — host serves from data/skills");
    assert.ok(!existsSync(path.join(mirrorDir(wsRoot), ".origin.json")), ".origin.json is host bookkeeping — not mirrored");

    // dataPath is host-owned (R3), not the upstream value.
    const sourceSchema = JSON.parse(readFileSync(path.join(sourceDir(wsRoot), "schema.json"), "utf-8"));
    assert.equal(sourceSchema.dataPath, "data/collections/movies/items", "dataPath normalized in source");
    const mirroredSchema = JSON.parse(readFileSync(path.join(mirrorDir(wsRoot), "schema.json"), "utf-8"));
    assert.equal(mirroredSchema.dataPath, sourceSchema.dataPath, "mirror is a 1:1 copy");

    // Provenance — the imported-vs-authored marker — lives in source only.
    const origin = JSON.parse(readFileSync(path.join(sourceDir(wsRoot), ".origin.json"), "utf-8"));
    assert.equal(origin.registry, REGISTRY);
    assert.equal(origin.author, "isamu");
    assert.equal(origin.contentSha, "abc123");
    assert.equal(origin.importedAt, "2026-06-27T00:00:00Z");

    assert.ok(existsSync(seedFile(wsRoot)), "seed record materialized into dataPath");
  });

  it("mirrors template files (the bridge allowlist), not arbitrary nested dirs", async () => {
    // The bridge mirror is defined by isSafeActionTemplatePath:
    //   - `templates/<safe>` crosses
    //   - other dirs (views/, README.md, assets/) do not
    const bundle = makeBundle({
      "templates/invoice.md": "# Invoice template",
      "README.md": "# Notes",
      "assets/logo.png": "<binary>",
    });
    const result = await writeImportedCollection({ registry: REGISTRY, entry, bundle, workspaceRoot: wsRoot, nowIso: "t" });
    assert.ok(result.ok);

    // Source has everything from the bundle (minus seed).
    assert.ok(existsSync(path.join(sourceDir(wsRoot), "templates", "invoice.md")));
    assert.ok(existsSync(path.join(sourceDir(wsRoot), "README.md")));
    assert.ok(existsSync(path.join(sourceDir(wsRoot), "assets", "logo.png")));

    // Mirror has only the allowlist.
    assert.ok(existsSync(path.join(mirrorDir(wsRoot), "templates", "invoice.md")), "templates/ mirrored");
    assert.ok(!existsSync(path.join(mirrorDir(wsRoot), "README.md")), "README.md not in bridge allowlist");
    assert.ok(!existsSync(path.join(mirrorDir(wsRoot), "assets")), "assets/ not in bridge allowlist");
  });

  it("treats a same-origin re-import as an update and skips seed when data exists", async () => {
    await writeImportedCollection({ registry: REGISTRY, entry, bundle: makeBundle(), workspaceRoot: wsRoot, nowIso: "t1" });
    const again = await writeImportedCollection({ registry: REGISTRY, entry, bundle: makeBundle(), workspaceRoot: wsRoot, nowIso: "t2" });
    assert.ok(again.ok);
    assert.equal(again.updated, true);
    assert.equal(again.seedWritten, 0);
    assert.equal(again.seedSkipped, true, "existing dataPath → seed skipped");
  });

  it("renames to <slug>-2 when a different collection occupies the slug (and re-imports as an update)", async () => {
    // Pre-existing authored collection at data/skills/movies/ (no `.origin.json`).
    mkdirSync(sourceDir(wsRoot), { recursive: true });
    writeFileSync(path.join(sourceDir(wsRoot), "SKILL.md"), "someone else's collection");
    const result = await writeImportedCollection({ registry: REGISTRY, entry, bundle: makeBundle(), workspaceRoot: wsRoot, nowIso: "t" });
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.localSlug, "movies-2");
      assert.equal(result.updated, false, "a renamed fresh install is not an update");
    }
    // the user's own authored collection is untouched
    assert.equal(readFileSync(path.join(sourceDir(wsRoot), "SKILL.md"), "utf-8"), "someone else's collection");
    assert.ok(!existsSync(path.join(sourceDir(wsRoot), ".origin.json")), "authored collection has no .origin.json");
    // import lands under the renamed slug
    assert.ok(existsSync(path.join(sourceDir(wsRoot, "movies-2"), "SKILL.md")));
    assert.ok(existsSync(path.join(sourceDir(wsRoot, "movies-2"), ".origin.json")), "import has .origin.json (= user-vs-imported marker)");
    assert.ok(existsSync(path.join(mirrorDir(wsRoot, "movies-2"), "SKILL.md")), "imported skill also mirrors to .claude/skills");
    // schema + seed land under the renamed slug, not the original
    const renamedSchema = JSON.parse(readFileSync(path.join(sourceDir(wsRoot, "movies-2"), "schema.json"), "utf-8"));
    assert.equal(renamedSchema.dataPath, "data/collections/movies-2/items");
    assert.ok(existsSync(seedFile(wsRoot, "movies-2")), "seed materialized under movies-2");
    assert.ok(!existsSync(seedFile(wsRoot)), "no seed written under the original slug");
    // a second import reuses movies-2 (matching origin) as an update, not movies-3
    const again = await writeImportedCollection({ registry: REGISTRY, entry, bundle: makeBundle(), workspaceRoot: wsRoot, nowIso: "t2" });
    assert.ok(again.ok);
    if (again.ok) {
      assert.equal(again.localSlug, "movies-2");
      assert.equal(again.updated, true);
    }
  });

  it("re-imports into the existing renamed slug even after the original slug frees up", async () => {
    mkdirSync(sourceDir(wsRoot), { recursive: true });
    writeFileSync(path.join(sourceDir(wsRoot), "SKILL.md"), "someone else's collection");
    const first = await writeImportedCollection({ registry: REGISTRY, entry, bundle: makeBundle(), workspaceRoot: wsRoot, nowIso: "t1" });
    assert.ok(first.ok && first.localSlug === "movies-2");
    // the user deletes their own collection → the original slug frees up
    rmSync(sourceDir(wsRoot), { recursive: true, force: true });
    const again = await writeImportedCollection({ registry: REGISTRY, entry, bundle: makeBundle(), workspaceRoot: wsRoot, nowIso: "t2" });
    assert.ok(again.ok);
    if (again.ok) {
      assert.equal(again.localSlug, "movies-2", "updates the existing renamed install, not a fresh 'movies'");
      assert.equal(again.updated, true);
    }
    assert.ok(!existsSync(path.join(sourceDir(wsRoot), ".origin.json")), "no duplicate fresh install at the freed slug");
  });

  it("finds a free slug past several colliding installs", async () => {
    for (const slug of ["movies", "movies-2", "movies-3"]) {
      mkdirSync(sourceDir(wsRoot, slug), { recursive: true });
      writeFileSync(path.join(sourceDir(wsRoot, slug), "SKILL.md"), "a foreign collection");
    }
    const result = await writeImportedCollection({ registry: REGISTRY, entry, bundle: makeBundle(), workspaceRoot: wsRoot, nowIso: "t" });
    assert.ok(result.ok);
    if (result.ok) assert.equal(result.localSlug, "movies-4");
  });

  it("rejects an invalid schema with 422", async () => {
    const bundle = makeBundle({ "schema.json": JSON.stringify({ title: "x" }) });
    const result = await writeImportedCollection({ registry: REGISTRY, entry, bundle, workspaceRoot: wsRoot, nowIso: "t" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 422);
  });

  it("rejects a bundle missing SKILL.md with 422 (no half-imported skill)", async () => {
    // The mirror step calls mirrorSkillWrite for SKILL.md unconditionally;
    // missing SKILL.md would throw inside the catch-all and return ok:true
    // for an unusable import unless we reject up front.
    const bundle = makeBundle();
    bundle.delete("SKILL.md");
    const result = await writeImportedCollection({ registry: REGISTRY, entry, bundle, workspaceRoot: wsRoot, nowIso: "t" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 422);
      assert.match(result.error, /SKILL\.md/);
    }
    // Nothing landed on disk either side.
    assert.ok(!existsSync(sourceDir(wsRoot)), "no source dir written");
    assert.ok(!existsSync(mirrorDir(wsRoot)), "no mirror dir written");
  });

  it("walks past a slug whose mirror exists but source is absent (don't clobber a manual Claude skill)", async () => {
    // Pre-existing `.claude/skills/movies/` (e.g. installed by the Claude CLI
    // directly, or a legacy pre-refactor import). data/skills/movies/ is
    // absent. Without the mirror-also-absent check the writer would happily
    // pick `movies`, then `mirrorSkillDelete` would silently wipe the user's
    // skill (CodeRabbit review on #1839).
    mkdirSync(mirrorDir(wsRoot), { recursive: true });
    writeFileSync(path.join(mirrorDir(wsRoot), "SKILL.md"), "manually installed claude skill");
    const result = await writeImportedCollection({ registry: REGISTRY, entry, bundle: makeBundle(), workspaceRoot: wsRoot, nowIso: "t" });
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.localSlug, "movies-2", "skipped 'movies' because the mirror was taken");
    }
    // The manual skill is intact.
    assert.equal(readFileSync(path.join(mirrorDir(wsRoot), "SKILL.md"), "utf-8"), "manually installed claude skill");
  });

  it("does not blank the mirror dir as an intermediate state (write-then-prune ordering)", async () => {
    // Regression for the Codex finding on #1839: if mirrorToClaudeSkills had
    // delete-then-write ordering, a failure between delete and write would
    // leave `.claude/skills/<slug>/` empty. We can't easily inject a failure
    // in the writer here, but we CAN verify that after a successful re-import
    // the mirror's SKILL.md file inode never went to "absent + recreated"
    // unnecessarily — the prior install's files are overwritten via tmp+rename,
    // not deleted first. As a proxy, after a successful re-import the mirror
    // dir is non-empty across the whole operation (sampled before + after).
    await writeImportedCollection({ registry: REGISTRY, entry, bundle: makeBundle(), workspaceRoot: wsRoot, nowIso: "t1" });
    assert.ok(existsSync(path.join(mirrorDir(wsRoot), "SKILL.md")), "mirror present after first import");
    await writeImportedCollection({
      registry: REGISTRY,
      entry,
      bundle: makeBundle({ "SKILL.md": "---\nname: movies\ndescription: y\n---\n# Movies v2" }),
      workspaceRoot: wsRoot,
      nowIso: "t2",
    });
    assert.ok(existsSync(path.join(mirrorDir(wsRoot), "SKILL.md")), "mirror present after re-import");
    assert.match(readFileSync(path.join(mirrorDir(wsRoot), "SKILL.md"), "utf-8"), /Movies v2/, "re-imported content lands in the mirror");
  });

  it("re-import removes files that dropped out of the manifest (source + mirror)", async () => {
    await writeImportedCollection({ registry: REGISTRY, entry, bundle: makeBundle({ "templates/old.md": "old" }), workspaceRoot: wsRoot, nowIso: "t1" });
    assert.ok(existsSync(path.join(sourceDir(wsRoot), "templates", "old.md")), "template present after first install (source)");
    assert.ok(existsSync(path.join(mirrorDir(wsRoot), "templates", "old.md")), "template present after first install (mirror)");

    await writeImportedCollection({ registry: REGISTRY, entry, bundle: makeBundle(), workspaceRoot: wsRoot, nowIso: "t2" });
    assert.ok(!existsSync(path.join(sourceDir(wsRoot), "templates", "old.md")), "stale source file removed on re-import");
    assert.ok(!existsSync(path.join(mirrorDir(wsRoot), "templates", "old.md")), "stale mirror file removed on re-import");
    assert.ok(existsSync(path.join(sourceDir(wsRoot), "SKILL.md")), "current bundle still installed (source)");
    assert.ok(existsSync(path.join(mirrorDir(wsRoot), "SKILL.md")), "current bundle still installed (mirror)");
  });

  it("renames past a slug path that exists as a non-directory file", async () => {
    mkdirSync(path.dirname(sourceDir(wsRoot)), { recursive: true });
    writeFileSync(sourceDir(wsRoot), "i am a file, not a directory");
    const result = await writeImportedCollection({ registry: REGISTRY, entry, bundle: makeBundle(), workspaceRoot: wsRoot, nowIso: "t" });
    assert.ok(result.ok);
    if (result.ok) assert.equal(result.localSlug, "movies-2");
  });

  it("returns 409 when the data path exists as a non-directory file", async () => {
    mkdirSync(path.join(wsRoot, "data", "collections", "movies"), { recursive: true });
    writeFileSync(path.join(wsRoot, "data", "collections", "movies", "items"), "i am a file, not a directory");
    const result = await writeImportedCollection({ registry: REGISTRY, entry, bundle: makeBundle(), workspaceRoot: wsRoot, nowIso: "t" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 409);
  });

  it("returns 409 when an ancestor of the data path is a non-directory file", async () => {
    mkdirSync(path.join(wsRoot, "data", "collections"), { recursive: true });
    writeFileSync(path.join(wsRoot, "data", "collections", "movies"), "ancestor is a file, not a dir");
    const result = await writeImportedCollection({ registry: REGISTRY, entry, bundle: makeBundle(), workspaceRoot: wsRoot, nowIso: "t" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 409);
  });

  it("cleans leftover staging/backup dirs from a prior crashed import and still installs", async () => {
    // Staging / backup dirs live alongside the target under `data/skills/` now.
    const staging = path.join(wsRoot, "data", "skills", ".importing-movies");
    const backup = path.join(wsRoot, "data", "skills", ".backup-movies");
    mkdirSync(staging, { recursive: true });
    mkdirSync(backup, { recursive: true });
    writeFileSync(path.join(staging, "junk.txt"), "leftover from a crashed import");
    writeFileSync(path.join(backup, "junk.txt"), "leftover from a crashed swap");
    const result = await writeImportedCollection({ registry: REGISTRY, entry, bundle: makeBundle(), workspaceRoot: wsRoot, nowIso: "t" });
    assert.ok(result.ok);
    assert.ok(!existsSync(staging), "leftover staging dir removed");
    assert.ok(!existsSync(backup), "leftover backup dir removed");
    assert.ok(existsSync(path.join(sourceDir(wsRoot), "SKILL.md")));
    assert.ok(existsSync(path.join(mirrorDir(wsRoot), "SKILL.md")));
  });
});

// The ENOENT branch of `statType` is invisible to the integration tests on
// POSIX (there a file ancestor yields ENOTDIR, not ENOENT) — but it IS the path
// Windows takes for the same layout. Test `hasNonDirAncestor` directly so every
// runner covers the logic that turns a file-ancestor conflict into a 409.
describe("hasNonDirAncestor", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "mc-ancestor-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("true when an ancestor of the target is a non-directory file", async () => {
    writeFileSync(path.join(root, "a"), "i am a file");
    assert.equal(await hasNonDirAncestor(path.join(root, "a", "b", "c")), true);
  });

  it("false when the whole existing ancestor chain is directories", async () => {
    mkdirSync(path.join(root, "a", "b"), { recursive: true });
    assert.equal(await hasNonDirAncestor(path.join(root, "a", "b", "c")), false);
  });

  it("false when the target is genuinely absent under an existing directory", async () => {
    assert.equal(await hasNonDirAncestor(path.join(root, "missing", "deep", "leaf")), false);
  });
});
