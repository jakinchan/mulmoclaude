// `POST /api/shutdown` — stop the server from the app (#2616).
//
// The icon launcher (#2613) spawns the server detached, so it outlives
// the launcher by design. That left `kill $(lsof -ti:3001)` as the only
// way to stop it — a terminal command, for the people the icon exists
// to spare from terminals.
//
// Reachable from the local machine only, and not because of a check
// here: `server/index.ts` binds to `127.0.0.1`, and the RemoteHost
// channel dispatches its own handler table rather than HTTP routes. A
// phone cannot reach this, which is deliberate — there would be no way
// to start the server again from there.

import { Router, type Request, type Response } from "express";

import { API_ROUTES } from "../../../src/config/apiRoutes.js";
import { log } from "../../system/logger/index.js";
import { SHUTDOWN_RESPONSE_GRACE_MS } from "../../utils/time.js";

export interface ShutdownResponse {
  stopping: true;
}

export interface ShutdownDeps {
  /** Injected so tests can observe the request without dying. */
  stop: () => void;
  delayMs: number;
}

// SIGTERM rather than a second shutdown implementation: `index.ts`
// already handles it with `gracefulShutdown`, which runs the shutdown
// hooks, removes the token file and exits — and guards itself against
// running twice. Duplicating any of that here is how the two copies
// start to disagree.
const defaultDeps: ShutdownDeps = {
  stop: () => process.kill(process.pid, "SIGTERM"),
  delayMs: SHUTDOWN_RESPONSE_GRACE_MS,
};

/**
 * Answer first, stop second. The browser needs the response to switch to
 * its "stopped" screen; stopping inside the handler would close the
 * socket first and the click would look like a failure.
 */
export function createShutdownRouter(deps: ShutdownDeps = defaultDeps): Router {
  const router = Router();
  router.post(API_ROUTES.shutdown, (_req: Request, res: Response<ShutdownResponse>) => {
    log.info("shutdown", "stop requested from the app");
    res.json({ stopping: true });
    setTimeout(deps.stop, deps.delayMs).unref();
  });
  return router;
}
