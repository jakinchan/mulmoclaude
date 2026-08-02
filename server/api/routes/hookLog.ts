// POST /api/hooks/log — receives one structured log line from the
// PostToolUse dispatcher and forwards it into the server's logger.
//
// Why: hook handlers run inside Claude CLI's process space and have
// no path to the server's structured logger. Without this endpoint,
// every hook side-effect (skill-bridge mirror copy, future ones)
// silently succeeds — a user trying to verify a copy actually
// happened has no signal to look at, and a partial failure is
// indistinguishable from "the hook didn't fire". This endpoint is
// the bridge from "the hook side did something" to the same log
// stream the rest of the server writes to.
//
// Body shape:
//
//   { namespace: string; message: string;
//     level?: "info" | "warn" | "error"; data?: object }
//
// Authentication: bearer auth (same as every other internal hook
// endpoint). The dispatcher reads the workspace's `.session-token`
// sidecar before POSTing.

import { Router, type Request, type Response } from "express";
import { API_ROUTES } from "../../../src/config/apiRoutes.js";
import { badRequest } from "../../utils/httpError.js";
import { log } from "../../system/logger/index.js";
import { isRecord } from "../../utils/types.js";

type Level = "info" | "warn" | "error";

interface HookLogBody {
  namespace?: unknown | undefined;
  message?: unknown | undefined;
  level?: unknown | undefined;
  data?: unknown | undefined;
}

const router = Router();

// Cap the inbound payload's text length. The dispatcher is trusted
// (bearer-authed, same machine) but a runaway handler emitting an
// unbounded `data` blob would crowd the server logs. 2 KB per field
// is comfortable for "mirror src → dst" style messages and tight
// enough to keep one event readable in the tail.
const MAX_FIELD_CHARS = 2048;

interface ValidatedHookLog {
  namespace: string;
  message: string;
  level: Level;
  // `Record<string, unknown>` matches the server logger's `data?`
  // parameter exactly — `object` would force a cast at the log
  // call site. The validator already narrows via `isRecord`, so the
  // tighter type also documents the gate visually.
  data?: Record<string, unknown> | undefined;
}

// Pull validation into a helper so the route body stays under the
// 20-line cognitive-complexity guideline. The helper either returns
// the typed shape ready for `log[level](...)` or writes a 400 and
// returns null — caller short-circuits on null.
function validateHookLogBody(body: HookLogBody | undefined, res: Response): ValidatedHookLog | null {
  const { namespace, message, level, data } = body ?? {};
  if (typeof namespace !== "string" || namespace.length === 0) {
    badRequest(res, "namespace required");
    return null;
  }
  if (typeof message !== "string" || message.length === 0) {
    badRequest(res, "message required");
    return null;
  }
  return {
    // Tag the log entry's namespace so it's easy to grep against
    // server-side noise — every hook-side log line starts with
    // `hook:<handler>` rather than the bare handler name a server
    // module would use.
    namespace: `hook:${namespace.slice(0, MAX_FIELD_CHARS)}`,
    message: message.slice(0, MAX_FIELD_CHARS),
    level: resolveLevel(level),
    data: isRecord(data) ? data : undefined,
  };
}

router.post(API_ROUTES.hooks.log, (req: Request<object, unknown, HookLogBody>, res: Response) => {
  const validated = validateHookLogBody(req.body, res);
  if (validated === null) return;
  log[validated.level](validated.namespace, validated.message, validated.data);
  res.status(204).end();
});

function resolveLevel(raw: unknown): Level {
  if (raw === "warn" || raw === "error") return raw;
  return "info";
}

export default router;
