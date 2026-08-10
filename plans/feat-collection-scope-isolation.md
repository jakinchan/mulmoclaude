# feat(core): a project root must not resolve a USER-scope collection

Written 2026-08-09 for an implementing agent. **In English**, continuing
`plans/feat-collection-multi-root-3.md` — the rest of `plans/` is Japanese.

The multi-root arc is otherwise finished: MulmoTerminal now serves collections from any project
directory (receptron/mulmoterminal#1571 … #1590). This is the last thing the ENGINE decides for a
host that has more than one root, and it needs a decision the host cannot express today.

**The rule the host owner stated, verbatim in effect:** `~` and a project are separate worlds.
Standing in `~/git/ai/mag2`, a collection under `~/.claude/skills` must not be reachable **at all**
— not listed, and not resolvable by slug. The reverse already holds (project scope is per root).

**MulmoClaude is unaffected.** It is one workspace and wants user scope merged into it exactly as
today; the change below is additive with a default that preserves that. Say so in the PR and name
what you ran.

---

## 1. What makes it reachable today

Both entry points read ONE global user dir and apply it to every root
(`packages/core/src/collection/server/discovery.ts`):

```ts
async function discoverCollections(opts = {}) {
  const userDir = opts.userSkillsDir ?? userSkillsDir();      // host binding: a plain string
  const userCollections = await collectFromDir(userDir, "user", workspaceRoot);
  // merged: feed, then user, then project — project wins a slug collision
}

async function loadCollection(slug, opts = {}) {
  const projectCollection = await loadOneCollection(projectSkillsDir(workspaceRoot), …);
  if (projectCollection) return projectCollection;
  const userCollection = await loadOneCollection(userDir, …);  // ← the fallback, for ANY root
  …
}
```

`paths.userSkillsDir` is `string`. A host with several roots cannot say "this one has no user
scope", so the fallback in `loadCollection` applies everywhere.

**A host-side filter on the LISTING would not do it**, which is why this is an upstream ask rather
than a MulmoTerminal patch. `loadCollection` is what `getSchema`, `getItems`, `putItems`, the
detail route, the view-token mint and the watcher all go through: hide the entry from a list and a
slug typed by the agent — or arriving in a URL — still resolves to the user-scope collection and
writes to its data dir. The guarantee has to hold where resolution happens.

## 2. The change

Make the user dir root-parameterised and nullable — **the same shape `skillsStagingDir` already
has**, added in core 3.1.0 for the same kind of "this root does not have that base" statement:

```ts
paths: {
  /** Absolute user-scope skills dir for a root, or `null` when this root has NO user scope.
   *
   *  A single-workspace host returns the same path for its one root and behaves exactly as
   *  before. A host serving several roots returns null for a project directory: `~` and a
   *  project are separate worlds, and a project that could resolve a machine-global collection
   *  would depend on something no clone of it can have. */
  userSkillsDir: (workspaceRoot: string) => string | null;
  …
}
```

- `discoverCollections`: skip the user pass when it is null. The merge order is otherwise
  unchanged (feed, user, project).
- `loadCollection`: skip the user fallback when it is null — so an unknown slug is a MISS, not a
  quiet hop into another world.
- The per-call `opts.userSkillsDir` should be able to say "none" too. Today `opts.userSkillsDir ??
  userSkillsDir()` cannot express it: `undefined` means "use the host's". Accept `null` for none,
  or keep the option purely for tests and let the host binding decide — either is fine, but say
  which in the JSDoc, because a caller that thinks it opted out and did not is exactly the failure
  this removes.

Everything else the user scope touches should follow the same answer for consistency — the write
targets, the archive path and the delete path all pick a base per root already, so grep
`userSkillsDir(` and check each call site rather than only the two above.

## 3. Consequences worth stating in the code

- **A slug collision stops being a collision.** Today a project's `tasks` shadows a user `tasks`
  (project wins the merge). With isolation there is no shadowing to reason about: a project sees
  its own, and nothing else.
- **A miss is a miss.** `loadCollection` returning null for a slug that exists only in user scope
  is the intended answer for a project root, and the host will surface it as "no such collection"
  — which is true, in that world.

## 4. Verifying

`packages/core` runs `tsx --test test/**/test_*.ts`; collection tests live in
`packages/core/test/collection/`.

1. **A project root with `userSkillsDir → null`**: `discoverCollections` lists only its own (and
   feeds), and `loadCollection` returns null for a slug that exists ONLY in user scope — the
   assertion that a listing filter could not make.
2. **A workspace root with a path**: both behave exactly as today, including a project slug
   shadowing a user one.
3. **Writes**: a `putSchema` / `putItems` for that user-only slug fails as "unknown collection"
   rather than writing into `~/.claude/skills` from a project.

Then MulmoTerminal binds `userSkillsDir: (root) => (isManagedWorkspace(root) ? <~/.claude/skills> : null)`
— the same one-line shape it already uses for `skillsStagingDir` — and brings its own skill
scanner (`server/backends/remoteHost/skills.ts`, which reads both dirs) into line.
