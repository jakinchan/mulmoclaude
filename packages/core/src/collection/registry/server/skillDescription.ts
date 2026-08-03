// `description:` reader for a SKILL.md YAML frontmatter envelope.
//
// The host (MulmoClaude) parses SKILL.md frontmatter with js-yaml, but
// @mulmoclaude/core deliberately carries no YAML dependency and export only needs
// the single `description` scalar for the registry meta.json (best-effort — it
// defaults to "" when absent). Rather than pull in a YAML parser we scan the
// envelope for the first `description:` line and resolve the common YAML scalar
// forms so exported descriptions match what the host produced:
//   - double-quoted ("…")  → unescaped, trailing inline comment ignored
//   - single-quoted ('…')  → '' → ', trailing inline comment ignored
//   - plain (unquoted)     → trailing " #comment" stripped (YAML comment rule)
// Block scalars (`description: |`) are NOT expanded — they yield "" (skill
// descriptions are single-line in practice).

const FENCE = "---";
const KEY = "description:";
const BLOCK_SCALAR_INDICATORS = new Set(["|", ">", "|-", ">-", "|+", ">+"]);

const isYamlSpace = (char: string | undefined): boolean => char === " " || char === "\t";

// After a closing quote, YAML allows only whitespace and an optional "#" comment.
// Anything else (e.g. `"foo" bar`) is malformed — js-yaml would throw, so we
// reject (→ null → "") rather than silently truncate.
const isOnlyTrailingComment = (rest: string): boolean => {
  const trimmed = rest.trimStart();
  return trimmed === "" || trimmed.startsWith("#");
};

// Escapes a description realistically carries inside a double-quoted scalar;
// any other `\x` collapses to the literal `x`.
const DOUBLE_QUOTE_ESCAPES: Record<string, string> = { n: "\n", t: "\t" };
const unescapeDoubleQuote = (next: string): string => DOUBLE_QUOTE_ESCAPES[next] ?? next;

// The text a two-character escape pair at `index` stands for, or null when the
// pair isn't an escape — which makes `index` an ordinary character (possibly the
// closing quote). Both YAML quoted forms differ only in this one rule.
type EscapeReader = (value: string, index: number) => string | null;

// Walk a quoted scalar from just past its opening quote to the closing one.
// Returns null for a malformed scalar (no closing quote, or trailing non-comment
// text) so the caller degrades to "" — matching the host's js-yaml behavior.
function scanQuotedScalar(value: string, quote: string, readEscape: EscapeReader): string | null {
  const out: string[] = [];
  // `charAt` (not `value[i]`) so the scanner reads a plain `string`: every
  // index below is in range, and an out-of-range read would be "" either way.
  for (let i = 1; i < value.length; i += 1) {
    const escaped = readEscape(value, i);
    if (escaped !== null) {
      out.push(escaped);
      i += 1;
      continue;
    }
    const char = value.charAt(i);
    if (char === quote) return isOnlyTrailingComment(value.slice(i + 1)) ? out.join("") : null;
    out.push(char);
  }
  return null; // unterminated
}

// A trailing backslash has nothing to escape, so it stays a literal backslash.
const readDoubleQuoteEscape: EscapeReader = (value, index) =>
  value.charAt(index) === "\\" && index + 1 < value.length ? unescapeDoubleQuote(value.charAt(index + 1)) : null;

// The only escape in a single-quoted scalar is a doubled quote ('').
const readSingleQuoteEscape: EscapeReader = (value, index) => (value.charAt(index) === "'" && value[index + 1] === "'" ? "'" : null);

function parseDoubleQuoted(value: string): string | null {
  return scanQuotedScalar(value, '"', readDoubleQuoteEscape);
}

function parseSingleQuoted(value: string): string | null {
  return scanQuotedScalar(value, "'", readSingleQuoteEscape);
}

// Plain scalar: a "#" preceded by whitespace (or at the start) begins a YAML
// comment; "#" not preceded by whitespace (e.g. "C#") is literal.
function stripPlainComment(value: string): string {
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === "#" && (i === 0 || isYamlSpace(value[i - 1]))) return value.slice(0, i);
  }
  return value;
}

/** Extract the frontmatter `description` from raw SKILL.md text. Returns "" when
 *  there's no `---` envelope, no `description:` key, or the value is a block
 *  scalar indicator. */
export function parseSkillDescription(raw: string): string {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== FENCE) return "";
  for (const line of lines.slice(1)) {
    if (line.trim() === FENCE) return ""; // end of envelope, key not found
    if (!line.startsWith(KEY)) continue;
    return resolveScalar(line.slice(KEY.length).trim());
  }
  return "";
}

/** Resolve the raw text after `description:` to its scalar value. */
function resolveScalar(value: string): string {
  if (value === "" || BLOCK_SCALAR_INDICATORS.has(value)) return "";
  if (value.startsWith('"')) return parseDoubleQuoted(value) ?? "";
  if (value.startsWith("'")) return parseSingleQuoted(value) ?? "";
  return stripPlainComment(value).trim();
}
