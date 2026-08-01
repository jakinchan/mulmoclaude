# fix(lint): ban `as` type assertions in production code (#2692)

`CLAUDE.md` says "NEVER use `as` type casts; MUST use type guards instead", but
ESLint never enforced it: `@typescript-eslint/consistent-type-assertions` was on
at its default `assertionStyle: "as"`, which only polices the _syntax_ (`as T`
over `<T>x`). The written ban was therefore unmachined, and casts accumulated.

Follows the approach established in
[mulmoterminal#1231](https://github.com/receptron/mulmoterminal/issues/1231).

## Measured baseline (2026-08-02, this branch)

Switching the rule to `assertionStyle: "never"` reports **474 casts across 200
files**. The issue's headline number (187) counted `src/` + `server/` only;
`packages/` contributes the rest.

By shape:

| count | shape                                             | intended treatment                       |
| ----- | ------------------------------------------------- | ---------------------------------------- |
| 218   | other                                             | case by case                             |
| 68    | `as unknown as T` (double cast)                   | **fix** — the most dangerous kind        |
| 64    | `as Record<…>`                                    | usually a typed reader / guard           |
| 35    | `as string \| undefined`                          | typed field reader                       |
| 25    | error narrowing (`err as NodeJS.ErrnoException`)  | shared guard helper                      |
| 25    | `JSON.parse(…) as T`                              | **fix** — parse + validate               |
| 18    | DOM element (`$event.target as HTMLInputElement`) | allowlist candidate                      |
| 11    | `as never`                                        | fix — hides a real type mismatch         |
| 10    | `Object.fromEntries(…) as …`                      | TS inference limit — allowlist candidate |

## Approach

1. **Rule in at `warn`** (this PR) so the whole backlog is visible without
   failing CI. `yarn lint` has no `--max-warnings`, so nothing breaks.
2. **Tests are exempt.** They have a legitimate use production code doesn't:
   constructing input the types call impossible so a runtime guard has
   something to reject, and handing partial mocks to code wanting a full
   interface. The exemption lives in the existing test override and spells out
   its options — flat config _keeps_ the previous match's options when an
   override supplies only a severity, so a bare `"error"` there would have
   inherited `never` and banned `as` in tests too.
3. **Drain file by file.** One file per commit, each one a real fix (type
   guard, typed reader, or corrected signature) — never an inline
   `eslint-disable`.
4. **Genuine exceptions go in `eslint.config.mjs`**, one entry per reason, in
   the style of the existing allowlists. Inline disables stay at zero.
5. **Graduate to `error`** once production code is clean.

## Progress

Drain order is largest-file-first, so the dominant shapes get a reusable fix
early.

- [x] `eslint.config.mjs` — rule at `warn`, tests exempt
- [x] `accounting-plugin/src/server/router.ts` — 30 → 3 → **0**
- [x] `server/plugins/runtime-loader.ts` (#2697) · `server/api/routes/collections.ts` (#2699)
- [x] `src/plugins/presentMulmoScript/index.ts` (#2702) · `packages/core/src/notifier/store.ts` (#2703)
- [x] `server/api/routes/plugins.ts` (#2705) · `server/events/session-store/index.ts` (#2706)
- [x] `server/workspace/photo-locations/list.ts` (#2701) · `server/plugins/runtime.ts` (#2698)
- [x] `src/plugins/scope.ts` + chart / markdown / presentHtml (#2710) — 15 in one go
- [ ] 368 casts / 188 files remaining (re-measured 2026-08-02, after #2698)

### Two shapes worth copying

**Fix the signature, not the call site.** `wrapWithScope` and `withHostAdapter`
both declared `<TInner> (…): TInner` while returning a brand-new wrapper
component; `as TInner` laundered it. Correcting the two signatures deleted 15
casts across four files, because every one of them existed only to satisfy the
lie. When several files cast the same call, suspect the callee.

**A stale comment outlives its reason.** Fourteen of those casts carried
"yarn-4's dual-@vue can make the package's nominal types distinct". The tree
resolves one `vue` today, so the direct assignment type-checks. Re-test the
premise before preserving a workaround.

### Done: the accounting validation layer

The three casts left in `router.ts` (`account` / `entries` / `lines`
`as never`) couldn't be removed at the router. The service declared them as
already-validated shapes (`Account`, `AddEntriesItem[]`, `JournalLine[]`) while
receiving them raw, and the validators written to turn bad input into a
structured 400 read `item.date` / `line.accountCode` off elements that may not
be objects.

Fixed on #2695 by turning those validators into parsers — see
[`fix-2695-accounting-parse-boundary.md`](./fix-2695-accounting-parse-boundary.md).
The cast was hiding three live bugs, not just a type mismatch: two 500s and
three silent 200s that persisted unchecked data.

## Notes

Bugs found while removing a cast are reported on #2692 with their root cause —
a cast that was hiding a real type mismatch is a finding, not just churn. Two
came out of `router.ts` alone, one of them returning HTTP 200 with wrong
numbers.
