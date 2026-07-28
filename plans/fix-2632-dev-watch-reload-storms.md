# fix #2632 — `yarn dev` full-page reload storms during agent turns

Follow-up to #1940 (closed as not-reproducible) / #1943 (closed unmerged), with the
reproduction conditions isolated by the reporter of #2632.

## Reproduced locally (macOS, this checkout)

Both failure classes were reproduced with a Playwright probe against a real
`vite` dev server, so neither rests on the reporter's machine alone.

### Class 2 — `packages/*/dist` mtime bump → Vite full reload

Bumping **only the mtime** of `packages/protocol/dist/index.js` (identical bytes,
`fs.utimesSync`) while a page is open:

```
content identical after utimes: true
mtime 2026-07-28T20:38:49.747Z -> 2026-07-28T20:44:11.748Z
window.__probe after mtime bump: null  => PAGE WAS RELOADED
vite server log: "[vite] (client) page reload packages/protocol/dist/index.js"
```

Why the module is reachable at all: yarn workspace symlinks resolve
`@mulmobridge/protocol` (imported from `src/types/events.ts`,
`src/config/apiRoutes.ts`) to `packages/protocol`, whose `main` is
`./dist/index.js`. Vite treats linked deps as source, so `packages/*/dist` sits
in the client module graph with no HMR accept boundary → full reload.

The mtime bump itself is **win32-only**: every sandboxed agent spawn
bind-mounts each workspace package read-only into the container
(`workspaceModuleMounts`, `server/agent/config.ts`, #1946), and Docker Desktop
for Windows bumps the mounted files' mtimes on each mount. macOS/Linux never
mount them, which is why #1940 could not be reproduced there.

### Class 1 — runtime workspace writes → Tailwind bare full-reload

Four appends to `artifacts/probe-2632.md` (a non-gitignored path inside the Vite
root) produced **four full page reloads**, with **no** `page reload <file>` line
in the server log — matching #1940's "not Vite file-watch reloads" observation.
That is `@tailwindcss/vite`'s `hotUpdate` hook broadcasting a bare
`{"type":"full-reload"}` after its automatic source detection (which scans the
Vite root minus `.gitignore`) sees a scanned file change.

This only bites when the workspace lives inside the Vite root — the default
`MULMOCLAUDE_WORKSPACE_PATH` is `~/mulmoclaude`, so cloning the repo there makes
the runtime workspace *be* the watch root.

## Fix

### 1. `scripts/lib/devWatchIgnore.ts` (new, pure)

`createDevWatchIgnore({ projectRoot, workspacePath, platform, watchPackageDists })`
returns a `(path) => boolean` predicate for `server.watch.ignored`. Vite 8 passes
`server.watch` through `resolveChokidarOptions` straight into `chokidar.watch`,
and chokidar's `ignored` is anymatch-compatible, so a function entry works and
prunes whole directories during traversal.

Pruned:

- `server/system/logs/` — always (already gitignored; the events are pure waste).
- Workspace runtime paths — only when the workspace is inside the Vite root.
  - workspace **inside** root → the whole workspace directory.
  - workspace **equals** root → `conversations/`, `data/`, `artifacts/`,
    `feeds/`, `.mulmoclaude/`, `.session-token`, `.server-port`.
  - `config/` is deliberately **not** pruned: it is a tracked repo directory
    (`config/eslint.packages.mjs`, `config/tsconfig.packages.json`) as well as a
    workspace dir, and the reporter's ~20 h of server logs show it is not a storm
    driver.
- `packages/**/dist` — **win32 only**, and only when
  `MULMOCLAUDE_DEV_WATCH_PACKAGES=1` is unset. macOS/Linux keep package-rebuild
  HMR untouched. The Windows trade-off is to restart `yarn dev` after really
  rebuilding a workspace package; the env var is the escape hatch for a Windows
  dev actively iterating on `packages/*`.

Path comparison is separator-normalised and segment-wise, so
`packages/foo/src/dist-utils.ts` does not match the `dist` rule.

### 2. `vite.config.ts`

Realpath-resolve the Vite root and `resolveWorkspacePath()` before comparing
(macOS `/private` symlinks, NTFS junctions, casing), falling back to the literal
path when the workspace does not exist yet, then wire the predicate into
`server.watch.ignored`.

### 3. `.gitignore`

Add the workspace runtime paths, each **anchored with a leading `/`**:

```
/conversations/
/data/
/artifacts/
/feeds/
/.mulmoclaude/
/.session-token
/.server-port
```

Anchoring matters. The unanchored form proposed in the issue (`artifacts/`,
`feeds/`, …) matches a directory of that name at *any* depth, which in this repo
means `packages/core/src/artifacts/`, `packages/core/src/feeds/` — real, tracked
source. Already-tracked files stay tracked, so nothing breaks today, but any new
file added under those directories would be silently untracked.

Inert for a checkout whose workspace lives elsewhere; when the workspace *is* the
checkout it both keeps personal data uncommittable and keeps it out of Tailwind's
gitignore-honouring scanner (defence in depth behind the watcher prune).

## Tests

`test/scripts/test_devWatchIgnore.ts` — unit tests over the pure predicate,
parameterised by platform, so the win32 behaviour is covered from every CI host
(the existing daily `lint_test (Windows)` job runs it natively too).

## Verification

- `yarn format` / `yarn lint` / `yarn typecheck` / `yarn build` / `yarn test`
- Re-run both Playwright probes against the patched dev server and confirm the
  page survives.
