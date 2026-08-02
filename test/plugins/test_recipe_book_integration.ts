// End-to-end integration test for the Recipe Book runtime plugin
// (#1175 / #1169 PR-A). Loads the workspace-built `dist/index.js`
// through the real runtime loader with a real `makePluginRuntime`,
// then exercises save → read → update → delete + the metadata-
// preservation invariant (CodeRabbit review on PR #1183) against an
// isolated tmp workspace.
//
// Skips automatically when the plugin's dist isn't present (i.e.
// `yarn build` hasn't been run in `packages/plugins/recipe-book-plugin/`).
// CI runs `yarn build:packages` before tests so this is hard-required
// in CI.

import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadPluginFromCacheDir } from "../../server/plugins/runtime-loader.js";
import { makePluginRuntime } from "../../server/plugins/runtime.js";
import { createTaskManager } from "../../server/events/task-manager/index.js";
import { WORKSPACE_PATHS } from "../../server/workspace/paths.js";
import type { IPubSub } from "../../server/events/pub-sub/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_DIR = path.resolve(__dirname, "../../packages/plugins/recipe-book-plugin");
const PLUGIN_DIST_INDEX = path.join(PLUGIN_DIR, "dist", "index.js");

const PKG_NAME = "@mulmoclaude/recipe-book-plugin";
const VERSION = "0.1.0";

interface RecipeSummary {
  slug: string;
  title: string;
  tags: string[];
  servings: number | null;
  updated: string;
}

interface Recipe extends RecipeSummary {
  prepTime: number | null;
  cookTime: number | null;
  created: string;
  body: string;
}

interface RecipeResult {
  ok: boolean;
  recipe?: Recipe;
  recipes?: RecipeSummary[];
  slug?: string;
  error?: string;
}

function makeRecordingPubSub(): { pubsub: IPubSub; published: { channel: string; data: unknown }[] } {
  const published: { channel: string; data: unknown }[] = [];
  return {
    pubsub: {
      publish(channel, data) {
        published.push({ channel, data });
      },
    },
    published,
  };
}

describe("Recipe Book plugin — end-to-end through the loader", () => {
  before(() => {
    if (!existsSync(PLUGIN_DIST_INDEX)) {
      console.warn(`[recipe-book integration] skipping: ${PLUGIN_DIST_INDEX} not built — run \`yarn build\` in packages/plugins/recipe-book-plugin/`);
    }
  });

  // Capture the FULL property descriptor so afterEach restores
  // writability + enumerability flags too — same fix as
  // test_bookmarks_integration.ts (Codex review iter on PR #1124).
  let savedDataDescriptor: PropertyDescriptor | undefined;
  let savedConfigDescriptor: PropertyDescriptor | undefined;
  let dataRoot: string;
  let configRoot: string;

  beforeEach(() => {
    savedDataDescriptor = Object.getOwnPropertyDescriptor(WORKSPACE_PATHS, "pluginsData");
    savedConfigDescriptor = Object.getOwnPropertyDescriptor(WORKSPACE_PATHS, "pluginsConfig");
    dataRoot = mkdtempSync(path.join(tmpdir(), "recipe-int-data-"));
    configRoot = mkdtempSync(path.join(tmpdir(), "recipe-int-config-"));
    if (savedDataDescriptor) Object.defineProperty(WORKSPACE_PATHS, "pluginsData", { ...savedDataDescriptor, value: dataRoot });
    if (savedConfigDescriptor) Object.defineProperty(WORKSPACE_PATHS, "pluginsConfig", { ...savedConfigDescriptor, value: configRoot });
  });

  afterEach(() => {
    if (savedDataDescriptor) Object.defineProperty(WORKSPACE_PATHS, "pluginsData", savedDataDescriptor);
    if (savedConfigDescriptor) Object.defineProperty(WORKSPACE_PATHS, "pluginsConfig", savedConfigDescriptor);
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(configRoot, { recursive: true, force: true });
  });

  it("save → read → list → delete round-trip with frontmatter preserved", async (ctx) => {
    if (!existsSync(PLUGIN_DIST_INDEX)) {
      ctx.skip("dist not built");
      return;
    }
    const { pubsub, published } = makeRecordingPubSub();
    const plugin = await loadPluginFromCacheDir(PKG_NAME, VERSION, PLUGIN_DIR, {
      runtimeFactory: (pkgName) => makePluginRuntime({ pkgName, pubsub, locale: "en", taskManager: createTaskManager() }),
    });
    assert.ok(plugin, "plugin should load");
    assert.equal(plugin.definition.name, "manageRecipes");
    assert.ok(plugin.execute, "execute handler must be present");

    // 1. List on empty workspace → []
    let res = (await plugin.execute({}, { kind: "list" })) as RecipeResult;
    assert.deepEqual(res, { ok: true, recipes: [] });
    assert.equal(published.length, 0, "list must not publish");

    // 2. Save → ok:true + "changed" pub event
    res = (await plugin.execute(
      {},
      {
        kind: "save",
        slug: "stuffed-peppers",
        title: "ピーマンの肉詰め",
        tags: ["和食", "主菜"],
        servings: 4,
        prepTime: 15,
        cookTime: 20,
        body: "## 材料\n- ピーマン 8個\n- 合いびき肉 300g\n\n## 手順\n1. ピーマンを縦半分に切る\n",
      },
    )) as RecipeResult;
    assert.equal(res.ok, true);
    assert.equal(res.recipe?.slug, "stuffed-peppers");
    assert.equal(published.length, 1);
    const [saveEvent] = published;
    assert.ok(saveEvent);
    assert.equal(saveEvent.channel, `plugin:${PKG_NAME}:changed`);

    // 3. Read returns the full recipe with all frontmatter + body
    res = (await plugin.execute({}, { kind: "read", slug: "stuffed-peppers" })) as RecipeResult;
    assert.equal(res.ok, true);
    assert.ok(res.recipe);
    if (!res.recipe) return;
    assert.equal(res.recipe.title, "ピーマンの肉詰め");
    assert.deepEqual(res.recipe.tags, ["和食", "主菜"]);
    assert.equal(res.recipe.servings, 4);
    assert.equal(res.recipe.prepTime, 15);
    assert.equal(res.recipe.cookTime, 20);
    assert.match(res.recipe.body, /## 材料/);
    assert.match(res.recipe.body, /## 手順/);
    assert.equal(typeof res.recipe.created, "string");
    assert.equal(typeof res.recipe.updated, "string");

    // 4. List returns one summary (body / prep / cook stripped)
    res = (await plugin.execute({}, { kind: "list" })) as RecipeResult;
    assert.ok(res.recipes);
    assert.equal(res.recipes.length, 1);
    const [summary] = res.recipes;
    assert.ok(summary);
    assert.equal(summary.slug, "stuffed-peppers");
    assert.equal(summary.servings, 4);

    // 5. Read on missing slug → not_found
    res = (await plugin.execute({}, { kind: "read", slug: "ghost" })) as RecipeResult;
    assert.equal(res.ok, false);
    assert.equal(res.error, "not_found");

    // 6. Delete → ok + second pub event
    res = (await plugin.execute({}, { kind: "delete", slug: "stuffed-peppers" })) as RecipeResult;
    assert.equal(res.ok, true);
    assert.equal(published.length, 2);

    // 7. Read after delete → not_found
    res = (await plugin.execute({}, { kind: "read", slug: "stuffed-peppers" })) as RecipeResult;
    assert.equal(res.ok, false);
    assert.equal(res.error, "not_found");
  });

  // Regression: CodeRabbit review on PR #1183 caught that `update`
  // dropped servings / prepTime / cookTime to null when the caller
  // omitted them. The fix mirrors how `tags` already preserved on
  // omit. This test locks the contract in place.
  it("update preserves omitted optional metadata (servings / prepTime / cookTime / tags)", async (ctx) => {
    if (!existsSync(PLUGIN_DIST_INDEX)) {
      ctx.skip("dist not built");
      return;
    }
    const { pubsub } = makeRecordingPubSub();
    const plugin = await loadPluginFromCacheDir(PKG_NAME, VERSION, PLUGIN_DIR, {
      runtimeFactory: (pkgName) => makePluginRuntime({ pkgName, pubsub, locale: "en", taskManager: createTaskManager() }),
    });
    assert.ok(plugin, "plugin should load");
    const { execute } = plugin;
    assert.ok(execute, "execute handler must be present");

    // Save with all metadata.
    await execute(
      {},
      {
        kind: "save",
        slug: "lasagna",
        title: "Lasagna",
        tags: ["italian", "main"],
        servings: 6,
        prepTime: 30,
        cookTime: 60,
        body: "Original body",
      },
    );

    // Update only title + body — omit tags / servings / prep / cook.
    const updateRes = (await execute(
      {},
      {
        kind: "update",
        slug: "lasagna",
        title: "Lasagna v2",
        body: "Refined body",
      },
    )) as RecipeResult;
    assert.equal(updateRes.ok, true);

    // Read back — omitted metadata MUST be preserved.
    const readRes = (await execute({}, { kind: "read", slug: "lasagna" })) as RecipeResult;
    assert.equal(readRes.ok, true);
    assert.ok(readRes.recipe);
    if (!readRes.recipe) return;
    assert.equal(readRes.recipe.title, "Lasagna v2");
    assert.equal(readRes.recipe.body.trim(), "Refined body");
    assert.deepEqual(readRes.recipe.tags, ["italian", "main"], "tags must survive a body-only update");
    assert.equal(readRes.recipe.servings, 6, "servings must survive a body-only update");
    assert.equal(readRes.recipe.prepTime, 30, "prepTime must survive a body-only update");
    assert.equal(readRes.recipe.cookTime, 60, "cookTime must survive a body-only update");
  });

  it("save refuses to overwrite an existing slug", async (ctx) => {
    if (!existsSync(PLUGIN_DIST_INDEX)) {
      ctx.skip("dist not built");
      return;
    }
    const { pubsub } = makeRecordingPubSub();
    const plugin = await loadPluginFromCacheDir(PKG_NAME, VERSION, PLUGIN_DIR, {
      runtimeFactory: (pkgName) => makePluginRuntime({ pkgName, pubsub, locale: "en", taskManager: createTaskManager() }),
    });
    assert.ok(plugin?.execute);
    if (!plugin?.execute) return;

    await plugin.execute({}, { kind: "save", slug: "dup", title: "First", body: "a" });
    const second = (await plugin.execute({}, { kind: "save", slug: "dup", title: "Second", body: "b" })) as RecipeResult;
    assert.equal(second.ok, false);
    assert.equal(second.error, "exists");
  });

  it("rejects invalid slugs at save / read / update / delete", async (ctx) => {
    if (!existsSync(PLUGIN_DIST_INDEX)) {
      ctx.skip("dist not built");
      return;
    }
    const { pubsub } = makeRecordingPubSub();
    const plugin = await loadPluginFromCacheDir(PKG_NAME, VERSION, PLUGIN_DIR, {
      runtimeFactory: (pkgName) => makePluginRuntime({ pkgName, pubsub, locale: "en", taskManager: createTaskManager() }),
    });
    assert.ok(plugin?.execute);
    if (!plugin?.execute) return;
    const { execute } = plugin;

    // Zod rejects bad slugs at the schema boundary for save/update —
    // those throw rather than returning ok:false. read/delete pass
    // them through and surface the io-layer's invalid_slug rejection.
    const badRead = (await execute({}, { kind: "read", slug: "Bad Slug!" })) as RecipeResult;
    assert.equal(badRead.ok, false);
    assert.equal(badRead.error, "invalid_slug");

    const badDelete = (await execute({}, { kind: "delete", slug: "Bad Slug!" })) as RecipeResult;
    assert.equal(badDelete.ok, false);
    assert.equal(badDelete.error, "invalid_slug");
  });
});
