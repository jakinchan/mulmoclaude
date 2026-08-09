# feat: the last two upstream pieces multi-root needs

Written 2026-08-09 for an implementing agent. **In English**, continuing
`plans/feat-collection-multi-root-2.md` — the rest of `plans/` is Japanese.

`@mulmoclaude/core@3.1.0` (receptron/mulmoclaude#2844) made the engine multi-root, and
MulmoTerminal has now built the host side on it: per-root watchers, project-scoped bells, a
Collections pane per directory, a clone-portability check (receptron/mulmoterminal#1571, #1572,
#1573, #1578, #1579, #1580, #1582).

Two things it cannot finish, because they are ours. Both are small. Both were found by building
against 3.1.0 and hitting the wall, not by reading.

**MulmoClaude's behaviour must not change.** It is a single-workspace host; both items are
additive with a default that preserves today's path. Say so in the PR and name what you ran.

---

## 1. `AgentWorkerRunner` must carry the root *(required — a silent wrong-directory write)*

**The bug, end to end.** `refreshViaAgent` (`packages/core/src/feeds/server/…`) builds the worker's
seed prompt with `promptPathsFor`, which emits `dataPath` **straight from the schema** — i.e.
root-RELATIVE (`data/collections/<slug>/items`). It then calls the host's `spawnWorker` with:

```ts
{ message, roleId, hidden, onComplete }   // no root
```

The host therefore cannot know which root the refresh was for, and MulmoTerminal's runner spawns
the agent with no cwd — in its workspace. So scheduling a feed refresh for a PROJECT root makes the
worker resolve `data/collections/<slug>/items` against the **workspace** and write into the
workspace's same-named collection. Silent, and into another project's data.

MulmoTerminal shipped the per-root registration, review caught this, and it was **reverted**
(receptron/mulmoterminal#1582, commit `26ca37ae` reverted by `07b0c086`). Declarative RSS/JSON feeds
were never at risk — they fetch and write through the engine under the explicit root — but a host
cannot register only those, because the refresh walks a root's collections internally.

**The change.** Add `workspaceRoot` to the `AgentWorkerRunner` argument object and pass the root
`refreshViaAgent` already has:

```ts
export type AgentWorkerRunner = (args: {
  message: string;
  roleId: string;
  hidden: boolean;
  /** The root this refresh is for. A multi-root host spawns the worker THERE — the prompt's
   *  `dataPath` is relative to it. Absent/ignored by a single-workspace host. */
  workspaceRoot?: string;
  onComplete?: ((outcome: { didError: boolean }) => void | Promise<void>) | undefined;
}) => Promise<AgentWorkerResult>;
```

Optional, so MulmoClaude's runner compiles and behaves identically. MulmoTerminal then forwards it
as the spawn's cwd and re-lands its reverted commit as written.

**Worth considering while you are there:** `promptPathsFor` emitting a root-relative `dataPath`
with no statement of what it is relative to is the underlying sharpness. Making the paths block
carry the root (or absolute paths) would remove the class rather than this instance — but it
changes a prompt both hosts serve, so it is a separate decision, not a drive-by.

## 2. `@mulmoclaude/collection-plugin` must read `PresentCollectionData.scope` *(required — then publish)*

core 3.1.0 ships `withCardScope` (`packages/core/src/collection/core/presentCollection.ts`) and the
`scope` field on `PresentCollectionData`, and the executor deliberately DROPS a `scope` supplied in
tool arguments so the model cannot choose a project. Nothing reads it yet:

- `packages/plugins/collection-plugin/src/vue/chat/View.vue` derives only
  `slug = data.value?.collectionSlug` and passes that down. `data.value?.scope` is never read.
  Same for `Preview.vue`.
- So a card fetches through the host binding's ambient project, whatever produced the card.

**The change.** Thread `data.scope` from `PresentCollectionData` into the fetches the card makes,
so a card carries the project it was made for. Then **publish** — the package's `package.json`
already requires `@mulmoclaude/core@^3.1.0` while the published version is **3.0.0** with peer
`^3.0.0`, so MulmoTerminal is pinned to a build that predates the field. Recipe:
`plans/chore-publish-plugins-core3.md`.

MulmoClaude is unaffected: one root, so `scope` is absent and the card fetches exactly as now.

MulmoTerminal's cards are correct TODAY for the case that matters — one panel, one session's work
(receptron/mulmoterminal#1579 scopes at the surface). What this unlocks is two cards from two
projects in the same panel.

---

## 3. A question, not a task: rooted vs root-less bell ids

Both apps share one notifier file. Since core 3.1.0, a bell id encodes the root when the engine
call carried one — and MulmoTerminal passes a root on every call, while MulmoClaude passes none. The
sweep is asymmetric by design (`sweepVerdict`): MulmoTerminal's rooted sweep clears a root-less
entry as `drop-legacy` and republishes, but MulmoClaude's root-less sweep `skip`s a rooted one.

So alternating between the two apps on the same workspace can leave a bell MulmoClaude will never
clear. It is pre-existing (since receptron/mulmoterminal#1571) and follows from the documented
design; nobody has confirmed whether it is intended. **Confirm or file it** — no code change is
proposed here.

---

## Verifying

1. **Item 1** — a unit test that `refreshViaAgent` passes the root it was called with through to
   `spawnWorker`, plus one that an omitted root still reaches a runner that does not declare the
   parameter (the MulmoClaude shape).
2. **Item 2** — a card whose `scope` names a project fetches under that project; a card without one
   behaves exactly as before.
3. Then bump `@mulmoclaude/core` and `@mulmoclaude/collection-plugin` in MulmoTerminal and re-land
   `26ca37ae` there.
