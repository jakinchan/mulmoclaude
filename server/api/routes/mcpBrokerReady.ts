// POST /api/mcp/broker-ready — the mulmoclaude MCP broker reporting that it
// answered `initialize`, with how long it took to get there.
//
// Why: the broker is a grandchild of this server. Claude CLI spawns it over
// stdio and owns its stderr, so its `[mcp-server] …` lines never reach
// `server/system/logs/`. From the host, a broker that is slow and a broker that
// is dead look identical — that ambiguity is what #2842 was filed against, and
// what made a `tsx`-path install read as "the connect-wait gate is too small".
//
// The timings are measured INSIDE the broker, relative to its own process
// start, so no host/container clock agreement is needed — and the cold boot we
// care about (tsx transcoding the import graph, or node reading the 6 MB
// bundle) happens after that process starts, so it lands inside the number.
//
// Body: { bootMs: number; initializeMs: number; kind: "bundle" | "tsx" }
// Query: ?session=<chat session id>, as every broker bridge call carries.
// Authentication: bearer, same as the rest of /api.

import { Router, type Request, type Response } from "express";
import { API_ROUTES } from "../../../src/config/apiRoutes.js";
import { badRequest } from "../../utils/httpError.js";
import { log } from "../../system/logger/index.js";
import { BROKER_SLOW_BOOT_MS, recordBrokerReady, type BrokerReady } from "../../agent/brokerReadiness.js";
import { ONE_MINUTE_MS } from "../../utils/time.js";

interface BrokerReadyBody {
  bootMs?: unknown | undefined;
  initializeMs?: unknown | undefined;
  kind?: unknown | undefined;
  spawnId?: unknown | undefined;
}

const router = Router();

const isBrokerKind = (value: unknown): value is BrokerReady["kind"] => value === "bundle" || value === "tsx";

// A negative or absurd duration means the sender's clock is not what we think
// it is; reject rather than log a number that would mislead a later reader.
const MAX_PLAUSIBLE_BOOT_MS = 10 * ONE_MINUTE_MS;
const isDuration = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_PLAUSIBLE_BOOT_MS;

interface ValidatedBeacon {
  spawnId: string;
  ready: BrokerReady;
}

function validate(body: BrokerReadyBody | undefined, res: Response): ValidatedBeacon | null {
  const { bootMs, initializeMs, kind, spawnId } = body ?? {};
  if (!isDuration(bootMs) || !isDuration(initializeMs)) {
    badRequest(res, "bootMs and initializeMs must be durations in ms");
    return null;
  }
  if (!isBrokerKind(kind)) {
    badRequest(res, "kind must be 'bundle' or 'tsx'");
    return null;
  }
  if (typeof spawnId !== "string" || spawnId.length === 0) {
    badRequest(res, "spawnId required");
    return null;
  }
  return { spawnId, ready: { bootMs, initializeMs, kind } };
}

// Slow enough to be worth a warn: the same turn on a heavier mount is the one
// that overruns the CLI's connect wait and dies on `handlePermission not
// found`. Naming the cause (`tsx`) in the line saves the next reader the
// investigation that #2842 had to do by hand.
function logBrokerReady(sessionId: string, ready: BrokerReady): void {
  const data = { chatSessionId: sessionId, ...ready };
  if (ready.initializeMs >= BROKER_SLOW_BOOT_MS) {
    log.warn("mcp", "broker cold boot is slow — a heavier mount would overrun the CLI connect wait", data);
    return;
  }
  log.info("mcp", "broker ready", data);
}

router.post(API_ROUTES.mcp.brokerReady, (req: Request<object, unknown, BrokerReadyBody>, res: Response) => {
  const sessionId = req.query.session;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    badRequest(res, "session query parameter required");
    return;
  }
  const beacon = validate(req.body, res);
  if (beacon === null) return;
  // 204 either way: a straggler from a replaced attempt is not the sender's
  // fault, and it is still worth a line — "the broker DID come up, just too
  // late to be the one we ran" is a distinct diagnosis from both alternatives.
  if (!recordBrokerReady(sessionId, beacon.spawnId, beacon.ready)) {
    log.info("mcp", "broker ready, but from a superseded spawn — not counted for the current attempt", {
      chatSessionId: sessionId,
      ...beacon.ready,
    });
    res.status(204).end();
    return;
  }
  logBrokerReady(sessionId, beacon.ready);
  res.status(204).end();
});

export default router;
