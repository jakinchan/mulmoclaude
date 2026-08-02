// End-to-end integration test for the Bookmarks reference plugin
// (#1110). Loads the workspace-built `dist/index.js` through the real
// runtime loader with a real `makePluginRuntime`, then exercises the
// add → list → remove → list flow against an isolated tmp workspace.
//
// Skips automatically when the plugin's dist isn't present (i.e.
// `yarn build` hasn't been run in `packages/plugins/bookmarks-plugin/`). Add
// the build step to the test prereqs to make this hard-required.

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
const PLUGIN_DIR = path.resolve(__dirname, "../../packages/plugins/bookmarks-plugin");
const PLUGIN_DIST_INDEX = path.join(PLUGIN_DIR, "dist", "index.js");

const PKG_NAME = "@mulmoclaude/bookmarks-plugin";
const VERSION = "0.1.0";

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

interface BookmarkResult {
  ok: boolean;
  bookmark?: { id: string; url: string; title: string; addedAt: string };
  bookmarks?: { id: string; url: string; title: string }[];
  error?: string;
}

describe("Bookmarks plugin — end-to-end through the loader", () => {
  before(() => {
    // The dist must exist for the loader to import. If a developer hasn't
    // built the plugin yet (`cd packages/plugins/bookmarks-plugin && yarn build`),
    // skip rather than failing — CI runs the build before tests.
    if (!existsSync(PLUGIN_DIST_INDEX)) {
      console.warn(`[bookmarks integration] skipping: ${PLUGIN_DIST_INDEX} not built — run \`yarn build\` in packages/plugins/bookmarks-plugin/`);
    }
  });

  // Capture the FULL property descriptor so afterEach restores
  // writability + enumerability flags too. The earlier
  // `Object.defineProperty(..., {value, configurable})` shape silently
  // flipped the property to non-writable + non-enumerable, leaking
  // that mutation across tests (Codex review iter on PR #1124, same
  // fix as test_plugin_runtime.ts).
  let savedDataDescriptor: PropertyDescriptor | undefined;
  let savedConfigDescriptor: PropertyDescriptor | undefined;
  let dataRoot: string;
  let configRoot: string;

  beforeEach(() => {
    savedDataDescriptor = Object.getOwnPropertyDescriptor(WORKSPACE_PATHS, "pluginsData");
    savedConfigDescriptor = Object.getOwnPropertyDescriptor(WORKSPACE_PATHS, "pluginsConfig");
    dataRoot = mkdtempSync(path.join(tmpdir(), "bookmarks-int-data-"));
    configRoot = mkdtempSync(path.join(tmpdir(), "bookmarks-int-config-"));
    if (savedDataDescriptor) Object.defineProperty(WORKSPACE_PATHS, "pluginsData", { ...savedDataDescriptor, value: dataRoot });
    if (savedConfigDescriptor) Object.defineProperty(WORKSPACE_PATHS, "pluginsConfig", { ...savedConfigDescriptor, value: configRoot });
  });

  afterEach(() => {
    if (savedDataDescriptor) Object.defineProperty(WORKSPACE_PATHS, "pluginsData", savedDataDescriptor);
    if (savedConfigDescriptor) Object.defineProperty(WORKSPACE_PATHS, "pluginsConfig", savedConfigDescriptor);
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(configRoot, { recursive: true, force: true });
  });

  it("loads the factory plugin, runs add + list + remove, and publishes scoped events", async (ctx) => {
    if (!existsSync(PLUGIN_DIST_INDEX)) {
      ctx.skip("dist not built");
      return;
    }
    const { pubsub, published } = makeRecordingPubSub();
    const plugin = await loadPluginFromCacheDir(PKG_NAME, VERSION, PLUGIN_DIR, {
      runtimeFactory: (pkgName) => makePluginRuntime({ pkgName, pubsub, locale: "en", taskManager: createTaskManager() }),
    });
    assert.ok(plugin, "plugin should load");
    assert.equal(plugin.definition.name, "manageBookmarks");
    assert.ok(plugin.execute, "execute handler must be present");

    // 1. List on empty workspace returns 0 bookmarks (no publish).
    let res = (await plugin.execute({}, { kind: "list" })) as BookmarkResult;
    assert.deepEqual(res, { ok: true, bookmarks: [] });
    assert.equal(published.length, 0, "list must not publish");

    // 2. Add a bookmark — should publish "changed".
    res = (await plugin.execute({}, { kind: "add", url: "https://example.com/", title: "Example" })) as BookmarkResult;
    assert.equal(res.ok, true);
    if (!res.bookmark) throw new Error("add must return a bookmark");
    assert.equal(res.bookmark.url, "https://example.com/");
    assert.equal(published.length, 1, "add must publish exactly one changed event");
    const [addEvent] = published;
    assert.ok(addEvent);
    assert.equal(addEvent.channel, `plugin:${PKG_NAME}:changed`);

    // 3. List returns the bookmark.
    res = (await plugin.execute({}, { kind: "list" })) as BookmarkResult;
    assert.equal(res.bookmarks?.length, 1);
    if (!res.bookmarks) throw new Error("list must return bookmarks array");
    const [listed] = res.bookmarks;
    assert.ok(listed);
    const { id } = listed;

    // 4. Remove the bookmark — should publish "changed" again.
    res = (await plugin.execute({}, { kind: "remove", id })) as BookmarkResult;
    assert.deepEqual(res, { ok: true });
    assert.equal(published.length, 2);
    const [, removeEvent] = published;
    assert.ok(removeEvent);
    assert.equal(removeEvent.channel, `plugin:${PKG_NAME}:changed`);

    // 5. List again — back to empty.
    res = (await plugin.execute({}, { kind: "list" })) as BookmarkResult;
    assert.deepEqual(res, { ok: true, bookmarks: [] });

    // 6. Remove a non-existent id returns ok:false.
    res = (await plugin.execute({}, { kind: "remove", id: "ghost" })) as BookmarkResult;
    assert.deepEqual(res, { ok: false, error: "not_found" });
  });

  // Regression: parallel `add` calls used to read the same snapshot
  // and the later writer dropped the earlier change. The plugin now
  // serialises read-modify-write through a per-process mutex —
  // CodeRabbit review on PR #1124. Asserts: 5 concurrent `add`s land
  // in the file, none are silently dropped.
  it("serialises concurrent add calls — no lost updates", async (ctx) => {
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

    const PARALLEL = 5;
    const adds = Array.from({ length: PARALLEL }, (_, i) => execute({}, { kind: "add", url: `https://example.com/${i}`, title: `Example ${i}` }));
    await Promise.all(adds);

    const listed = (await execute({}, { kind: "list" })) as BookmarkResult;
    assert.equal(listed.bookmarks?.length, PARALLEL, `expected ${PARALLEL} bookmarks after concurrent adds, got ${listed.bookmarks?.length}`);
  });

  it("setSort writes to files.config (not files.data) and publishes prefs-changed", async (ctx) => {
    if (!existsSync(PLUGIN_DIST_INDEX)) {
      ctx.skip("dist not built");
      return;
    }
    const { pubsub, published } = makeRecordingPubSub();
    const plugin = await loadPluginFromCacheDir(PKG_NAME, VERSION, PLUGIN_DIR, {
      runtimeFactory: (pkgName) => makePluginRuntime({ pkgName, pubsub, locale: "en", taskManager: createTaskManager() }),
    });
    assert.ok(plugin?.execute);

    const res = (await plugin.execute({}, { kind: "setSort", by: "title" })) as BookmarkResult;
    assert.deepEqual(res, { ok: true });

    assert.equal(published.length, 1);
    const [prefsEvent] = published;
    assert.ok(prefsEvent);
    assert.equal(prefsEvent.channel, `plugin:${PKG_NAME}:prefs-changed`);

    // The prefs file should land under the config root, NOT data.
    const sanitisedSeg = encodeURIComponent(PKG_NAME);
    const expectedConfigFile = path.join(configRoot, sanitisedSeg, "prefs.json");
    assert.ok(existsSync(expectedConfigFile), `expected ${expectedConfigFile} to exist`);
    const expectedDataFile = path.join(dataRoot, sanitisedSeg, "prefs.json");
    assert.ok(!existsSync(expectedDataFile), "prefs must not leak into the data root");
  });
});
