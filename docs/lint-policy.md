# Lint policy — driving warnings toward zero

Read this when you encounter a `yarn lint` warning, are tempted to add an `eslint-disable`, or need to understand why a `vue/no-v-html` rule is intentionally suppressed instead of fixed.

`yarn lint` runs at error-strict for most rules. A handful are kept at `warn` because graduating them to error would force a noisy cleanup and risk regressions. **Treat warnings as a backlog, not a baseline.**

Where a rule's remaining findings genuinely cannot move, the rule is still `error` — the individual sites are pinned to `warn` in a **grandfather list**, by file, with the reason. That way a *new* occurrence anywhere else fails CI. See the two sections below.

## Reduce warnings opportunistically

When you touch a file, fix any warnings in it that are mechanically safe (`prefer-destructuring` auto-fix, missing `return undefined`, etc.). Don't leave a warning behind in code you just edited.

## `max-lines-per-function` is ratcheted to `error` + a grandfather list

The rule is `error` repo-wide (50-line budget, `skipBlankLines` + `skipComments`), so **no new function may exceed 50 lines** — it fails CI. The pre-existing violations that resist a behavior-preserving split (async generators whose yielded code can't move out, factory closures over mutable state, Vue composables holding reactive refs, impure Promise executors / fs watchers) are pinned to `warn` in a single **grandfather block at the end of `eslint.config.mjs`** (search `max-lines-per-function grandfather`).

Rules for that list:

- **Never add a file to it.** A new over-budget function must be split (extract pure sub-logic into tested helpers, delegate switch cases, compose sub-generators with `yield*`), not grandfathered. If a split genuinely isn't safe, that's a design discussion for the PR, not a new list entry.
- **Drain, then delete.** When you bring a listed file's functions under 50 lines, remove its entry. When the list is empty, delete the block and the rule is plain `error` everywhere.
- Test files and `e2e*/` keep the rule `off` (a `describe()` holding ten `it()` cases isn't the readability target) — that's a separate override block, not the grandfather list.

## The other grandfather lists (`no-unsafe-assignment`, `function-return-type`, the regex rules)

Same contract, same block at the end of `eslint.config.mjs` (search `Grandfather lists`), same two rules: **never add a file**, and **drain, then delete**. What is listed and why (#2885):

- **`@typescript-eslint/no-unsafe-assignment`** — three families. `const parsed: T = JSON.parse(...)` (the repo bans `as`, so the only alternative is a runtime schema check on every parse, which would reject payloads that pass today); `Object.create(null)` assigned to a typed `Record` (TypeScript types `Object.create` as `any`, and the null prototype is load-bearing against `__proto__`); and one `req.body` destructuring whose values must reach a typed writer, so the honest fix is per-field validation.
- **`sonarjs/function-return-type`** — 8 files where the union return *is* the contract (a parser answering `T | null`, a tool handler answering one of several result shapes). Narrowing changes what every caller receives.
- **`sonarjs/super-linear-regex` / `regex-complexity` / `security/detect-unsafe-regex`** — these were a directory-wide `warn` for all of `scripts/**`, which let a genuinely dangerous new pattern in anywhere under that tree. Now `error` there with three files listed: `deps.mjs` (scans this repo's own source, so backtracking is a build-speed question, and rewriting the patterns risks the dependency audit), plus `launcherSync.mjs` and `check-readme-translations.mjs`, which are `safe-regex` **false positives** — measured at ~0.1 ms on the 40,000-char input each is supposed to blow up on.

**`sonarjs/reduce-initial-value` is not on any list** — it stays a plain `warn`. Both findings are seedless folds whose sole caller already returns or throws on an empty array, and each site says so in a comment; seeding them would buy an unreachable branch and a widened return type.

## Per-line `eslint-disable-next-line` is intentional

When you see one with a `--` rationale (e.g. `vue/no-v-html`, `no-unmodified-loop-condition`, `no-script-url` test fixtures, `no-new` URL/Intl probes, `no-loop-func` Mocha closures), it has been audited. **Never remove these comments during refactors** — they encode a trust decision. If the surrounding code changes shape, port the disable to the new line; don't drop it.

## `vue/no-v-html` specifically

Every `v-html` in this repo (NewsView, markdown/View, spreadsheet/View, textResponse/View, wiki/View) feeds from `marked.parse` or `XLSX.utils.sheet_to_html` over app-owned data — all intentional, all suppressed at the call site. If you add a new `v-html`, audit the data source and add the same comment with a one-sentence rationale; do NOT silence the rule globally.

## Multi-line elements need the wrapping form

`eslint-disable-next-line` only reaches one line. Use a `<!-- eslint-disable <rule> -->` … `<!-- eslint-enable <rule> -->` pair around the element instead.

## Raw collection io functions are import-restricted

`no-restricted-imports` blocks `listItems` / `readItem` / `writeItem` / `deleteItem` from `@mulmoclaude/core/collection/server` in host + plugin code: records are accessed through `storeFor(collection)` — `.list()`/`.page()`/`.read()` to read, `.write()`/`.delete()` to mutate (present only on writable stores; absence is the read-only refusal) — so storage backends can't be bypassed (plans/done/refactor-storage-virtualization.md). Don't suppress it — if a call site seems to need the raw io function, the store interface is missing a capability; extend it instead.
