import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTaskFinishedPush, condenseReplyForPush } from "../../server/agent/webPush.js";

const push = (input: { sessionTitle?: string | undefined; replyText?: string | undefined; didError?: boolean }) =>
  buildTaskFinishedPush({ sessionTitle: input.sessionTitle, replyText: input.replyText, didError: input.didError ?? false });

describe("buildTaskFinishedPush title — WHICH chat finished", () => {
  it("marks success with ✅ and failure with ⚠️", () => {
    assert.ok(push({ sessionTitle: "Lens DB" }).title.startsWith("✅"));
    assert.ok(push({ sessionTitle: "Lens DB", didError: true }).title.startsWith("⚠️"));
  });

  it("names the chat, so two sessions are distinguishable at a glance", () => {
    assert.equal(push({ sessionTitle: "Lens DB sync" }).title, "✅ Lens DB sync");
    assert.equal(push({ sessionTitle: "Osaka trip" }).title, "✅ Osaka trip");
  });

  it("falls back to the app name when the session has no title yet", () => {
    assert.equal(push({}).title, "✅ MulmoClaude");
    assert.equal(push({ sessionTitle: "   " }).title, "✅ MulmoClaude");
  });

  it("caps the title", () => {
    assert.ok(push({ sessionTitle: "x".repeat(500) }).title.length <= 80);
  });
});

describe("buildTaskFinishedPush body — WHAT it did", () => {
  it("uses the assistant reply, not the user's message", () => {
    assert.equal(push({ replyText: "Wrote 42 rows to lenses.csv." }).body, "Wrote 42 rows to lenses.csv.");
  });

  // The reason the turn's own user message was rejected as a source: a turn is
  // very often driven by a bare acknowledgement, which says nothing about what
  // finished. The reply is what carries the outcome.
  it("still says something useful on a turn the user drove with just はい", () => {
    const { title, body } = push({ sessionTitle: "Lens DB sync", replyText: "Firestore への書き込みが完了しました。42件を同期しています。" });
    assert.equal(title, "✅ Lens DB sync");
    assert.equal(body, "Firestore への書き込みが完了しました。42件を同期しています。");
    assert.ok(!body.includes("はい"));
  });

  // The #2901 regression itself: the body must move between turns of ONE
  // session. Before the fix both turns pushed the session's first message.
  it("differs between two turns of the same session", () => {
    const sessionTitle = "Lens DB sync";
    const first = push({ sessionTitle, replyText: "スキーマを作成しました。" });
    const second = push({ sessionTitle, replyText: "CSV を42件書き出しました。" });
    assert.equal(first.title, second.title, "the chat is the same, so the title should match");
    assert.notEqual(first.body, second.body, "what finished differs, so the body must differ");
  });

  it("falls back to a generic body when the turn produced no reply (tools only)", () => {
    assert.equal(push({ replyText: undefined }).body, "Task complete");
    assert.equal(push({ replyText: "   " }).body, "Task complete");
    assert.equal(push({ replyText: "```js\nconst a = 1;\n```" }).body, "Task complete");
  });

  it("caps the body length (ellipsis included in the budget)", () => {
    const { body } = push({ replyText: "x".repeat(500) });
    assert.ok(body.length <= 160, `body length ${body.length} exceeds cap`);
    assert.ok(body.endsWith("…"));
  });
});

describe("condenseReplyForPush", () => {
  it("drops fenced code blocks entirely", () => {
    assert.equal(condenseReplyForPush("Done.\n\n```ts\nconst a = 1;\n```\n\nNext up: tests."), "Done. Next up: tests.");
  });

  // A reply cut short mid-block — an abort, or an error turn (which still
  // pushes, under ⚠️) — leaves an opening fence with no partner. The paired
  // rule cannot touch it, so the raw fence reached the lock screen.
  // (Codex review on #2909.)
  it("drops an unterminated fence and everything after it", () => {
    assert.equal(condenseReplyForPush("Here you go:\n\n```ts\nconst a = 1;"), "Here you go:");
    assert.equal(condenseReplyForPush("```"), "");
    assert.equal(condenseReplyForPush("Wrote the file.\n\n```"), "Wrote the file.");
  });

  it("keeps a complete block's trailing prose when a later fence is unclosed", () => {
    const reply = "Step one.\n\n```sh\nyarn build\n```\n\nStep two.\n\n```sh\nyarn test";
    assert.equal(condenseReplyForPush(reply), "Step one. Step two.");
  });

  it("keeps inline code content without the backticks", () => {
    assert.equal(condenseReplyForPush("Updated `webPush.ts`."), "Updated webPush.ts.");
  });

  it("keeps link text and drops the URL", () => {
    assert.equal(condenseReplyForPush("See [the plan](https://example.com/a?b=c)."), "See the plan.");
  });

  it("strips heading, quote, bullet and ordered-list markers", () => {
    assert.equal(condenseReplyForPush("## Summary\n- one\n* two\n+ three\n1. four\n> quoted"), "Summary one two three four quoted");
  });

  it("strips bold markers", () => {
    assert.equal(condenseReplyForPush("**Done** and __dusted__"), "Done and dusted");
  });

  it("collapses newlines and runs of whitespace into single spaces", () => {
    assert.equal(condenseReplyForPush("line one\n\n\nline   two\t\tend"), "line one line two end");
  });

  it("returns an empty string for nothing, blanks, or markup-only input", () => {
    assert.equal(condenseReplyForPush(undefined), "");
    assert.equal(condenseReplyForPush("\n\n   \t"), "");
    assert.equal(condenseReplyForPush("```\nx\n```"), "");
  });

  // A hyphen mid-sentence is not a list marker, and snake_case is not emphasis
  // — only the leading marker and the doubled form are markup.
  it("leaves ordinary punctuation alone", () => {
    assert.equal(condenseReplyForPush("well-formed input_name stays intact"), "well-formed input_name stays intact");
  });
});
