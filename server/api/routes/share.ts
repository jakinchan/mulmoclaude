import { Router, Request, Response } from "express";
import { API_ROUTES } from "../../../src/config/apiRoutes.js";
import { WORKSPACE_DIRS } from "../../workspace/paths.js";
import { packHtmlZip, zipBundle, safeZipName } from "../../utils/share/packHtml.js";
import { renderMarkdownHtml } from "./pdf.js";
import { isHtmlPath } from "../../utils/files/html-store.js";
import { badRequest, serverError } from "../../utils/httpError.js";
import { errorMessage } from "../../utils/errors.js";
import { log } from "../../system/logger/index.js";

const router = Router();

interface PackBody {
  path?: string;
}

// Route-boundary guard: only a canonical `.html` under artifacts/html is
// packable. Delegates to the repo's shared HTML path policy (`isHtmlPath`
// = prefix + `.html` ext + canonical form + no `..` + no traversal
// segment) so malformed input is a deterministic 400, never a 500 from
// deeper code.
export function isPackablePath(value: unknown): value is string {
  return typeof value === "string" && isHtmlPath(value);
}

// POST /api/share/pack — bundle an HTML artifact and its referenced
// local assets into a single self-contained zip (index.html + assets/),
// returned as a download. Paths are rewritten to be relative so the
// unzipped folder opens directly over file://.
router.post(API_ROUTES.share.pack, async (req: Request<object, unknown, PackBody>, res: Response) => {
  const htmlPath = req.body?.path;
  if (!isPackablePath(htmlPath)) {
    badRequest(res, `path must be a canonical ${WORKSPACE_DIRS.htmls}/*.html file`);
    return;
  }
  try {
    const { filename, zip } = await packHtmlZip(htmlPath);
    log.info("share", "pack: ok", { path: htmlPath, bytes: zip.length });
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(zip);
  } catch (err) {
    // Log the detail server-side; return a generic message so an internal
    // path / stack never reaches the client.
    log.error("share", "pack: threw", { path: htmlPath, error: errorMessage(err) });
    serverError(res, "failed to pack HTML bundle");
  }
});

interface PackMarkdownBody {
  markdown?: string | undefined;
  filename?: string | undefined;
  baseDir?: string | undefined;
  stripFrontmatter?: boolean | undefined;
  marp?: boolean | undefined;
}

// A shared markdown zip is opened directly by the recipient (unlike the
// PDF path, which puppeteer renders once), so neutralize any script the
// source markdown carries — `marked` passes raw HTML through. A strict
// CSP blocks `<script>` / inline handlers / `javascript:` and plugins
// without stripping content or touching images/styles.
const SHARE_MARKDOWN_CSP = "script-src 'none'; object-src 'none'; base-uri 'none'";

export function withScriptCsp(html: string): string {
  return html.replace(/<head>/i, `<head><meta http-equiv="Content-Security-Policy" content="${SHARE_MARKDOWN_CSP}">`);
}

async function buildMarkdownZip(body: PackMarkdownBody): Promise<{ filename: string; zip: Buffer }> {
  const markdown = typeof body.markdown === "string" ? body.markdown : "";
  const baseDir = typeof body.baseDir === "string" ? body.baseDir : undefined;
  const html = withScriptCsp(await renderMarkdownHtml({ markdown, baseDir, stripFrontmatter: body.stripFrontmatter === true, marp: body.marp === true }));
  const zip = await zipBundle([{ bundlePath: "index.html", bytes: Buffer.from(html, "utf-8") }]);
  const filename = typeof body.filename === "string" ? body.filename : "document";
  return { filename: safeZipName(filename.replace(/\.(md|markdown|html?|pdf)$/i, "")), zip };
}

// POST /api/share/pack-markdown — render markdown (or a wiki page) to a
// self-contained HTML (CSS inlined, images embedded as data URIs, scripts
// neutralized) and return it zipped as index.html. Shares the render path
// with the PDF route (`renderMarkdownHtml`). `baseDir` resolves relative
// image refs; traversal is rejected downstream by the shared image resolver.
router.post(API_ROUTES.share.packMarkdown, async (req: Request<object, unknown, PackMarkdownBody>, res: Response) => {
  const { body } = req;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    badRequest(res, "request body must be a JSON object");
    return;
  }
  if (typeof body.markdown !== "string" || !body.markdown) {
    badRequest(res, "markdown is required");
    return;
  }
  try {
    const { filename, zip } = await buildMarkdownZip(body);
    log.info("share", "pack-markdown: ok", { bytes: zip.length, marp: body.marp === true });
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(zip);
  } catch (err) {
    log.error("share", "pack-markdown: threw", { error: errorMessage(err) });
    serverError(res, "failed to pack markdown bundle");
  }
});

export default router;
