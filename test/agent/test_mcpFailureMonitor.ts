// Tests for the runtime MCP failure monitor (#1353).
//
// The monitor consumes `AgentEvent`s, tracks `is_error` ratio per
// MCP server (parsed from `mcp__<server>__<tool>` toolName), and
// fires one structured warn + one bell notification once a server
// crosses a consecutive-failure threshold.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMcpFailureMonitor, mcpServerFromToolName, MCP_FAILURE_THRESHOLD } from "../../server/agent/mcpFailureMonitor.js";
import { EVENT_TYPES } from "../../src/types/events.js";

interface CapturedPublish {
  id: string;
  body: string;
}
interface CapturedWarn {
  event: string;
  message: string;
  data?: Record<string, unknown>;
}

function makeSink() {
  const publishes: CapturedPublish[] = [];
  const warns: CapturedWarn[] = [];
  return {
    publishes,
    warns,
    sink: {
      // Loose `as never` casts because the real types pull a heavy
      // notification union that's irrelevant for these assertions —
      // we only need the `id` + `body` round-trip.
      publish: ((params: { id: string; body: string }) => {
        publishes.push({ id: params.id, body: params.body });
      }) as never,
      warn: (event: string, message: string, data?: Record<string, unknown>) => {
        warns.push({ event, message, data });
      },
    },
  };
}

function toolCall(toolUseId: string, toolName: string) {
  return { type: EVENT_TYPES.toolCall, toolUseId, toolName };
}

function toolCallResult(toolUseId: string, isError: boolean) {
  return { type: EVENT_TYPES.toolCallResult, toolUseId, content: "", isError };
}

describe("mcpServerFromToolName", () => {
  it("extracts the server segment from a well-formed MCP tool name", () => {
    assert.equal(mcpServerFromToolName("mcp__notion__page_create"), "notion");
    assert.equal(mcpServerFromToolName("mcp__github__create_issue"), "github");
  });

  it("returns null for non-MCP tools", () => {
    assert.equal(mcpServerFromToolName("Bash"), null);
    assert.equal(mcpServerFromToolName("Read"), null);
    assert.equal(mcpServerFromToolName("ToolSearch"), null);
  });

  it("returns null for malformed names", () => {
    assert.equal(mcpServerFromToolName("mcp__"), null);
    assert.equal(mcpServerFromToolName("mcp_notion"), null);
  });

  // Regression for the Codex review on #1356: the old regex
  // (`[A-Za-z0-9-]+`) excluded `_`, but `isMcpServerId` in
  // `server/system/config.ts` explicitly allows underscores. Servers
  // like `a1_b2` were silently un-attributed → their repeated
  // failures never triggered the alert path. Pin the new shape so a
  // future "let's tighten the regex" change can't silently regress.
  it("attributes server ids that contain underscores (isMcpServerId contract)", () => {
    assert.equal(mcpServerFromToolName("mcp__a1_b2__do_thing"), "a1_b2");
    assert.equal(mcpServerFromToolName("mcp__my_server__tool"), "my_server");
    assert.equal(mcpServerFromToolName("mcp__under_score_galore__x"), "under_score_galore");
  });

  it("uses the FIRST `__` after the `mcp__` prefix as the server↔tool delimiter", () => {
    // Some MCP authors put `__` inside tool names too. The server
    // half is always the first segment up to the first `__` after
    // the prefix; what comes after is opaque tool-part.
    assert.equal(mcpServerFromToolName("mcp__notion__page__create__subaction"), "notion");
  });

  it("rejects server ids that violate the isMcpServerId shape", () => {
    // Uppercase / starts-with-digit / too-long / forbidden chars.
    assert.equal(mcpServerFromToolName("mcp__Bad__tool"), null); // uppercase
    assert.equal(mcpServerFromToolName("mcp__1foo__tool"), null); // leading digit
    assert.equal(mcpServerFromToolName("mcp__foo!bar__tool"), null); // `!` forbidden
  });

  // Codex iter-2 on #1356: `isMcpServerId` was tightened to forbid
  // consecutive `__` because the `mcp__<server>__<tool>` encoding
  // would otherwise be ambiguous. For input `mcp__foo__bar__tool`:
  //   - First-`__` split → server `"foo"`, tool `"bar__tool"`  ✓ taken
  //   - Hypothetical alt   → server `"foo__bar"`, tool `"tool"` — but
  //     `foo__bar` is no longer a valid id, so the alt is dead.
  // Pin both: parser returns the unambiguous first-segment server,
  // AND the would-be-`__`-containing alt fails validation if anyone
  // tried to construct it directly.
  it("treats `__`-containing strings as the unambiguous first-segment server only", () => {
    assert.equal(mcpServerFromToolName("mcp__foo__bar__tool"), "foo");
    // A double-underscore name like `foo__bar` is not a legal server
    // id (config-time isMcpServerId rejects it), so even if a tool
    // name happens to be exactly `mcp__foo__bar` (server `foo`, tool
    // `bar`), the parser resolves it unambiguously.
    assert.equal(mcpServerFromToolName("mcp__foo__bar"), "foo");
  });
});

describe("createMcpFailureMonitor — threshold + notification", () => {
  it("does NOT notify before the threshold", () => {
    const { sink, publishes, warns } = makeSink();
    const monitor = createMcpFailureMonitor({ sink });
    for (let callIndex = 0; callIndex < MCP_FAILURE_THRESHOLD - 1; callIndex += 1) {
      monitor.track(toolCall(`id-${String(callIndex)}`, "mcp__notion__page_create"));
      monitor.track(toolCallResult(`id-${String(callIndex)}`, true));
    }
    assert.equal(publishes.length, 0);
    assert.equal(warns.length, 0);
  });

  it("notifies exactly once when the threshold is crossed", () => {
    const { sink, publishes, warns } = makeSink();
    const monitor = createMcpFailureMonitor({ sink });
    for (let callIndex = 0; callIndex < MCP_FAILURE_THRESHOLD + 2; callIndex += 1) {
      monitor.track(toolCall(`id-${String(callIndex)}`, "mcp__notion__page_create"));
      monitor.track(toolCallResult(`id-${String(callIndex)}`, true));
    }
    assert.equal(publishes.length, 1, "exactly one bell entry per server");
    assert.equal(publishes[0].id, "mcp-failure-notion");
    assert.match(publishes[0].body, /notion/);
    assert.equal(warns.length, 1);
  });

  // Sourcery review on #1356: `createMcpFailureMonitor` accepts a
  // `threshold` override option, but the default-only tests above
  // wouldn't catch a future refactor that ignores the override.
  // Pin the wiring with an explicit per-call assertion.
  it("honours the `threshold` override (single failure triggers when threshold=1)", () => {
    const { sink, publishes, warns } = makeSink();
    const monitor = createMcpFailureMonitor({ sink, threshold: 1 });
    monitor.track(toolCall("id-0", "mcp__notion__page_create"));
    monitor.track(toolCallResult("id-0", true));
    assert.equal(publishes.length, 1, "threshold=1 → one failure is enough");
    assert.equal(warns.length, 1);
  });

  it("honours a high `threshold` override (5 failures don't trigger when threshold=10)", () => {
    const { sink, publishes, warns } = makeSink();
    const monitor = createMcpFailureMonitor({ sink, threshold: 10 });
    for (let callIndex = 0; callIndex < 5; callIndex += 1) {
      monitor.track(toolCall(`id-${String(callIndex)}`, "mcp__notion__page_create"));
      monitor.track(toolCallResult(`id-${String(callIndex)}`, true));
    }
    assert.equal(publishes.length, 0, "threshold=10 stays silent below 10 failures");
    assert.equal(warns.length, 0);
  });

  it("resets the consecutive counter on a success", () => {
    const { sink, publishes } = makeSink();
    const monitor = createMcpFailureMonitor({ sink });
    // 2 fails — below threshold.
    monitor.track(toolCall("c1", "mcp__notion__page_create"));
    monitor.track(toolCallResult("c1", true));
    monitor.track(toolCall("c2", "mcp__notion__page_create"));
    monitor.track(toolCallResult("c2", true));
    // 1 success — resets streak.
    monitor.track(toolCall("c3", "mcp__notion__page_create"));
    monitor.track(toolCallResult("c3", false));
    // 2 more fails — total 4 but only 2 consecutive, still below 3.
    monitor.track(toolCall("c4", "mcp__notion__page_create"));
    monitor.track(toolCallResult("c4", true));
    monitor.track(toolCall("c5", "mcp__notion__page_create"));
    monitor.track(toolCallResult("c5", true));
    assert.equal(publishes.length, 0);
  });
});

describe("createMcpFailureMonitor — per-server isolation", () => {
  it("tracks each server independently", () => {
    const { sink, publishes } = makeSink();
    const monitor = createMcpFailureMonitor({ sink });
    // notion: 3 fails → notify
    for (let i = 0; i < 3; i += 1) {
      monitor.track(toolCall(`n-${String(i)}`, "mcp__notion__page_create"));
      monitor.track(toolCallResult(`n-${String(i)}`, true));
    }
    // github: 3 successes → no notify
    for (let i = 0; i < 3; i += 1) {
      monitor.track(toolCall(`g-${String(i)}`, "mcp__github__create_issue"));
      monitor.track(toolCallResult(`g-${String(i)}`, false));
    }
    assert.equal(publishes.length, 1);
    assert.equal(publishes[0].id, "mcp-failure-notion");
  });

  it("interleaved failures across servers don't interfere", () => {
    const { sink, publishes } = makeSink();
    const monitor = createMcpFailureMonitor({ sink });
    // notion / github / notion / github / notion — 3 notion fails total, 2 github fails total
    monitor.track(toolCall("n1", "mcp__notion__x"));
    monitor.track(toolCall("g1", "mcp__github__y"));
    monitor.track(toolCallResult("n1", true));
    monitor.track(toolCallResult("g1", true));
    monitor.track(toolCall("n2", "mcp__notion__x"));
    monitor.track(toolCall("g2", "mcp__github__y"));
    monitor.track(toolCallResult("n2", true));
    monitor.track(toolCallResult("g2", true));
    monitor.track(toolCall("n3", "mcp__notion__x"));
    monitor.track(toolCallResult("n3", true));
    // notion crossed threshold (3), github only at 2
    assert.equal(publishes.length, 1);
    assert.equal(publishes[0].id, "mcp-failure-notion");
  });
});

describe("createMcpFailureMonitor — ignored / orphan events", () => {
  it("ignores non-MCP tool errors", () => {
    const { sink, publishes } = makeSink();
    const monitor = createMcpFailureMonitor({ sink });
    for (let i = 0; i < 5; i += 1) {
      monitor.track(toolCall(`id-${String(i)}`, "Bash"));
      monitor.track(toolCallResult(`id-${String(i)}`, true));
    }
    assert.equal(publishes.length, 0);
  });

  it("ignores an orphan toolCallResult without a prior toolCall", () => {
    const { sink, publishes } = makeSink();
    const monitor = createMcpFailureMonitor({ sink });
    monitor.track(toolCallResult("orphan-1", true));
    monitor.track(toolCallResult("orphan-2", true));
    assert.equal(publishes.length, 0);
  });
});

describe("createMcpFailureMonitor — does not double-notify", () => {
  it("crossing threshold a second time after a success+failures bursts does NOT publish again", () => {
    const { sink, publishes } = makeSink();
    const monitor = createMcpFailureMonitor({ sink });
    // First burst → notify
    for (let i = 0; i < 3; i += 1) {
      monitor.track(toolCall(`a-${String(i)}`, "mcp__notion__x"));
      monitor.track(toolCallResult(`a-${String(i)}`, true));
    }
    assert.equal(publishes.length, 1);
    // Success resets counter
    monitor.track(toolCall("ok", "mcp__notion__x"));
    monitor.track(toolCallResult("ok", false));
    // Second burst → no duplicate notification (bell entry persists
    // until user dismisses; the engine's id-dedup matches our
    // `notified` guard).
    for (let i = 0; i < 3; i += 1) {
      monitor.track(toolCall(`b-${String(i)}`, "mcp__notion__x"));
      monitor.track(toolCallResult(`b-${String(i)}`, true));
    }
    assert.equal(publishes.length, 1);
  });
});
