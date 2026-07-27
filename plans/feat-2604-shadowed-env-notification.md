# Tell the user in-app when the shell is shadowing their launch-dir `.env`

Issue: #2604 · follow-up filed: #2610

## The trap

`.env` in the launch directory loses to an exported shell variable — dotenv's
no-override semantics, and the launcher already implements it correctly. The problem
is that losing is invisible. A user with a stale `export GEMINI_API_KEY=…` in their
`~/.zshrc` can fix `.env` as many times as they like and nothing changes, with no
signal pointing at the shell.

A single definition is unambiguous and fine. The failure needs two definitions and no
visible precedence.

## What already exists

The launcher computes exactly the right fact and then throws it away:

- `mergeLaunchEnv` (`server/utils/launch-env.mjs`) returns `skippedKeys` — the `.env`
  keys the shell had already defined.
- `packages/mulmoclaude/bin/mulmoclaude.js:227` turns it into one terminal log line
  and stops there. Nothing reaches the app.

The notification side is equally ready. `kind: "system"` is documented as "server boot
warnings", `publishNotification` takes a caller-supplied stable `id` specifically so a
reboot doesn't pile duplicates into `active.json`, and `announcePluginMetaDiagnostics`
(`server/plugins/diagnostics.ts`) is a working instance of that exact pattern —
log.warn + dedupe against the active set + publish with i18n keys.

So this is a wiring job, not a new mechanism.

## Change

### 1. Launcher → server

`packages/mulmoclaude/bin/mulmoclaude.js` puts the skipped keys on the spawned
server's environment:

```js
if (skippedKeys.length > 0) serverEnv.MULMOCLAUDE_SHADOWED_ENV_KEYS = skippedKeys.join(",");
```

An env var rather than a file or a flag: the launcher already builds `serverEnv` for
exactly this kind of hand-off (`MULMOCLAUDE_DEV_PLUGINS`, the `flagEnvOverrides` loop),
and it needs no lifecycle management.

### 2. `server/system/shadowedEnv.ts` (new)

Two pure functions plus one announce, so the decisions are testable without a notifier:

- `parseShadowedEnvKeys(raw)` — CSV → deduped, trimmed, sorted key list. Sorted so the
  id below is stable regardless of the order dotenv happened to parse the file in.
- `shadowedEnvDiagnostic(keys)` — `null` when there is nothing to say, else the stable
  `id`, the English fallback text, and the i18n key + params.
- `announceShadowedEnv()` — reads the env var, logs, dedupes against the notifier's
  active set, publishes. Mirrors `announcePluginMetaDiagnostics` step for step.

The id embeds the sorted key list (`shadowed-env:GEMINI_API_KEY,OPENAI_API_KEY`). A
reboot with the same conflict finds its own entry and stays quiet.

Dedupe alone is not enough, though, and this was the one real design hole found while
writing the tests: a *changed* key set gets a new id, so publishing it would leave the
old entry sitting next to it — still naming the key the user just fixed. Two
notifications, one of them a lie. So the announce also **clears** any active
`shadowed-env:` entry that isn't the current one, including when the conflict is gone
entirely (a boot with nothing shadowed retracts yesterday's warning). The active set
therefore always describes the situation right now, never its history. Both behaviours
are pinned by tests that were confirmed to fail without the clear.

### 3. Wire into boot

Called from `initBootDiagnostics()` in `server/index.ts`, beside the plugin-meta
announce — same requirement (notifier engine initialised), same shape.

### 4. i18n

`shadowedEnv.title` / `shadowedEnv.body` in all 8 locales. Body names the keys and says
which side wins and what to do:

> `GEMINI_API_KEY` is set in both your shell and `.env`. The shell value is being used
> and `.env` is ignored. If you edited `.env`, update the shell value (or unset it) and
> restart.

English `title` / `body` stay set as fallbacks — they feed the log line and the macOS
Reminder push, which have no vue-i18n.

Key names are capped (as the launcher's log line already caps at 20) so a large `.env`
whose every key is shadowed can't produce an unreadable notification.

## Scope

Per the issue: **only** the shell-shadows-launch-dir-`.env` case. Not the general
"effective source of any secret" surface, and not precedence against #871's web-managed
secrets — those are named in the issue as future work.

### Found while scoping, filed separately as #2610

`server/index.ts:1` does `import "dotenv/config"`, so the server ALSO reads a `.env`
from its own cwd with the same shell-wins rule. `yarn dev` doesn't go through the
launcher, so that path gets no log line today and won't get this notification either.
Same trap, less signal. Left out on purpose — the issue scopes this to the launcher —
but recorded so the asymmetry isn't discovered as a surprise.

## Verification

The issue asks for a manual check, which is right: the behaviour depends on a real
shell environment.

- both shell and `.env` define `GEMINI_API_KEY` → bell shows the notification, naming
  the key, saying the shell wins
- only one place defines it → no notification
- restart with the conflict unfixed → still one entry, not two

Automated coverage goes further than the pure functions. Two layers:

- **Pure** (`test_shadowedEnv.ts`) — parse, de-dupe, sort, cap, the nothing-to-say cases,
  the id's stability across reorderings vs. its change when the key set changes, and the
  rejection of any token that isn't an env var name.
- **Wiring** (`test_shadowedEnv_bell.ts`, against a tmpdir `active.json`) — the entry
  actually reaches the bell, carries the i18n keys, contains no `=`, doesn't stack on a
  reboot, replaces itself when a key is fixed, and clears when the conflict is gone. The
  replace and clear cases were confirmed to fail without the clear-superseded logic.

What stays manual is the part that needs a real shell: that the launcher's own detection
fires against a genuine `export`, end to end through `npx mulmoclaude`.
