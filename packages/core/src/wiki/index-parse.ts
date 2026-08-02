// Pure parsers for `data/wiki/index.md` content. Used by:
//   - server/api/routes/wiki.ts — page resolver + lint
//   - frontend lint preview (future) — same parser, no fork
//
// All exports here are pure string ops; no `node:*` imports allowed.
// If a future caller needs to walk the filesystem, that wrapper goes
// under `@mulmoclaude/core/wiki/server` (today only `server/paths.ts`
// touches `node:path`; nothing here touches disk).

import { parseWikiLink } from "./link.js";
import { wikiSlugify } from "./slug.js";

export interface WikiPageEntry {
  title: string;
  slug: string;
  description: string;
  tags: string[];
}

// ── Patterns ──────────────────────────────────────────────────
// Bullet patterns live here (not server/utils/regex.ts) because the
// index parser is the only consumer and the regexes are part of the
// public surface that callers may want to reason about in tests.
// Linear in line length: every `[^x]+` runs over a fixed exclusion
// set with a hard delimiter; the optional summary group's `(.*)` is
// a single greedy run with no nested overlap.

// eslint-disable-next-line security/detect-unsafe-regex -- bullet-link parser; bounded captures with hard delimiters
export const BULLET_LINK_PATTERN = /^[-*]\s+\[([^\]]+)\]\(([^)]*)\)(?:\s*[—–-]\s*(.*))?/;
// eslint-disable-next-line security/detect-unsafe-regex -- same shape as BULLET_LINK_PATTERN
export const BULLET_WIKI_LINK_PATTERN = /^[-*]\s+\[\[([^\]]+)\]\](?:\s*[—–-]\s*(.*))?/;

const TABLE_SEPARATOR_PATTERN = /^\|[\s|:-]+\|$/;

// Unicode-aware tag body: any letter or number in any script (so
// Japanese / Chinese / Korean tags like `#クラウド` or `#可視化` work),
// plus `-` and `_` as internal joiners. First char is a letter or
// number only — no leading punctuation.
const HASHTAG_PATTERN = /(?:^|\s)#([\p{L}\p{N}][\p{L}\p{N}_-]*)/gu;

// ── Tag extraction ────────────────────────────────────────────

/** Extract `#tag` tokens from a bullet description, returning the
 *  stripped description and a sorted, deduped, lowercased tag list.
 *  Only matches at word boundaries so mid-word `#` (e.g. anchor
 *  URLs) is left alone. */
export function extractHashTags(text: string): { description: string; tags: string[] } {
  HASHTAG_PATTERN.lastIndex = 0;
  const tags = [...text.matchAll(HASHTAG_PATTERN)].flatMap(([, tag]) => (tag ? [tag.toLowerCase()] : []));
  const description = text.replace(HASHTAG_PATTERN, "").replace(/\s+/g, " ").trim();
  const deduped = [...new Set(tags)].sort();
  return { description, tags: deduped };
}

/** Split a table Tags cell — tolerates comma, whitespace, or `#`
 *  prefixes. Empty cell yields an empty list. */
export function parseTagsCell(cell: string): string[] {
  const tokens = cell
    .split(/[,\s]+/)
    .map((token) => token.trim().replace(/^#/, "").toLowerCase())
    .filter((token) => token.length > 0);
  return [...new Set(tokens)].sort();
}

// ── Table parser ──────────────────────────────────────────────

/** Map header cell names → column indices, case- and whitespace-
 *  tolerant. Used by the row parser to locate the Tags column (and
 *  any other named column) without assuming a fixed position, so
 *  older 3- and 4-column tables keep working. */
export function buildTableColumnMap(headerRow: string): Map<string, number> {
  const cells = headerRow
    .split("|")
    .slice(1, -1)
    // Mirror parseTableRow's cell-normalising: strip the surrounding
    // backticks that commonly wrap cell values in wiki tables.
    // Without this, a `| \`tags\` |` header maps to the key "`tags`"
    // and the subsequent `columnMap.get("tags")` lookup silently
    // misses the column, falling back to `tags: []`.
    .map((cell) => cell.trim().replace(/^`|`$/g, "").toLowerCase());
  const map = new Map<string, number>();
  cells.forEach((cell, i) => {
    if (cell) map.set(cell, i);
  });
  return map;
}

interface TableColumnIndices {
  slug: number;
  title: number;
  summary: number;
  /** Undefined when the table has no `tags` column — caller skips
   *  the tags lookup entirely and the row gets `tags: []`. */
  tags: number | undefined;
}

/** Resolve the per-column indices the row parser needs. Falls back
 *  to positional defaults (0/1/2) when the table has no header map.
 *  "summary" is the canonical column name; "description" is accepted
 *  as a legacy alias used by older fixtures. */
function resolveTableColumnIndices(columnMap: Map<string, number> | null): TableColumnIndices {
  return {
    slug: columnMap?.get("slug") ?? 0,
    title: columnMap?.get("title") ?? 1,
    summary: columnMap?.get("summary") ?? columnMap?.get("description") ?? 2,
    tags: columnMap?.get("tags"),
  };
}

function parseTableRow(trimmed: string, columnMap: Map<string, number> | null): WikiPageEntry | null {
  const cols = trimmed
    .split("|")
    .slice(1, -1)
    .map((column) => column.trim().replace(/^`|`$/g, ""));
  if (cols.length < 2) return null;

  const idx = resolveTableColumnIndices(columnMap);
  const slug = cols[idx.slug] ?? "";
  const title = cols[idx.title] || slug;
  if (!slug || !title) return null;

  const description = cols[idx.summary] ?? "";
  const tags = idx.tags !== undefined ? parseTagsCell(cols[idx.tags] ?? "") : [];
  return { title, slug, description, tags };
}

// ── Bullet-row parsers ────────────────────────────────────────

/** Extract the slug segment from a bullet link's href. Accepts the
 *  canonical `pages/<slug>.md`, a bare `<slug>.md`, or just `<slug>`
 *  — the three forms produced by different historical writers of
 *  index.md. Returns "" for hrefs that don't look like a wiki page
 *  reference (e.g. `https://example.com`) so the caller can fall
 *  back to title-based slugification. */
export function extractSlugFromBulletHref(rawHref: string): string {
  const href = rawHref.trim();
  if (!href) return "";
  if (/^[a-z]+:\/\//i.test(href)) return "";
  const lastSegment = href.split("/").pop() ?? href;
  return lastSegment.replace(/\.md$/i, "");
}

function parseBulletLinkRow(trimmed: string): WikiPageEntry | null {
  const match = BULLET_LINK_PATTERN.exec(trimmed);
  if (!match) return null;
  const title = match[1]?.trim() ?? "";
  const href = match[2] ?? "";
  const raw = match[3]?.trim() ?? "";
  const { description, tags } = extractHashTags(raw);
  // Prefer the slug embedded in the href so non-ASCII titles keep
  // a navigable slug. Fall back to slugifying the title only when
  // the href has no recognisable slug (rare — usually means the
  // author put an external URL here).
  const slug = extractSlugFromBulletHref(href) || wikiSlugify(title);
  return { title, slug, description, tags };
}

function parseBulletWikiLinkRow(trimmed: string): WikiPageEntry | null {
  const match = BULLET_WIKI_LINK_PATTERN.exec(trimmed);
  if (!match) return null;
  // Split `[[target|display]]` so the bullet entry's slug derives
  // from the TARGET (which is already a slug-shaped identifier
  // when the author wrote the alias form) and the title shows
  // the DISPLAY half. Pre-#1297 the parser slugified the full
  // `target|display` body, which collapses `|` to "" and
  // produces a wrong slug — Codex review on PR #1312.
  const { target, display } = parseWikiLink(match[1] ?? "");
  const title = (display || target).trim();
  const slug = target ? wikiSlugify(target) : wikiSlugify(title);
  const raw = match[2]?.trim() ?? "";
  const { description, tags } = extractHashTags(raw);
  return { title, slug, description, tags };
}

// ── Top-level parser ──────────────────────────────────────────

/** Parse entries from index.md. Supports three formats:
 *  1. Table: `| slug | Title | Summary | (Tags) |`
 *  2. Bullet link: `- [Title](pages/slug.md) — description`
 *  3. Wiki link: `- [[Title]] — description`
 *
 *  Returns entries in source order. Any unrecognised line is
 *  silently skipped — index.md is freeform markdown otherwise. */
export function parseIndexEntries(content: string): WikiPageEntry[] {
  const entries: WikiPageEntry[] = [];
  let inTable = false;
  let columnMap: Map<string, number> | null = null;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();

    if (trimmed.startsWith("|")) {
      if (TABLE_SEPARATOR_PATTERN.test(trimmed)) {
        inTable = true;
        continue;
      }
      if (!inTable) {
        // First `|`-line before the separator is the header. Capture
        // the column map so parseTableRow can locate the Tags
        // column (if any) by name rather than position.
        columnMap = buildTableColumnMap(trimmed);
        inTable = true;
        continue;
      }
      const entry = parseTableRow(trimmed, columnMap);
      if (entry) entries.push(entry);
      continue;
    }

    inTable = false;
    columnMap = null;

    const bullet = parseBulletLinkRow(trimmed) ?? parseBulletWikiLinkRow(trimmed);
    if (bullet) entries.push(bullet);
  }
  return entries;
}
