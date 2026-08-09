// Host-injected runtime context for the accounting Vue surface.
//
// The package can't reach into the host for its network client or its
// raw pub/sub transport (that would be an uphill import, and would
// hard-wire the package to MulmoClaude's internals). Instead the host
// injects them once at startup via `configureAccountingHost(...)`, the
// same module-level DI pattern `@mulmoclaude/collection-plugin` uses
// (`configureCollectionUi`). MulmoTerminal wires its own equivalents.
//
// Two seams:
//   · apiCall  — POST to /api/accounting; the host attaches the bearer
//                token + base URL. Returns the shared `ApiResult` union.
//   · subscribe — raw pub/sub channel subscription (socket.io in the
//                MulmoClaude host). The accounting backend publishes on
//                raw `accounting:<bookId>` channels, so the View needs
//                the raw transport, not the plugin-scoped pub/sub.

/** Mirrors the host's `ApiResult<T>` (src/utils/api.ts) so callers
 *  pattern-match on `.ok` without depending on the host module. */
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string; status: number };

/** Network seam — structurally compatible with the host's `apiCall`.
 *  `method` mirrors the host `ApiOptions["method"]` union so the host
 *  can pass its `apiCall` straight in without an adapter. */
export type AccountingApiCall = <T = unknown>(
  path: string,
  opts: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown },
) => Promise<ApiResult<T>>;

/** Pub/sub seam — structurally compatible with `usePubSub().subscribe`. */
export type AccountingSubscribe = (channel: string, handler: (payload: unknown) => void) => () => void;

/** Locale seam — the host's active i18n locale tag (e.g. "en", "ja"), read
 *  reactively. The plugin owns a self-contained vue-i18n instance and mirrors
 *  this tag onto it, so it shares NO i18n resources with the host. */
export type AccountingLocaleTag = () => string;

/** Project seam — the host's OPAQUE id for the project (root) the
 *  mounted accounting surface belongs to, or `null` for the host's
 *  default root. A single-root host omits it entirely and every
 *  request and channel name stays exactly what it is today.
 *
 *  It rides dispatch requests as `ACCOUNTING_PROJECT_FIELD` and
 *  namespaces the pub/sub channel names, so two projects that both hold
 *  a book called `main` neither read nor refresh each other. It must be
 *  an id the host can resolve, never a path — it reaches the browser. */
export type AccountingProjectScope = () => string | null;

export interface AccountingHostContext {
  apiCall: AccountingApiCall;
  subscribe: AccountingSubscribe;
  localeTag: AccountingLocaleTag;
  projectScope?: AccountingProjectScope;
}

let ctx: AccountingHostContext | null = null;

/** Called once by the host before any accounting View mounts. */
export function configureAccountingHost(context: AccountingHostContext): void {
  ctx = context;
}

function requireCtx(): AccountingHostContext {
  if (!ctx) {
    throw new Error("@mulmoclaude/accounting-plugin: configureAccountingHost() must be called before the accounting View mounts");
  }
  return ctx;
}

export function hostApiCall<T = unknown>(path: string, opts: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown }): Promise<ApiResult<T>> {
  return requireCtx().apiCall<T>(path, opts);
}

export function hostSubscribe(channel: string, handler: (payload: unknown) => void): () => void {
  return requireCtx().subscribe(channel, handler);
}

/** The host's active i18n locale tag, read reactively by the plugin's own
 *  vue-i18n instance (see `./lang`). */
export function hostLocaleTag(): string {
  return requireCtx().localeTag();
}

/** The host's opaque project id for the mounted surface, or `null` when
 *  the host serves a single root (MulmoClaude) or the surface belongs to
 *  its default one. */
export function hostProjectScope(): string | null {
  return ctx?.projectScope?.() ?? null;
}
