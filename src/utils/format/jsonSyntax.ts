// Tiny regex-based JSON tokenizer used by the Files-mode preview for
// syntax coloring. Keeps itself dependency-free so it can be reused
// and unit-tested without pulling in Vue or Tailwind.

export type JsonTokenType = "key" | "string" | "number" | "keyword" | "punct" | "whitespace";

export interface JsonToken {
  type: JsonTokenType;
  value: string;
}

// Tailwind class for each token type. Kept alongside the tokenizer so
// callers that want colored output can just import and use it directly.
export const JSON_TOKEN_CLASS: Record<JsonTokenType, string> = {
  key: "text-blue-700",
  string: "text-green-700",
  number: "text-orange-600",
  keyword: "text-purple-700",
  punct: "text-gray-500",
  whitespace: "",
};

// Individually simple patterns combined by `nextToken` below. Keeping
// them separate avoids a single combined regex that trips
// sonarjs/regex-complexity and is easier to reason about.
const STRING_RE = /^"(?:[^"\\]|\\.)*"/;
const KEYWORD_RE = /^(?:true|false|null)\b/;
// Bounded JSON number parser — each `\d+` runs over a digits-only
// class with hard delimiters (`.`, `e`, `E`, `+`, `-`) between
// segments. Linear in input length; safe-regex flags the optional
// groups generically.
// eslint-disable-next-line security/detect-unsafe-regex -- bounded JSON number parser, no nested-quantifier overlap
const NUMBER_RE = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/;
const WS_RE = /^\s+/;
const PUNCT_RE = /^[{}[\]:,]/;

const MATCHERS: { type: JsonTokenType; pattern: RegExp }[] = [
  { type: "string", pattern: STRING_RE },
  { type: "keyword", pattern: KEYWORD_RE },
  { type: "number", pattern: NUMBER_RE },
  { type: "whitespace", pattern: WS_RE },
  { type: "punct", pattern: PUNCT_RE },
];

function nextToken(slice: string): JsonToken | null {
  for (const { type, pattern } of MATCHERS) {
    const match = pattern.exec(slice);
    if (match) return { type, value: match[0] };
  }
  return null;
}

export function tokenizeJson(raw: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  let pos = 0;
  while (pos < raw.length) {
    const slice = raw.slice(pos);
    const token = nextToken(slice);
    if (!token) {
      // Unknown char (syntax error / stray bytes). Emit verbatim so
      // the user still sees it, then advance one character.
      tokens.push({ type: "punct", value: slice.slice(0, 1) });
      pos++;
      continue;
    }
    tokens.push(token);
    pos += token.value.length;
  }
  return markKeys(tokens);
}

const isColon = (token: JsonToken | undefined): boolean => token?.type === "punct" && token.value === ":";

// WS_RE is greedy, so a whitespace run is always a single token and one
// step of lookahead is enough to skip it.
const afterWhitespace = (tokens: JsonToken[], index: number): JsonToken | undefined => {
  const next = tokens[index + 1];
  return next?.type === "whitespace" ? tokens[index + 2] : next;
};

// A string that precedes ":" (skipping whitespace) is an object key.
function markKeys(tokens: JsonToken[]): JsonToken[] {
  return tokens.map((token, index) => (token.type === "string" && isColon(afterWhitespace(tokens, index)) ? { type: "key", value: token.value } : token));
}

// Pretty-print JSON with 2-space indentation, falling back to the raw
// source on parse error so the user can still read malformed files.
export function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export interface JsonlLine {
  tokens: JsonToken[];
  parseError: boolean;
}

// Tokenize a JSON Lines document: one JSON value per non-empty line.
// Each parseable line is pretty-printed before tokenization so the
// output shows a readable multi-line record per entry. Malformed
// lines are tokenized as-is with `parseError: true` so the caller
// can mark them visually.
export function tokenizeJsonl(raw: string): JsonlLine[] {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return lines.map((line) => {
    try {
      const pretty = JSON.stringify(JSON.parse(line), null, 2);
      return { tokens: tokenizeJson(pretty), parseError: false };
    } catch {
      return { tokens: tokenizeJson(line), parseError: true };
    }
  });
}
