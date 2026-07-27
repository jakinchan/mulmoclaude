# Make the server's own `.env` load report shadowing too

Issue: #2610 · follows #2604

## What's left unsignalled

#2604 gave the launcher path an in-app notification when the shell shadows a launch-dir
`.env`. The server reaches a `.env` by a second route that got nothing:

| launch | server cwd | `.env` `dotenv/config` reads | signal today |
| --- | --- | --- | --- |
| `npx mulmoclaude` | `packages/mulmoclaude/` | none exists — a no-op | launcher detects it (#2604) |
| `yarn dev` / `tsx server/index.ts` | repo root | **the repo's own `.env`** | **none** |

Same shell-wins rule, same "I edited `.env` and nothing changed" dead end, and in the dev
case not even the launcher's log line. So this is effectively a dev-path fix.

## The trap in the obvious implementation

`import "dotenv/config"` cannot simply become a function call. ESM evaluates **every**
import before the first statement of the module body, so a `loadServerEnv()` on line 1 of
the body would run *after* every imported module has already been evaluated —
`server/workspace/paths.ts:81` reads `process.env` at its own module scope and would see
an unpopulated environment.

The load therefore stays a **side-effecting import**, listed first, exactly where
`dotenv/config` was. Only the module behind it changes.

## Change

### 1. `server/system/envFile.ts` + `server/system/loadEnv.ts` (new)

Together they replace `import "dotenv/config"` at the top of `server/index.ts`.

Reuses the launcher's existing pieces rather than a second parser: `parseEnvFile` +
`mergeLaunchEnv` (`server/utils/launch-env.mjs`) already implement dotenv's no-override
semantics and already return `skippedKeys`. Parsing stays byte-identical because
`parseEnvFile` calls `dotenv.parse`.

Two modules, because a single one cannot be both:

- `envFile.ts` — `applyEnvFile(cwd, target)`, pure, **no load-time side effect**. Takes
  both as arguments, so a test drives a temp dir and a plain object without ever reading
  the repository's real `.env`.
- `loadEnv.ts` — the side-effect entrypoint. Calls it once for `process.cwd()` /
  `process.env` and freezes the result behind `shadowedByServerLoad()`. Nothing but
  `server/index.ts` imports it.

`DOTENV_CONFIG_*` is deliberately **not** honoured. `dotenv/config` read
`DOTENV_CONFIG_PATH` / `_OVERRIDE` / `_ENCODING` / `_DEBUG` / `_QUIET`; nothing in this
repo — code, scripts, CI, Docker — ever set one, and they were never documented as a way
to configure the server. Rejecting them explicitly (in a comment at the load site) beats
carrying a config surface no caller uses.

### 2. Feed it into the existing announce

`announceShadowedEnv` gains a second parameter for keys the server itself skipped, unioned
with the launcher's. `server/index.ts` passes `shadowedByServerLoad()`.

Both sources deliberately produce **one** notification with the union of key names, not
one per source. Per the issue decision, the text does not name the `.env` path: only one
of the two files is ever in play (the launcher's cwd has no `.env`, and `yarn dev` has no
launcher), so a path would add an 8-locale change for a distinction the user cannot
currently hit.

`shadowedEnv.ts` deliberately does **not** import `loadEnv.ts` — that would make merely
importing the diagnostic read the repo's real `.env`, which is exactly the side effect the
tests must not have.

### 3. `error-recovery.md` — the gap #2604 left

CLAUDE.md requires a new runtime diagnostic to land in
`packages/core/assets/helps/error-recovery.md`, and #2604 did not do it. The omission has
teeth: the existing "media generation failed" section already tells the agent to *"add the
missing key to `.env` (restart the server)"* — which is precisely the advice that silently
fails when the shell holds a stale value. The agent reads that file before asking the user
a clarifying question, so the know-how was invisible where it mattered most.

Adding it means bumping `@mulmoclaude/core` (assets ship to npm) and the launcher's range
for it in the same PR, per the launcher-sync gate.

### 4. Documentation touch-ups

- `docs/developer.md` — the `MULMOCLAUDE_SHADOWED_ENV_KEYS` row says the signal is "absent
  entirely outside `npx mulmoclaude` (see #2610)". No longer true.
- `e2e-live/tests/docker.spec.ts` — its comment names `server/index.ts:1` as
  `import "dotenv/config"`. The spec's own behaviour is unaffected (it loads dotenv
  itself), but the reference goes stale.

## Verification

- `applyEnvFile` unit-tested against a temp dir: file applied, shell value wins, shadowed
  names returned, missing file a no-op.
- The union in `announceShadowedEnv` tested at both layers, as in #2604.
- Manual, as in #2604 but for the dev path: `export GEMINI_API_KEY=…` plus the same key in
  the repo `.env`, then `yarn dev` → the bell shows it; unset one → it clears.

## Out of scope

The bridges (`packages/bridges/*/src/index.ts`) each carry their own `import
"dotenv/config"`. They are separate processes with their own cwd and no bell to publish
to; nothing here applies to them.
