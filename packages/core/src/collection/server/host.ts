// Host binding for the server-side collection engine.
//
// The engine is parameterized over the host's workspace + services, but
// threading those through every call would be invasive. Instead each host
// (MulmoClaude, MulmoTerminal) configures the binding ONCE at startup via
// `configureCollectionHost`, and the engine reads it through the getters
// below. This keeps the existing call sites (which default to the live
// workspace root) unchanged while removing the package's dependency on
// host-only modules (`server/workspace/workspace.ts`, the host logger).

import { createForwardingLogger, createHostSlot, type StructuredLogger } from "../../host/hostSlot.js";

/** Public alias of the shared `StructuredLogger` — keeps the domain surface name-stable. */
export type CollectionLogger = StructuredLogger;

export interface CollectionHost {
  /** Absolute path to the host workspace root (e.g. `~/mulmoclaude`). The
   *  default root for every path/containment check that isn't given an
   *  explicit override.
   *
   *  `null` puts the binding in EXPLICIT-ROOT mode: the host declares that it
   *  always passes `opts.workspaceRoot` per call, and `getWorkspaceRoot()`
   *  throws instead of guessing. A multi-root host (MulmoTerminal, one root
   *  per project) wants this — there, a forgotten option is not a crash but a
   *  silent read/write against the WRONG project. A single-workspace host
   *  (MulmoClaude) passes a string and nothing changes. */
  workspaceRoot: string | null;
  /** Host logger; the engine logs under the `"collections"` prefix. */
  log: CollectionLogger;
  /** Host workspace layout — supplied as the host's own path helpers so the
   *  package owns no layout literals and works against a test/alt root. */
  paths: {
    /** Absolute user-scope skills dir (host-specific, e.g. `~/.claude/skills`). */
    userSkillsDir: string;
    /** Absolute project-scope skills dir for a workspace (`<root>/.claude/skills`). */
    projectSkillsDir: (workspaceRoot: string) => string;
    /** Absolute feeds-registry root for a workspace (`<root>/data/feeds`). */
    feedsRoot: (workspaceRoot: string) => string;
    /** Absolute project-skills *staging* dir for a workspace (`<root>/data/skills`). */
    skillsStagingDir: (workspaceRoot: string) => string;
    /** Workspace-relative archive dir (a removed collection's files move here). */
    archiveDir: string;
    /** Absolute path to the user-supplied extra-registries config file for a
     *  workspace (`<root>/config/collections-registries.json`). Injected so the
     *  registry engine owns no app layout literal and a downstream host can point
     *  it at its own workspace. */
    collectionsRegistriesConfig: (workspaceRoot: string) => string;
  };
  /** True for a preset-skill slug (host-owned naming convention). */
  isPresetSlug: (slug: string) => boolean;
}

/** A collection's records changed on disk. Carries the `slug` so the host can
 *  publish on a per-collection channel; `ids` lists the affected record ids
 *  when known (a consumer may ignore them and refetch the whole collection),
 *  and `op` is advisory. Deliberately carries NO record bodies — this is a
 *  "refetch" ping, not a data feed, so it stays cheap and leaks nothing when a
 *  host relays it into an opaque-origin custom-view iframe. */
export interface CollectionChangePayload {
  slug: string;
  /** Absolute workspace/project root the change happened under. Present only
   *  when the engine call carried an explicit `workspaceRoot`; absent means
   *  the host's configured root, so a single-workspace host never sets it.
   *  A multi-root host MUST key its live-update fan-out on `(root, slug)` —
   *  two projects each owning a `tasks` collection would otherwise refresh
   *  each other's open views. */
  root?: string;
  ids?: string[];
  op?: "upsert" | "delete";
}

type CollectionChangePublisher = (payload: CollectionChangePayload) => void;

/** Build a change payload, attaching `root` only when the engine call carried
 *  an explicit one. Centralised so every publish site states the root the same
 *  way, and so a single-workspace host's payload shape stays byte-identical to
 *  what it saw before multi-root support. */
export function collectionChangePayload(base: Omit<CollectionChangePayload, "root">, root: string | undefined): CollectionChangePayload {
  return root === undefined ? base : { ...base, root };
}

const hostSlot = createHostSlot<CollectionHost>("@mulmoclaude/core/collection/server: configureCollectionHost()");
let changePublisher: CollectionChangePublisher | null = null;

/** Wire the engine to a host. Call once at server startup, before any
 *  collection storage operation. Re-binding to a *different* host throws —
 *  silently redirecting later filesystem operations to another workspace
 *  would be a bug, not a feature. Re-calling with the same host is a no-op. */
export function configureCollectionHost(host: CollectionHost): void {
  hostSlot.set(host);
}

/** Wire a publisher that broadcasts record-change events; the host bridges it
 *  to its pubsub. Kept SEPARATE from `configureCollectionHost` because the
 *  host's pubsub instance isn't ready at host-binding time (the binding is set
 *  at the top of server startup, the pubsub later). Optional: left unset, every
 *  write is silent — the default for tests and for a host that doesn't want
 *  live view updates. Pass `null` to detach (test teardown). */
export function setCollectionChangePublisher(publish: CollectionChangePublisher | null): void {
  changePublisher = publish;
}

/** Broadcast a record-change event if a publisher is wired (no-op otherwise).
 *  Called from the write path (`writeItem`/`deleteItem`). The wired publisher is
 *  expected to be fire-and-forget (it wraps its own pubsub call in try/catch),
 *  so this stays a thin pass-through and never throws into the write. */
export function publishCollectionChange(payload: CollectionChangePayload): void {
  changePublisher?.(payload);
}

function requireHost(): CollectionHost {
  return hostSlot.get();
}

/** The configured workspace root. Throws if the host never configured one —
 *  and, under an explicit-root binding (`workspaceRoot: null`), throws rather
 *  than guessing, which is the whole point of that mode: on a multi-root host
 *  a missing `opts.workspaceRoot` must fail loudly instead of silently
 *  resolving against some other project. */
export function getWorkspaceRoot(): string {
  const root = requireHost().workspaceRoot;
  if (root === null) {
    throw new Error(
      "@mulmoclaude/core/collection/server: the host is bound in explicit-root mode (workspaceRoot: null), " +
        "so there is no ambient workspace root — pass an explicit `workspaceRoot` in this call's options.",
    );
  }
  return root;
}

// Workspace-layout accessors — thin wrappers over the host binding, named to
// match the host helpers they replace so the moved engine modules keep their
// call sites. Each throws (via requireHost) if the host never configured.
export function userSkillsDir(): string {
  return requireHost().paths.userSkillsDir;
}
export function projectSkillsDir(workspaceRoot: string): string {
  return requireHost().paths.projectSkillsDir(workspaceRoot);
}
export function feedsRoot(workspaceRoot: string): string {
  return requireHost().paths.feedsRoot(workspaceRoot);
}
export function skillsStagingDir(workspaceRoot: string): string {
  return requireHost().paths.skillsStagingDir(workspaceRoot);
}
export function archiveDir(): string {
  return requireHost().paths.archiveDir;
}
/** Absolute path to a workspace's `collections-registries.json`. Takes the
 *  root explicitly — reading the ambient one here would throw under an
 *  explicit-root binding and take the Discover tab down with it. */
export function collectionsRegistriesConfigPath(workspaceRoot: string): string {
  return requireHost().paths.collectionsRegistriesConfig(workspaceRoot);
}
export function isPresetSlug(slug: string): boolean {
  return requireHost().isPresetSlug(slug);
}

/** Logger proxy so engine modules can `import { log }` and use it exactly like
 *  the host logger — each call forwards to the live host binding. Logging is
 *  non-critical, so calls before the host configures a binding (e.g. unit tests
 *  that exercise pure logic) are dropped rather than throwing — unlike
 *  `getWorkspaceRoot()`, which fails loudly because the engine cannot operate
 *  without a workspace root. */
export const log: CollectionLogger = createForwardingLogger(() => hostSlot.peek()?.log ?? null);
