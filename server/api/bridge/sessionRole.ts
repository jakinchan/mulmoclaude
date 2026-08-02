// Session-id-safe wrapper for the `getSessionRole` DI the chat-service
// package exposes to the HTTP `/connect` route. Extracted from server/index.ts
// so the hostile-input + IO-error semantics can be pinned in a focused test
// (codex review on #1895).

/** Character-class + length bound. `\w` covers UUIDs (`randomUUID()`)
 *  and the transport-chat-timestamp triples chat-state emits for fresh
 *  bridge chats; `.` and `-` cover the separator variants used in the
 *  wild. `/` and `\` are excluded, so single-dot / single-hyphen
 *  separators are fine but a whole-string `..` slips through this
 *  check alone — the `isSafeSessionId` wrapper below rejects `..`
 *  sequences as a second gate. Exported for direct unit testing. */
export const SAFE_SESSION_ID_RE = /^[\w.-]{1,200}$/;

/** True iff `sessionId` is safe to hand to `readSessionMeta`. Combines
 *  the character-class regex with an explicit `..` rejection —
 *  otherwise a literal `..` (or `foo..bar`) would pass the class check
 *  and let `path.join(dir, "..json")` escape the CHAT dir on any
 *  reader that trusts its input (`readTextUnder` is documented as
 *  "internal fixed paths only, no traversal guard"). */
export function isSafeSessionId(sessionId: string): boolean {
  if (!SAFE_SESSION_ID_RE.test(sessionId)) return false;
  if (sessionId.includes("..")) return false;
  return true;
}

/** Read one session's `roleId` for the HTTP `/connect` role-resolver
 *  path. The `sessionId` MUST NOT be handed to the underlying reader
 *  unvalidated — see `readTextUnder`'s "internal fixed paths only, no
 *  `..` traversal guard" contract. Returns null in three cases, all
 *  treated by the route as "preserve the previous role":
 *
 *    1. `sessionId` fails the safe-id shape check (hostile input).
 *    2. Metadata is absent or corrupt (the reader itself returns null).
 *    3. Any unexpected IO error (permission denied, disk error). Left
 *       unwrapped, `rethrowUnexpected` inside the reader would surface
 *       as a 500 from the `/connect` handler — that's a hostile-input
 *       surface too, so degrade to null instead. */
export async function resolveBridgeSessionRole(sessionId: string, readMeta: (id: string) => Promise<{ roleId?: string | undefined } | null>): Promise<string | null> {
  if (!isSafeSessionId(sessionId)) return null;
  try {
    const meta = await readMeta(sessionId);
    return meta?.roleId ?? null;
  } catch {
    return null;
  }
}
