// Web Push on task finish (#2086): when a visible agent turn completes and the
// user enabled push in Settings, notify their registered devices via the
// mulmoserver sendPush Cloud Function (@mulmobridge/web-push). Fire-and-forget —
// sendWebPush no-ops when RemoteHost (its Firebase auth) isn't connected, so
// this is safe to call unconditionally from the turn-end hook.
import { sendWebPush } from "@mulmobridge/web-push";
import { currentIdToken } from "../remoteHost/session.js";
import { loadSettings, isPushEnabled } from "../system/config.js";
import { readSessionMeta } from "../utils/files/session-io.js";
import { truncate } from "../utils/text.js";
import { log } from "../system/logger/index.js";

const PUSH_TITLE_MAX = 80;
const PUSH_BODY_MAX = 160;
const DONE_TITLE = "✅ MulmoClaude";
const ERROR_TITLE = "⚠️ MulmoClaude";
// Neutral English fallback (the app's fallback locale) for the rare turn with no
// user message — a fixed Japanese string here would give non-JA users a
// mixed-language push. Locale-aware bodies are a follow-up (needs the user's
// locale plumbed server-side).
const DEFAULT_BODY = "Task complete";

export interface TaskFinishedPush {
  title: string;
  body: string;
}

// Pure: derive the push title/body from the turn outcome and the session's
// first user message (identifies the task). Falls back to a generic body when
// there's no message. Both fields are length-capped.
export function buildTaskFinishedPush(firstUserMessage: string | undefined, didError: boolean): TaskFinishedPush {
  return {
    title: truncate(didError ? ERROR_TITLE : DONE_TITLE, PUSH_TITLE_MAX),
    body: truncate((firstUserMessage ?? "").trim() || DEFAULT_BODY, PUSH_BODY_MAX),
  };
}

// Notify the user's registered devices that a visible agent turn finished.
// No-op when push is disabled or RemoteHost isn't connected. Never throws.
export async function notifyTaskFinished(chatSessionId: string, didError: boolean): Promise<void> {
  // Logged, quietly: "push is off" and "push failed" are the two answers a
  // reader is choosing between, and a silent return leaves `grep web-push`
  // empty for both (#2903).
  if (!isPushEnabled(loadSettings())) {
    log.debug("web-push", "skipped — push is disabled in settings", { chatSessionId });
    return;
  }
  const meta = await readSessionMeta(chatSessionId);
  const { title, body } = buildTaskFinishedPush(meta?.firstUserMessage, didError);
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
