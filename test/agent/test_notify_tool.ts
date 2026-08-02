import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { notify, makeNotifyTool, type NotifyPublishFn } from "../../server/agent/mcp-tools/notify.js";
import { mcpTools } from "../../server/agent/mcp-tools/index.js";
import { NOTIFICATION_ACTION_TYPES, NOTIFICATION_KINDS, NOTIFICATION_VIEWS } from "../../src/types/notification.js";

// Capture each `publish` call so tests can assert on the args
// without firing the real publishNotification (which on darwin
// spawns osascript and adds a real entry to Reminders.app, #803).
function makeMockPublish(): { publish: NotifyPublishFn; calls: Parameters<NotifyPublishFn>[0][] } {
  const calls: Parameters<NotifyPublishFn>[0][] = [];
  const publish: NotifyPublishFn = (opts) => {
    calls.push(opts);
  };
  return { publish, calls };
}

describe("notify MCP tool — input validation", () => {
  it("rejects an empty title", async () => {
    const result = await notify.handler({ title: "" });
    assert.match(result, /title.*required/i);
  });

  it("rejects a non-string title", async () => {
    const result = await notify.handler({ title: 123 });
    assert.match(result, /title.*required/i);
  });

  it("rejects a whitespace-only title", async () => {
    const result = await notify.handler({ title: "   " });
    assert.match(result, /title.*required/i);
  });

  it("does NOT call publish when validation fails", async () => {
    const { publish, calls } = makeMockPublish();
    const tool = makeNotifyTool({ publish });
    await tool.handler({ title: "" });
    await tool.handler({ title: "   " });
    await tool.handler({ title: 42 });
    assert.equal(calls.length, 0);
  });
});

describe("notify MCP tool — happy path", () => {
  it("returns a confirmation including the title", async () => {
    const { publish, calls } = makeMockPublish();
    const tool = makeNotifyTool({ publish });
    const result = await tool.handler({ title: "Build done" });
    assert.match(result, /Notification sent: Build done/);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.ok(call);
    assert.equal(call.title, "Build done");
    assert.equal(call.body, undefined);
    assert.equal(call.kind, NOTIFICATION_KINDS.push);
  });

  it("appends the body line when supplied", async () => {
    const { publish, calls } = makeMockPublish();
    const tool = makeNotifyTool({ publish });
    const result = await tool.handler({ title: "Build done", body: "All 12 steps green" });
    assert.equal(result, "Notification sent: Build done\nAll 12 steps green");
    const [call] = calls;
    assert.ok(call);
    assert.equal(call.body, "All 12 steps green");
  });

  it("trims surrounding whitespace from title and body", async () => {
    const { publish, calls } = makeMockPublish();
    const tool = makeNotifyTool({ publish });
    const result = await tool.handler({ title: "  hi  ", body: "  there  " });
    assert.equal(result, "Notification sent: hi\nthere");
    const [call] = calls;
    assert.ok(call);
    assert.equal(call.title, "hi");
    assert.equal(call.body, "there");
  });

  it("treats a whitespace-only body as missing", async () => {
    const { publish, calls } = makeMockPublish();
    const tool = makeNotifyTool({ publish });
    const result = await tool.handler({ title: "hi", body: "   " });
    assert.equal(result, "Notification sent: hi");
    const [call] = calls;
    assert.ok(call);
    assert.equal(call.body, undefined);
  });
});

describe("notify MCP tool — chat session linkback", () => {
  it("publishes a navigate action targeting the chat session when ctx carries sessionId", async () => {
    const { publish, calls } = makeMockPublish();
    const tool = makeNotifyTool({ publish });
    await tool.handler({ title: "Build done" }, { sessionId: "sess-abc-123" });
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.ok(call);
    assert.deepEqual(call.action, {
      type: NOTIFICATION_ACTION_TYPES.navigate,
      target: { view: NOTIFICATION_VIEWS.chat, sessionId: "sess-abc-123" },
    });
  });

  it("omits the action when ctx is undefined (e.g. test / ad-hoc HTTP caller)", async () => {
    const { publish, calls } = makeMockPublish();
    const tool = makeNotifyTool({ publish });
    await tool.handler({ title: "Build done" });
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.ok(call);
    assert.equal(call.action, undefined);
  });

  it("omits the action when sessionId is empty string", async () => {
    const { publish, calls } = makeMockPublish();
    const tool = makeNotifyTool({ publish });
    await tool.handler({ title: "Build done" }, { sessionId: "" });
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.ok(call);
    assert.equal(call.action, undefined);
  });
});

describe("notify MCP tool — definition shape", () => {
  it("declares title as required and body as optional", () => {
    const schema = notify.definition.inputSchema as {
      properties: Record<string, unknown>;
      required: readonly string[];
    };
    assert.deepEqual(schema.required, ["title"]);
    assert.ok(schema.properties.title);
    assert.ok(schema.properties.body);
  });

  it("makeNotifyTool produces a definition matching the production singleton", () => {
    const { publish } = makeMockPublish();
    const tool = makeNotifyTool({ publish });
    assert.equal(tool.definition.name, notify.definition.name);
    assert.deepEqual(tool.definition.inputSchema, notify.definition.inputSchema);
  });
});

// Codex review on #808 surfaced a gap: the unit tests above exercise
// the factory in isolation, but never assert that the production
// singleton is actually wired into the agent's MCP tool registry.
// Without this, a refactor could quietly drop `notify` from the
// registry and the agent would lose access — but every existing
// test would still pass.
describe("notify MCP tool — registry integration", () => {
  it("is registered in the production mcpTools array", () => {
    assert.ok(mcpTools.includes(notify), "notify must be in the mcpTools registry exported from server/agent/mcp-tools/index.ts");
  });

  it("appears in mcpTools by its canonical name", () => {
    const byName = mcpTools.find((tool) => tool.definition.name === "notify");
    assert.equal(byName, notify, "the tool registered under the name 'notify' must be the same object as the exported singleton");
  });
});
