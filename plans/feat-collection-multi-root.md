# feat(core/collection): make the collection engine safely multi-root

Written 2026-08-08 for an implementing agent. **In English at the requester's instruction** —
note that the rest of `plans/` is Japanese.

## Why

MulmoTerminal wants a collection to live in **any project directory**, not only the one shared
workspace. Investigation of `packages/core/src/collection/server/` showed the engine is **already
root-parameterized end to end** — every entry point takes `opts.workspaceRoot` and falls back to
the host binding. So MulmoTerminal needs only a small number of upstream changes before it can
resolve a root per request.

**MulmoClaude's own behaviour must not change.** It is a single-workspace app, it will keep
passing no root, and every item below is additive with a default that preserves today's path.

## Scope

Four items, all inside `packages/core`. Do NOT change route shapes, the on-disk layout, or the
`configureCollectionHost` re-binding guard (re-binding to a different host must keep throwing —
we are not re-binding, we are passing arguments).

---

### U1. `CollectionChangePayload` must carry the root *(required — correctness)*

`packages/core/src/collection/server/host.ts:52`

```ts
export interface CollectionChangePayload { slug: string; ids?: string[]; op?: "upsert" | "delete"; }
```

The live-update ping is keyed by **slug alone**. Once two roots each own a `tasks` collection, a
write under root A refreshes an open view of root B's `tasks`. Today this cannot happen (one
root); with MulmoTerminal it is a live bug.

**Do:** add an optional root to the payload and supply it at every publish site.

```ts
export interface CollectionChangePayload {
  slug: string;
  /** Absolute workspace/project root the change happened under. Absent means
   *  the host's configured root (single-workspace hosts never set it). */
  root?: string;
  ids?: string[];
  op?: "upsert" | "delete";
}
```

Publish sites to update:

- `collection/server/io.ts:207`, `:222` — the root is available as `opts.workspaceRoot`
- `collection/server/sqliteStore.ts:274`, `:293` — same, via the store's options
- `collection-watchers/watcher.ts:329`, `:346`, `:542` — **check what the watcher was configured
  with.** `LoadedCollection` carries only absolute paths (`dataDir`, `skillDir`), not a root, so
  thread the root the watcher was started for rather than deriving one from a path. If a site
  genuinely has no root in scope, leave the field undefined and say so in the PR — do not invent
  one from string manipulation.

**Acceptance:** a test that publishes from two roots and asserts each payload carries its own
root; MulmoClaude's publisher, which reads only `slug`/`ids`/`op`, still compiles and behaves
identically.

---

### U2. A strict mode with no ambient root *(strongly recommended — safety)*

This is the highest-value item and the reason the rest is safe.

Today a forgotten `opts.workspaceRoot` silently falls back to the host's workspace. In a
single-workspace app that is correct. In MulmoTerminal, with N project roots, a missed option is
**not a crash — it reads or writes the wrong project's data with no error anywhere**: tests pass,
types pass, the wrong files change.

**Do:** let a host declare that it always passes roots explicitly, after which `getWorkspaceRoot()`
**throws** instead of guessing.

Suggested shape (`host.ts`) — pick whichever fits `createHostSlot` best, but keep the default
behaviour identical:

```ts
export interface CollectionHost {
  /** Absolute default root, or `null` for a host that always passes an explicit
   *  root per call. With `null`, `getWorkspaceRoot()` throws rather than guessing. */
  workspaceRoot: string | null;
  …
}
```

Care is needed at two places that read the ambient root **unconditionally**:

1. `host.ts:117 collectionsRegistriesConfigPath()` — `host.paths.collectionsRegistriesConfig(host.workspaceRoot)`.
   Under a null root this would throw and break the Discover tab. **Give it an explicit root
   parameter** (`collectionsRegistriesConfigPath(root: string)`), and update its single caller
   `collection/registry/server/registriesConfig.ts:112`.
2. `collection/server/paths.ts:87 isContainedInWorkspace()` — see U3.

Everything else already uses `opts.workspaceRoot ?? getWorkspaceRoot()` and needs no change.

**Acceptance:** with a null-root host configured, any engine call made without an explicit root
throws a clear error naming the missing option; with a string root, behaviour is byte-identical to
today. MulmoClaude keeps passing a string and is unaffected.

---

### U3. Remove or parameterize `isContainedInWorkspace()` *(hygiene)*

`collection/server/paths.ts:87`

```ts
export function isContainedInWorkspace(absPath: string): boolean {
  return isContainedInRoot(absPath, getWorkspaceRoot());
}
```

**It has zero callers.** It is also exactly the helper a future contributor would reach for, at
which point containment is silently checked against the wrong root — the failure U2 exists to
prevent. Delete it (preferred), or give it a required root parameter.

The pure `isContainedInRoot(absPath, rootPath)` stays as is; it is already correct.

---

### U4. Document the multi-root contract *(cheap, prevents regression)*

The `opts.workspaceRoot ?? getWorkspaceRoot()` pattern is currently an unstated convention. Once
MulmoTerminal depends on it, a new entry point that reads the ambient root directly silently
breaks project isolation.

**Do:** state the contract in the module header of `collection/server/index.ts` — *every exported
entry point that touches the filesystem must accept a root override; the host binding is a
default, not the source of truth* — and add a test that fails if a new engine call ignores an
explicit root (e.g. run a representative set of entry points against a `mkdtempSync` root and
assert nothing touched the configured one).

---

## Non-goals

- Route shapes / API paths — collection HTTP routes are host-owned. `src/config/apiRoutes.ts` stays
  as it is; MulmoTerminal will carry the project as an optional query parameter on the same paths.
- Multi-root **discovery merge policy** (which roots to scan, whether user scope merges in) — that
  is a host decision, expressed through the options already available.
- Any change to MulmoClaude's app code, workspace layout, or storage formats.

## Testing

Runner: `packages/core` uses `tsx --test test/**/test_*.ts`. Collection engine tests live in
`packages/core/test/collection/`, watcher tests in `packages/core/test/collection-watchers/`.

Add:

1. **Two-root isolation** — discover and write against two `mkdtempSync` roots in one process;
   assert no bleed in either direction. This is the test the current architecture cannot express
   and the one that pins the whole change.
2. **Strict mode** — a null-root host; an engine call without a root throws; the same call with an
   explicit root succeeds.
3. **Payload root (U1)** — writes under two roots publish payloads carrying their own root.
4. **Back-compat** — with a string-root host and no explicit overrides, existing behaviour is
   unchanged (the existing suite passing is most of this; add an explicit pin if cheap).

Run `yarn test`, `yarn typecheck`, `yarn lint` in `packages/core`.

## Delivery

- One PR against `packages/core`, with the four items separable by commit.
- MulmoClaude's behaviour must be unchanged; say so explicitly in the PR body and name what you
  ran to confirm it.
- Publish a new `@mulmoclaude/core`; MulmoTerminal picks it up with a version bump and does the
  rest of the work on its side (`resolveProjectRoot`, threading the root through ~30 routes,
  re-keying tokens/caches/channels by `(root, slug)`).

## Context

The consumer-side plan, including why the workspace becomes just another project and what
self-containment (git clone parity) requires, is
`../mulmoterminal/plans/feat-collections-project-root.md`.
