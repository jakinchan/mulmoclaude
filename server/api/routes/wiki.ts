import { Router, Request, Response } from "express";
import path from "path";
import { workspacePath } from "../../workspace/paths.js";
import { writeWikiPage } from "../../workspace/wiki-pages/io.js";
import { badRequest, notFound } from "../../utils/httpError.js";
import { getOptionalStringQuery } from "../../utils/request.js";
import { API_ROUTES } from "../../../src/config/apiRoutes.js";
import { log } from "../../system/logger/index.js";
import { previewSnippet } from "../../utils/logPreview.js";
// Aliased because `buildPageResponseData` below declares a local
// string named `errorMessage`; importing the errors util under a
// different name avoids the no-shadow clash without renaming the
// long-standing local.
import { errorMessage as formatError } from "../../utils/errors.js";
// Pure wiki-text helpers (slug rules, lint formatting, types) live in
// `@mulmoclaude/core/wiki`; the workspace-injected fs read-engine
// (resolve / index / page / log / graph / lint) lives in
// `@mulmoclaude/core/wiki/server`, shared with MulmoTerminal. This
// route is the thin HTTP shell that shapes their output into the
// canvas response envelope.
import { wikiSlugify, formatLintReport, type WikiPageEntry, type WikiGraph } from "@mulmoclaude/core/wiki";
import { resolvePagePath, readWikiIndex, readWikiPage, readWikiLog, loadWikiGraph, collectLintIssues } from "@mulmoclaude/core/wiki/server";

const router = Router();

// Re-exports kept here for legacy callers that import wiki-text
// helpers via this route module (e.g. tests in
// `test/routes/test_wikiHelpers.ts`).
export { wikiSlugify, buildTableColumnMap, extractHashTags, extractSlugFromBulletHref, parseIndexEntries, parseTagsCell } from "@mulmoclaude/core/wiki";
export type { WikiPageEntry } from "@mulmoclaude/core/wiki";
export { findBrokenLinksInPage, findMissingFiles, findOrphanPages, findTagDrift, formatLintReport } from "@mulmoclaude/core/wiki";

// `resolvePagePath` / `pickFuzzyMatch` now live in
// `@mulmoclaude/core/wiki/server` (shared with MulmoTerminal). This
// route resolves pages through the imported `readWikiPage` /
// `resolvePagePath`.

router.get(API_ROUTES.wiki.base, async (req: Request, res: Response<WikiResponse | ErrorResponse>) => {
  const slug = getOptionalStringQuery(req, "slug");
  if (slug) {
    log.info("wiki", "GET page: start", { slugPreview: previewSnippet(slug) });
    try {
      const response = await buildPageResponse("page", slug);
      if (!response.data.pageExists) {
        log.warn("wiki", "GET page: not found", { slugPreview: previewSnippet(slug) });
      } else {
        log.info("wiki", "GET page: ok", { slugPreview: previewSnippet(slug), bytes: response.data.content.length });
      }
      res.json(response);
    } catch (err) {
      log.error("wiki", "GET page: threw", { slugPreview: previewSnippet(slug), error: formatError(err) });
      throw err;
    }
    return;
  }
  log.info("wiki", "GET index: start");
  const { content, entries: pageEntries } = readWikiIndex(workspacePath);
  log.info("wiki", "GET index: ok", { pages: pageEntries.length, bytes: content.length });
  res.json({
    data: { action: "index", title: "Wiki Index", content, pageEntries },
    message: content ? `Wiki index — ${pageEntries.length} page(s)` : "Wiki index is empty.",
    title: "Wiki Index",
    instructions: "The wiki index is now displayed on the canvas.",
    updating: true,
  });
});

interface WikiBody {
  action: string;
  pageName?: string;
  // `save` action only: full new file contents (frontmatter + body).
  content?: string;
}

interface WikiData {
  action: string;
  title: string;
  content: string;
  pageEntries?: WikiPageEntry[] | undefined;
  pageName?: string | undefined;
  pageExists?: boolean | undefined;
  error?: string | undefined;
  graph?: WikiGraph | undefined;
}

interface WikiResponse {
  data: WikiData;
  message: string;
  title: string;
  instructions: string;
  updating: boolean;
}

interface ErrorResponse {
  error: string;
}

function buildIndexResponse(action: string): WikiResponse {
  const { content, entries: pageEntries } = readWikiIndex(workspacePath);
  return {
    data: { action, title: "Wiki Index", content, pageEntries },
    message: content ? `Wiki index — ${pageEntries.length} page(s)` : "Wiki index is empty.",
    title: "Wiki Index",
    instructions: "The wiki index is now displayed on the canvas.",
    updating: true,
  };
}

// Pure branching helper extracted from buildPageResponse so the three
// states (missing / empty / has-content) can be pinned by unit tests
// without requiring a real filesystem. The I/O wrapper below supplies
// `exists`, `content`, and `resolvedTitle` from disk; this function
// builds the response shape — including the error / message /
// instructions distinctions that the GET and POST handlers share.
export function buildPageResponseData(args: { action: string; pageName: string; resolvedTitle: string; content: string; exists: boolean }): WikiResponse {
  const { action, pageName, resolvedTitle, content, exists } = args;
  const hasContent = Boolean(content);
  // Three states:
  //   1. !exists              → page file is missing entirely.
  //   2. exists && !hasContent → page file exists but is empty (e.g.,
  //                              zero-byte placeholder waiting to be filled).
  //   3. exists && hasContent  → normal page with body text.
  // Previously every "no content" case collapsed into "Page not found",
  // which mis-reported empty-but-existing pages. error / message /
  // instructions now distinguish missing vs empty so the client and
  // the agent get consistent signals.
  const missing = !exists;
  const slug = wikiSlugify(pageName);
  const errorMessage = missing ? `Page not found: ${pageName}` : hasContent ? undefined : `Page is empty: ${pageName}`;
  const statusMessage = hasContent ? `Showing page: ${resolvedTitle}` : missing ? `Page not found: ${pageName}` : `Page exists but is empty: ${resolvedTitle}`;
  const statusInstructions = hasContent
    ? "The wiki page is now displayed on the canvas."
    : missing
      ? `Page not found: wiki/pages/${slug}.md does not exist. You can create it or check the slug in wiki/index.md.`
      : `Page exists but is empty: wiki/pages/${slug}.md has no content yet. Research the topic and write a comprehensive article, then save it to the same path.`;
  return {
    data: {
      action,
      title: resolvedTitle,
      content,
      pageName: resolvedTitle,
      pageExists: exists,
      error: errorMessage,
    },
    message: statusMessage,
    title: resolvedTitle,
    instructions: statusInstructions,
    updating: true,
  };
}

// Pure-ish seam between `resolvePagePath` + `readFileOrEmpty` (the
// filesystem I/O) and `buildPageResponseData` (the response shape).
// Exported so tests can exercise the `exists`/`resolvedTitle`
// computation without spinning up a real wiki directory — the
// original regression this PR fixed was precisely this layer
// conflating `content` with `exists`, so pinning it here is worth
// the extra indirection.
export function toPageResponse(args: { action: string; pageName: string; filePath: string | null; content: string }): WikiResponse {
  const { action, pageName, filePath, content } = args;
  const resolvedTitle = filePath ? path.basename(filePath, ".md") : pageName;
  return buildPageResponseData({
    action,
    pageName,
    resolvedTitle,
    content,
    exists: Boolean(filePath),
  });
}

async function buildPageResponse(action: string, pageName: string): Promise<WikiResponse> {
  const { filePath, content } = await readWikiPage(workspacePath, pageName);
  return toPageResponse({ action, pageName, filePath, content });
}

function buildLogResponse(action: string): WikiResponse {
  const content = readWikiLog(workspacePath);
  return {
    data: { action, title: "Activity Log", content },
    message: content ? "Wiki activity log" : "Activity log is empty.",
    title: "Activity Log",
    instructions: "The wiki activity log is now displayed on the canvas.",
    updating: true,
  };
}

// `collectLintIssues` and `loadWikiGraph` (the read-all-pages loops
// over the pure lint rules / `buildWikiGraph`) now live in
// `@mulmoclaude/core/wiki/server`, shared with MulmoTerminal.

async function buildGraphResponse(action: string): Promise<WikiResponse> {
  const graph = await loadWikiGraph(workspacePath);
  log.info("wiki", "POST graph: ok", { nodes: graph.nodes.length, edges: graph.edges.length });
  return {
    data: { action, title: "Wiki Graph", content: "", graph },
    message: `Wiki graph — ${graph.nodes.length} page(s), ${graph.edges.length} link(s)`,
    title: "Wiki Graph",
    instructions: "The wiki link graph is now displayed on the canvas.",
    updating: true,
  };
}

// Result of a save attempt — null on lookup miss so the route can
// return 404 distinctly from a 400 / 500.
type SaveOutcome = { ok: true; absPath: string } | { ok: false; reason: "not-found" };

async function saveExistingPage(pageName: string, content: string): Promise<SaveOutcome> {
  const absPath = await resolvePagePath(workspacePath, pageName);
  if (!absPath) return { ok: false, reason: "not-found" };
  // Funnel through the wiki-page write helper. Atomic write is
  // guaranteed inside; the helper also routes the (old, new) pair
  // to the snapshot pipeline (#763 PR 2 — currently a no-op stub).
  // Editor identity defaults to "user" here because the route is
  // hit by both LLM (`manageWiki` MCP) and frontend saves; PR 2
  // disambiguates them via a request-side flag.
  const slug = path.basename(absPath, ".md");
  await writeWikiPage(slug, content, { editor: "user" });
  return { ok: true, absPath };
}

// Extracted from the POST switch to keep the route handler under
// the project's cognitive-complexity limit. Returns true if the
// response was sent (success or any handled error), false to fall
// through to the next case (currently unused — every code path
// terminates).
async function handleSaveAction(
  req: Request<object, unknown, WikiBody>,
  res: Response<WikiResponse | ErrorResponse>,
  pageName: string | undefined,
): Promise<void> {
  if (!pageName) {
    log.warn("wiki", "POST save: missing pageName");
    badRequest(res, "pageName required for save action");
    return;
  }
  const { content } = req.body;
  if (typeof content !== "string") {
    log.warn("wiki", "POST save: missing content", { pageNamePreview: previewSnippet(pageName) });
    badRequest(res, "content (string) required for save action");
    return;
  }
  const outcome = await saveExistingPage(pageName, content);
  if (!outcome.ok) {
    log.warn("wiki", "POST save: page not found", { pageNamePreview: previewSnippet(pageName) });
    notFound(res, `Page not found: ${pageName}`);
    return;
  }
  log.info("wiki", "POST save: ok", { pageNamePreview: previewSnippet(pageName), bytes: content.length });
  // Re-read so the response carries the canonical post-write state.
  const response = await buildPageResponse("page", pageName);
  res.json(response);
}

// Extracted from the POST switch (mirrors handleSaveAction) so the
// route handler stays under the max-lines-per-function limit.
// Resolves the page, logs the missing / ok distinction, and writes
// the canvas response envelope.
async function handlePageAction(res: Response<WikiResponse | ErrorResponse>, action: string, pageName: string | undefined): Promise<void> {
  if (!pageName) {
    log.warn("wiki", "POST page: missing pageName");
    badRequest(res, "pageName required for page action");
    return;
  }
  const response = await buildPageResponse(action, pageName);
  if (!response.data.pageExists) {
    log.warn("wiki", "POST page: not found", { pageNamePreview: previewSnippet(pageName) });
  } else {
    log.info("wiki", "POST page: ok", { pageNamePreview: previewSnippet(pageName), bytes: response.data.content.length });
  }
  res.json(response);
}

async function buildLintReportResponse(action: string): Promise<WikiResponse> {
  const issues = await collectLintIssues(workspacePath);
  const report = formatLintReport(issues);
  const healthy = issues.length === 0;
  return {
    data: { action, title: "Wiki Lint Report", content: report },
    message: healthy ? "Wiki is healthy" : `${issues.length} issue(s) found`,
    title: "Wiki Lint Report",
    instructions: healthy ? "Wiki is healthy — no issues found." : `${issues.length} issue(s) found that need fixing:\n${issues.join("\n")}`,
    updating: true,
  };
}

async function handleWikiPost(req: Request<object, unknown, WikiBody>, res: Response<WikiResponse | ErrorResponse>): Promise<void> {
  const { action, pageName } = req.body;
  log.info("wiki", "POST: start", { action, pageNamePreview: pageName ? previewSnippet(pageName) : undefined });
  try {
    switch (action) {
      case "index": {
        const response = buildIndexResponse(action);
        log.info("wiki", "POST index: ok", { pages: response.data.pageEntries?.length ?? 0 });
        res.json(response);
        return;
      }
      case "page": {
        await handlePageAction(res, action, pageName);
        return;
      }
      case "log": {
        const response = buildLogResponse(action);
        log.info("wiki", "POST log: ok", { bytes: response.data.content.length });
        res.json(response);
        return;
      }
      case "graph": {
        res.json(await buildGraphResponse(action));
        return;
      }
      case "lint_report": {
        const response = await buildLintReportResponse(action);
        // `summary` not `issues`: the field is the human-readable
        // result string ("Wiki is healthy" / "N issue(s) found"),
        // not a count. Aggregators that group by `issues` would
        // otherwise treat the same string as a numeric facet.
        log.info("wiki", "POST lint_report: ok", { summary: response.message });
        res.json(response);
        return;
      }
      case "save": {
        // Used by the wiki page View when the user toggles a GFM
        // task checkbox in the rendered body (#775). Overwrites the
        // existing page file atomically; refuses to create new pages
        // — that flow lives elsewhere (LLM via Write, manageWiki).
        await handleSaveAction(req, res, pageName);
        return;
      }
      default:
        log.warn("wiki", "POST: unknown action", { action });
        badRequest(res, `Unknown action: ${action}`);
    }
  } catch (err) {
    log.error("wiki", "POST: threw", { action, pageNamePreview: pageName ? previewSnippet(pageName) : undefined, error: formatError(err) });
    throw err;
  }
}

router.post(API_ROUTES.wiki.base, async (req: Request<object, unknown, WikiBody>, res: Response<WikiResponse | ErrorResponse>) => handleWikiPost(req, res));

export default router;
