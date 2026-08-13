# fix #2888 — align the three `packages/dist` cache keys

## What was wrong

Three `actions/cache` steps cache `packages/*/dist`. Only one hashed the root
`package.json`:

| file:line | job | `package.json` |
|---|---|---|
| `pull_request.yaml:115` | `lint_test` | ✅ |
| `pull_request.yaml:241` | `e2e` | ❌ |
| `lint_test_windows.yaml:115` | `lint_test` (Windows) | ❌ |

## Not a new theory — a known bug left half-fixed

`3208224c5` (2026-07-14) already diagnosed and fixed this, and its message records
the observed failure:

> the cache key hashed `packages/*/src` + per-package manifests but NOT the root
> `package.json`, where `build:packages` (the explicit workspace build list) lives.
> So adding a package to that list didn't bust the cache: a prior failed run had
> saved a dist snapshot WITHOUT the new package under the same key, and the next
> run restored it, skipped `build:packages`, and failed typecheck with **TS2307**.

That commit changed **1 file, 1 line**. The e2e key in the same file and the whole
Windows workflow were never updated.

## Why it is still reachable

The `pkg-dist` caches have **no `restore-keys`** — the `restore-keys` nearby belong
to the puppeteer cache. So restore happens only on an exact key match. When root
`package.json` changes alone:

- `lint_test` — key changes, rebuilds (correct)
- `e2e` / Windows — key does **not** change, restores the pre-change dist on an
  exact match, and `if: cache-hit != 'true'` then skips `yarn build:packages`

That is the same path `3208224c5` fixed. Both jobs run on every PR, so nothing
gates it.

## Second consequence: a documented guarantee that silently stopped holding

The e2e step carries this comment, added in `08f2ebb5b` (2026-04-27) when the two
keys were identical:

```yaml
# Same packages/dist cache as lint_test — shares the cache key
# across both jobs on ubuntu-latest + node 22.x, so whichever
# finishes building first warms the cache for the other.
```

Adding one file to the `lint_test` hash inputs in 2026-07-14 made the two hashes
permanently different, so the keys can never match and the sharing has not worked
since. `yarn build:packages` has been running twice per PR on ubuntu 22.x.

So this is a **regression with a date**, not a long-standing gap.

## Fix

Append `'package.json'` to the two remaining `hashFiles(...)` lists so all three
share one input list. Fixing only the one CodeRabbit flagged would leave Windows
inconsistent with the job it is named after.

## Verification

- All three `pkg-dist` `hashFiles(...)` input lists are now **byte-identical**
  (`sort -u` over them → 1 distinct list; the only other `hashFiles` in these files
  is the unrelated `hashFiles('yarn.lock')` puppeteer cache)
- With `matrix.node-version` resolved to `22.x`, the two `pull_request.yaml` key
  expressions collapse to **1 distinct string** — the condition the e2e comment
  promises, and the thing that was broken
- Both workflows parse (`YAML.parse`), and the parsed `Cache packages/dist` step of
  each job reports `package.json in key: true`
- Diff is exactly 2 changed lines, both `key:` lines

Cache-key behaviour cannot be proven from a PR run (the effect appears on the *next*
run after a root `package.json` change), so the checks above are structural; CI's
`workflow-lint (actionlint + zizmor)` gates syntax.
