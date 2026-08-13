# fix #2873 — runtime files under `config/` break `yarn format` and `yarn lint`

## Symptom

After the scheduler runs, a commit-time check fails on a tree nobody edited:

```
[warn] config/scheduler/state.json
[warn] Code style issues fixed in the above file.
```

## Root cause

`config/` is a workspace directory (`WORKSPACE_DIRS.configs`, eager-created at boot)
*and* the home of two committed build configs. In the layout where the workspace IS
the checkout, the running app writes into the same `config/` the repo tracks.

The failure is deterministic, not content-dependent: the writers use
`JSON.stringify(obj, null, 2)`, which emits no trailing newline, and Prettier
requires one for JSON. So the file is reformatted on *every* run even when the
content is unchanged.

`.gitignore` (#2632) lists the other runtime roots — `/data/`, `/artifacts/`,
`/conversations/` … — but omits `/config/` precisely because of those two
committed files. So `config/` was the one gap.

## Scope is wider than the issue reports

Reproduced in-tree with the real toolchain, runtime files present:

| tool | exit | finding |
|---|---|---|
| `prettier --check 'config/**/*.json'` | 1 | 5 files |
| `eslint config` | 1 | ✖ 5 problems (5 errors) |

- **Not one file.** `config/scheduler/{state,tasks}.json`, `config/roles/*.json`,
  `config/dashboard.json`, `config/news-read-state.json` — plus, in a live
  workspace, `settings.json`, `mcp.json`, `interests.json`,
  `reference-dirs.json`, `workspace-dirs.json`, `shortcuts.json`, `plugins/`,
  `helps/`, `marp-themes/`.
- **`yarn lint` breaks too**, which the issue does not mention. The config object
  at `eslint.config.mjs:142` declares no `files`, so it applies to every file and
  its `prettier/prettier` rule reaches JSON.

`dashboard-io.ts` and `shortcuts-io.ts` already append `\n` by hand — evidence
this was being patched one file at a time.

## Fix

Two edits; both are needed because **Prettier reads `.gitignore` and ESLint does not**.

1. `.gitignore` — ignore `config/`'s contents, re-admit the two committed files.
   Fixes Prettier *and* the `git status` noise, which is the more dangerous half
   (untracked runtime files are one `git add` away from being committed).
2. `eslint.config.mjs` `ignores` — the same three lines, for the lint half.

Rejected: the issue's `.prettierignore` + `config/scheduler/` suggestion — it
leaves the other `config/*.json` files and does not fix `yarn lint`.

Rejected: moving the two build configs out of `config/` and ignoring `/config/`
wholesale. Structurally cleaner, but rewrites `extends` / `import` paths in ~40
`packages/*/tsconfig.json` and `eslint.config.mjs` files — disproportionate here.

## Verification

Runtime files recreated before each run (they are rewritten by any formatter that
touches them, so a stale tree reads as a false pass):

| state | prettier | eslint |
|---|---|---|
| before | exit 1, 5 files | exit 1, 5 errors |
| `.gitignore` only | exit 0 | exit 1, 5 errors ← proves the second edit is load-bearing |
| both edits | exit 0 | exit 0 |

`config/tsconfig.packages.json` stays genuinely linted under the negation — it
reports no `ignored` warning, so it is not silently skipped.
