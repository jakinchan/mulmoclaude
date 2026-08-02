// The shape a user turn's attachments take on the client: in the session
// jsonl, on the SSE broadcast, and inside a text-response result.
//
// Mirrors `AttachedFile` on the server (server/agent/messageDecorate.ts) —
// same two fields, produced from the same `Attachment`, separated only by
// the HTTP boundary between them.

/** One file the user attached to a turn. `path`'s basename is a
 *  collision-proof hex id, so `filename` — the name the file had on the
 *  user's machine — is the only thing that makes a chip readable (#2308).
 *  Absent for a file the user selected rather than uploaded, and for every
 *  turn recorded before #2308 shipped. */
export interface AttachmentEntry {
  path: string;
  filename?: string | undefined;
}

/** What a stored or broadcast `attachments` array may hold. Turns recorded
 *  before #2308 wrote bare path strings, and those sessions are still read
 *  back today — run anything from this field through `normalizeAttachments`
 *  rather than indexing it directly. */
export type PersistedAttachment = string | AttachmentEntry;
