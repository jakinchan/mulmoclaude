// Tests for `server/plugins/dev-watcher.ts` — the debounce + classify
// pass that turns vite's burst of file writes into one reload event.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { watchDevPlugins, summarizeChangedFiles } from "../../server/plugins/dev-watcher.js";
import type { RuntimePlugin } from "../../server/plugins/runtime-loader.js";

// Make a fake `FSWatcher`. `node:fs.watch` returns an EventEmitter +
// `.close()`; tests push synthetic file changes through `onChange`
// captured at registration time.
type FakeWatcher = ReturnType<typeof makeFakeWatcher>;
function makeFakeWatcher() {
  const emitter = new EventEmitter() as EventEmitter & { close: () => void; closed: boolean };
  emitter.closed = false;
  emitter.close = () => {
    emitter.closed = true;
    emitter.removeAllListeners();
  };
  return emitter;
}

function fakePlugin(name: string, cachePath = `/cache/${name}`): RuntimePlugin {
  return {
    name,
    version: "dev",
    cachePath,
    definition: { type: "function", name: `tool_${name}`, description: "", parameters: { type: "object", properties: {}, required: [] } },
    execute: async () => ({}),
    oauthCallbackAlias: null,
  };
}

interface PublishCall {
  name: string;
  changedFiles: string[];
  serverSideChange: boolean;
}

function recorder() {
  const calls: PublishCall[] = [];
  const warns: string[] = [];
  return {
    publish: (name: string, payload: { changedFiles: string[]; serverSideChange: boolean }) => {
      calls.push({ name, ...payload });
    },
    warnServerSideChange: (name: string) => {
      warns.push(name);
    },
    calls,
    warns,
  };
}

function onlyCall(calls: PublishCall[]): PublishCall {
  const [call] = calls;
  assert.ok(call, "expected at least one publish call");
  return call;
}

interface TestRig {
  fire: (relativePath: string) => void;
  watcher: FakeWatcher;
  rec: ReturnType<typeof recorder>;
  close: () => void;
}

function makeRig(plugin: RuntimePlugin, debounceMs: number): TestRig {
  const watcher = makeFakeWatcher();
  let onChange: ((relativePath: string) => void) | null = null;
  const rec = recorder();
  const handle = watchDevPlugins([plugin], {
    publish: rec.publish,
    warnServerSideChange: rec.warnServerSideChange,
    debounceMs,
    watcherFactory: (_absDistPath, callback) => {
      onChange = callback;
      return watcher as unknown as ReturnType<typeof watchDevPlugins>["close"] extends never ? never : import("node:fs").FSWatcher;
    },
  });
  return {
    fire: (relativePath) => onChange?.(relativePath),
    watcher,
    rec,
    close: handle.close,
  };
}

const sleep = (delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs));

describe("watchDevPlugins — debounce", () => {
  it("collapses a burst of file events into a single publish", async () => {
    const plugin = fakePlugin("@test/burst");
    const rig = makeRig(plugin, 50);
    rig.fire("vue.js");
    rig.fire("style.css");
    rig.fire("definition-Dvdjo6Xe.js");
    rig.fire("vue.js"); // duplicate file in burst — still 1 publish
    await sleep(150);
    assert.equal(rig.rec.calls.length, 1, `expected 1 publish; got ${rig.rec.calls.length}`);
    const burst = onlyCall(rig.rec.calls);
    assert.equal(burst.name, "@test/burst");
    assert.deepEqual(burst.changedFiles.sort(), ["definition-Dvdjo6Xe.js", "style.css", "vue.js"], "publish should include every distinct file in the burst");
    rig.close();
  });

  it("emits twice when bursts are separated by more than the debounce window", async () => {
    const plugin = fakePlugin("@test/two-bursts");
    const rig = makeRig(plugin, 30);
    rig.fire("vue.js");
    await sleep(80); // beyond debounce → flush
    rig.fire("vue.js");
    await sleep(80);
    assert.equal(rig.rec.calls.length, 2);
    rig.close();
  });

  it("does not publish when nothing changed (close before window elapses)", async () => {
    const plugin = fakePlugin("@test/no-events");
    const rig = makeRig(plugin, 30);
    // Close immediately — watcher fires nothing.
    rig.close();
    await sleep(60);
    assert.equal(rig.rec.calls.length, 0);
  });
});

describe("watchDevPlugins — server-side classification", () => {
  it("flags serverSideChange + warns when dist/index.js is in the burst", async () => {
    const plugin = fakePlugin("@test/server-side");
    const rig = makeRig(plugin, 30);
    rig.fire("index.js");
    rig.fire("vue.js");
    await sleep(80);
    assert.equal(rig.rec.calls.length, 1);
    assert.equal(onlyCall(rig.rec.calls).serverSideChange, true);
    assert.deepEqual(rig.rec.warns, ["@test/server-side"]);
    rig.close();
  });

  it("does NOT flag serverSideChange for browser-only changes", async () => {
    const plugin = fakePlugin("@test/browser-only");
    const rig = makeRig(plugin, 30);
    rig.fire("vue.js");
    rig.fire("style.css");
    await sleep(80);
    assert.equal(rig.rec.calls.length, 1);
    assert.equal(onlyCall(rig.rec.calls).serverSideChange, false);
    assert.deepEqual(rig.rec.warns, []);
    rig.close();
  });

  it("warns at most once per burst even if index.js fires multiple times", async () => {
    const plugin = fakePlugin("@test/multi-index");
    const rig = makeRig(plugin, 30);
    rig.fire("index.js");
    rig.fire("index.js");
    rig.fire("index.js");
    await sleep(80);
    assert.equal(rig.rec.warns.length, 1);
    rig.close();
  });

  it("does NOT match nested `assets/index.js` chunks (vite code-split output)", async () => {
    // Real-world false-positive: vite splits Vue components into
    // separate chunks like `dist/assets/index.js`. Treating those as
    // a server-side change would log a misleading "restart
    // mulmoclaude" hint on every component edit.
    const plugin = fakePlugin("@test/nested-index");
    const rig = makeRig(plugin, 30);
    rig.fire("assets/index.js");
    rig.fire("vue.js");
    await sleep(80);
    assert.equal(rig.rec.calls.length, 1);
    assert.equal(onlyCall(rig.rec.calls).serverSideChange, false);
    assert.deepEqual(rig.rec.warns, []);
    rig.close();
  });

  it("normalizes Windows-style backslash paths the same way", async () => {
    // `fs.watch` reports filenames with the platform separator. On
    // Windows that's `\`. The check must handle both so we don't
    // false-positive `assets\index.js` either.
    const plugin = fakePlugin("@test/windows-nested");
    const rig = makeRig(plugin, 30);
    rig.fire("assets\\index.js");
    await sleep(80);
    assert.equal(rig.rec.calls.length, 1);
    assert.equal(onlyCall(rig.rec.calls).serverSideChange, false);
    rig.close();
  });
});

describe("watchDevPlugins — multiple plugins", () => {
  it("debounces independently per plugin", async () => {
    const pluginA = fakePlugin("@test/multi-a");
    const pluginB = fakePlugin("@test/multi-b");
    const rec = recorder();
    const callbacks = new Map<string, (relativePath: string) => void>();
    const handle = watchDevPlugins([pluginA, pluginB], {
      publish: rec.publish,
      warnServerSideChange: rec.warnServerSideChange,
      debounceMs: 30,
      watcherFactory: (absDistPath, callback) => {
        callbacks.set(absDistPath, callback);
        return makeFakeWatcher() as unknown as import("node:fs").FSWatcher;
      },
    });
    for (const [absDistPath, callback] of callbacks) {
      // Each plugin fires its own change — debounce is per-plugin.
      callback("vue.js");
      assert.ok(absDistPath.includes("multi-"), `unexpected watcher path: ${absDistPath}`);
    }
    await sleep(80);
    assert.equal(rec.calls.length, 2);
    const names = rec.calls.map((entry) => entry.name).sort();
    assert.deepEqual(names, ["@test/multi-a", "@test/multi-b"]);
    handle.close();
  });
});

describe("watchDevPlugins — error isolation", () => {
  it("calls onWatcherError + closes the watcher when fs.watch emits `error`", async () => {
    const plugin = fakePlugin("@test/error");
    const watcher = makeFakeWatcher();
    const rec = recorder();
    const errorEvents: { name: string; error: Error }[] = [];
    watchDevPlugins([plugin], {
      publish: rec.publish,
      warnServerSideChange: rec.warnServerSideChange,
      onWatcherError: (name, error) => errorEvents.push({ name, error }),
      debounceMs: 30,
      watcherFactory: () => watcher as unknown as import("node:fs").FSWatcher,
    });
    const boom = new Error("ENOENT: dist disappeared");
    watcher.emit("error", boom);
    assert.equal(errorEvents.length, 1);
    const [errorEvent] = errorEvents;
    assert.ok(errorEvent);
    assert.equal(errorEvent.name, "@test/error");
    assert.equal(errorEvent.error.message, "ENOENT: dist disappeared");
    assert.equal(watcher.closed, true, "watcher should self-close on error");
  });

  it("subsequent file events from a closed-on-error watcher do not publish", async () => {
    // Even if the fake watcher kept emitting after error (a real
    // EventEmitter wouldn't, but we want defence in depth), the
    // debounce timer was cleared and the buffer wiped.
    const plugin = fakePlugin("@test/error-then-event");
    const watcher = makeFakeWatcher();
    const rec = recorder();
    const captured: ((relativePath: string) => void)[] = [];
    watchDevPlugins([plugin], {
      publish: rec.publish,
      warnServerSideChange: rec.warnServerSideChange,
      onWatcherError: () => {},
      debounceMs: 20,
      watcherFactory: (_absDistPath, callback) => {
        captured.push(callback);
        return watcher as unknown as import("node:fs").FSWatcher;
      },
    });
    const [fireChange] = captured;
    assert.ok(fireChange, "watcherFactory must have been called");
    fireChange("vue.js"); // queues a debounced publish
    watcher.emit("error", new Error("simulated"));
    await sleep(60);
    assert.equal(rec.calls.length, 0, "no publish after error wiped the buffer");
  });

  it("does not throw when onWatcherError is omitted (production-safe default)", () => {
    // Production wires onWatcherError through the structured logger;
    // tests / single-shot scripts may omit it. The watcher must
    // still self-close cleanly without an unhandled-error crash.
    const plugin = fakePlugin("@test/no-handler");
    const watcher = makeFakeWatcher();
    const rec = recorder();
    watchDevPlugins([plugin], {
      publish: rec.publish,
      watcherFactory: () => watcher as unknown as import("node:fs").FSWatcher,
    });
    assert.doesNotThrow(() => watcher.emit("error", new Error("silent")));
    assert.equal(watcher.closed, true);
  });
});

describe("watchDevPlugins — close()", () => {
  it("close() cancels pending timers and shuts watchers down", async () => {
    const plugin = fakePlugin("@test/close");
    const rig = makeRig(plugin, 30);
    rig.fire("vue.js");
    rig.close();
    await sleep(80);
    // No publish fires after close, even though the burst was queued.
    assert.equal(rig.rec.calls.length, 0);
    assert.equal(rig.watcher.closed, true);
  });

  it("close() is idempotent", () => {
    const plugin = fakePlugin("@test/close-twice");
    const rig = makeRig(plugin, 30);
    rig.close();
    assert.doesNotThrow(() => rig.close());
  });
});

describe("summarizeChangedFiles", () => {
  it("returns empty + no server-side change for an empty set", () => {
    assert.deepEqual(summarizeChangedFiles(new Set()), { changedFiles: [], serverSideChange: false });
  });

  it("sorts the changed files alphabetically", () => {
    const summary = summarizeChangedFiles(new Set(["vue.js", "definition-Dvdjo6Xe.js", "style.css"]));
    assert.deepEqual(summary.changedFiles, ["definition-Dvdjo6Xe.js", "style.css", "vue.js"]);
  });

  it("flags serverSideChange when the server entry `index.js` is present", () => {
    const summary = summarizeChangedFiles(new Set(["index.js", "vue.js"]));
    assert.equal(summary.serverSideChange, true);
    assert.deepEqual(summary.changedFiles, ["index.js", "vue.js"]);
  });

  it("does NOT flag serverSideChange for browser-only files", () => {
    assert.equal(summarizeChangedFiles(new Set(["vue.js", "style.css"])).serverSideChange, false);
  });

  it("does NOT flag nested `assets/index.js` chunks (vite code-split output)", () => {
    assert.equal(summarizeChangedFiles(new Set(["assets/index.js"])).serverSideChange, false);
  });

  it("normalizes Windows-style backslash paths for the server entry check", () => {
    assert.equal(summarizeChangedFiles(new Set(["assets\\index.js"])).serverSideChange, false);
  });

  it("returns a single entry for a one-file set", () => {
    assert.deepEqual(summarizeChangedFiles(new Set(["index.js"])), { changedFiles: ["index.js"], serverSideChange: true });
  });
});
