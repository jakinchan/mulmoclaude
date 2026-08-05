// Per-session chat input drafts (#2811). Pure helpers over the map the
// composable keeps in sessionStorage, so the "when does a draft die"
// rules are testable without a browser.

export const CHAT_DRAFTS_STORAGE_KEY = "chat_drafts_by_session";

export type DraftMap = Record<string, string>;

// Cap on how many sessions keep unsent state — text and attachments
// alike, so neither half can grow without bound. Insertion order is the
// LRU order (putSession re-inserts the touched session last), so the
// oldest entries fall off the front once the cap is hit.
const MAX_DRAFT_SESSIONS = 20;

export function parseStoredDrafts(raw: string | null): DraftMap {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(isDraftEntry));
  } catch {
    return {};
  }
}

// Drafts under an empty session id are in-memory only: persisting them
// would replay someone else's text into the next session that boots
// before its id is known.
export function serializeDrafts(drafts: DraftMap): string {
  return JSON.stringify(Object.fromEntries(Object.entries(drafts).filter(([sessionId]) => sessionId !== "")));
}

export function getDraft(drafts: DraftMap, sessionId: string): string {
  return drafts[sessionId] ?? "";
}

// Whitespace-only text drops the key so a stray space never counts as a
// draft; the stored text itself is kept verbatim (a slash command like
// `/skill ` needs its trailing space).
export function setDraft(drafts: DraftMap, sessionId: string, text: string): DraftMap {
  return text.trim() === "" ? omitSession(drafts, sessionId) : putSession(drafts, sessionId, text);
}

// Write one session's entry and re-insert it last, so insertion order
// stays the LRU order and the cap drops whoever has been idle longest.
// Shared by the draft text and the attachment lists — the two halves of
// a composer are capped together or the uncapped one grows forever.
export function putSession<T>(bySession: Record<string, T>, sessionId: string, value: T): Record<string, T> {
  const entries: [string, T][] = [...Object.entries(omitSession(bySession, sessionId)), [sessionId, value]];
  return Object.fromEntries(entries.slice(-MAX_DRAFT_SESSIONS));
}

// Also used for the memory-only attachment map, which is keyed the same
// way — one drop path means one place to forget a dead session.
export function omitSession<T>(bySession: Record<string, T>, sessionId: string): Record<string, T> {
  if (!(sessionId in bySession)) return bySession;
  return Object.fromEntries(Object.entries(bySession).filter(([storedId]) => storedId !== sessionId));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDraftEntry(entry: [string, unknown]): entry is [string, string] {
  const [sessionId, text] = entry;
  return sessionId !== "" && typeof text === "string" && text.trim() !== "";
}
