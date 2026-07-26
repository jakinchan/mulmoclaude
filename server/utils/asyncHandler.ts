// Generic wrapper that turns "unhandled error inside an async route
// handler" into "logged 500 response". Without it, an uncaught throw
// either crashes the request silently or surfaces as a generic 500
// with no server-side trace (#779 / DRY audit batch B).
//
// Migration story: `server/api/routes/plugins.ts` shipped a private
// `wrapPluginExecute` with this exact shape, hard-coded to the
// "plugins" log namespace. This module generalises the same idea so
// every route file uses one wrapper.
//
// Scope:
//
//   - Catches anything the inner handler throws. The wrapper logs
//     the raw error message on the server side (full detail kept for
//     debugging) and returns a 500 carrying ONLY the caller-supplied
//     `fallbackMessage` — never the raw `err.message`. Leaking
//     internal error text to clients would surface stack-shape
//     details, file paths, and library internals to anyone hitting
//     the endpoint.
//   - The inner handler stays in charge of 4xx mapping (validation,
//     not-found, etc.) — those paths respond + `return` inside the
//     handler before the wrapper's catch ever runs.
//   - When the response has already been sent (`headersSent`), a
//     second status can't be written, so the error is forwarded to
//     Express via `next(err)` instead. Measured against Express 5.2.1:
//     returning without forwarding leaves the request hanging with no
//     end to its body, while forwarding makes finalhandler destroy the
//     socket in milliseconds. No route wrapped here streams today, so
//     this branch is currently unreachable — it exists so the first
//     streaming route added doesn't inherit a silent hang.
//
// Naming: `namespace` is the log tag (e.g. "accounting", "wiki") —
// matches the existing `log.info("namespace", …)` convention across
// the route layer. `fallbackMessage` mirrors the strings the
// hand-rolled try/catch blocks used before the migration ("failed to
// load news items", "Failed to list tasks", …) so the client-facing
// behaviour is unchanged.

import type { NextFunction, Request, Response } from "express";
import { log } from "../system/logger/index.js";
import { errorMessage } from "./errors.js";
import { serverError, type ErrorSendable } from "./httpError.js";

// The TReq / TRes bounds name exactly what the catch path dereferences —
// nothing more.
//
// They are NOT `extends Request` / `extends Response`. Express's
// `Request<P, ResBody, ReqBody, Query>` uses its type parameters in mixed
// variance positions, so a nominal `extends Request<…>` bound rejects
// perfectly valid call sites like `Request<object, unknown, MyBody>` or
// `Request<SessionIdParams, ResBody, ReqBody>`: TS treats `object` /
// concrete-ResBody as incompatible with the default's `ParamsDictionary` /
// `any` slots. Naming only the members we touch sidesteps that entirely —
// every concrete `Request<…>` has `path`, so every call site still fits.
//
// Structural bounds rather than unconstrained generics + `as` casts, because
// the cast was load-bearing in a way that hid a real contract: this wrapper
// can send `{ error }` on the failure path, so a route declaring a `ResBody`
// that cannot carry that body was lying. `ErrorSendable` now makes such a
// route a compile error instead of a silent runtime mismatch — the fix at
// those sites is to widen the `ResBody` union, which is the truth.
//
// Mirrors `wrapPluginExecute` in `server/api/routes/plugins.ts`, which this
// module generalises.
interface RoutePathBearing {
  path: string;
}

/** `ErrorSendable` plus the already-sent probe the catch path checks before
 *  writing a second status. */
interface ErrorSendableResponse extends ErrorSendable {
  headersSent: boolean;
}

export function asyncHandler<TReq extends RoutePathBearing = Request, TRes extends ErrorSendableResponse = Response>(
  namespace: string,
  fallbackMessage: string,
  handler: (req: TReq, res: TRes) => Promise<void>,
): (req: TReq, res: TRes, next: NextFunction) => Promise<void> {
  return async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (err) {
      log.error(namespace, "handler threw", { route: req.path, error: errorMessage(err) });
      if (res.headersSent) {
        // A partially-sent response can't take a clean 500, and simply
        // returning here leaves the request open — measured against this
        // repo's Express (5.2.1), the client waits indefinitely for a body
        // that never ends. Handing the error to Express lets finalhandler
        // destroy the socket instead, so the caller fails in milliseconds
        // rather than hanging until some timeout upstream.
        //
        // The forwarded value must be TRUTHY. Express reads `next(<falsy>)`
        // as plain `next()` — "keep routing", not "fail" — so forwarding a
        // thrown `undefined` (a bare `Promise.reject()` produces exactly
        // that) skips the error flow entirely and hangs, reintroducing the
        // bug this branch exists to prevent. Measured: the request hung past
        // 2.5s. A falsy throw carries no diagnostic value anyway, so
        // substituting a real Error loses nothing.
        // `||`, deliberately not `??`: `??` only substitutes for null/undefined,
        // leaving `0` / `""` / `false` to be forwarded verbatim and swallowed.
        next(err || new Error(`${namespace}: handler threw a falsy value`));
        return;
      }
      serverError(res, fallbackMessage);
    }
  };
}
