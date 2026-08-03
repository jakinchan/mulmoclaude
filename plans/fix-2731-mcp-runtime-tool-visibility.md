# fix #2731 — runtime-plugin tools advertised to the session but not callable

## Report

`mcp__mulmoclaude__google` is described in the system prompt (`buildPluginPromptSections`)
but a direct call returns `No such tool available`, and `ToolSearch select:…` finds nothing.
The server side is healthy: `/api/plugins/runtime/list` carries `@mulmoclaude/google-plugin`
and a `dispatch` of `{"kind":"status"}` answers 200.

The issue's hypothesis was that the MCP child fails to load runtime plugins.

## What the evidence actually shows

Driving the child the way the CLI does (`initialize` → `notifications/initialized` →
`tools/list`), on both broker paths:

```text
[stdout] [plugins/preset]  loaded requested=5 succeeded=5
[stdout] [plugins/runtime] loaded requested=3 succeeded=3
tools/list → google, presentDocument, handlePermission
```

and a headless `claude` CLI 2.1.220 run against the same broker resolves
`mcp__mulmoclaude__google` (the call reaches `handleToolCall`, failing only at the
dispatch fetch because no parent server was listening).

So the child DOES publish the tool, and the hypothesis is wrong. Two real defects turned
up while establishing that, either of which produces the reported symptom on a host we
have not reproduced yet.

### Defect 1 — the child logs onto the JSON-RPC channel

`server/system/logger/sinks.ts` routes `info` / `debug` records to **stdout**. In the MCP
child stdout IS the protocol stream, so every boot injects non-JSON lines between
JSON-RPC messages (the two `loaded` lines above). `mcp-server.ts` is careful to use
`process.stderr.write` for its own diagnostics; everything reaching the shared `log`
helper bypasses that care.

A client's line reader skips a garbage line, so this is survivable — until a response
large enough to be split across writes (a full role's `tools/list` is tens of KB) has a
log line land inside it, at which point a real message is corrupted.

### Defect 2 — `tools/list` answers before runtime plugins exist

`handleToolsList` deliberately does not await `runtimeReady` (#1698: keep
`handlePermission` responsive at session start). Runtime plugins that finish loading
later are announced with `notifications/tools/list_changed`.

Any client that snapshots the tool surface at session start — which is what a deferred /
tool-search index does — therefore keeps a list with **only static plugins**. That is
exactly the reported shape: `presentDocument` and friends work, the preset-backed
`google` / `manageSpotify` do not, while the prompt (built in the parent, whose registry
is complete) advertises them.

## Changes

1. **Console sink stream is configurable; the broker gets `stderr`.**
   `LOG_CONSOLE_STREAM=stderr` makes every record go to stderr instead of the
   level-based split. `buildMulmoclaudeServer` sets it in the child's env (native and
   Docker share that env block), so the broker's stdout carries JSON-RPC only.

2. **`tools/list` waits — briefly — for runtime plugins.**
   The first `tools/list` awaits `runtimeReady` with a hard cap
   (`TOOLS_LIST_RUNTIME_WAIT_MS`). A normal load resolves in milliseconds, so the answer
   now includes runtime tools and a snapshotting client is correct. A pathological load
   still answers within the cap with static tools, preserving the #1698 / #2201 property
   that `handlePermission` cannot be starved, and `tools/list_changed` remains the
   backstop.

3. **The child reports what it published.** After `runtimeReady`, log the runtime plugin
   names that registered and — the diagnostic the issue asked for — any name in
   `PLUGIN_NAMES` (i.e. advertised by the parent's system prompt) that resolved to no
   tool. "Advertised but not callable" stops being invisible.

4. **`error-recovery.md`**: a short section so the agent, on `No such tool available` for
   a tool its own instructions describe, tells the user what to check instead of
   inventing a fallback (the token-reading detour in the sibling issue).

## Verification

- `test/agent/test_mcp_smoke.ts` — spawns the broker with the env
  `buildMulmoclaudeServer` actually ships and asserts stdout carries no non-JSON line;
  asserts the published surface and the "advertised but NOT published" diagnostic on
  stderr (`google` appearing there is itself the regression test for "the child does
  load presets").
- `test/agent/test_agent_config.ts` — the broker env carries `LOG_CONSOLE_STREAM` in both
  native and Docker mode.
- `test/logger/test_config.ts` / `test_sinks.ts` — `LOG_CONSOLE_STREAM` parsing, and no
  level reaching stdout in `stderr` mode.
- `test/utils/test_promise.ts` — `settleWithin` resolves early, treats a rejection as
  settled, and gives up at the deadline.
- Manual: re-run the stdio probe against the built bundle and confirm stdout is pure
  JSON-RPC.

The timing property itself (a runtime tool present in the FIRST `tools/list`) is left to
the manual probe: asserting it in CI would make the test a race against the 2 s cap on a
cold runner.

## Not done here

The reporter's host is still unreproduced — this hardens the two paths that can produce
the symptom rather than pinning theirs. Worth asking on the issue whether
`manageSpotify` (the other preset-backed tool in the `personal` role) vanished at the
same time; both defects predict yes, a host-specific loader failure predicts a different
answer.
