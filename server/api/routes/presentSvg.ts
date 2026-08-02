import { Router, Request, Response } from "express";
import { WORKSPACE_DIRS } from "../../workspace/paths.js";
import { writeWorkspaceText } from "../../utils/files/workspace-io.js";
import { buildArtifactPath } from "../../utils/files/naming.js";
import { overwriteSvg, isSvgPath } from "../../utils/files/svg-store.js";
import { errorMessage } from "../../utils/errors.js";
import { badRequest, serverError } from "../../utils/httpError.js";
import { API_ROUTES } from "../../../src/config/apiRoutes.js";
import { bindRoute } from "../../utils/router.js";
import { log } from "../../system/logger/index.js";
import { previewSnippet } from "../../utils/logPreview.js";
import { publishFileChange } from "../../events/file-change.js";

const router = Router();

interface PresentSvgBody {
  svg: string;
  title?: string | undefined;
}

interface PresentSvgSuccessResponse {
  message: string;
  instructions: string;
  data: { title?: string | undefined; filePath: string };
}

interface PresentSvgErrorResponse {
  error: string;
}

type PresentSvgResponse = PresentSvgSuccessResponse | PresentSvgErrorResponse;

bindRoute(router, API_ROUTES.svg.create, async (req: Request<object, unknown, PresentSvgBody>, res: Response<PresentSvgResponse>) => {
  const { svg, title } = req.body;
  log.info("svg", "present: start", {
    titlePreview: typeof title === "string" ? previewSnippet(title) : undefined,
    bytes: typeof svg === "string" ? svg.length : undefined,
  });
  if (!svg) {
    log.warn("svg", "present: missing svg");
    badRequest(res, "svg is required");
    return;
  }

  try {
    const filePath = buildArtifactPath(WORKSPACE_DIRS.svgs, title, ".svg", "drawing");
    await writeWorkspaceText(filePath, svg);
    log.info("svg", "present: ok", { filePath, bytes: svg.length });
    void publishFileChange(filePath);
    res.json({
      message: `Saved SVG to ${filePath}`,
      instructions: "Acknowledge that the SVG drawing has been presented to the user.",
      data: { title, filePath },
    });
  } catch (err) {
    log.error("svg", "present: threw", { error: errorMessage(err) });
    serverError(res, errorMessage(err));
  }
});

interface UpdateSvgBody {
  relativePath: string;
  svg: string;
}

interface UpdateSvgSuccessResponse {
  path: string;
}

interface UpdateSvgErrorResponse {
  error: string;
}

bindRoute(
  router,
  API_ROUTES.svg.update,
  async (req: Request<object, unknown, UpdateSvgBody>, res: Response<UpdateSvgSuccessResponse | UpdateSvgErrorResponse>) => {
    const { relativePath, svg } = req.body;
    log.info("svg", "update: start", {
      pathPreview: typeof relativePath === "string" ? previewSnippet(relativePath) : undefined,
      bytes: typeof svg === "string" ? svg.length : undefined,
    });
    if (!svg) {
      log.warn("svg", "update: missing svg");
      badRequest(res, "svg is required");
      return;
    }
    if (!relativePath || !isSvgPath(relativePath)) {
      log.warn("svg", "update: invalid relativePath", {
        pathPreview: typeof relativePath === "string" ? previewSnippet(relativePath) : undefined,
      });
      badRequest(res, "invalid svg relativePath");
      return;
    }
    try {
      await overwriteSvg(relativePath, svg);
      log.info("svg", "update: ok", { pathPreview: previewSnippet(relativePath), bytes: svg.length });
      void publishFileChange(relativePath);
      res.json({ path: relativePath });
    } catch (err) {
      log.error("svg", "update: threw", { pathPreview: previewSnippet(relativePath), error: errorMessage(err) });
      serverError(res, errorMessage(err));
    }
  },
);

export default router;
