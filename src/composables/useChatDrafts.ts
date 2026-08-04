// What the user has composed but not sent, kept per session (#2811):
// the input text plus its attachments. Both used to be single global
// refs, so a session switch showed the previous session's text and
// chips, and a reload threw the text away.
//
// The text is mirrored into sessionStorage — it survives a reload and a
// tab restore, dies with the tab, and two tabs never overwrite each
// other. Attachments stay in memory only: they are data URLs (up to
// 30 MB each) and would blow the storage quota.

import { computed, ref, type Ref, type WritableComputedRef } from "vue";
import { CHAT_DRAFTS_STORAGE_KEY, getDraft, omitSession, parseStoredDrafts, serializeDrafts, setDraft, type DraftMap } from "../utils/chat/draftStore";
import type { PastedFile } from "../types/pastedFile";

const NO_FILES: PastedFile[] = [];

export interface UseChatDrafts {
  /** Draft text of the displayed session. Reads/writes look like a
   *  plain `ref<string>` so callers stay unaware of the keying. */
  userInput: WritableComputedRef<string>;
  /** Attachments staged for the displayed session. */
  pastedFiles: WritableComputedRef<PastedFile[]>;
  /** Forget a session's draft and attachments — its session is gone
   *  (deleted, or an empty one evicted), so both are unreachable. */
  dropDraft: (sessionId: string) => void;
}

export function useChatDrafts(currentSessionId: Ref<string>): UseChatDrafts {
  const drafts = ref<DraftMap>(parseStoredDrafts(readStoredDrafts()));
  const attachments = ref<Record<string, PastedFile[]>>({});

  function commitDrafts(next: DraftMap): void {
    drafts.value = next;
    writeStoredDrafts(serializeDrafts(next));
  }

  const userInput = computed<string>({
    get: () => getDraft(drafts.value, currentSessionId.value),
    set: (text) => commitDrafts(setDraft(drafts.value, currentSessionId.value, text)),
  });

  const pastedFiles = computed<PastedFile[]>({
    get: () => attachments.value[currentSessionId.value] ?? NO_FILES,
    set: (files) => {
      const sessionId = currentSessionId.value;
      attachments.value = files.length === 0 ? omitSession(attachments.value, sessionId) : { ...attachments.value, [sessionId]: files };
    },
  });

  function dropDraft(sessionId: string): void {
    commitDrafts(omitSession(drafts.value, sessionId));
    attachments.value = omitSession(attachments.value, sessionId);
  }

  return { userInput, pastedFiles, dropDraft };
}

function readStoredDrafts(): string | null {
  try {
    return sessionStorage.getItem(CHAT_DRAFTS_STORAGE_KEY);
  } catch {
    // Storage can be unavailable (private mode / blocked cookies) —
    // drafts then live in memory only, which still beats losing input.
    return null;
  }
}

function writeStoredDrafts(serialized: string): void {
  try {
    sessionStorage.setItem(CHAT_DRAFTS_STORAGE_KEY, serialized);
  } catch {
    // Quota or blocked storage: keep the in-memory draft, skip persisting.
  }
}
