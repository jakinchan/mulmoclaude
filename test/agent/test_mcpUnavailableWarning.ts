import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMcpToolWatcher, shouldWarnMcpUnavailable } from "../../server/agent/backend/claude-code.js";
import { EVENT_TYPES } from "../../src/types/events.js";
import type { AgentEvent } from "../../server/agent/stream.js";

const toolCall = (toolName: string): AgentEvent => ({ type: EVENT_TYPES.toolCall, toolUseId: "u1", toolName, args: {} });

// The warning this guards exists to say "your tools didn't load". Every case
// below is a way the old check got that answer wrong, or a way a naive fix
// would.
describe("shouldWarnMcpUnavailable", () => {
  it("warns when MCP was configured, the broker never reported ready, and nothing ran", () => {
    assert.equal(shouldWarnMcpUnavailable({ mcpConfigured: true, brokerEverReady: false, mcpToolsCalled: 0 }), true);
  });

  it("stays silent on a turn that was never given MCP", () => {
    assert.equal(shouldWarnMcpUnavailable({ mcpConfigured: false, brokerEverReady: false, mcpToolsCalled: 0 }), false);
  });

  // The #2886 regression. The old check fired on exactly this shape: ToolSearch
  // ran (resolving the CLI built-ins `PushNotification` / `WebFetch`), no
  // `mcp__*` call followed, and the warning claimed a crash — while the broker
  // was healthy and had published its four tools.
  it("stays silent when the broker reported ready but the turn called no MCP tool", () => {
    assert.equal(shouldWarnMcpUnavailable({ mcpConfigured: true, brokerEverReady: true, mcpToolsCalled: 0 }), false);
  });

  // The beacon is a POST from the broker back to the host, so a relay or
  // firewall can eat it — #2842's socat setup is precisely that. Tools that ran
  // prove the broker delivered, beacon or not. Dropping this condition would
  // recreate the false positive in the environment that reported it.
  it("stays silent when tools ran even though no beacon arrived", () => {
    assert.equal(shouldWarnMcpUnavailable({ mcpConfigured: true, brokerEverReady: false, mcpToolsCalled: 3 }), false);
  });

  it("stays silent on a fully healthy turn", () => {
    assert.equal(shouldWarnMcpUnavailable({ mcpConfigured: true, brokerEverReady: true, mcpToolsCalled: 5 }), false);
  });

  // One call is enough — the question is "did anything get through", not "how
  // much".
  it("treats a single MCP call as delivery", () => {
    assert.equal(shouldWarnMcpUnavailable({ mcpConfigured: true, brokerEverReady: false, mcpToolsCalled: 1 }), false);
  });
});

describe("createMcpToolWatcher", () => {
  it("counts mcp__* calls and nothing else", () => {
    const watcher = createMcpToolWatcher();
    // The exact tool names from the #2886 turn: ToolSearch resolved two CLI
    // built-ins, and the old check read that as the MCP server having crashed.
    ["ToolSearch", "PushNotification", "WebFetch", "Bash", "Read"].forEach((name) => watcher.track(toolCall(name)));
    assert.equal(watcher.count(), 0);

    watcher.track(toolCall("mcp__mulmoclaude__notify"));
    assert.equal(watcher.count(), 1);
  });

  it("counts distinct tools, not repeat calls", () => {
    const watcher = createMcpToolWatcher();
    watcher.track(toolCall("mcp__mulmoclaude__notify"));
    watcher.track(toolCall("mcp__mulmoclaude__notify"));
    watcher.track(toolCall("mcp__mulmoclaude__manageCollection"));
    assert.equal(watcher.count(), 2);
  });

  it("ignores events that are not tool calls", () => {
    const watcher = createMcpToolWatcher();
    watcher.track({ type: EVENT_TYPES.error, message: "mcp__mulmoclaude__notify failed" });
    assert.equal(watcher.count(), 0);
  });
});
