// Workspace-injected wiki read-engine — the filesystem layer that feeds
// the pure helpers in `@mulmoclaude/core/wiki`. Shared by every host so
// the two apps reading the same `data/wiki/` can't disagree on slug
// resolution, graph edges, or lint findings. Mirrors the bodies that
// previously lived in MulmoClaude's `server/api/routes/wiki.ts`; the
// hosts keep only their HTTP response shaping on top.
//
// The read/write WRITE side (writeWikiPage / snapshots) stays host-side
// until a host needs it shared.

import path from "node:path";
import { parseWikiLink } from "../link.js";
import { wikiSlugify } from "../slug.js";
import { type WikiPageEntry, parseIndexEntries } from "../index-parse.js";
import { findBrokenLinksInPage, findMissingFiles, findOrphanPages, findTagDrift } from "../lint.js";
import { type WikiGraph, buildWikiGraph } from "../graph.js";
import { readTextSafe, readTextSafeSync } from "./fs.js";
import { getPageIndex } from "./pageIndex.js";
import { parseFrontmatterTags } from "./frontmatter.js";
import { wikiDirs } from "./paths.js";

// Below this length the fuzzy `includes` step is skipped — CJK /
// emoji-only / very-short page names slugify down to a short noise
// tail that partial-matches almost anything; the index.md title-match
// fallback still handles the legitimate non-ASCII case (#1194).
const MIN_FUZZY_SLUG_LEN = 6;

function readFileOrEmpty(absPath: string): string {
  return readTextSafeSync(absPath) ?? "";
}

/** Walk every indexed slug for an `includes`-style match. Returns the
 *  single best candidate, or null when the slug is too short OR several
 *  candidates tie at the top score (ambiguous → defer to the caller's
 *  title-match fallback). Score = min/max length, decoupled from Map
 *  iteration order so resolution is deterministic across hosts. */
export function pickFuzzyMatch(slug: string, slugs: ReadonlyMap<string, string>): string | null {
  if (slug.length < MIN_FUZZY_SLUG_LEN) return null;
  let bestFile: string | null = null;
  let bestScore = 0;
  let bestIsTied = false;
  for (const [key, file] of slugs) {
    if (!slug.includes(key) && !key.includes(slug)) continue;
    const shorter = Math.min(slug.length, key.length);
    const longer = Math.max(slug.length, key.length);
    const score = shorter / longer;
    if (score > bestScore) {
      bestScore = score;
      bestFile = file;
      bestIsTied = false;
    } else if (score === bestScore) {
      bestIsTied = true;
    }
  }
  return bestIsTied ? null : bestFile;
}

/** Resolve a page name to an absolute `.md` path: exact slug → fuzzy →
 *  index-title fallback (for non-ASCII names that slugify to empty).
 *  `pageName` may carry the `[[target|display]]` form; `parseWikiLink`
 *  strips the display half so the lookup uses just the target. */
export async function resolvePagePath(workspace: string, pageName: string): Promise<string | null> {
  const { pagesDir, indexFile } = wikiDirs(workspace);
  const { slugs } = await getPageIndex(pagesDir);
  if (slugs.size === 0) return null;

  const { target } = parseWikiLink(pageName);
  const slug = wikiSlugify(target);

  if (slug.length > 0) {
    const exact = slugs.get(slug);
    if (exact) return path.join(pagesDir, exact);
    const fuzzy = pickFuzzyMatch(slug, slugs);
    if (fuzzy) return path.join(pagesDir, fuzzy);
  }

  const entries = parseIndexEntries(readFileOrEmpty(indexFile));
  const titleMatch = entries.find((entry) => entry.title === target);
  if (titleMatch) {
    const file = slugs.get(titleMatch.slug);
    if (file) return path.join(pagesDir, file);
  }
  return null;
}

/** Raw `index.md` content + its parsed entries. */
export function readWikiIndex(workspace: string): { content: string; entries: WikiPageEntry[] } {
  const content = readFileOrEmpty(wikiDirs(workspace).indexFile);
  return { content, entries: parseIndexEntries(content) };
}

/** Raw `log.md` content (empty string if absent). */
export function readWikiLog(workspace: string): string {
  return readFileOrEmpty(wikiDirs(workspace).logFile);
}

export interface WikiPageRead {
  /** Absolute path of the resolved file, or null when nothing matched. */
  filePath: string | null;
  /** File body (empty when missing OR when the file is an empty placeholder). */
  content: string;
  /** True iff a page file resolved (distinct from empty content). */
  exists: boolean;
  /** Title to display — the resolved filename stem, or the raw pageName. */
  resolvedTitle: string;
}

/** Resolve + read a page. Distinguishes missing (`exists: false`) from
 *  empty-but-present (`exists: true`, `content: ""`). */
export async function readWikiPage(workspace: string, pageName: string): Promise<WikiPageRead> {
  const filePath = await resolvePagePath(workspace, pageName);
  const content = filePath ? readFileOrEmpty(filePath) : "";
  const resolvedTitle = filePath ? path.basename(filePath, ".md") : pageName;
  return { filePath, content, exists: Boolean(filePath), resolvedTitle };
}

/** Page body, or "" when the file vanished between indexing and reading. */
async function readPageBody(pagesDir: string, fileName: string): Promise<string> {
  return (await readTextSafe(path.join(pagesDir, fileName))) ?? "";
}

/** Read every page + the index and build the page→page link graph.
 *  No cache: the graph is requested explicitly and a content edit does
 *  not advance the pagesDir mtime the page index caches on. */
export async function loadWikiGraph(workspace: string): Promise<WikiGraph> {
  const { pagesDir, indexFile } = wikiDirs(workspace);
  const { slugs } = await getPageIndex(pagesDir);
  const pages = await Promise.all([...slugs.entries()].map(async ([slug, fileName]) => ({ slug, content: await readPageBody(pagesDir, fileName) })));
  const indexEntries = parseIndexEntries(readFileOrEmpty(indexFile));
  return buildWikiGraph(pages, indexEntries);
}

/** Run every lint rule over the on-disk wiki, returning issue strings. */
export async function collectLintIssues(workspace: string): Promise<string[]> {
  const { pagesDir, indexFile } = wikiDirs(workspace);
  const { slugs } = await getPageIndex(pagesDir);
  if (slugs.size === 0) {
    return ["- Wiki `pages/` directory does not exist yet. Start ingesting sources."];
  }
  const pageEntries = parseIndexEntries(readFileOrEmpty(indexFile));
  const indexedSlugs = new Set(pageEntries.map((entry) => entry.slug));
  const fileSlugs = new Set(slugs.keys());
  const bodies = await Promise.all([...slugs.values()].map(async (fileName) => ({ fileName, content: await readPageBody(pagesDir, fileName) })));

  const issues: string[] = [];
  issues.push(...findOrphanPages(fileSlugs, indexedSlugs));
  issues.push(...findMissingFiles(pageEntries, fileSlugs));
  const frontmatterTagsBySlug = new Map<string, string[]>();
  for (const { fileName, content } of bodies) {
    issues.push(...findBrokenLinksInPage(fileName, content, fileSlugs));
    // Lowercase the key so a `MyPage.md` filename matches an
    // `entry.slug` of `mypage`; `findTagDrift` lowercases the lookup.
    frontmatterTagsBySlug.set(fileName.replace(/\.md$/i, "").toLowerCase(), parseFrontmatterTags(content));
  }
  issues.push(...findTagDrift(pageEntries, frontmatterTagsBySlug));
  return issues;
}
