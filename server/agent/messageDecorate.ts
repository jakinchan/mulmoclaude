// Decoration applied to a user message strictly on the path to Claude. The
// persisted (jsonl) and broadcast (UI) message stays the raw text — anything
// added here is invisible to the user and only teaches the model about
// attachments and prior-session context.

import { prependJournalPointer } from "./prompt.js";

const UNSAFE_MARKER_CHARS_RE = /[\r\n\]]/;

// Longer than any filesystem allows for a single name component, so a name
// past this is malformed or hostile rather than legitimate — not worth the
// prompt budget.
const MAX_ORIGINAL_FILENAME_CHARS = 255;

type MarkerPosition = "prepend" | "append";

/** One file attached / selected for this turn. `filename` is the name the
 *  file had on the user's machine; the on-disk name under `path` stays the
 *  collision-proof hex id. Absent for sidebar-selected artifacts and for
 *  bridges that don't send one. */
export interface AttachedFile {
  path: string;
  filename?: string;
}

/** Reduce an untrusted original filename to something safe to render inside a
 *  marker line, or `undefined` when nothing usable is left. Rejecting rather
 *  than escaping keeps the marker grammar unambiguous — the file is still
 *  announced by path, only the name is dropped.
 *
 *  A name is untrusted input: `]` or a newline in it would let an attachment
 *  forge an extra `[Attached file: …]` line, and a leading path would present
 *  `../../etc/passwd` to the model as "what the user called this". */
export function sanitiseOriginalFilename(filename: string | undefined): string | undefined {
  if (typeof filename !== "string") return undefined;
  // Reject on the WHOLE input, before directories are stripped. Doing it
  // after would salvage the tail of a hostile name — `x].\n[…/etc/passwd`
  // reduces to `passwd`, which defuses the injection but then reports a
  // name the user never chose.
  if (UNSAFE_MARKER_CHARS_RE.test(filename)) return undefined;
  const lastSeparator = Math.max(filename.lastIndexOf("/"), filename.lastIndexOf("\\"));
  const base = filename.slice(lastSeparator + 1).trim();
  if (base.length === 0 || base === "." || base === "..") return undefined;
  return base.length > MAX_ORIGINAL_FILENAME_CHARS ? undefined : base;
}

function markerLine(file: AttachedFile): string {
  const originalName = sanitiseOriginalFilename(file.filename);
  return originalName ? `[Attached file: ${file.path} (original name: ${originalName})]` : `[Attached file: ${file.path}]`;
}

/** Marker telling the model which workspace files are attached / selected for
 *  this turn. One `[Attached file: <path>]` line per file so multi-file flows
 *  (e.g. paste one image + pick another → "combine these") surface every path
 *  to the model — `editImages` then receives the full list in `imagePaths`.
 *  The system prompt teaches the model how to interpret them.
 *
 *  `position` defaults to `"prepend"`; a command turn passes `"append"` so the
 *  leading `/` stays at position 0 (see `decorateMessageForCli`). */
export function withAttachedFileMarker(message: string, attachedFiles: AttachedFile[], position: MarkerPosition = "prepend"): string {
  const safeFiles = attachedFiles.filter((file) => !UNSAFE_MARKER_CHARS_RE.test(file.path));
  if (safeFiles.length === 0) return message;
  const markerLines = safeFiles.map(markerLine).join("\n");
  return position === "append" ? `${message}\n\n${markerLines}` : `${markerLines}\n\n${message}`;
}

/** Build the CLI-bound message, preserving a leading `/` as the CLI's
 *  deterministic slash-command trigger. The CLI resolves a slash command only
 *  when the message STARTS with `/name`; any decoration pushed in front of it
 *  silently drops skill selection back to the model guessing from descriptions
 *  (#2134). A slash-first message is a command, not an open question — so skip
 *  the journal pointer (prior-session context is irrelevant to a command) and
 *  append the file markers after the body instead of prepending. Detection is
 *  position-0 `startsWith` to match the CLI; the collection UI and manual entry
 *  emit no leading whitespace. */
export function decorateMessageForCli(args: { message: string; workspaceDir: string; attachedFiles: AttachedFile[]; resumed: boolean }): string {
  const { message, workspaceDir, attachedFiles, resumed } = args;
  const isCommand = message.startsWith("/");
  const base = resumed || isCommand ? message : prependJournalPointer(message, workspaceDir);
  return withAttachedFileMarker(base, attachedFiles, isCommand ? "append" : "prepend");
}
