// Tests for the factory-shape detection in `runtime-loader.ts` (#1110).
//
// The loader supports two plugin shapes:
//   1. Legacy:  `export const TOOL_DEFINITION = ...; export async function fooTool(...)`
//   2. Factory: `export default definePlugin((runtime) => ({ TOOL_DEFINITION, fooTool }))`
//
// Both must produce the same `RuntimePlugin` shape so the dispatch
// route works unchanged. The factory case must call the supplied
// `runtimeFactory` callback so the handler closes over the per-plugin
// scoped runtime.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadPluginFromCacheDir } from "../../server/plugins/runtime-loader.js";
import { makePluginRuntime } from "../../server/plugins/runtime.js";
import { createTaskManager } from "../../server/events/task-manager/index.js";
import type { IPubSub } from "../../server/events/pub-sub/index.js";

interface FixtureOpts {
  /** Source for `entry.js`. */
  entryContent: string;
}

function makeFixture(opts: FixtureOpts): string {
  const dir = mkdtempSync(path.join(tmpdir(), "mulmo-runtime-loader-factory-"));
  const pkg = JSON.stringify({
    name: "@fixture/plugin",
    version: "1.0.0",
    type: "module",
    exports: { ".": { import: "./entry.js" } },
  });
  writeFileSync(path.join(dir, "package.json"), pkg);
  const entryPath = path.join(dir, "entry.js");
  mkdirSync(path.dirname(entryPath), { recursive: true });
  writeFileSync(entryPath, opts.entryContent);
  return dir;
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

describe("loadPluginFromCacheDir — factory shape", () => {
  it("calls the factory with the supplied runtime and exposes the named handler", async () => {
    // The factory closes over `runtime.pubsub` and exposes a handler
    // under TOOL_DEFINITION.name. Calling the handler from outside
    // (as the dispatch route does) must trigger the publish.
    const dir = makeFixture({
      entryContent: `
function definePlugin(setup) { return setup; }
export default definePlugin(({ pubsub }) => ({
  TOOL_DEFINITION: {
    name: "fixtureTool",
    description: "factory-shape fixture",
    parameters: { type: "object", properties: {} },
  },
  async fixtureTool(args) {
    pubsub.publish("called", args);
    return { ok: true };
  },
}));
`,
    });
    const { pubsub, published } = makeRecordingPubSub();
    const plugin = await loadPluginFromCacheDir("@fixture/plugin", "1.0.0", dir, {
      // Production wiring: each plugin gets a fresh scoped runtime.
      runtimeFactory: (pkgName) => makePluginRuntime({ pkgName, pubsub, locale: "en", taskManager: createTaskManager() }),
    });
    assert.ok(plugin, "expected plugin to load");
    assert.equal(plugin.definition.name, "fixtureTool");
    assert.ok(plugin.execute, "execute handler must be captured");
    // Calling the handler via the dispatch-route signature `(ctx, args)`
    // should still invoke the factory's `(args)`-only handler with the
    // correct args (the loader wraps to discard `ctx`).
    await plugin.execute({}, { hello: "world" });
    // The host-side recording pubsub should see the SCOPED channel.
    assert.deepEqual(published, [{ channel: "plugin:@fixture/plugin:called", data: { hello: "world" } }]);
  });

  it("with no runtimeFactory, factory plugins still load (definition-only path)", async () => {
    // The MCP child loads plugins to know TOOL_DEFINITION but never
    // invokes the handler. The stub runtime supplies enough for the
    // factory body to evaluate; only handler invocation throws.
    const dir = makeFixture({
      entryContent: `
function definePlugin(setup) { return setup; }
export default definePlugin(({ pubsub }) => ({
  TOOL_DEFINITION: {
    name: "fixtureTool",
    description: "factory-shape fixture",
    parameters: { type: "object", properties: {} },
  },
  async fixtureTool() {
    // Should never actually run when no real runtime is provided.
    pubsub.publish("called", {});
    return { ok: true };
  },
}));
`,
    });
    const plugin = await loadPluginFromCacheDir("@fixture/plugin", "1.0.0", dir);
    assert.ok(plugin, "definition-only load must still produce a RuntimePlugin");
    assert.equal(plugin.definition.name, "fixtureTool");
    assert.ok(plugin.execute, "handler is captured even with stub runtime");
    // The stub runtime's pubsub.publish is a silent no-op (not a throw),
    // so calling the handler in this path does not blow up — but the
    // event would never reach a real subscriber. The contract is that
    // the parent server always passes a real runtimeFactory; tests of
    // that path live above.
  });

  // The stub runtime used to be asserted into `PluginRuntime` with a double
  // cast, so members the real runtime had since grown (`files.artifacts`,
  // `notifier.update` / `.get`) silently stayed `undefined` — a plugin
  // touching one got `TypeError: … is not a function` instead of the
  // loader's "unavailable in this process" message.
  it("stub runtime exposes every member the real runtime provides", async () => {
    const dir = makeFixture({
      entryContent: `
function definePlugin(setup) { return setup; }
export default definePlugin((runtime) => ({
  TOOL_DEFINITION: {
    name: "fixtureTool",
    description: "runtime-shape probe",
    parameters: { type: "object", properties: {} },
  },
  async fixtureTool() {
    // The stub throws synchronously rather than rejecting, so this cannot
    // be a \`.catch\`.
    let artifactsReadError = null;
    try { await runtime.files.artifacts.read("x"); } catch (err) { artifactsReadError = err.message; }
    return {
      files: Object.keys(runtime.files),
      notifier: Object.keys(runtime.notifier),
      artifactsReadError,
    };
  },
}));
`,
    });
    const plugin = await loadPluginFromCacheDir("@fixture/plugin", "1.0.0", dir);
    assert.ok(plugin?.execute);
    assert.deepEqual(await plugin.execute({}, {}), {
      files: ["data", "config", "artifacts"],
      notifier: ["publish", "update", "clear", "get"],
      artifactsReadError: "plugin/@fixture/plugin: runtime.files.read unavailable in this process (definition-only load)",
    });
  });

  it("legacy shape continues to load (backward compatibility)", async () => {
    const dir = makeFixture({
      entryContent: `
export const TOOL_DEFINITION = {
  name: "fixtureTool",
  description: "legacy-shape fixture",
  parameters: { type: "object", properties: {} },
};
export async function fixtureTool(_context, args) {
  return { ok: true, args };
}
`,
    });
    const plugin = await loadPluginFromCacheDir("@fixture/plugin", "1.0.0", dir);
    assert.ok(plugin, "legacy shape must still load");
    assert.equal(plugin.definition.name, "fixtureTool");
    assert.ok(plugin.execute);
    const result = await plugin.execute({}, { x: 1 });
    assert.deepEqual(result, { ok: true, args: { x: 1 } });
  });
});
