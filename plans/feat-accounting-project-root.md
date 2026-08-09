# feat(accounting-plugin): make the accounting engine safely multi-root

Written 2026-08-09. **In English**, like its two siblings
(`feat-collection-multi-root.md`, `feat-collection-multi-root-2.md`) — the rest of `plans/`
is Japanese.

## Why

MulmoTerminal's project work (`../mulmoterminal/plans/project-architecture.md` §5) treats
collections / accounting / wiki / resources as **one** problem: every shared subsystem is
bound at boot to one process-wide workspace root, and the fix is the same in each — replace
the boot-time binding with a per-request root resolution. Collections went first
(`@mulmoclaude/core@3.0.0` and `3.1.0`). Accounting is next, and MulmoTerminal's own
comment in `server/backends/accounting.ts` predicted the seam:

> The single-root DI … is exactly what the FOCUSED freelance product wants. A generic
> accounting-in-MulmoTerminal would later swap this for a per-request cwd resolver.

This PR is the upstream half — the part MulmoTerminal cannot do for itself. Whether
accounting SHOULD follow the selected project is still MulmoTerminal's product decision
(D7 keeps it workspace-bound, and hides the panel outside the workspace, until then); this
change only removes the technical reason it cannot.

**MulmoClaude's behaviour does not change.** It is a single-workspace host, it wires none
of the new options, and every item is additive with a default that preserves today's path.

## What shipped

All inside `packages/plugins/accounting-plugin`, mirroring the collection engine's shape so
a host wires both the same way.

1. **Explicit-root mode.** `AccountingServerDeps.workspaceRoot` widens to `string | null`.
   With `null`, `defaultWorkspaceRoot()` throws instead of guessing — because with N roots a
   forgotten option is not a crash but a silent read or write against the wrong project.
2. **A per-request root.** `createAccountingRouter({ resolveWorkspaceRoot })` — a host-owned
   resolver — and the root threaded through every one of the 15 dispatch actions into the
   service layer, which was already root-parameterised end to end.
3. **Channel names carry the scope.** `bookChannel(bookId, scope?)` / `booksChannel(scope?)`,
   fed by `AccountingServerDeps.channelScopeForRoot`. A bookId is unique within a root and
   nowhere else, so without this a write to `main` in project A refreshes an open view of
   `main` in project B. Unscoped the names are byte-identical to today's.
4. **The rebuild queue is keyed by `(root, bookId)`**, not by bookId. Two projects holding a
   book of the same name previously shared one queue: B's write would cancel A's rebuild and
   `awaitRebuildIdle` would return while the other project's rebuild was still writing.
5. **The card envelope carries the scope.** `openBook` stamps the host's opaque project id,
   so a mounted card fetches ITS OWN project rather than whatever the host has selected when
   it renders. Absent for a single-root host.
6. **The Vue surface can be scoped**: `configureAccountingHost({ …, projectScope })` — the
   opaque id rides dispatch requests as `ACCOUNTING_PROJECT_FIELD` and namespaces the
   channels the View subscribes to.
7. **Remote-host prep.** `createListAccountingBooks` resolves a scope from its params,
   defaulting to the host root, so the day a phone can pick a project the parameter is
   additive and no handler changes (the §8 shape from the collections round).

### The rules the shape encodes

- **A project is named by an opaque id, never a path.** Channel names and card envelopes
  reach the browser; a root there publishes the user's home directory.
- **The model never picks a project.** `manageAccounting`'s schema has no project parameter
  — pinned by `test/plugins/test_accounting_tool_schema.ts` — and the package never reads a
  root or project off a request body. Only the host's own resolver does.
- **A bookId is unique within a root and nowhere else.** Anything keyed by bookId alone is a
  cross-project collision waiting to happen.

## Not in scope

- MulmoClaude app code, workspace layout, storage formats, route paths (`/api/accounting`
  stays one dispatch route; a project rides the body, not the URL).
- Whether MulmoTerminal shows accounting per project — its product decision, and its own
  work: the host flag wiring, `resolveProjectRoot` reuse, and the per-project panel.
- Wiki and resources, the other two subsystems in the same family.

## Testing

`packages/plugins/accounting-plugin/test/accounting/test_multiRoot.ts` covers two-root
isolation through the real router, the explicit-root throw, scope-namespaced channels, the
stamped card envelope, per-`(root, bookId)` queues, and — the item that protects MulmoClaude
— a single-root host whose channels, envelope and request bodies are unchanged.

## Delivery

`@mulmoclaude/accounting-plugin` 2.1.0 → **2.2.0** (every change is additive), the launcher's
declared range swept in the same PR. MulmoTerminal picks it up with a version bump and does
its side.
