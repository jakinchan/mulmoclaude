// Pure readers over the parsed `~/.config/mulmo/config.json` document. No IO
// here so the validation rules are unit-testable without a filesystem, and so a
// host that already has the document in memory can reuse them.
//
// Every reader is TOLERANT by design: this file is hand-edited (there is no UI
// for it yet), and a typo in one key must not take out the app or the other
// keys. An unusable value reads as "not configured" and the caller applies its
// own default.

/** A user-supplied regular expression source is compiled and then run against
 *  whole documents on every keystroke. Length is the cheap, honest guard: it
 *  bounds how baroque — and so how catastrophically backtracking — the pattern
 *  can be, without pretending to be a ReDoS analyser. The file is machine-local
 *  and hand-written, so the threat model is "the user's own typo", not attack. */
export const MAX_BOOKMARK_PATTERN_LENGTH = 200;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** True when `source` compiles as a regular expression. `new RegExp` is the
 *  only real validator — there is no cheaper way to reject `"^([a-z"`. */
function compiles(source: string): boolean {
  try {
    return RegExp(source) instanceof RegExp;
  } catch {
    return false;
  }
}

/**
 * `documentBookmarks.pattern` — the regex whose matches the markdown source
 * editor marks in its left-edge rail. Returns the raw SOURCE string (not a
 * compiled RegExp): the value crosses a JSON dispatch hop to the browser, which
 * compiles it there.
 *
 * Returns null — meaning "not configured, use your default" — for a missing
 * file, a missing key, a non-string, an empty string, an over-long string, or
 * one that does not compile.
 */
export function readDocumentBookmarkPattern(config: unknown): string | null {
  if (!isRecord(config)) return null;
  const { documentBookmarks } = config;
  if (!isRecord(documentBookmarks)) return null;
  const { pattern } = documentBookmarks;
  if (typeof pattern !== "string") return null;
  if (pattern.length === 0 || pattern.length > MAX_BOOKMARK_PATTERN_LENGTH) return null;
  return compiles(pattern) ? pattern : null;
}
