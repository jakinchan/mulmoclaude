# refactor #2883 — move the shared build config out of `config/`

## Why

#2879 stopped runtime files under `config/` from breaking `yarn format` and
`yarn lint`, but only by punching two holes in an otherwise-blanket ignore:

```gitignore
/config/*
!/config/eslint.packages.mjs
!/config/tsconfig.packages.json
```

That is fail-open. A newly committed file under `config/` is silently invisible
to eslint until someone adds a matching negation, and the rule has to be
repeated in `.gitignore` and `eslint.config.mjs` — two lists free to drift.
`config/plugins.registry.ts` existed earlier in the repo's life, so "the
committed set never changes" is not a safe assumption.

`config/` was carrying two unrelated jobs: a workspace directory the running app
writes to, and the home of two committed build configs. Splitting them removes
the conflict at the source instead of managing it.

## What moved

`config/eslint.packages.mjs` → `build-config/eslint.packages.mjs`
`config/tsconfig.packages.json` → `build-config/tsconfig.packages.json`

`build-config/` sits at the same depth as `config/`, so every `extends` /
`import` is a pure string substitution with no relative-depth arithmetic — the
error most likely to slip through 43 near-identical edits.

`config/` now joins `/data/`, `/artifacts/` and the rest of the #2632 block as a
plain `/config/` ignore. No negations, nothing repeated in `eslint.config.mjs`.

## Call sites swept

| Where | N | Change |
|---|---|---|
| `packages/**/tsconfig.json` | 34 | `extends` path |
| `packages/**/eslint.config.mjs` | 9 | `import` path |
| `.github/workflows/` (2 files) | 3 | `hashFiles()` cache key |
| `package.json` | 2 | `lint` target dir, `format` glob |
| `eslint.config.mjs` | 2 | drop the #2879 allowlist; repoint `**/*.mjs` |
| `.gitignore` | 1 | allowlist block → `/config/` |
| `scripts/lib/devWatchIgnore.ts` | 1 | `config` becomes a pruned runtime entry |
| tests | 2 | see below |

### Two that a path substitution alone would have missed

**`scripts/lib/devWatchIgnore.ts`** keeps `WORKSPACE_RUNTIME_ENTRIES`, a literal
list mirroring the `.gitignore` block (it cannot import `WORKSPACE_DIRS` without
dragging the plugin meta graph into Vite config load). `config` was deliberately
excluded there with the comment *"tracked repo directories here as well as
workspace dirs, so pruning them would stop HMR for real source"*. That reason is
now gone, so `config` joins the list and the dev watcher stops watching it —
`.claude` remains the only deliberate exception.

**`test/scripts/test_devWatchIgnore.ts`** is the guard holding those two lists
together; its `DELIBERATELY_WATCHED` set drops `config`. Without this the guard
fails, which is the test doing its job.

The CI cache keys are the quiet one: `hashFiles()` does **not** error on a path
that no longer exists. Left stale, CI stays green while the package-dist cache
silently stops keying on the shared tsconfig.

## Verification

**Equivalence, not inspection.** The resolved configuration was captured before
and after the move and compared whole:

- `tsc --showConfig -p <file>` for all **34** package tsconfigs — `diff` of the
  full output is **identical**, 1016 lines compared, 0 resolution errors. This is
  TypeScript's own resolver, so `extends` is exercised exactly as at compile time.
- All **9** package `eslint.config.mjs` files imported and their resolved config
  serialised and hashed — **identical** hashes before and after.

**Behaviour with real runtime files present** (`config/scheduler/state.json`,
`tasks.json`, `roles/*.json`, `dashboard.json`, `settings.json`):

- `git status` — clean; no untracked runtime files
- `prettier --check` over the real format glob — exit 0
- `eslint build-config` — exit 0, and genuinely linted rather than skipped: no
  `ignored` warning, and an injected violation produces 4 findings
- `yarn format` — exit 0, no tracked file rewritten
- `yarn lint` — 45 problems / 1 error / 44 warnings, exactly the pre-change baseline

**Tests**: `test_devWatchIgnore.ts` 22/22, `test_packageStrictFlags.ts` 5/5.
Full root suite 9070 tests, 12 failures across 6 files — reproduced identically
on a pristine `origin/main` worktree, so pre-existing (shared `node_modules`
resolving workspace packages to another checkout), not from this change.

`yarn build` / `yarn typecheck` are left to CI: this worktree shares the main
checkout's `node_modules`, so workspace packages resolve to a different tree and
local results would be misleading. The `tsc --showConfig` equivalence above is
the meaningful local signal for the `extends` rewrite.
