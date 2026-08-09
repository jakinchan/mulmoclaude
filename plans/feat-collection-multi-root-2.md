# feat(core): finish multi-root — identity, the authoring docs, and per-root operation

Written 2026-08-09 for an implementing agent. **In English at the requester's instruction** —
the rest of `plans/` is Japanese.

Follow-up to `plans/feat-collection-multi-root.md` (shipped as `@mulmoclaude/core@3.0.0`,
receptron/mulmoclaude#2838). That change made the collection ENGINE multi-root: every entry point
takes a root, and a host may bind `workspaceRoot: null` so a forgotten one throws.

MulmoTerminal then built on it (receptron/mulmoterminal#1571, #1572, #1573) and reached the point
where a collection genuinely lives in any project folder. Using it surfaced what the first pass
missed, and it is one thing said six ways:

> **A collection's identity became `(root, slug)`. Everything that REFERS to a collection across a
> boundary still carries the slug alone** — including the authoring documentation both hosts serve
> to the agent.

This document is meant to be the last upstream round trip for this feature, so it lists every item
found, including the ones that are documentation rather than code. Read §1 first: it is the one
that silently produces collections that can never be discovered.

**MulmoClaude's behaviour must not change.** It is a single-workspace host; every item below is
additive with a default that preserves today's path. Say so in the PR and name what you ran.

---

## 1. The authoring guide tells the agent to write where only a workspace can *(required)*

`packages/core/assets/helps/collection-skills.md` is served to the agent by `manageCollection`'s
`schemaDocs` action — **in both hosts**. It says, emphatically and repeatedly:

> - **Author under `data/skills/<slug>/`, NEVER `.claude/skills/<slug>/`** … Writing under
>   `data/skills/` has no such gate; the bridge hook mirrors it for you

That is correct **for the managed workspace**, where `.claude/` is behind a permission gate and
`@mulmoclaude/core/skill-bridge` mirrors an allowlist across. It is wrong everywhere else, and in
MulmoTerminal it fails silently and completely:

1. the agent writes `<project>/data/skills/<slug>/schema.json`, as instructed;
2. **MulmoTerminal wires no skill bridge** (its PR5 was deferred), so nothing mirrors it;
3. discovery scans `<root>/.claude/skills`, so the collection **is never discovered**;
4. and the tree left behind is exactly the stray staging dir that shadows a committed skill (§2).

The agent did as it was told and produced nothing, with no error anywhere.

**Do:** make the authoring instructions root-dependent, and let `schemaDocs` pick.

- `manageCollection` already knows its root (`deps.workspaceRoot`), and `schemaDocs` is one of its
  actions, so the selection can happen there — no new host injection required.
- The host must be able to say which kind of root it is. Add ONE deps flag rather than having the
  package guess, e.g. `stagedSkillAuthoring: boolean` (default `true`, which is MulmoClaude's and
  today's behaviour). MulmoTerminal passes `true` only for its managed workspace.
- Split the affected passages so the two variants share everything else. The affected lines in
  `collection-skills.md` today: **18, 23, 37-43, 52-54, 1023, 1139-1149, 1176** (author-here
  instructions and the worked example), plus the `dataPath` row at **130**.
- The non-staged variant says: author directly under `<root>/.claude/skills/<slug>/`
  (`schema.json`, `SKILL.md`, `templates/`, `views/`), because there is no gate to route around
  and **no bridge to mirror**; and a `data/skills/` tree in such a root is not merely useless but
  harmful (§2).

**Also root-relative, not workspace-relative,** in the same file and its siblings — the wording is
load-bearing because it tells the agent what paths are legal:

- `collection-skills.md:130` `dataPath` — "Workspace-relative … Must stay under the workspace" →
  root-relative, must stay under the collection's own root. Same for `dataSource.path` (131) and
  the `image` / `file` field docs (237-255).
- `feeds.md:19,123` — "the workspace is the database", and the `feeds/<slug>/` layout.
- `custom-view.md:199` — an `image` field stores "a **workspace path**".
- Check the rest of `assets/helps/*.md` for the same phrasing; the ones that mention a workspace
  are listed by `grep -ln "data/skills\|~/mulmoclaude\|workspace" *.md`.

**Acceptance:** with `stagedSkillAuthoring: false`, `schemaDocs` never tells the agent to write
under `data/skills`, and its worked example writes `.claude/skills/<slug>/schema.json`. With the
flag absent or `true`, the text is byte-identical to today (assert that: it is what protects
MulmoClaude).

---

## 2. `skillsStagingDir` must be able to say "there is no staging here" *(required, was U5)*

`CollectionHost.paths.skillsStagingDir: (root) => string` cannot express "this root has no staging
tree", so a host must hand back SOME path for every root. That matters because the engine reaches
for staging in four places, one of which deletes:

| where | what it does | guarded? |
|---|---|---|
| `collection/server/skillAssets.ts:55` | lists `<staging>/<slug>` as the FIRST read base for a `source: "project"` collection | **no** — a stray file there wins over the real skill |
| `collection/server/views.ts:57,70` | `canonicalBase` / `schemaWriteTargets` | yes (only when `<staging>/schema.json` exists) |
| `collection/server/delete.ts:66,87,179` | staging dir for archive/read | yes (`pathExists`) |
| `collection/server/delete.ts:210` | **`rm -rf <staging>/<slug>`** (`force: true`) | no — relies on the path being staging |

**Do:** widen to `(root) => string | null`; when null, skip the staging base entirely (the read
list becomes `[collection.skillDir]`, the write targets `[active]`, and the delete does not run).

**Do NOT let a host fake it** by returning the skill dir for non-workspace roots. It looks
equivalent — the read list becomes the same dir twice — but `delete.ts:210` would then `rm -rf`
the skill dir under the name "staging". It works by accident today only because the next line
removes it anyway.

**Acceptance:** a null-staging host discovers, reads, writes and deletes a project collection
correctly, and a stray `<root>/data/skills/<slug>/views/x.html` does NOT shadow the committed
`<root>/.claude/skills/<slug>/views/x.html`. A string-staging host is unchanged.

---

## 3. Bell identity and deep links carry only the slug *(required — cross-app)*

`completionLegacyId(slug, itemId)` and the host adapter's `buildNavigateTarget(slug, itemId)` /
`buildPluginData` identify a completion bell by slug alone. Two roots owning one slug therefore
collide **on a host-facing contract**, not merely in a map — and the notifier file
(`<ws>/data/notifier/active.json`) is SHARED between MulmoClaude and MulmoTerminal, which is why
mulmoterminal#1571 deliberately deferred watcher concurrency rather than re-key a private map.

**Do:** thread the root into the completion identity and the navigate target.

- Extend `completionLegacyId` to take an optional root and include it in the id **only when
  present**, so a single-workspace host's ids are byte-identical and existing `active.json`
  entries keep matching. `parseCompletionLegacyId` must accept both forms.
- Give the navigate target an optional project so a host can deep-link into the right one. The
  target is host-built (`CollectionNotificationAdapter`), so the package's job is to pass the root
  through to the adapter rather than to invent MulmoTerminal's URL shape.
- **State the compatibility rule in the code**, not just the PR: both apps read one file, they
  never run simultaneously, and an id written by one must not duplicate a bell for the other.

**Acceptance:** with no root supplied, every id and target is byte-for-byte what it is today
(assert it); with two roots, one slug and one itemId, the two bells do not dedupe into each other.

---

## 4. The watcher is one generation per process *(required for MulmoTerminal)*

`collection-watchers/watcher.ts` holds one module-level generation (`watchers`, `itemSlots`,
`collectionSlots`, the timers, `discoveryOpts`). #2838 made a second start for a different root
throw (`WATCHER_ROOT_CONFLICT`) instead of silently leaving it unwatched, which was the right
first move — but it means a host can watch exactly one root.

That is not cosmetic: the watcher is **the only producer of change events for records the agent
writes directly**, which its own header calls the canonical pattern. In MulmoTerminal, a project's
collections therefore have no live refresh and no completion bells.

**Do:** support concurrent roots — a watcher instance per root rather than module globals, with
`stopCollectionWatchers()` scoped to one.

**This depends on §3.** Two roots owning one slug collide on the bell identity before they collide
in the watcher, so re-keying the maps alone would trade a loud failure for a quiet one. Land §3
first, and keep the `WATCHER_ROOT_CONFLICT` refusal until concurrency is actually correct — a host
that cannot serve two roots must keep saying so.

**Acceptance:** two roots watched at once, each publishing its own root on its payloads, each
producing bells that do not dedupe into the other's; a single-root host behaves as today,
including `stop()` → `start(otherRoot)`.

---

## 5. A rendered collection card does not know its root *(required)*

`presentCollection` passes only a slug — the card SELF-FETCHES the collection rather than
rendering a snapshot. The host then resolves that fetch through its own binding, and in
MulmoTerminal the binding resolves whichever project is *currently* selected, which may be none by
the time the card renders. A card made in one folder can read another's data.

### The agent's parameters do NOT change

`presentCollection({ slug })` stays exactly as it is, and the tool schema must not grow a
`project`. A project id is an opaque value the SERVER derives from a path: an LLM has no way to
know one, and accepting one from the caller would make the client the source of the root — the
thing every other part of this feature refuses. The same reasoning already settled the agent's
data plane: MulmoTerminal session-scopes `manageCollection` at dispatch and its arguments are
untouched (mulmoterminal#1573).

### What changes instead

1. **The host stamps the scope onto the tool result** at dispatch, resolving session → cwd → root
   — the same resolution `manageCollection` uses. Nothing in the agent's call changes.
2. **The card payload carries that opaque scope**, and the View self-fetches WITH it instead of
   depending on whatever the host has selected when it renders.
3. **Card identity becomes `(project, slug)`, in BOTH places that define it.** Today it is the slug
   alone, in `collectionIdentity` (canvas collapse) and in `reconcileCollectionCard` (dropping a
   browser-seeded placeholder once the agent's real card lands). The host code says outright that
   these are two rules over ONE notion of "the same collection" — so they must move together, or
   two `tasks` cards from two folders collapse into one.

### Back-compat

A payload with no scope means the host's configured root, so the identity string, the
reconciliation and MulmoClaude's behaviour are byte-identical to today.

**Acceptance:** absent, payload + reconciliation unchanged; present, two same-slug cards from
different roots stay two cards and each fetches its own; the agent's tool schema is unchanged
(assert the definition, so a later "helpful" parameter is a test failure).

---

## 6. Scheduled feed refresh runs against one root *(decide, then do)*

`feedRefreshTaskDef` refreshes the configured workspace's feeds. A project's feeds are refreshed
only by an explicit call, so a feed in a project silently never updates on its schedule.

**Do:** either make the task def root-parameterised (a host registers one per root it wants
refreshed), or state in the def's own doc comment that it is workspace-only and that per-root
refresh is the host's job. **Either is acceptable; silence is not** — this is exactly the class of
gap this document exists to close.

---

## 7. Invariants to write down so a host cannot break them *(cheap, prevents the next round trip)*

Each of these was learned by breaking it in MulmoTerminal. They belong in the package, next to the
thing they constrain, because the next host will not read this plan.

1. **`dataUrl` is a bare base URL and must stay one.** `custom-view.md` itself tells views to build
   endpoints by concatenation — `dataUrl + "?fields=…"` (line 83), `+ "/query"` (114),
   `+ "/actions/assign"` (178), `+ "/image?path=…"` (207). A host that appends a query to `dataUrl`
   (to carry a project, say) corrupts every one of those. Say so where `dataUrl` is minted and in
   the help.
2. **A view token must carry an opaque scope, never a path.** A token is signed, not encrypted, and
   is handed to an LLM-authored iframe; an absolute root in the payload publishes the user's home
   directory to it.
3. **`conventionalDataPath(slug)` is not a default `dataPath`.** It applies to `dataSource` /
   `storage` collections, whose records are not per-file JSON; a normal collection declares its own
   (`dataPath` | `dataSource` | `storage`, exactly one). The help's `dataPath` row should say
   "required" plainly.
4. **A slug is unique within a root and nowhere else.** Anything keyed by slug alone — a cache, a
   channel, a token, a notification id, a card — is a cross-root collision waiting to happen.

---

## 8. Remote access to a project's collections — do not foreclose it *(preparation, now)*

A phone will want a project's collections, not only the workspace's. That is not this change, but
the shape it needs must be agreed now, because the parts that are hard to change later are the
ones being written today.

Where it stands: the remote-host command handlers for collections
(`listCollections`, `getCollection`, `getRemoteView`, `getRemoteViewItems`, `mutateRemoteViewItem`,
`getFeed`, `listSkills`) are bound to the host's workspace in MulmoTerminal, deliberately, so a
project's collections do not exist on the phone at all.

The good news is that the protocol does not stand in the way: `CommandHandlers` is
`Record<string, CommandHandler>` over a `JsonObject`, so a `project` param is additive at the type
level. What must be decided now is what that param IS, and it is the same answer as everywhere
else in this feature:

1. **An opaque scope, never a path.** The phone is a genuinely remote client; an absolute root in a
   command, an artifact or a token publishes the user's home directory over the wire. MulmoTerminal
   already mints view tokens carrying an opaque project id for exactly this reason — the phone case
   inherits it, provided nothing "helpfully" swaps in a path for readability.
2. **The phone must be able to LEARN the list.** A picker needs `{ id, label }` pairs from the
   host; add a command for it (or a field on an existing listing) when the feature lands, but
   design the scope value now so that command is the only new thing.
3. **Handlers resolve a scope, they do not hard-code one.** Write each collection handler as
   "resolve the scope from params, defaulting to the host's root" rather than calling the
   workspace accessor inline. Today every call resolves the default and behaves exactly as it does
   now; the day the param arrives, no handler changes.
4. **The artifact stays host-built.** A remote view's srcdoc, its inlined image thumbnails and its
   token are assembled on the host, so the phone never resolves a path itself — keep it that way.
   It is what makes (1) hold without trusting the client.

**Do now:** (3), and state (1) and (4) where the handlers live. That is the whole preparation; it
costs nothing and it is the difference between adding a parameter later and renegotiating a
protocol with a shipped phone client.

## Non-goals

- No change to MulmoClaude's app code, workspace layout, or storage formats.
- No change to route paths. `src/config/apiRoutes.ts` stays as it is; MulmoTerminal carries the
  project as an optional query parameter on the same paths.
- Do not remove `WATCHER_ROOT_CONFLICT` before §4 is genuinely concurrent (§4).
- §8 is preparation only — do not add the phone-side project picker or change any command's
  behaviour in this PR.

## Testing

`packages/core` runs `tsx --test test/**/test_*.ts`; collection tests live in
`packages/core/test/collection/`, watcher tests in `packages/core/test/collection-watchers/`.

1. **Docs variant** — `schemaDocs` with and without `stagedSkillAuthoring`; the staged text is
   byte-identical to today, the unstaged one never says `data/skills`.
2. **Null staging** — discovery/read/write/delete against a root with no staging, and a stray
   staging file that must NOT shadow.
3. **Identity back-compat** — `completionLegacyId` / navigate target unchanged with no root;
   distinct with two roots; `parseCompletionLegacyId` accepts both.
4. **Two live watcher roots** — no bleed in events or bells; single-root path unchanged.
5. **Card identity** — two same-slug cards from two roots stay two cards.

Run `yarn test`, `yarn typecheck`, `yarn lint` in `packages/core`, and the workspace gate.

## Delivery

- One PR against `packages/core`, items separable by commit.
- The version bump is a **major** if any exported signature changes incompatibly (§2 widens
  `skillsStagingDir`'s return type, which is breaking for a host that implements the interface);
  check each item and pick once.
- After merge: publish, then **republish every plugin that declares `@mulmoclaude/core`** — a caret
  does not float across a major and the published plugins would otherwise pin the old line. The
  recipe is `plans/chore-publish-plugins-core3.md`; it lists the seven and which bump each takes.
- Then MulmoTerminal bumps and does its side (the host flag for §1, per-root watchers for §4, the
  card scope for §5).

## Context

Consumer-side plan and the audit this came from:
`../mulmoterminal/plans/feat-collections-project-root.md` §6.5, §7b, §7c.
