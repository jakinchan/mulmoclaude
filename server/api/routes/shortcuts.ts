// HTTP route for manually-pinned launcher shortcuts (collections / feeds).
//
//   GET /api/shortcuts  → { shortcuts }
//   PUT /api/shortcuts  → replace the full list → { shortcuts }
//
// The client owns ordering / add / remove and sends the whole array;
// the server normalises (validate kind, non-empty slug, dedupe on
// `(kind, slug)`, no length cap) before persisting. A single
// replace-endpoint avoids add/remove route sprawl.

import { Router, Request } from "express";
import { API_ROUTES } from "../../../src/config/apiRoutes.js";
import type { Shortcut } from "../../../src/types/shortcuts.js";
import { readShortcuts, writeShortcuts } from "../../utils/files/shortcuts-io.js";
import { errorMessage } from "../../utils/errors.js";
import { badRequest, serverError, type ApiResponse } from "../../utils/httpError.js";
import { requestBodyRecord } from "../../utils/requestBody.js";
import { log } from "../../system/logger/index.js";

const router = Router();

interface ShortcutsResponse {
  shortcuts: Shortcut[];
}

router.get(API_ROUTES.shortcuts, async (_req: Request, res: ApiResponse<ShortcutsResponse>) => {
  try {
    res.json({ shortcuts: await readShortcuts() });
  } catch (err) {
    log.warn("shortcuts", "read failed", { error: errorMessage(err) });
    serverError(res, errorMessage(err));
  }
});

router.put(API_ROUTES.shortcuts, async (req: Request, res: ApiResponse<ShortcutsResponse>) => {
  const incoming = requestBodyRecord(req.body).shortcuts;
  if (!Array.isArray(incoming)) {
    badRequest(res, "Request body must be { shortcuts: Shortcut[] }");
    return;
  }
  try {
    const shortcuts = await writeShortcuts(incoming);
    res.json({ shortcuts });
  } catch (err) {
    log.warn("shortcuts", "write failed", { error: errorMessage(err) });
    serverError(res, errorMessage(err));
  }
});

export default router;
