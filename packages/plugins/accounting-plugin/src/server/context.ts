// Host-injected runtime context for the accounting server surface.
//
// The backend can't reach into the host for the workspace root, the
// pub/sub instance, or the logger — those are host-specific. The host
// injects them once via `configureAccountingServer(...)` before
// mounting the router (server/index.ts), the server-side mirror of the
// Vue surface's `configureAccountingHost`. MulmoTerminal wires its own.
//
// `log` is a thin proxy that forwards to the injected logger so the
// many `log.warn("accounting", …)` call sites across the service layer
// stay unchanged. Before configuration (and in unit tests that drive
// the service with an explicit workspace root) it falls back to a
// console logger so nothing throws.

import type { StructuredLogger } from "@mulmoclaude/common";

/** Minimal pub/sub shape — structurally compatible with the host's
 *  `IPubSub`. The eventPublisher holds its own instance (set via
 *  `initAccountingEventPublisher`); this type is the contract. */
export interface IPubSub {
  publish: (channel: string, payload: unknown) => void;
}

/** Alias of the shared `StructuredLogger` — the host `Logger` stays directly assignable when injected. */
export type AccountingLogger = StructuredLogger;

export interface AccountingServerDeps {
  /** Absolute path to the workspace root (where `data/` lives). Used as
   *  the default when a service/io call doesn't pass an explicit root.
   *
   *  `null` declares STRICT mode: this host always passes an explicit
   *  root per call, and `defaultWorkspaceRoot()` throws instead of
   *  guessing. A multi-root host (MulmoTerminal, one root per project
   *  directory) MUST use it — with N roots a forgotten option is not a
   *  crash but a silent read/write against the wrong project. Mirrors
   *  `CollectionHost.workspaceRoot: string | null` in
   *  `@mulmoclaude/core/collection/server`. */
  workspaceRoot: string | null;
  logger: AccountingLogger;
  /** Optional: map an absolute root to the OPAQUE scope id the host uses
   *  for that project, used to namespace pub/sub channel names so two
   *  roots owning one bookId do not cross-notify. Return `null` for the
   *  host's default root, which keeps channel names byte-identical to a
   *  single-root host's (`accounting:<bookId>`).
   *
   *  It must be an opaque id, NEVER a path: channel names reach the
   *  browser, and an absolute root there publishes the user's home
   *  directory to the client. Same rule as a collection view token. */
  channelScopeForRoot?: (workspaceRoot: string) => string | null;
}

let deps: AccountingServerDeps | null = null;

/** Called once by the host before the accounting router is mounted. */
export function configureAccountingServer(context: AccountingServerDeps): void {
  deps = context;
}

/** Default workspace root for io calls that don't pass one explicitly.
 *  Throws if the host never configured the server — a real wiring bug
 *  (unit tests always pass an explicit root, so they never hit this) —
 *  and also under STRICT mode (`workspaceRoot: null`), where there is no
 *  ambient root to fall back to and a missing option is a bug rather
 *  than a default. */
export function defaultWorkspaceRoot(): string {
  if (!deps) {
    throw new Error("@mulmoclaude/accounting-plugin: configureAccountingServer() must be called before serving accounting requests");
  }
  if (deps.workspaceRoot === null) {
    throw new Error(
      "@mulmoclaude/accounting-plugin: this host is configured with workspaceRoot: null (explicit-root mode), so every call must pass a workspaceRoot. A call reached the engine without one.",
    );
  }
  return deps.workspaceRoot;
}

/** The opaque channel scope for a root, or `null` when the host declared
 *  none (single-root hosts, and a multi-root host's default root). Used
 *  by the event publisher; never contains a path.
 *
 *  A missing root throws under explicit-root mode, exactly as
 *  `defaultWorkspaceRoot()` does. Returning `null` there would be worse
 *  than the io-path bug it mirrors: the event would go out on the
 *  UNSCOPED channel name, which every project's default-scope
 *  subscriber receives. The publisher catches it and logs, so a dropped
 *  root costs one event and a warning rather than a silent cross-project
 *  notification. */
export function channelScopeFor(workspaceRoot?: string): string | null {
  if (!deps?.channelScopeForRoot) return null;
  return deps.channelScopeForRoot(workspaceRoot ?? defaultWorkspaceRoot());
}

/** Whether the host declared project scoping at all.
 *
 *  The difference matters where a card records the project it belongs
 *  to: on a scoped host, "no scope" is a REAL answer (the default root)
 *  and must be recorded as `null`, not left out — an omitted field means
 *  "ask the host what is active now", which is precisely the drift a
 *  pinned card exists to prevent. On an unscoped host the field is left
 *  out entirely and every payload stays byte-identical to today's. */
export function isProjectScopedHost(): boolean {
  return Boolean(deps?.channelScopeForRoot);
}

const consoleLogger: AccountingLogger = {
  error: (namespace, msg, data) => console.error(`[${namespace}] ${msg}`, data ?? ""),
  warn: (namespace, msg, data) => console.warn(`[${namespace}] ${msg}`, data ?? ""),
  info: () => {},
  debug: () => {},
};

/** Logger proxy — forwards to the injected logger, console fallback
 *  before configuration. Lets call sites keep `log.warn("accounting", …)`. */
export const log: AccountingLogger = {
  error: (namespace, msg, data) => (deps?.logger ?? consoleLogger).error(namespace, msg, data),
  warn: (namespace, msg, data) => (deps?.logger ?? consoleLogger).warn(namespace, msg, data),
  info: (namespace, msg, data) => (deps?.logger ?? consoleLogger).info(namespace, msg, data),
  debug: (namespace, msg, data) => (deps?.logger ?? consoleLogger).debug(namespace, msg, data),
};
