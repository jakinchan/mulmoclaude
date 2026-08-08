# Changelog

Newest first. Each entry corresponds to a tagged release. Written in English.

## @mulmoclaude/core@2.2.0 — 2026-08-08

Makes the server-side collection engine safely multi-root, so a downstream host (MulmoTerminal) can serve a collection out of any project directory. MulmoClaude's behaviour is unchanged — it is a single-workspace host, it keeps passing no root, and every item is additive with a default that preserves today's path.

### From `plans/feat-collection-multi-root.md`

- `CollectionChangePayload` gained an optional `root`, stamped at every publish site (`io.ts`, `sqliteStore.ts`, `collection-watchers/watcher.ts`) with the root the call was given. Absent means "the host's configured root", so a single-workspace host's payload shape is byte-identical to before. Without it, a write to project A's `tasks` refreshes project B's open `tasks` view.
- `CollectionHost.workspaceRoot` accepts `null` — EXPLICIT-ROOT mode. A host that always passes `opts.workspaceRoot` binds `null`, after which `getWorkspaceRoot()` throws instead of silently resolving against another project.
- `collectionsRegistriesConfigPath()` now takes the root explicitly; the registries-config read chain (`loadRegistriesConfig`, `listRegistries`, `findRegistry`, `fetchAllRegistries`, `rawBaseForEntry`, `fetchManifest`, `fetchBundle`, `previewCollection`, `listRegistry`) accepts an optional `RegistryScope` so Discover works under an explicit-root binding. All parameters are optional and default to the host root.
- Removed `isContainedInWorkspace(absPath)` from `@mulmoclaude/core/collection/server`. It had zero callers and checked containment against the AMBIENT root — exactly the silent-wrong-project failure the rest of this change exists to prevent. Use the pure `isContainedInRoot(absPath, rootPath)`.
- The multi-root contract is now stated in the `collection/server/index.ts` module header and pinned by `test/collection/test_multiRoot.ts`.

📦 **npm**: [`@mulmoclaude/core@2.2.0`](https://www.npmjs.com/package/@mulmoclaude/core/v/2.2.0)

## @mulmoclaude/core@0.8.2 — 2026-07-04

Restores the `computeCollectionIcon` export that was published to the workspace source in PR #1957 (dynamic collection icons) but never reached the npm tarball. The mulmoclaude launcher's tarball smoke was failing with `SyntaxError: does not provide an export named 'computeCollectionIcon'` on every push against `@mulmoclaude/core@0.8.1`.

### From PR #1957 — feat(collections): dynamic collection icons based on data state

- Collection schemas can declare an optional `dynamicIcon` block; launcher shortcut icons then reflect the current state of a source collection's data (weather forecast, todo completion state, etc.).
- Reuses the existing `CollectionWhen` `{field, in}` predicate for `rules`; absent `dynamicIcon` = static `schema.icon` (unchanged).
- New public exports on `@mulmoclaude/core/collection/server`: `computeCollectionIcon`.
- New public exports on `@mulmoclaude/core/collection`: `dynamicIcon.ts` pure resolver + `where.ts` predicate helper.
- `CollectionSummary.iconSources` tells the client which collection channels to watch for reactive icon refresh.

📦 **npm**: [`@mulmoclaude/core@0.8.2`](https://www.npmjs.com/package/@mulmoclaude/core/v/0.8.2)
