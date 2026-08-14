import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createBuiltinMcpToolWatcher, shouldWarnMcpUnavailable } from "../../server/agent/backend/claude-code.js";
import { EVENT_TYPES } from "../../src/types/events.js";
import type { AgentEvent } from "../../server/agent/stream.js";

const toolCall = (toolName: string): AgentEvent => ({ type: EVENT_TYPES.toolCall, toolUseId: "u1", toolName, args: {} });

// The warning this guards exists to say "your tools didn't load". Every case
// below is a way the old check got that answer wrong, or a way a naive fix
// would.
describe("shouldWarnMcpUnavailable", () => {
  it("warns when MCP was configured, the broker never reported ready, and nothing ran", () => {
    assert.equal(shouldWarnMcpUnavailable({ mcpConfigured: true, aborted: false, brokerEverReady: false, builtinMcpToolsCalled: 0 }), true);
  });

  it("stays silent on a turn that was never given MCP", () => {
    assert.equal(shouldWarnMcpUnavailable({ mcpConfigured: false, aborted: false, brokerEverReady: false, builtinMcpToolsCalled: 0 }), false);
  });

  // Hitting stop straight away produces "configured, no beacon, no calls" every
  // single time — the broker simply never got the chance. Diagnosing that as a
  // broker failure is a false positive on the most ordinary user action there
  // is (Codex iter-2 on #2906).
  it("stays silent when the user cancelled the turn", () => {
    assert.equal(shouldWarnMcpUnavailable({ mcpConfigured: true, aborted: true, brokerEverReady: false, builtinMcpToolsCalled: 0 }), false);
  });

  it("stays silent on a cancel even when everything else looks like a failure", () => {
    // Same inputs as the one case that DOES warn, flipping only `aborted`.
    const failing = { mcpConfigured: true, brokerEverReady: false, builtinMcpToolsCalled: 0 };
    assert.equal(shouldWarnMcpUnavailable({ ...failing, aborted: false }), true);
    assert.equal(shouldWarnMcpUnavailable({ ...failing, aborted: true }), false);
  });

  // The #2886 regression. The old check fired on exactly this shape: ToolSearch
  // ran (resolving the CLI built-ins `PushNotification` / `WebFetch`), no
  // `mcp__*` call followed, and the warning claimed a crash — while the broker
  // was healthy and had published its four tools.
  it("stays silent when the broker reported ready but the turn called no MCP tool", () => {
    assert.equal(shouldWarnMcpUnavailable({ mcpConfigured: true, aborted: false, brokerEverReady: true, builtinMcpToolsCalled: 0 }), false);
  });

  // The beacon is a POST from the broker back to the host, so a relay or
  // firewall can eat it — #2842's socat setup is precisely that. Built-in tools
  // that ran prove the broker delivered, beacon or not. Dropping this condition
  // would recreate the false positive in the environment that reported it.
  it("stays silent when the broker's own tools ran even though no beacon arrived", () => {
    assert.equal(shouldWarnMcpUnavailable({ mcpConfigured: true, aborted: false, brokerEverReady: false, builtinMcpToolsCalled: 3 }), false);
  });

  // The end-to-end shape of the Codex finding: a user-configured MCP server
  // answered all turn, our broker never did. The watcher does not count those
  // calls, so the count stays 0 and the warning still fires.
  it("still warns when only a non-built-in MCP server answered", () => {
    const watcher = createBuiltinMcpToolWatcher();
    watcher.track(toolCall("mcp__github__create_issue"));
    assert.equal(shouldWarnMcpUnavailable({ mcpConfigured: true, aborted: false, brokerEverReady: false, builtinMcpToolsCalled: watcher.count() }), true);
  });

  it("stays silent on a fully healthy turn", () => {
    assert.equal(shouldWarnMcpUnavailable({ mcpConfigured: true, aborted: false, brokerEverReady: true, builtinMcpToolsCalled: 5 }), false);
  });

  // One call is enough — the question is "did anything get through", not "how
  // much".
  it("treats a single MCP call as delivery", () => {
    assert.equal(shouldWarnMcpUnavailable({ mcpConfigured: true, aborted: false, brokerEverReady: false, builtinMcpToolsCalled: 1 }), false);
  });
});

describe("createBuiltinMcpToolWatcher", () => {
  it("counts the built-in broker's tools and nothing else", () => {
    const watcher = createBuiltinMcpToolWatcher();
    // The exact tool names from the #2886 turn: ToolSearch resolved two CLI
    // built-ins, and the old check read that as the MCP server having crashed.
    ["ToolSearch", "PushNotification", "WebFetch", "Bash", "Read"].forEach((name) => watcher.track(toolCall(name)));
    assert.equal(watcher.count(), 0);

    watcher.track(toolCall("mcp__mulmoclaude__notify"));
    assert.equal(watcher.count(), 1);
  });

  // `buildMcpConfig` registers user servers and claude.ai connectors alongside
  // the built-in broker, so `mcp__*` alone would count a working
  // `mcp__github__…` as proof OUR broker loaded — hiding the startup failure
  // the warning exists for (Codex review on #2906).
  it("does not count other MCP servers as the built-in broker answering", () => {
    const watcher = createBuiltinMcpToolWatcher();
    ["mcp__github__create_issue", "mcp__claude_ai_Gmail__search", "mcp__weather__fetchWeather"].forEach((name) => watcher.track(toolCall(name)));
    assert.equal(watcher.count(), 0);
  });

  it("counts distinct tools, not repeat calls", () => {
    const watcher = createBuiltinMcpToolWatcher();
    watcher.track(toolCall("mcp__mulmoclaude__notify"));
    watcher.track(toolCall("mcp__mulmoclaude__notify"));
    watcher.track(toolCall("mcp__mulmoclaude__manageCollection"));
    assert.equal(watcher.count(), 2);
  });

  it("ignores events that are not tool calls", () => {
    const watcher = createBuiltinMcpToolWatcher();
    watcher.track({ type: EVENT_TYPES.error, message: "mcp__mulmoclaude__notify failed" });
    assert.equal(watcher.count(), 0);
  });
});
