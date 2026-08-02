import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  createSessionMeta,
  readSessionMeta,
  writeSessionMeta,
  updateHasUnread,
  incrementUserQueryCount,
  backfillFirstUserMessage,
  setClaudeSessionId,
  clearClaudeSessionId,
  appendSessionLine,
  readSessionJsonl,
} from "../../../server/utils/files/session-io.js";
import { WORKSPACE_DIRS } from "../../../server/workspace/paths.js";

let root: string;

before(() => {
  root = mkdtempSync(path.join(tmpdir(), "session-io-test-"));
  // Create the chat dir
  mkdirSync(path.join(root, WORKSPACE_DIRS.chat), { recursive: true });
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("readSessionMeta", () => {
  it("returns null for non-existent session", async () => {
    assert.equal(await readSessionMeta("nonexistent", root), null);
  });

  it("returns null for corrupt JSON (not crash)", async () => {
    const chatDir = path.join(root, WORKSPACE_DIRS.chat);
    writeFileSync(path.join(chatDir, "corrupt.json"), "{broken");
    assert.equal(await readSessionMeta("corrupt", root), null);
  });

  it("round-trips with writeSessionMeta", async () => {
    await writeSessionMeta("rw-test", { roleId: "general" }, root);
    const meta = await readSessionMeta("rw-test", root);
    assert.equal(meta?.roleId, "general");
  });

  it("returns null for JSON whose declared fields have the wrong types", async () => {
    const chatDir = path.join(root, WORKSPACE_DIRS.chat);
    const body = JSON.stringify({ roleId: 5, hasUnread: "yes", origin: "martian" });
    writeFileSync(path.join(chatDir, "bad-shape.json"), body);
    assert.equal(await readSessionMeta("bad-shape", root), null);
    // Every mutator early-returns on null, so an unreadable meta file must
    // stay on disk intact rather than being replaced by a partial rewrite.
    await updateHasUnread("bad-shape", true, root);
    assert.equal(readFileSync(path.join(chatDir, "bad-shape.json"), "utf-8"), body);
  });

  it("keeps keys the type doesn't model, and accepts a plugin origin", async () => {
    const chatDir = path.join(root, WORKSPACE_DIRS.chat);
    writeFileSync(path.join(chatDir, "extra.json"), JSON.stringify({ roleId: "general", origin: "plugin:@scope/pkg", futureField: [1, 2] }));
    const meta = await readSessionMeta("extra", root);
    assert.equal(meta?.origin, "plugin:@scope/pkg");
    assert.deepEqual(meta?.futureField, [1, 2]);
  });
});

describe("createSessionMeta", () => {
  it("creates meta with roleId, startedAt, firstUserMessage", async () => {
    await createSessionMeta("create-test", "office", "hello", root);
    const meta = await readSessionMeta("create-test", root);
    assert.equal(meta?.roleId, "office");
    assert.equal(meta?.firstUserMessage, "hello");
    assert.ok(meta?.startedAt);
  });

  it("creates parent dir if missing", async () => {
    const freshRoot = mkdtempSync(path.join(tmpdir(), "session-io-nodir-"));
    // Don't pre-create chat dir
    await createSessionMeta("nodir-test", "general", "hi", freshRoot);
    const meta = await readSessionMeta("nodir-test", freshRoot);
    assert.equal(meta?.roleId, "general");
    rmSync(freshRoot, { recursive: true, force: true });
  });
});

describe("updateHasUnread", () => {
  it("sets hasUnread on existing meta", async () => {
    await writeSessionMeta("unread-test", { roleId: "general" }, root);
    await updateHasUnread("unread-test", true, root);
    const meta = await readSessionMeta("unread-test", root);
    assert.equal(meta?.hasUnread, true);
  });

  it("no-ops when session meta does not exist", async () => {
    await assert.doesNotReject(updateHasUnread("ghost", false, root));
  });
});

describe("incrementUserQueryCount", () => {
  it("bumps undefined → 1 on the first turn, then 1 → 2", async () => {
    await writeSessionMeta("count-test", { roleId: "general" }, root);
    await incrementUserQueryCount("count-test", root);
    assert.equal((await readSessionMeta("count-test", root))?.userQueryCount, 1);
    await incrementUserQueryCount("count-test", root);
    assert.equal((await readSessionMeta("count-test", root))?.userQueryCount, 2);
  });

  it("no-ops when session meta does not exist", async () => {
    await incrementUserQueryCount("count-ghost", root);
    assert.equal(await readSessionMeta("count-ghost", root), null);
  });

  it("preserves other meta fields", async () => {
    await writeSessionMeta("count-preserve", { roleId: "office", isBookmarked: true }, root);
    await incrementUserQueryCount("count-preserve", root);
    const meta = await readSessionMeta("count-preserve", root);
    assert.equal(meta?.roleId, "office");
    assert.equal(meta?.isBookmarked, true);
    assert.equal(meta?.userQueryCount, 1);
  });
});

describe("backfillFirstUserMessage", () => {
  it("backfills when missing", async () => {
    await writeSessionMeta("backfill-test", { roleId: "general" }, root);
    await backfillFirstUserMessage("backfill-test", "first msg", root);
    const meta = await readSessionMeta("backfill-test", root);
    assert.equal(meta?.firstUserMessage, "first msg");
  });

  it("does not overwrite when already set", async () => {
    await writeSessionMeta("backfill-noop", { roleId: "general", firstUserMessage: "original" }, root);
    await backfillFirstUserMessage("backfill-noop", "replacement", root);
    const meta = await readSessionMeta("backfill-noop", root);
    assert.equal(meta?.firstUserMessage, "original");
  });
});

describe("setClaudeSessionId / clearClaudeSessionId", () => {
  it("sets and clears claudeSessionId", async () => {
    await writeSessionMeta("claude-test", { roleId: "general" }, root);
    await setClaudeSessionId("claude-test", "cs-123", root);
    let meta = await readSessionMeta("claude-test", root);
    assert.equal(meta?.claudeSessionId, "cs-123");

    await clearClaudeSessionId("claude-test", root);
    meta = await readSessionMeta("claude-test", root);
    assert.equal(meta?.claudeSessionId, undefined);
    assert.equal(meta?.roleId, "general"); // other fields preserved
  });
});

describe("appendSessionLine", () => {
  it("appends lines with trailing newline", async () => {
    await appendSessionLine("append-test", '{"a":1}', root);
    await appendSessionLine("append-test", '{"b":2}', root);
    const raw = await readSessionJsonl("append-test", root);
    assert.ok(raw);
    const lines = raw.split("\n").filter(Boolean);
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]), { a: 1 });
    assert.deepEqual(JSON.parse(lines[1]), { b: 2 });
  });

  it("normalizes missing trailing newline", async () => {
    await appendSessionLine("nl-test", "line-without-nl", root);
    await appendSessionLine("nl-test", "line-with-nl\n", root);
    const raw = await readSessionJsonl("nl-test", root);
    assert.ok(raw);
    // Both should end up as separate lines
    const lines = raw.split("\n").filter(Boolean);
    assert.equal(lines.length, 2);
    assert.equal(lines[0], "line-without-nl");
    assert.equal(lines[1], "line-with-nl");
  });

  it("does not double-newline when caller already includes \\n", async () => {
    await appendSessionLine("double-nl", "data\n", root);
    const raw = await readSessionJsonl("double-nl", root);
    assert.ok(raw);
    assert.equal(raw, "data\n");
    // NOT "data\n\n"
  });
});

describe("readSessionJsonl", () => {
  it("returns null for non-existent session", async () => {
    assert.equal(await readSessionJsonl("no-jsonl", root), null);
  });
});
