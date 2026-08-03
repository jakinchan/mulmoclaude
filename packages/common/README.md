# @mulmoclaude/common

General-purpose, **dependency-free** runtime type guards shared across the
MulmoClaude host (`server/`, `src/`), the chat bridges (`@mulmobridge/*`), and
the plugins.

This is a **leaf package** — it imports nothing, so any tier can depend on it
without creating an uphill edge (see the dependency-direction rule in the repo
`CLAUDE.md`).

## Why it exists

`server/utils/types.ts` and `src/utils/types.ts` were byte-for-byte duplicates
kept in sync by hand, and the `isObj` guard alone had been re-typed in 18 files
across the bridges and relay. These guards are the definition of "general and
duplicated," so they live here once.

## Contents

| Guard | Narrows to | Notes |
|---|---|---|
| `isRecord(v)` | `Record<string, unknown>` | plain object; **arrays excluded** |
| `isObj(v)` | `object` | any non-null object; **arrays allowed** |
| `isNonEmptyString(v)` | `string` | non-empty **after trimming** |
| `isStringRecord(v)` | `Record<string, string>` | every value is a string |
| `isStringArray(v)` | `string[]` | every element is a string |
| `isUnknownArray(v)` | `unknown[]` | prefer over bare `Array.isArray` (which narrows to `any[]`) |
| `isErrorWithCode(v)` | `{ code: string; message?: string }` | Node.js fs-style errors |
| `hasStringProp(v, k)` | `Record<k, string>` | key present with a string value |
| `hasNumberProp(v, k)` | `Record<k, number>` | key present with a number value |

Plus CSV/env helpers `parseCsvList(raw, { lowercase? })` and
`parseCsvSet(raw, { lowercase? })` (empty set = "allow all" sentinel), and the
helpers below.

| Helper | Returns | Notes |
|---|---|---|
| `errorMessage(v, fallback?)` | `string` | unknown caught value → human-readable string; **isomorphic**, so Vue/browser surfaces use it too |
| `toUtcIsoDate(timestamp)` | `string` | `Date` → `YYYY-MM-DD` in UTC — for dates that must not shift with the host's local timezone |
| `splitJwtSegments(token)` | `JwtSegments \| null` | JWS compact serialization → its three segments; `null` for anything that isn't **exactly** three. Pure string work, so the Node bridges and the Workers relay share the guard while decoding differently |

`errorMessage` surfaces a non-empty string `details` (gRPC convention) or
`message` field of a non-Error object (`details` wins) instead of
`[object Object]`; `fallback` covers a thrown non-Error at an error boundary.
This is the single home the #2217 consolidation could not reach, because
`@mulmoclaude/core/utils` is server-only — core now re-exports this one.

`isRecord` vs `isObj`: use `isRecord` whenever you go on to index string keys —
`isObj` lets arrays through, which is rarely what you want for a JSON payload.

## Shared types

`src/logger.ts` (re-exported from the root entry) holds the canonical logger
interface family:

| Type | Shape | Notes |
|---|---|---|
| `StructuredLogger` | `error`/`warn`/`info`/`debug` `(prefix, message, data?)` | The host logger, and every engine/plugin logger injected from it |
| `MinimalLogger` | `info`/`warn`/`error` `(message, data?)` | For a package that already namespaces its own entries |

They live here because the shape spans all three tiers — host `server/`, the
plugins, and `@mulmoclaude/core` — so no tier above the leaf can own the
declaration without becoming an uphill import for the others (#2486). Domains
keep their own exported name by **aliasing** rather than re-declaring
(`export type FeedsLogger = StructuredLogger`, or a
`Pick<MinimalLogger, "warn" | "error">` subset): TypeScript is structurally
typed, so the alias preserves the public name and the emitted `.d.ts` exactly.

## Related projects

Published from the MulmoClaude monorepo by [Receptron](https://github.com/receptron).

- **[MulmoClaude](https://github.com/receptron/mulmoclaude)** — an open-source AI assistant platform that runs on your own computer. Claude Code as the engine, a personal wiki for long-term memory, schema-driven collections for your data, and chat that summons the right GUI (markdown, charts, forms, spreadsheets, wikis) for each task.
- **[MulmoTerminal](https://github.com/receptron/mulmoterminal)** — a terminal-first cockpit for running many AI coding agents in parallel. One roster showing every session's summary and PR status, tmux-backed session persistence, git-worktree isolation, one-click PRs, and mobile push with remote reply.
- **[MulmoTerminal manual](https://receptron.github.io/mulmoterminal/)** — setup, workflows, feature reference, configuration, mobile notifications, and alternative / local model providers. Available in English and Japanese.
