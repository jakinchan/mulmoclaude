// Tests for `server/plugins/runtime.ts` (#1110).
//
// Covers:
//   - `normalizePluginPath`: POSIX normalisation, Windows backslash
//     repair, traversal rejection, scope-root anchoring.
//   - `sanitisePackageNameForFs`: scoped names produce a single safe
//     directory segment.
//   - `pluginChannelName`: produces the contracted `plugin:<pkg>:<event>`
//     shape (must stay in lockstep with the browser-side helper).
//   - `makePluginRuntime`: scoped pubsub publishes prefixed channels;
//     two plugins on the same host can't see each other's events;
//     `files.data` and `files.config` write into separate roots and
//     reject traversal.
//   - `log.*`: a non-record payload (the protocol allows any `object`)
//     reaches the host logger wrapped, never dropped or reshaped.
//   - `fetch`: a `SharedArrayBuffer`-backed `Uint8Array` body arrives on
//     the wire as its raw bytes, not as its `toString()`.

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { Buffer } from "node:buffer";
import { tmpdir } from "node:os";
import path from "node:path";

import { makePluginRuntime, normalizePluginPath, pluginChannelName, pluginTaskId, sanitisePackageNameForFs } from "../../server/plugins/runtime.js";
import { WORKSPACE_PATHS } from "../../server/workspace/paths.js";
import { hasNumberProp, hasStringProp } from "../../server/utils/types.js";
import { log as hostLog, type LogLevel } from "../../server/system/logger/index.js";
import type { IPubSub } from "../../server/events/pub-sub/index.js";
import { createTaskManager, type ITaskManager } from "../../server/events/task-manager/index.js";

// In-memory pubsub double — captures every publish for inspection.
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

// Real task manager (pure, no timer started) — `tasks.register()`
// rounds-trip into `taskManager.listTasks()` so the test can assert
// the registration lands under the contracted id.
function makeStubTaskManager(): ITaskManager {
  return createTaskManager();
}

function makeTestRuntime(pkgName: string) {
  const { pubsub } = makeRecordingPubSub();
  return makePluginRuntime({ pkgName, pubsub, locale: "en", taskManager: makeStubTaskManager() });
}

describe("normalizePluginPath", () => {
  // `path.join` for the expected values so the tests pass on both POSIX
  // (forward slashes) and Windows (backslashes). `normalizePluginPath`
  // uses `path.join` internally for the same reason — `ensureInsideBase`
  // compares with `path.resolve` + `path.sep`, which is platform-aware.
  // Using a Windows-style root (`C:\\tmp\\scope-root`) on Windows
  // would also work; the test root just needs to be absolute on the
  // host OS — `path.resolve("/tmp/scope-root")` produces a usable
  // absolute on both platforms.
  const root = path.resolve("/tmp/scope-root");

  it("returns the absolute path for a simple relative file", () => {
    assert.equal(normalizePluginPath(root, "foo.json"), path.join(root, "foo.json"));
  });

  it("accepts nested POSIX paths", () => {
    assert.equal(normalizePluginPath(root, "books/2026/journal.jsonl"), path.join(root, "books", "2026", "journal.jsonl"));
  });

  it("repairs Windows backslash separators", () => {
    // Plugin authors who slip up and use `node:path.join` on Windows
    // get `"books\\2026\\journal.jsonl"`. The platform should still
    // resolve that to a sane absolute path under the scope root.
    assert.equal(normalizePluginPath(root, "books\\2026\\journal.jsonl"), path.join(root, "books", "2026", "journal.jsonl"));
  });

  it("folds redundant `.` and `//` segments", () => {
    assert.equal(normalizePluginPath(root, "./a//b/./c.json"), path.join(root, "a", "b", "c.json"));
  });

  it("rejects traversal that escapes the scope root", () => {
    assert.throws(() => normalizePluginPath(root, "../../etc/passwd"), /escapes plugin scope/);
    assert.throws(() => normalizePluginPath(root, "../sibling.json"), /escapes plugin scope/);
  });

  it("rejects encoded traversal mixed with legitimate segments", () => {
    assert.throws(() => normalizePluginPath(root, "books/../../etc/hosts"), /escapes plugin scope/);
  });

  it("treats absolute paths as anchored to scope root (lexical normalisation)", () => {
    // After `path.posix.normalize`, `/etc/passwd` keeps its leading
    // `/` — the lexical-reject branch catches it before it ever
    // reaches the filesystem.
    assert.throws(() => normalizePluginPath(root, "/etc/passwd"), /escapes plugin scope/);
  });
});

describe("sanitisePackageNameForFs", () => {
  it("encodes scoped package names so the path stays one level deep", () => {
    const seg = sanitisePackageNameForFs("@example/bookmarks-plugin");
    // The slash inside the scope must not survive — otherwise readdir
    // on the parent would list `@example/` and the plugin name would
    // span two directory levels.
    assert.ok(!seg.includes("/"), `expected single-segment, got "${seg}"`);
    // And the encoded form must be reversible (so debug output is useful).
    assert.equal(decodeURIComponent(seg), "@example/bookmarks-plugin");
  });

  it("leaves unscoped names untouched (URL-safe characters)", () => {
    assert.equal(sanitisePackageNameForFs("weather"), "weather");
  });
});

describe("pluginChannelName", () => {
  it("produces the contracted format", () => {
    assert.equal(pluginChannelName("@example/foo", "changed"), "plugin:@example/foo:changed");
  });

  it("does not collide between plugins with the same event name", () => {
    const alpha = pluginChannelName("@a/p", "event");
    const beta = pluginChannelName("@b/p", "event");
    assert.notEqual(alpha, beta);
  });
});

describe("makePluginRuntime — scoped pubsub", () => {
  it("prefixes the plugin name on every publish", () => {
    const { pubsub, published } = makeRecordingPubSub();
    const runtime = makePluginRuntime({ pkgName: "@example/foo", pubsub, locale: "en", taskManager: makeStubTaskManager() });
    runtime.pubsub.publish("changed", { id: 1 });
    assert.deepEqual(published, [{ channel: "plugin:@example/foo:changed", data: { id: 1 } }]);
  });

  it("isolates two plugins sharing the same host pubsub", () => {
    const { pubsub, published } = makeRecordingPubSub();
    const alpha = makePluginRuntime({ pkgName: "@a/p", pubsub, locale: "en", taskManager: makeStubTaskManager() });
    const beta = makePluginRuntime({ pkgName: "@b/p", pubsub, locale: "en", taskManager: makeStubTaskManager() });
    alpha.pubsub.publish("event", { from: "a" });
    beta.pubsub.publish("event", { from: "b" });
    assert.deepEqual(published, [
      { channel: "plugin:@a/p:event", data: { from: "a" } },
      { channel: "plugin:@b/p:event", data: { from: "b" } },
    ]);
  });
});

describe("makePluginRuntime — scoped tasks (Phase 1 of Encore plan)", () => {
  it("registers under the contracted plugin:<pkg> id", () => {
    const { pubsub } = makeRecordingPubSub();
    const taskManager = makeStubTaskManager();
    const runtime = makePluginRuntime({ pkgName: "@example/foo", pubsub, locale: "en", taskManager });
    runtime.tasks.register({
      schedule: { type: "interval", intervalMs: 60_000 },
      run: async () => undefined,
    });
    const tasks = taskManager.listTasks();
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, pluginTaskId("@example/foo"));
    assert.equal(tasks[0].id, "plugin:@example/foo");
  });

  it("forwards the schedule verbatim", () => {
    const { pubsub } = makeRecordingPubSub();
    const taskManager = makeStubTaskManager();
    const runtime = makePluginRuntime({ pkgName: "@example/foo", pubsub, locale: "en", taskManager });
    runtime.tasks.register({
      schedule: { type: "daily", time: "09:00" },
      run: async () => undefined,
    });
    const [task] = taskManager.listTasks();
    assert.deepEqual(task.schedule, { type: "daily", time: "09:00" });
  });

  it("throws on the second register from the same plugin (cap-at-1)", () => {
    const { pubsub } = makeRecordingPubSub();
    const taskManager = makeStubTaskManager();
    const runtime = makePluginRuntime({ pkgName: "@example/foo", pubsub, locale: "en", taskManager });
    runtime.tasks.register({
      schedule: { type: "interval", intervalMs: 60_000 },
      run: async () => undefined,
    });
    assert.throws(
      () =>
        runtime.tasks.register({
          schedule: { type: "interval", intervalMs: 60_000 },
          run: async () => undefined,
        }),
      /already registered a task — only one tick per plugin/,
    );
    // The second registration must not have leaked into the host registry.
    assert.equal(taskManager.listTasks().length, 1);
  });

  it("isolates two plugins — each can register independently", () => {
    const { pubsub } = makeRecordingPubSub();
    const taskManager = makeStubTaskManager();
    const alpha = makePluginRuntime({ pkgName: "@a/p", pubsub, locale: "en", taskManager });
    const beta = makePluginRuntime({ pkgName: "@b/p", pubsub, locale: "en", taskManager });
    alpha.tasks.register({ schedule: { type: "interval", intervalMs: 60_000 }, run: async () => undefined });
    beta.tasks.register({ schedule: { type: "interval", intervalMs: 60_000 }, run: async () => undefined });
    const ids = taskManager
      .listTasks()
      .map((task) => task.id)
      .sort();
    assert.deepEqual(ids, ["plugin:@a/p", "plugin:@b/p"]);
  });

  it("the registered run callback invokes the plugin's run", async () => {
    const { pubsub } = makeRecordingPubSub();
    const taskManager = makeStubTaskManager();
    const runtime = makePluginRuntime({ pkgName: "@example/foo", pubsub, locale: "en", taskManager });
    let calls = 0;
    runtime.tasks.register({
      schedule: { type: "interval", intervalMs: 60_000 },
      run: async () => {
        calls++;
      },
    });
    // Drive the host task manager directly — `tick()` runs every due
    // task once. Interval-aligned, but with intervalMs === ONE_MINUTE_MS
    // (the default tickMs), the very first tick at 00:00 UTC is due.
    await taskManager.tick();
    assert.equal(calls, 1);
  });
});

describe("makePluginRuntime — files.data and files.config", () => {
  // Each test creates a fresh fake workspace root so the writes
  // don't pile up.
  let savedDataDescriptor: PropertyDescriptor | undefined;
  let savedConfigDescriptor: PropertyDescriptor | undefined;
  let dataRoot: string;
  let configRoot: string;

  beforeEach(() => {
    // Capture the FULL descriptor so afterEach can restore the original
    // writability + enumerability flags. Storing only `value` and re-
    // applying via `Object.defineProperty(...{value, configurable})`
    // would silently flip the property to non-writable and non-
    // enumerable, leaking that mutation into later test cases that
    // iterate or re-patch WORKSPACE_PATHS (CodeRabbit review on PR
    // #1124).
    savedDataDescriptor = Object.getOwnPropertyDescriptor(WORKSPACE_PATHS, "pluginsData");
    savedConfigDescriptor = Object.getOwnPropertyDescriptor(WORKSPACE_PATHS, "pluginsConfig");
    dataRoot = mkdtempSync(path.join(tmpdir(), "plugin-runtime-data-"));
    configRoot = mkdtempSync(path.join(tmpdir(), "plugin-runtime-config-"));
    // WORKSPACE_PATHS is a frozen const at import time, so we patch it
    // via Object.defineProperty for the lifetime of the test. The
    // alternative — refactoring `makePluginRuntime` to take roots as
    // arguments — would expose internals plugin authors don't need.
    if (savedDataDescriptor) Object.defineProperty(WORKSPACE_PATHS, "pluginsData", { ...savedDataDescriptor, value: dataRoot });
    if (savedConfigDescriptor) Object.defineProperty(WORKSPACE_PATHS, "pluginsConfig", { ...savedConfigDescriptor, value: configRoot });
  });

  afterEach(() => {
    if (savedDataDescriptor) Object.defineProperty(WORKSPACE_PATHS, "pluginsData", savedDataDescriptor);
    if (savedConfigDescriptor) Object.defineProperty(WORKSPACE_PATHS, "pluginsConfig", savedConfigDescriptor);
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(configRoot, { recursive: true, force: true });
  });

  function runtimeFor(pkgName: string) {
    const { pubsub } = makeRecordingPubSub();
    return makePluginRuntime({ pkgName, pubsub, locale: "en", taskManager: makeStubTaskManager() });
  }

  it("write+read round-trip lands under files.data root", async () => {
    const runtime = runtimeFor("@example/foo");
    await runtime.files.data.write("state.json", "hello");
    assert.equal(await runtime.files.data.read("state.json"), "hello");
    assert.equal(await runtime.files.data.exists("state.json"), true);
  });

  it("data and config are physically separate roots", async () => {
    const runtime = runtimeFor("@example/foo");
    await runtime.files.data.write("same.json", "data-side");
    await runtime.files.config.write("same.json", "config-side");
    assert.equal(await runtime.files.data.read("same.json"), "data-side");
    assert.equal(await runtime.files.config.read("same.json"), "config-side");
  });

  it("two plugins do not share a directory", async () => {
    const alpha = runtimeFor("@a/p");
    const beta = runtimeFor("@b/p");
    await alpha.files.data.write("state.json", "a-state");
    await beta.files.data.write("state.json", "b-state");
    assert.equal(await alpha.files.data.read("state.json"), "a-state");
    assert.equal(await beta.files.data.read("state.json"), "b-state");
  });

  it("files.exists returns false for never-written paths (no throw)", async () => {
    const runtime = runtimeFor("@example/foo");
    assert.equal(await runtime.files.data.exists("missing.json"), false);
  });

  it("files.unlink is a no-op when the file does not exist", async () => {
    const runtime = runtimeFor("@example/foo");
    await assert.doesNotReject(runtime.files.data.unlink("missing.json"));
  });

  it("files.readDir returns [] for a plugin that never wrote", async () => {
    const runtime = runtimeFor("@example/foo");
    assert.deepEqual(await runtime.files.data.readDir("."), []);
  });

  it("rejects traversal via files.data.write", async () => {
    const runtime = runtimeFor("@example/foo");
    await assert.rejects(runtime.files.data.write("../../escape.json", "x"), /escapes plugin scope/);
  });

  it("rejects traversal via files.config.read", async () => {
    const runtime = runtimeFor("@example/foo");
    await assert.rejects(runtime.files.config.read("../../escape.json"), /escapes plugin scope/);
  });

  it("accepts Windows-style backslash paths from misuse of node:path", async () => {
    const runtime = runtimeFor("@example/foo");
    // Plugin author uses `path.join("books", "2026", "journal.jsonl")` on Windows.
    await runtime.files.data.write("books\\2026\\journal.jsonl", "winpath");
    // Reads with the POSIX form because that's the contract.
    assert.equal(await runtime.files.data.read("books/2026/journal.jsonl"), "winpath");
  });
});

describe("makePluginRuntime — scoped logger payload", () => {
  const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];
  const calls: { level: LogLevel; prefix: string; message: string; data: Record<string, unknown> | undefined }[] = [];
  const originals = { debug: hostLog.debug, info: hostLog.info, warn: hostLog.warn, error: hostLog.error };

  // Assert on what the scoped logger hands the HOST logger: that is the
  // contract boundary the plugin runtime owns, and `LogRecord.data` is
  // where a non-record payload used to break the declared shape.
  beforeEach(() => {
    calls.length = 0;
    LOG_LEVELS.forEach((level) => {
      hostLog[level] = (prefix, message, data) => {
        calls.push({ level, prefix, message, data });
      };
    });
  });

  afterEach(() => {
    LOG_LEVELS.forEach((level) => {
      hostLog[level] = originals[level];
    });
  });

  it("forwards a record payload by reference on every level", () => {
    const runtime = makeTestRuntime("@example/foo");
    const payload = { a: 1, b: "two" };
    LOG_LEVELS.forEach((level) => runtime.log[level](`msg-${level}`, payload));
    assert.equal(calls.length, LOG_LEVELS.length);
    calls.forEach((call, index) => {
      assert.equal(call.level, LOG_LEVELS[index]);
      assert.equal(call.prefix, "plugin/@example/foo");
      assert.equal(call.message, `msg-${LOG_LEVELS[index]}`);
      assert.equal(call.data, payload);
    });
  });

  it("wraps a non-record payload instead of dropping it", () => {
    const runtime = makeTestRuntime("@example/foo");
    const payload = ["x", "y"];
    LOG_LEVELS.forEach((level) => runtime.log[level]("msg-array", payload));
    assert.equal(calls.length, LOG_LEVELS.length);
    calls.forEach((call) => {
      // Dropping the payload would be the silent-data-loss regression.
      assert.notEqual(call.data, undefined);
      // The host contracts for a keyed record; the array survives under it.
      assert.deepEqual(call.data, { value: ["x", "y"] });
      assert.equal(call.data?.value, payload);
    });
  });

  it("leaves an absent payload absent (no empty wrapper)", () => {
    const runtime = makeTestRuntime("@example/foo");
    runtime.log.warn("msg-none");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].data, undefined);
  });

  it("does not wrap an Error payload — it is already a record", () => {
    const runtime = makeTestRuntime("@example/foo");
    const failure = Object.assign(new Error("boom"), { code: "ENOENT" });
    runtime.log.error("msg-error", failure);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].data, failure);
  });

  it("scopes the prefix per plugin", () => {
    makeTestRuntime("@a/p").log.info("from-a");
    makeTestRuntime("@b/p").log.info("from-b");
    assert.deepEqual(
      calls.map((call) => call.prefix),
      ["plugin/@a/p", "plugin/@b/p"],
    );
  });
});

describe("makePluginRuntime — scoped fetch body", () => {
  const BODY_TEXT = "hi!";
  const expectedHex = Buffer.from(BODY_TEXT, "utf-8").toString("hex");
  // Filled in by `before` once the OS has assigned a port.
  const echo = { url: "" };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ bodyHex: Buffer.concat(chunks).toString("hex") }));
    });
  });

  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!hasNumberProp(address, "port")) throw new Error("echo server did not report a TCP port");
    echo.url = `http://127.0.0.1:${address.port}/echo`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // The body assertion is against what actually arrived on the wire,
  // not against our own construction of it.
  async function postBodyHex(body?: string | Uint8Array): Promise<string> {
    const response = await makeTestRuntime("@example/foo").fetch(echo.url, { method: "POST", body });
    const parsed: unknown = await response.json();
    assert.ok(hasStringProp(parsed, "bodyHex"), "echo server must answer with bodyHex");
    return parsed.bodyHex;
  }

  it("sends a string body verbatim", async () => {
    assert.equal(await postBodyHex(BODY_TEXT), expectedHex);
  });

  it("sends an ArrayBuffer-backed Uint8Array as raw bytes", async () => {
    assert.equal(await postBodyHex(new TextEncoder().encode(BODY_TEXT)), expectedHex);
  });

  it("sends a SharedArrayBuffer-backed Uint8Array as raw bytes, not its toString()", async () => {
    const bytes = new TextEncoder().encode(BODY_TEXT);
    const shared = new Uint8Array(new SharedArrayBuffer(bytes.byteLength));
    shared.set(bytes);
    const received = await postBodyHex(shared);
    // A SharedArrayBuffer-backed view is not a `BodyInit`, so undici
    // stringifies it ("104,105,33") unless the runtime copies it into a
    // transferable buffer first.
    assert.notEqual(received, Buffer.from(shared.toString(), "utf-8").toString("hex"));
    assert.equal(received, expectedHex);
  });

  it("sends no body when none was supplied", async () => {
    assert.equal(await postBodyHex(), "");
  });

  it("sends an empty string body as an empty payload", async () => {
    assert.equal(await postBodyHex(""), "");
  });
});
