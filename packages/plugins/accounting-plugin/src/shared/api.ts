// Single source of truth for the accounting REST contract — the one
// dispatch route the plugin owns. Consumed by BOTH the Vue api client
// (./vue/api.ts) and the server router (./server/router.ts) so the path
// can't drift between them. Mirrors the host META's
// `{ apiNamespace: "accounting", dispatch: { method: "POST", path: "" } }`
// resolved to a full URL.
//
// (CLAUDE.md: API routes go through `as const` objects, never hardcoded
// strings at the call site.)

export const ACCOUNTING_API = {
  dispatch: {
    path: "/api/accounting",
    method: "POST",
  },
} as const;

/** Body field carrying the host's OPAQUE project id on a dispatch
 *  request, for a host that serves more than one root. The package
 *  writes it (the Vue client, from `configureAccountingHost`'s
 *  `projectScope`) and the HOST reads it, through the
 *  `resolveWorkspaceRoot` resolver it passes to `createAccountingRouter`
 *  — the package itself never resolves it, so a project can only ever
 *  be named by the host's own client, never by the LLM (the
 *  `manageAccounting` tool schema has no such parameter).
 *
 *  It is an id the host can look up, NEVER a path. A single-root host
 *  neither sends nor reads it, and its requests are unchanged. */
export const ACCOUNTING_PROJECT_FIELD = "project";
