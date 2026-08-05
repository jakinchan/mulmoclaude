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

export interface UseChatDrafts {
  /** Draft text of the displayed session. Reads/writes look like a
   *  plain `ref<string>` so callers stay unaware of the keying. */
  userInput: WritableComputedRef<string>;
  /** Attachments staged for the displayed session. */
  pastedFiles: WritableComputedRef<PastedFile[]>;
  /** Put a composed message back under the session it was written in,
   *  rather than the one on screen. A failed send resolves after a
   *  network round trip, by which time the user may be looking at
   *  another session — whose draft must not be overwritten. */
  restoreDraft: (sessionId: string, text: string, files: PastedFile[]) => void;
  /** Forget a session's draft and attachments — its session is gone
   *  (deleted, or an empty one evicted), so both are unreachable. */
  dropDraft: (sessionId: string) => void;
}

export function useChatDrafts(currentSessionId: Ref<string>): UseChatDrafts {
  const drafts = ref<DraftMap>(parseStoredDrafts(readStoredDrafts()));
  const attachments = ref<Record<string, PastedFile[]>>({});

  // The pure helpers return the map unchanged when there was nothing to
  // do, which is the signal to skip the write — session switches and
  // delete broadcasts call through here constantly.
  function commitDrafts(next: DraftMap): void {
    if (next === drafts.value) return;
    drafts.value = next;
    writeStoredDrafts(serializeDrafts(next));
  }

  function setAttachments(sessionId: string, files: PastedFile[]): void {
    attachments.value = files.length === 0 ? omitSession(attachments.value, sessionId) : { ...attachments.value, [sessionId]: files };
  }

  const userInput = computed<string>({
    get: () => getDraft(drafts.value, currentSessionId.value),
    set: (text) => commitDrafts(setDraft(drafts.value, currentSessionId.value, text)),
  });

  const pastedFiles = computed<PastedFile[]>({
    get: () => attachments.value[currentSessionId.value] ?? [],
    set: (files) => setAttachments(currentSessionId.value, files),
  });

  function restoreDraft(sessionId: string, text: string, files: PastedFile[]): void {
    commitDrafts(setDraft(drafts.value, sessionId, text));
    setAttachments(sessionId, files);
  }

  function dropDraft(sessionId: string): void {
    commitDrafts(omitSession(drafts.value, sessionId));
    attachments.value = omitSession(attachments.value, sessionId);
  }

  return { userInput, pastedFiles, restoreDraft, dropDraft };
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
