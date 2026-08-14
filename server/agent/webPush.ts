// Web Push on task finish (#2086): when a visible agent turn completes and the
// user enabled push in Settings, notify their registered devices via the
// mulmoserver sendPush Cloud Function (@mulmobridge/web-push). Fire-and-forget —
// sendWebPush no-ops when RemoteHost (its Firebase auth) isn't connected, so
// this is safe to call unconditionally from the turn-end hook.
import { sendWebPush } from "@mulmobridge/web-push";
import { currentIdToken } from "../remoteHost/session.js";
import { loadSettings, isPushEnabled } from "../system/config.js";
import { readSessionMeta } from "../utils/files/session-io.js";
import { readIndexTitle } from "../workspace/chat-index/indexer.js";
import { workspacePath } from "../workspace/paths.js";
import { truncate } from "../utils/text.js";
import { log } from "../system/logger/index.js";

const PUSH_TITLE_MAX = 80;
const PUSH_BODY_MAX = 160;
const DONE_MARK = "✅";
const ERROR_MARK = "⚠️";
const APP_NAME = "MulmoClaude";
// Neutral English fallback (the app's fallback locale) for the rare turn that
// produced no assistant text at all — a fixed Japanese string here would give
// non-JA users a mixed-language push. Locale-aware bodies are a follow-up
// (needs the user's locale plumbed server-side).
const DEFAULT_BODY = "Task complete";

export interface TaskFinishedPush {
  title: string;
  body: string;
}

// The markup this strips. Every pattern here is kept linear on purpose: the
// input is model-authored text and this repo has had polynomial-ReDoS findings,
// so each is either a lazy span between literals or explicitly bounded.
const FENCE = "```";
const FENCED_CODE = /```[\s\S]*?```/g;
const INLINE_CODE = /`([^`]*)`/g;
// Bounded, and the label excludes `[` as well as `]`: an unbounded label lets
// `[[[[[…` restart a full scan at every bracket, which is the super-linear
// shape sonarjs rejects. A link longer than these caps simply keeps its markup
// — acceptable for a one-line preview that gets truncated anyway.
const MARKDOWN_LINK = /\[([^[\]]{0,200})\]\([^)]{0,500}\)/g;
// Leading block markers: heading, quote, bullet, ordered item.
const LINE_MARKER = /^[ \t]*(?:#{1,6}|>|[-*+]|\d+\.)[ \t]+/gm;
const BOLD_MARKER = /\*\*|__/g;
const WHITESPACE_RUN = /\s+/g;

/** Cut a reply at an opening fence that never closed. Run only AFTER the paired
 *  blocks are gone, so any fence still present is an unclosed opener — a reply
 *  cut short mid-block, which is what an abort or an error turn (still pushed,
 *  under ⚠️) produces. Everything after it IS the code block as far as markdown
 *  is concerned, so it goes too, and the raw snippet stays off the lock screen
 *  (Codex review on #2909).
 *
 *  `indexOf` rather than a regex: `/```[\s\S]*$/` rescans to the end from every
 *  backtick run, which is the super-linear shape sonarjs rejects. */
function dropUnclosedFence(text: string): string {
  const open = text.indexOf(FENCE);
  return open === -1 ? text : text.slice(0, open);
}

/** Reduce model-authored text to one plain line fit for a notification field —
 *  both the reply that becomes the body and the AI title that becomes the
 *  title go through it, since a newline or a code fence ruins either.
 *
 *  Deliberately not a markdown parser: a notification shows one line, so the
 *  goal is only to stop the markup itself from being what the user reads.
 *  Returns "" when nothing survives (a turn that only ran tools), which the
 *  caller turns into its own fallback. */
export function condenseForPush(reply: string | undefined): string {
  return dropUnclosedFence((reply ?? "").replace(FENCED_CODE, " "))
    .replace(INLINE_CODE, "$1")
    .replace(MARKDOWN_LINK, "$1")
    .replace(LINE_MARKER, "")
    .replace(BOLD_MARKER, "")
    .replace(WHITESPACE_RUN, " ")
    .trim();
}

/** The chat this push belongs to, in the same words the session list uses
 *  (`buildSessionSummary`): the AI title, else the first user message. */
function pushTitleFor(sessionTitle: string | undefined, didError: boolean): string {
  const mark = didError ? ERROR_MARK : DONE_MARK;
  const name = condenseForPush(sessionTitle) || APP_NAME;
  return truncate(`${mark} ${name}`, PUSH_TITLE_MAX);
}

// Pure: the title says WHICH chat finished, the body says WHAT it did.
//
// The body used to be the session's FIRST user message, which is the session's
// identity rather than the turn's outcome — so every turn in a session pushed
// the same text forever (#2901). The turn's own user message is no better: a
// turn is often driven by "はい" / "OK" / "続けて", which carries nothing. Only
// the assistant's reply knows what actually happened, so that is the body.
export function buildTaskFinishedPush(input: { sessionTitle: string | undefined; replyText: string | undefined; didError: boolean }): TaskFinishedPush {
  return {
    title: pushTitleFor(input.sessionTitle, input.didError),
    body: truncate(condenseForPush(input.replyText) || DEFAULT_BODY, PUSH_BODY_MAX),
  };
}

// Notify the user's registered devices that a visible agent turn finished.
// No-op when push is disabled or RemoteHost isn't connected. Never throws.
export async function notifyTaskFinished(chatSessionId: string, didError: boolean, replyText?: string): Promise<void> {
  // Logged, quietly: "push is off" and "push failed" are the two answers a
  // reader is choosing between, and a silent return leaves `grep web-push`
  // empty for both (#2903).
  if (!isPushEnabled(loadSettings())) {
    log.debug("web-push", "skipped — push is disabled in settings", { chatSessionId });
    return;
  }
  const [meta, indexTitle] = await Promise.all([readSessionMeta(chatSessionId), readIndexTitle(workspacePath, chatSessionId)]);
  const sessionTitle = indexTitle ?? meta?.firstUserMessage;
  const { title, body } = buildTaskFinishedPush({ sessionTitle, replyText, didError });
  const result = await sendWebPush(title, body, {
    getIdToken: currentIdToken,
    onFailure: (failure) => log.warn("web-push", "sendPush did not deliver", { chatSessionId, ...failure }),
  });
  if (!result) return; // already reported by onFailure
  if (result.targets === 0) {
    log.info("web-push", "sendPush reached no registered devices", { chatSessionId });
    return;
  }
  log.info("web-push", "sendPush delivered", { chatSessionId, ...result });
}
