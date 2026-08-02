// Tiny adapter for registering Express routes from a `ResolvedRoute`
// `{ method, url }` tuple — the shape host aggregators emit for every
// plugin-owned route. Lets route files spell the registration as
// `bindRoute(router, API_ROUTES.todos.itemsCreate, handler)` instead
// of branching on the verb at the call site.
//
// Handler typing mirrors Express's own: the generics travel through to
// `router[method]`, whose matching overload is itself generic over
// params / body / query, so a handler declared as `(req: Request<{ id:
// string }>, res: Response) => void` binds with no coercion.

import type { IRouter, RequestHandler } from "express";
import type { ResolvedRoute } from "../../src/plugins/meta-types.js";

// `RequestHandler`'s own defaults, read off Express's public type rather than
// imported from `express-serve-static-core` — that sub-package is a transitive
// type-only dep, and naming it makes the launcher's dependency scan fail.
type DefaultParams = RequestHandler extends RequestHandler<infer P, infer __R, infer __B, infer __Q> ? P : never;
type DefaultQuery = RequestHandler extends RequestHandler<infer __P, infer __R, infer __B, infer Q> ? Q : never;

/** Register `handlers` on `router` using the verb + URL declared by
 *  `route`. The generics let callers keep their own `params` / `body` /
 *  `query` shapes; every handler in one call must agree on them, which
 *  is the same constraint Express itself imposes. */
export function bindRoute<P = DefaultParams, ResBody = unknown, ReqBody = unknown, ReqQuery = DefaultQuery>(
  router: IRouter,
  route: ResolvedRoute,
  ...handlers: RequestHandler<P, ResBody, ReqBody, ReqQuery>[]
): void {
  switch (route.method) {
    case "GET":
      router.get<P, ResBody, ReqBody, ReqQuery>(route.url, ...handlers);
      break;
    case "POST":
      router.post<P, ResBody, ReqBody, ReqQuery>(route.url, ...handlers);
      break;
    case "PUT":
      router.put<P, ResBody, ReqBody, ReqQuery>(route.url, ...handlers);
      break;
    case "PATCH":
      router.patch<P, ResBody, ReqBody, ReqQuery>(route.url, ...handlers);
      break;
    case "DELETE":
      router.delete<P, ResBody, ReqBody, ReqQuery>(route.url, ...handlers);
      break;
  }
}
