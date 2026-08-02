import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  configureNotifier,
  setNotifierFilePaths,
  resetNotifier,
  onEvent,
  publish,
  clear,
  cancel,
  updateForPlugin,
  clearForPlugin,
  getForPlugin,
  listAll,
  listFor,
  listHistory,
  validatePublishInput,
  type NotifierEvent,
} from "../../src/notifier/index.ts";

let events: NotifierEvent[] = [];

function setup(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "notifier-"));
  events = [];
  configureNotifier({
    // Minimal atomic-ish writer for the test: ensure dir, then write.
    writeJson: async (filePath, data) => {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, JSON.stringify(data, null, 2));
    },
    publishEvent: (event) => events.push(event),
  });
  setNotifierFilePaths({ active: path.join(dir, "active.json"), history: path.join(dir, "history.json") });
  return dir;
}

afterEach(() => resetNotifier());

test("publish persists, emits, and is readable", async () => {
  const dir = setup();
  try {
    const { id } = await publish({ pluginPkg: "todo", severity: "nudge", title: "Hi" });
    assert.ok(id);
    const all = await listAll();
    assert.equal(all.length, 1);
    const [bell] = all;
    assert.ok(bell);
    assert.equal(bell.title, "Hi");
    assert.deepEqual(
      events.map((event) => event.type),
      ["published"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clear moves to history and emits cleared", async () => {
  const dir = setup();
  try {
    const { id } = await publish({ pluginPkg: "todo", severity: "nudge", title: "Bye" });
    await clear(id);
    assert.equal((await listAll()).length, 0);
    const history = await listHistory();
    assert.equal(history.length, 1);
    const [cleared] = history;
    assert.ok(cleared);
    assert.equal(cleared.terminalType, "cleared");
    assert.deepEqual(
      events.map((event) => event.type),
      ["published", "cleared"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plugin isolation: clearForPlugin/getForPlugin no-op across plugins", async () => {
  const dir = setup();
  try {
    const { id } = await publish({ pluginPkg: "todo", severity: "nudge", title: "Mine" });
    assert.equal(await getForPlugin("other", id), undefined);
    await clearForPlugin("other", id); // no-op
    assert.equal((await listFor("todo")).length, 1);
    await clearForPlugin("todo", id); // real
    assert.equal((await listFor("todo")).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateForPlugin refreshes in place and rejects invalid merges silently", async () => {
  const dir = setup();
  try {
    const { id } = await publish({ pluginPkg: "todo", severity: "nudge", title: "v1" });
    await updateForPlugin("todo", id, { title: "v2" });
    const [updated] = await listAll();
    assert.ok(updated);
    assert.equal(updated.title, "v2");
    // Empty title would violate validation → silent no-op (title stays v2).
    await updateForPlugin("todo", id, { title: "" });
    const [unchanged] = await listAll();
    assert.ok(unchanged);
    assert.equal(unchanged.title, "v2");
    assert.deepEqual(
      events.map((event) => event.type),
      ["published", "updated"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("action lifecycle rules: publish throws on info severity / missing navigateTarget", async () => {
  const dir = setup();
  try {
    await assert.rejects(() => publish({ pluginPkg: "x", severity: "info", lifecycle: "action", title: "t", navigateTarget: "/x" }));
    await assert.rejects(() => publish({ pluginPkg: "x", severity: "urgent", lifecycle: "action", title: "t" }));
    const ok = await publish({ pluginPkg: "x", severity: "urgent", lifecycle: "action", title: "t", navigateTarget: "/ok" });
    assert.ok(ok.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("onEvent in-process listener fires before pubsub and can unsubscribe", async () => {
  const dir = setup();
  try {
    const seen: string[] = [];
    const off = onEvent((event) => seen.push(event.type));
    await publish({ pluginPkg: "todo", severity: "nudge", title: "a" });
    off();
    await publish({ pluginPkg: "todo", severity: "nudge", title: "b" });
    assert.deepEqual(seen, ["published"]); // only the first, after unsubscribe none
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cancel emits cancelled; concurrent publishes both persist", async () => {
  const dir = setup();
  try {
    const [first, second] = await Promise.all([
      publish({ pluginPkg: "todo", severity: "nudge", title: "a" }),
      publish({ pluginPkg: "todo", severity: "nudge", title: "b" }),
    ]);
    assert.notEqual(first.id, second.id);
    assert.equal((await listAll()).length, 2);
    await cancel(first.id);
    const [cancelled] = await listHistory();
    assert.ok(cancelled);
    assert.equal(cancelled.terminalType, "cancelled");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validatePublishInput is pure and matches the engine's wall", () => {
  assert.equal(validatePublishInput({ pluginPkg: "x", severity: "nudge", title: "ok" }), null);
  assert.match(validatePublishInput({ pluginPkg: "x", severity: "nudge", title: "" }) ?? "", /non-empty/);
  assert.match(validatePublishInput({ pluginPkg: "x", severity: "nudge", title: "t", navigateTarget: "//evil.com" }) ?? "", /single '\/'/);
});

test("malformed active.json surfaces as an error", async () => {
  const dir = setup();
  try {
    const active = path.join(dir, "active.json");
    await mkdir(path.dirname(active), { recursive: true });
    await writeFile(active, JSON.stringify({ entries: [] })); // array, not object → malformed
    await assert.rejects(() => listAll(), /malformed active\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function handWrittenEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "hand-1", pluginPkg: "todo", severity: "nudge", title: "hand-written", createdAt: "2026-01-01T00:00:00.000Z", ...overrides };
}

test("hand-written entries load with only the required fields, and unknown extras are tolerated", async () => {
  const dir = setup();
  try {
    const entries = { a: handWrittenEntry(), b: handWrittenEntry({ id: "hand-2", futureField: 42 }) };
    await writeFile(path.join(dir, "active.json"), JSON.stringify({ entries }));
    assert.deepEqual((await listAll()).map((entry) => entry.id).sort(), ["hand-1", "hand-2"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed entry rejects the whole active.json and leaves the file on disk untouched", async () => {
  const dir = setup();
  try {
    const active = path.join(dir, "active.json");
    const raw = JSON.stringify({ entries: { a: handWrittenEntry(), b: { junk: true } } });
    await writeFile(active, raw);
    await assert.rejects(() => listAll(), /malformed active\.json/);
    await assert.rejects(() => publish({ pluginPkg: "todo", severity: "nudge", title: "blocked" }), /malformed active\.json/);
    assert.equal(await readFile(active, "utf-8"), raw);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed history entry neither blocks notifications nor rewrites the history file", async () => {
  const dir = setup();
  try {
    const history = path.join(dir, "history.json");
    const raw = JSON.stringify({ entries: [{ junk: true }] });
    await writeFile(history, raw);
    const { id } = await publish({ pluginPkg: "todo", severity: "nudge", title: "still works" });
    await clear(id);
    assert.equal((await listAll()).length, 0);
    await assert.rejects(() => listHistory(), /malformed history\.json/);
    assert.equal(await readFile(history, "utf-8"), raw);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
