# `PORT=3100 yarn dev` moves the server and leaves the client behind

Issue: #2650 · related: #1570 (the same file already reads `MULMOCLAUDE_WORKSPACE_PATH`), PR #2648 (docs attempt, closed)

## The trap

The backend honours `PORT`. Vite's proxy targets a literal `http://localhost:3001`, five
times. So `PORT=3100 yarn dev` moves the server to 3100 while the dev client keeps
talking to 3001 — and if a first instance is already there, **the second browser shows
the first instance's data**. No error: the proxy connects, it just connects to the wrong
server. Someone who split their workspaces has no signal that they did not.

`e2e-live/fixtures/isolated-dev-server.ts:19-23` already documents the constraint by
bypassing Vite entirely.

## The half of it the issue does not mention

`PORT` unset is worse than `PORT` set, because the backend **walks forward** when its
port is busy (`resolvePort()`, `server/index.ts`): 3001 taken → bind 3002, logged at
`info` as a friendly fallback. Run `yarn dev` twice with no `PORT` and you get exactly
the reported symptom without ever touching an env var — server B on 3002, Vite B
proxying to 3001, which is server A.

Deriving the target from `PORT` cannot fix that case: the walk happens after Vite's
config was evaluated, in another process. So the fix has two parts — make the target
follow the env, and make the walk say what it costs.

## Change

### `scripts/lib/devServerPort.ts` (new)

`vite.config.ts` cannot import `server/system/env.ts` (it runs outside the server
tsconfig — the same reason `TOKEN_FILE_PATH` is duplicated there), so the resolution
lives in `scripts/lib/`, next to `devWatchIgnore.ts`, and is unit-tested from
`test/scripts/`.

- `parseServerPort(raw)` — integer 1-65535 or `null`. A junk value must not become
  `http://localhost:NaN`; it falls back with a warning rather than producing a target
  that fails at request time.
- `resolveServerPort({ processEnv, envFileText })` — `PORT` from the environment, else
  `PORT=` in `<cwd>/.env`, else 3001. That ordering mirrors the server: `loadEnv`
  populates `process.env` from `.env` and lets an exported shell variable win. Reading
  `.env` matters because a developer who sets `PORT` there (not in the shell) would
  otherwise hit the same split — `resolveWorkspacePath()` in the same file already reads
  `.env` for exactly that reason.
- `serverOrigins(port)` → `{ http, ws }`, so the five proxy entries share one source.

### `vite.config.ts`

All five proxy targets (`/api`, `/artifacts/images`, `/artifacts/svg`,
`/artifacts/html`, `/ws`) become `SERVER_ORIGIN` / `SERVER_WS_ORIGIN`.

Vite's own port is left alone: it is not read from `PORT` (verified — nothing in
`node_modules/vite/dist` reads it), and with `strictPort` off Vite already walks 5173 →
5174, so a second instance gets its own client port without configuration.

### `server/index.ts`

The walk-forward log moves from `info` to `warn` and names the consequence: the dev
client still proxies to the port that was asked for, so set `PORT` to run a second
instance. The behaviour itself does not change — walking forward is deliberate, and
failing loudly instead would break the stale-`yarn dev` case it was added for.

## Tests

`test/scripts/test_devServerPort.ts` — the resolution order (shell over `.env` over
default), `.env` parsing (whitespace, quotes, a commented-out line, a later duplicate),
rejection of 0 / 65536 / `abc` / empty / negative / float, and that the origins are
built from one port.

## Not in this PR

- Letting `e2e-live` use the Vite path again. The fixture bypasses Vite for this reason,
  but re-plumbing live tests is its own change with its own risk.
- A dedicated `MULMOCLAUDE_SERVER_PORT`. `PORT` is what the server already reads and
  what the launcher's `--port` maps to; a second name for the same number would be one
  more thing to keep in sync.
