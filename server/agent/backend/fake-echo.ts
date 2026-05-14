// Test-only LLM backend. Echoes the user's message verbatim as the
// assistant reply, with no Claude / Docker spawn. Loaded lazily by
// `getActiveBackend()` only when `MULMOCLAUDE_FAKE_AGENT=1` — keeps
// this code (and its `randomUUID` etc. imports) out of the production
// runtime path entirely.
//
// What this unlocks in CI without a Claude binary / API key:
//   - L-LINKIFY-CODESPAN — needs the assistant to echo a codespan
//   - L-23 (workspace-link-routing) — needs the assistant to echo a
//     markdown link
//   - L-19 (ui stack layout) — needs *any* completed turn
//   - L-06..L-09 (roles) — same; one tool-free turn per role
//   - L-11 (session reload) — same
//
// What it does NOT unlock: tests that pin on the LLM actually
// reasoning / calling tools (presentForm, generateImage, skills, ...).
// Those stay gated on `E2E_LIVE_NO_LLM=1`.

import { randomUUID } from "node:crypto";

import { EVENT_TYPES } from "../../../src/types/events.js";
import type { AgentEvent } from "../stream.js";
import type { AgentInput, LLMBackend } from "./types.js";

// Per-session conversation memory so context-recall tests (session
// L-12: "what was the 6-digit code from earlier?") see prior turn
// content in the reply. Keyed by mulmoclaude's chat session id so
// resume across page reloads keeps working. The map grows for the
// process lifetime — fine for CI runs which boot a fresh server.
const sessionTurns = new Map<string, string[]>();

async function* runFakeEchoAgent(input: AgentInput): AsyncGenerator<AgentEvent> {
  // Synthesize a claude session id so the orchestrator's resume
  // bookkeeping (and any session-store side-effects) sees the same
  // shape as a real run.
  yield { type: EVENT_TYPES.claudeSessionId, id: randomUUID() };

  // Append the current turn and emit ALL session messages joined
  // back as the assistant reply. Tests that only inspect the
  // latest turn (linkify, role-smoke) still see their content;
  // tests that ask the assistant to recall an earlier turn (L-12)
  // see the prior text inside the same reply.
  const history = sessionTurns.get(input.sessionId) ?? [];
  history.push(input.message);
  sessionTurns.set(input.sessionId, history);

  yield { type: EVENT_TYPES.text, message: history.join("\n\n") };
}

export const fakeEchoBackend: LLMBackend = {
  id: "fake-echo",
  // Resume-by-token / MCP aren't meaningfully replayable from an
  // echo stub. Flag them as unsupported so callers that depend on
  // the real Claude semantics opt out instead of getting silently
  // wrong behavior.
  capabilities: { sessionResume: false, mcp: false },
  runAgent: runFakeEchoAgent,
};
