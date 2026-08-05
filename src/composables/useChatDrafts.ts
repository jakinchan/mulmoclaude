// What the user has composed but not sent, kept per session (#2811):
// the input text plus its attachments. Both used to be single global
// refs, so a session switch showed the previous session's text and
// chips, and a reload threw the text away.
//
// The text is mirrored into sessionStorage — it survives a reload and a
// tab restore, dies with the tab, and two tabs never overwrite each
// other. Attachments stay in memory only: they are data URLs (up to
// 30 MB each) and would blow the storage quota.

import { computed, ref, watch, type Ref, type WritableComputedRef } from "vue";
import {
  CHAT_DRAFTS_STORAGE_KEY,
  getDraft,
  omitSession,
  parseStoredDrafts,
  putSession,
  serializeDrafts,
  setDraft,
  type DraftMap,
} from "../utils/chat/draftStore";
import { mergeBufferedIntoDraft } from "../utils/chat/buffer";
import type { PastedFile } from "../types/pastedFile";

// The composer is usable before the app has settled which session to
// land on (/chat with no id in the URL awaits roles + the session list
// first). Text typed then belongs to no session yet and parks here.
const UNIDENTIFIED_SESSION = "";

export interface UseChatDrafts {
  /** Draft text of the displayed session. Reads/writes look like a
   *  plain `ref<string>` so callers stay unaware of the keying. */
  userInput: WritableComputedRef<string>;
  /** Attachments staged for the displayed session. */
  pastedFiles: WritableComputedRef<PastedFile[]>;
  /** Put a composed message back under the session it was written in,
   *  rather than the one on screen. A failed send resolves after a
   *  network round trip, by which time the user may be looking at
   *  another session — whose draft must not be overwritten. Merges with
   *  whatever that session holds now, since the user may have started a
   *  new message there while the send was in flight. */
  restoreDraft: (sessionId: string, text: string, files: PastedFile[]) => void;
  /** Forget a session's draft and attachments — its session is gone
   *  (deleted, or an empty one evicted), so both are unreachable. */
  dropDraft: (sessionId: string) => void;
}

interface DraftState {
  drafts: Ref<DraftMap>;
  attachments: Ref<Record<string, PastedFile[]>>;
  commitDrafts: (next: DraftMap) => void;
  setAttachments: (sessionId: string, files: PastedFile[]) => void;
}

function createDraftState(): DraftState {
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
    attachments.value = files.length === 0 ? omitSession(attachments.value, sessionId) : putSession(attachments.value, sessionId, files);
  }

  return { drafts, attachments, commitDrafts, setAttachments };
}

function filesOf(state: DraftState, sessionId: string): PastedFile[] {
  return state.attachments.value[sessionId] ?? [];
}

// Hand what was typed before the id arrived to the session that
// materialised, appended after anything that session already holds
// (a draft restored from storage is older than what was just typed).
function adoptPendingDraft(state: DraftState, sessionId: string): void {
  const pendingText = getDraft(state.drafts.value, UNIDENTIFIED_SESSION);
  const pendingFiles = filesOf(state, UNIDENTIFIED_SESSION);
  if (pendingText === "" && pendingFiles.length === 0) return;
  const merged = mergeBufferedIntoDraft([getDraft(state.drafts.value, sessionId)], pendingText);
  state.commitDrafts(setDraft(state.drafts.value, sessionId, merged));
  state.setAttachments(sessionId, [...filesOf(state, sessionId), ...pendingFiles]);
}

function dropPendingDraft(state: DraftState): void {
  state.commitDrafts(omitSession(state.drafts.value, UNIDENTIFIED_SESSION));
  state.attachments.value = omitSession(state.attachments.value, UNIDENTIFIED_SESSION);
}

export function useChatDrafts(currentSessionId: Ref<string>): UseChatDrafts {
  const state = createDraftState();
  const { drafts, attachments, commitDrafts, setAttachments } = state;
  // Only the very first session takes over the unidentified draft. Later
  // returns to /chat must not resurrect a stray entry as someone else's.
  let awaitingFirstSession = true;

  watch(currentSessionId, (sessionId) => {
    if (sessionId === UNIDENTIFIED_SESSION) return;
    if (awaitingFirstSession) adoptPendingDraft(state, sessionId);
    awaitingFirstSession = false;
    dropPendingDraft(state);
  });

  const userInput = computed<string>({
    get: () => getDraft(drafts.value, currentSessionId.value),
    set: (text) => commitDrafts(setDraft(drafts.value, currentSessionId.value, text)),
  });

  const pastedFiles = computed<PastedFile[]>({
    get: () => attachments.value[currentSessionId.value] ?? [],
    set: (files) => setAttachments(currentSessionId.value, files),
  });

  function restoreDraft(sessionId: string, text: string, files: PastedFile[]): void {
    const merged = mergeBufferedIntoDraft([text], getDraft(drafts.value, sessionId));
    commitDrafts(setDraft(drafts.value, sessionId, merged));
    setAttachments(sessionId, [...files, ...filesOf(state, sessionId)]);
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
