// Unit tests for the pure helpers extracted from
// `src/App.vue#loadSession`. Tracks #175.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSessionEntries, resolveSelectedUuid, resolveSessionTimestamps, shouldAdoptServerTranscript } from "../../../src/utils/session/sessionEntries.js";
import type { SessionEntry, SessionSummary } from "../../../src/types/session.js";
import type { ToolResultComplete } from "gui-chat-protocol/vue";

// --- parseSessionEntries ------------------------------------------

/** Narrows a positional lookup: a shorter list than the test expects is a
 *  failure, so this throws instead of yielding `undefined`. */
function resultAt(results: ToolResultComplete[], index: number): ToolResultComplete {
  const result = results[index];
  assert.ok(result, `expected a tool result at index ${index}`);
  return result;
}

describe("parseSessionEntries", () => {
  it("returns empty array for empty input", () => {
    assert.deepEqual(parseSessionEntries([]), []);
  });

  it("skips session_meta entries", () => {
    const entries: SessionEntry[] = [
      {
        type: "session_meta",
        roleId: "general",
      } as SessionEntry,
    ];
    assert.deepEqual(parseSessionEntries(entries), []);
  });

  it("converts user text entries into tool-result envelopes", () => {
    const entries: SessionEntry[] = [
      {
        source: "user",
        type: "text",
        message: "hello",
      },
    ];
    const out = parseSessionEntries(entries);
    assert.equal(out.length, 1);
    assert.equal(resultAt(out, 0).toolName, "text-response");
  });

  it("converts assistant text entries", () => {
    const entries: SessionEntry[] = [
      {
        source: "assistant",
        type: "text",
        message: "ok",
      },
    ];
    const out = parseSessionEntries(entries);
    assert.equal(out.length, 1);
    assert.equal(resultAt(out, 0).toolName, "text-response");
  });

  it("passes tool_result entries through verbatim", () => {
    const toolResult = {
      uuid: "r1",
      toolName: "generateImage",
    } as unknown as ToolResultComplete;
    const entries: SessionEntry[] = [
      {
        source: "tool",
        type: "tool_result",
        result: toolResult,
      },
    ];
    const out = parseSessionEntries(entries);
    assert.equal(out.length, 1);
    assert.equal(out[0], toolResult);
  });

  it("preserves ordering across a mixed feed", () => {
    const toolResult = {
      uuid: "tool-1",
      toolName: "generateImage",
    } as unknown as ToolResultComplete;
    const entries: SessionEntry[] = [
      { source: "user", type: "text", message: "make an image" },
      { source: "tool", type: "tool_result", result: toolResult },
      { source: "assistant", type: "text", message: "done" },
    ];
    const out = parseSessionEntries(entries);
    assert.equal(out.length, 3);
    assert.equal(resultAt(out, 0).toolName, "text-response");
    assert.equal(out[1], toolResult);
    assert.equal(resultAt(out, 2).toolName, "text-response");
  });

  it("skips entries that are neither text nor tool_result", () => {
    const entries = [{ source: "unknown", type: "unknown-kind", message: "x" }] as unknown as SessionEntry[];
    assert.deepEqual(parseSessionEntries(entries), []);
  });

  it("tolerates session_meta mixed with real entries", () => {
    const entries: SessionEntry[] = [
      {
        type: "session_meta",
        roleId: "general",
      } as SessionEntry,
      { source: "user", type: "text", message: "hi" },
    ];
    const out = parseSessionEntries(entries);
    assert.equal(out.length, 1);
  });

  // --- plugin-seeded chat marker (Phase 1 of Encore plan) ---------

  it("does NOT mark seededByPlugin when sessionOrigin is undefined", () => {
    const entries: SessionEntry[] = [{ source: "user", type: "text", message: "hi" }];
    const out = parseSessionEntries(entries, undefined);
    assert.equal((resultAt(out, 0).data as Record<string, unknown>).seededByPlugin, undefined);
  });

  it("does NOT mark seededByPlugin for non-plugin origins", () => {
    const entries: SessionEntry[] = [{ source: "user", type: "text", message: "hi" }];
    const out = parseSessionEntries(entries, "scheduler");
    assert.equal((resultAt(out, 0).data as Record<string, unknown>).seededByPlugin, undefined);
  });

  it("marks the FIRST user turn with seededByPlugin when origin is plugin:<pkg>", () => {
    const entries: SessionEntry[] = [
      { source: "user", type: "text", message: "did you get your W-2?" },
      { source: "assistant", type: "text", message: "Have you received your W-2?" },
    ];
    const out = parseSessionEntries(entries, "plugin:@mulmoclaude/encore-plugin");
    const userData = resultAt(out, 0).data as Record<string, unknown>;
    const assistantData = resultAt(out, 1).data as Record<string, unknown>;
    assert.equal(userData.seededByPlugin, "@mulmoclaude/encore-plugin");
    // Assistant turn must NOT be marked.
    assert.equal(assistantData.seededByPlugin, undefined);
  });

  it("does NOT mark a SECOND user turn (only the first user turn is the seed)", () => {
    const entries: SessionEntry[] = [
      { source: "user", type: "text", message: "seed" },
      { source: "assistant", type: "text", message: "ok" },
      { source: "user", type: "text", message: "second user reply" },
    ];
    const out = parseSessionEntries(entries, "plugin:@mulmoclaude/encore-plugin");
    assert.equal((resultAt(out, 0).data as Record<string, unknown>).seededByPlugin, "@mulmoclaude/encore-plugin");
    assert.equal((resultAt(out, 2).data as Record<string, unknown>).seededByPlugin, undefined);
  });

  it("rejects plugin:<empty-pkg> as a non-plugin origin", () => {
    const entries: SessionEntry[] = [{ source: "user", type: "text", message: "hi" }];
    // `plugin:` with empty pkg should not match the plugin-tag regex.
    const out = parseSessionEntries(entries, "plugin:" as never);
    assert.equal((resultAt(out, 0).data as Record<string, unknown>).seededByPlugin, undefined);
  });

  // --- meta-row fallback for sessionOrigin (Codex review on PR #1237) -

  it("falls back to session_meta.origin when sessionOrigin is undefined", () => {
    // Simulates loadSession() racing fetchSessions() — serverSummary is
    // undefined but the detail payload's meta row carries the origin.
    const entries: SessionEntry[] = [
      { type: "session_meta", roleId: "general", origin: "plugin:@mulmoclaude/encore-plugin" } as SessionEntry,
      { source: "user", type: "text", message: "seed" },
    ];
    const out = parseSessionEntries(entries);
    assert.equal((resultAt(out, 0).data as Record<string, unknown>).seededByPlugin, "@mulmoclaude/encore-plugin");
  });

  it("explicit sessionOrigin wins over session_meta.origin", () => {
    // Summary's origin is the canonical source when both are present
    // (server populates it from the same meta row, so they should agree
    // — but if a stale summary disagrees with disk, prefer the caller).
    const entries: SessionEntry[] = [
      { type: "session_meta", roleId: "general", origin: "plugin:@a/p" } as SessionEntry,
      { source: "user", type: "text", message: "seed" },
    ];
    const out = parseSessionEntries(entries, "plugin:@b/p");
    assert.equal((resultAt(out, 0).data as Record<string, unknown>).seededByPlugin, "@b/p");
  });

  it("does NOT fall back when meta.origin is missing", () => {
    const entries: SessionEntry[] = [{ type: "session_meta", roleId: "general" } as SessionEntry, { source: "user", type: "text", message: "seed" }];
    const out = parseSessionEntries(entries);
    assert.equal((resultAt(out, 0).data as Record<string, unknown>).seededByPlugin, undefined);
  });

  it("ignores malformed meta.origin (not a SessionOrigin)", () => {
    const entries: SessionEntry[] = [
      { type: "session_meta", roleId: "general", origin: "not-a-real-origin" } as SessionEntry,
      { source: "user", type: "text", message: "seed" },
    ];
    const out = parseSessionEntries(entries);
    assert.equal((resultAt(out, 0).data as Record<string, unknown>).seededByPlugin, undefined);
  });
});

// --- resolveSelectedUuid ------------------------------------------

function makeResult(uuid: string, toolName: string): ToolResultComplete {
  return { uuid, toolName } as unknown as ToolResultComplete;
}

describe("resolveSelectedUuid", () => {
  it("returns null for empty list", () => {
    assert.equal(resolveSelectedUuid([]), null);
  });

  it("returns the only result regardless of type", () => {
    assert.equal(resolveSelectedUuid([makeResult("only", "text-response")]), "only");
    assert.equal(resolveSelectedUuid([makeResult("only", "generateImage")]), "only");
  });

  it("returns the last result, whether tool or text", () => {
    const trailingText = [makeResult("img-1", "generateImage"), makeResult("text-1", "text-response")];
    assert.equal(resolveSelectedUuid(trailingText), "text-1");

    const trailingTool = [makeResult("text-1", "text-response"), makeResult("img-1", "generateImage")];
    assert.equal(resolveSelectedUuid(trailingTool), "img-1");

    const trailingSkill = [makeResult("text-1", "text-response"), makeResult("skill-1", "skill")];
    assert.equal(resolveSelectedUuid(trailingSkill), "skill-1");
  });
});

// --- resolveSessionTimestamps -------------------------------------

describe("resolveSessionTimestamps", () => {
  const now = "2026-04-13T10:00:00.000Z";

  it("uses server summary timestamps when available", () => {
    const summary = {
      id: "s",
      roleId: "g",
      startedAt: "2026-04-10T10:00:00.000Z",
      updatedAt: "2026-04-11T10:00:00.000Z",
      preview: "",
    } as SessionSummary;
    assert.deepEqual(resolveSessionTimestamps(summary, now), {
      startedAt: "2026-04-10T10:00:00.000Z",
      updatedAt: "2026-04-11T10:00:00.000Z",
    });
  });

  it("falls back to now when summary is undefined", () => {
    assert.deepEqual(resolveSessionTimestamps(undefined, now), {
      startedAt: now,
      updatedAt: now,
    });
  });

  it("falls back updatedAt to startedAt when summary lacks updatedAt", () => {
    // The SessionSummary interface requires updatedAt, but defensive
    // programming: if it's missing at runtime (corrupt persistence),
    // prefer startedAt over the current clock — the session's
    // sidebar position should stay stable rather than jumping to
    // "just updated".
    const summary = {
      id: "s",
      roleId: "g",
      startedAt: "2026-04-10T10:00:00.000Z",
      preview: "",
    } as unknown as SessionSummary;
    assert.deepEqual(resolveSessionTimestamps(summary, now), {
      startedAt: "2026-04-10T10:00:00.000Z",
      updatedAt: "2026-04-10T10:00:00.000Z",
    });
  });

  it("falls back to now when summary lacks both timestamps (pathological)", () => {
    const summary = {
      id: "s",
      roleId: "g",
      preview: "",
    } as unknown as SessionSummary;
    assert.deepEqual(resolveSessionTimestamps(summary, now), {
      startedAt: now,
      updatedAt: now,
    });
  });
});

// --- shouldAdoptServerTranscript (#2096) --------------------------

describe("shouldAdoptServerTranscript", () => {
  const card = (message: string): ToolResultComplete =>
    ({ uuid: message, toolName: "text-response", message, title: "Assistant", data: {} }) as ToolResultComplete;

  it("adopts when the server has more cards (client missed events)", () => {
    assert.equal(shouldAdoptServerTranscript([card("a"), card("b")], [card("a")]), true);
  });

  it("adopts when card counts match but a text card was truncated mid-stream (#2096)", () => {
    // Same 2 cards, but the client's last card is cut off ("理由によ")
    // while the server has the full body — the dropped-frame case.
    const server = [card("intro"), card("理由によって打ち手が全然違う。次の一手として、…")];
    const client = [card("intro"), card("理由によ")];
    assert.equal(shouldAdoptServerTranscript(server, client), true);
  });

  it("keeps the client copy when counts and total text are equal (no clobber on a finished race)", () => {
    const same = [card("intro"), card("done")];
    assert.equal(shouldAdoptServerTranscript(same, [card("intro"), card("done")]), false);
  });

  it("keeps the client copy when the client has richer in-flight text than the server snapshot", () => {
    assert.equal(shouldAdoptServerTranscript([card("short")], [card("a much longer live body")]), false);
  });

  it("keeps the client copy when the server has fewer cards (stale snapshot)", () => {
    assert.equal(shouldAdoptServerTranscript([card("a")], [card("a"), card("b")]), false);
  });

  it("handles empty transcripts", () => {
    assert.equal(shouldAdoptServerTranscript([], []), false);
    assert.equal(shouldAdoptServerTranscript([card("a")], []), true);
  });

  it("ignores non-text (tool) card message diffs — only streamed text/skill bodies count (Sourcery review)", () => {
    const toolCard = (message: string): ToolResultComplete =>
      ({ uuid: "img", toolName: "generateImage", message, title: "Image", data: { url: "x" } }) as ToolResultComplete;
    // Same card count; only the non-streamed tool card's `message` differs.
    // Its payload lives in `data` and it arrives complete, so it must NOT
    // trigger adoption on its own.
    const server = [card("hi"), toolCard("done rendering the sunset image")];
    const client = [card("hi"), toolCard("rendering")];
    assert.equal(shouldAdoptServerTranscript(server, client), false);
  });
});
