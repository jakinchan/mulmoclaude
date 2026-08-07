# Package dependencies and what has to be published

This repo publishes ~54 packages to npm from one tree. The question this document
answers is the one that keeps being answered wrong: **I changed something — what do I
have to publish, and does the user actually get it?**

Three incidents are why it exists.

- `@mulmoclaude/markdown-utils@1.3.1` shipped a regex with polynomial backtracking. The
  fix (CodeQL #402) landed in the repo and stayed there for days, because nothing said
  "this package now differs from what npm serves". Every npm consumer kept running the
  unfixed copy — `core` depends on it at **runtime** rather than bundling it.
- `@mulmoclaude/core@1.8.0` was published without a git tag, so "which commit is this
  version?" had no answer. Reconstructing it needed the published tarball's file list.
- `mulmoclaude@1.4.0` shipped `0.x` caret ranges. A caret does **not** float across
  minors below 1.0, so six days of publishes reached nobody.

---

## The graph

Dependencies flow one way. Nothing below depends on anything above it.

```text
  mulmoclaude  (the launcher — the only package end users install)
       │  depends on 18 internal packages, AND ships the app itself:
       │  files: bin/ client/ server/ src/  ← built app code, via prepack
       ▼
  ┌─────────────────────────────┬──────────────────────────────┐
  │  @mulmoclaude/*-plugin      │  @mulmobridge/<service>       │
  │  accounting, chart,         │  slack, discord, line,        │
  │  collection, google, html,  │  telegram, whatsapp, … (23)   │
  │  markdown, mulmoscript      │                               │
  └──────────────┬──────────────┴───────────────┬───────────────┘
                 ▼                              ▼
        @mulmoclaude/core  (8 dependents)   @mulmobridge/client  (27)
                 │                              │
                 ▼                              ▼
        @mulmoclaude/markdown-utils (3)   @mulmobridge/protocol  (28)
                 │                        @mulmobridge/webhook-runtime (6)
                 ▼                              │
              @mulmoclaude/common  (32 dependents — the widest blast radius)
```

`@receptron/task-scheduler` (2 dependents) and `@mulmobridge/web-push` (1) sit beside
the leaves. `@mulmobridge/chat-service` and `@mulmobridge/mock-server` depend only on
`protocol`.

Regenerate this whenever it looks stale:

```bash
node -e '
const fs=require("fs"),path=require("path");const INT=/^(@mulmoclaude\/|@mulmobridge\/|@receptron\/|mulmoclaude$)/;
const dirs=["packages","packages/bridges","packages/plugins","packages/services"].flatMap(r=>fs.existsSync(r)?fs.readdirSync(r).map(d=>path.join(r,d)):[]);
const rev={};for(const d of dirs){const p=path.join(d,"package.json");if(!fs.existsSync(p))continue;const j=JSON.parse(fs.readFileSync(p));
for(const s of ["dependencies","devDependencies","peerDependencies"])for(const k of Object.keys(j[s]||{}))if(INT.test(k))(rev[k]??=new Set()).add(j.name);}
Object.entries(rev).sort((a,b)=>b[1].size-a[1].size).forEach(([k,v])=>console.log(v.size.toString().padStart(3),k));'
```

---

## What has to be published

### The rule

**Publish the package you changed. Its dependents usually do NOT need republishing.**

Every internal range is a caret on a `1.x` version, and a caret floats across minors and
patches at or above 1.0. A consumer declaring `^1.3.1` installs `1.3.2` the moment it
exists — no republish of the consumer required. That is why the `markdown-utils` fix
reached everyone the instant it was published, without touching `core`.

Two things break that rule:

- **`0.x` versions.** `^0.23.0` means `>=0.23.0 <0.24.0`. A consumer pinned there is
  frozen out of everything after it, which is exactly what `mulmoclaude@1.4.0` did. Keep
  published packages at `1.x` or higher.
- **Bundling.** A dependent that inlines the dependency at build time carries a *copy*,
  so the fix does not reach its users until the dependent is rebuilt and republished.
  Check before assuming:

  ```bash
  npm view <dependent> dependencies          # still a real dependency → floats, fine
  curl -sL "$(npm view <dependent> dist.tarball)" | tar -tz | grep <the-module>
  ```

  `@mulmoclaude/core` keeps `common` and `markdown-utils` as runtime dependencies (they
  are not in its tarball), so fixes there flow through without a core release.

### Publish order — bottom-up, launcher last

When a release spans several packages, publish each dependency **before** anything that
imports it:

```text
@mulmoclaude/common → @mulmoclaude/markdown-utils → @mulmoclaude/core → @mulmoclaude/*-plugin ─┐
@mulmobridge/protocol → @mulmobridge/client → @mulmobridge/<service> ──────────────────────────┤
@mulmobridge/webhook-runtime → the 6 webhook bridges ──────────────────────────────────────────┤
                                                                                               ▼
                                                                              mulmoclaude (launcher)
```

Backwards, you publish a package whose code calls an export npm does not serve yet. It
compiles here — the workspace resolves to the source — and fails for everyone else.

Each step is the same loop: bump → sweep that package's declared ranges → validate →
commit + tag → publish → release notes. Only then start the next package.

### Publish a dependent as well when

- it **imports something the published dependency does not have**. This is the case that
  bites: #2643 moved the runner's outer ring into core, and `server/remoteHost/` began
  importing `startResilientHostRunner` — absent from `@mulmoclaude/core@1.9.0`. Core had
  to ship as `1.10.0`, with the ranges swept, before the launcher could go at all. Here
  the range sweep is load-bearing rather than tidy;
- the range must move across a **major**;
- an already-installed user must get the fix without re-resolving. A caret only helps at
  install time; a lockfile pins what it pins.

### The launcher is the exception that catches people

`mulmoclaude` does not merely depend on the other packages. Its `files` include
`bin/ client/ server/ src/`, filled by `prepack` (`bin/prepare-dist.js`) from this
repo's own `server/` and `src/`. So:

> **Any change to app code — `server/`, `src/` — reaches npm users only through a
> `mulmoclaude` publish.** No amount of package publishing delivers it.

Use `/publish-mulmoclaude` for that, never the generic flow, and never bump the
launcher's `version` in a `chore(release)` commit that publishes something else.

---

## Before publishing anything: what is actually drifting?

A version equal to npm's latest does **not** mean the source matches what shipped. Only
the tag tells you that.

```bash
yarn audit:releases              # every publishable workspace: local / npm / state / detail
yarn audit:releases --code-only  # just the ones needing a decision

# or, for one package by hand
git diff "@scope/name@$(npm view @scope/name version)" HEAD -- packages/<dir>

# the launcher is the exception — its shipped source is not all under its own dir
git diff "mulmoclaude@$(npm view mulmoclaude version)" HEAD -- \
  packages/mulmoclaude server src Dockerfile.sandbox sandbox-entrypoint.sh
```

**The launcher is audited across the repo root too.** `packages/mulmoclaude/server/`
and `src/` are not in git — `prepack` copies them in from the repo root at pack time —
so a diff scoped to `packages/mulmoclaude` sees none of the app code. The audit widens
the launcher's pathspec to the roots `bin/prepare-dist.js` copies (`server`, `src`,
`Dockerfile.sandbox`, `sandbox-entrypoint.sh`); every other workspace stays scoped to
its own directory. Without this the launcher read `clean` while the change only it
could ship sat undelivered (#2827).

`state` is the useful column:

| state | meaning |
|---|---|
| `clean` | nothing that feeds the tarball has changed, judged against **the package's own `files`** plus `src/` and `bin/` (which produce the shipped `dist/`) and README (npm ships it regardless). Tests and tsconfig land here only because no package here lists them in `files` — a package that starts shipping them is classified accordingly |
| `code drift` | unreleased behaviour in something the package ships: `src/` or `bin/` (they become `dist/`), any root listed in its `files`, or README. For the launcher this also covers the repo-root `server/` and `src/` that `prepack` copies in |
| `manifest drift` | a **published** `package.json` field moved — `dependencies`, `exports`, `files`, `bin`, `engines`, … A dependency-range sweep shows up here; it reaches users at this package's next release, so it is a decision, not an emergency |
| `untagged` | published, but no tag, so drift **cannot be measured** — fix the tag first |
| `unpublished` | never went to npm — decide whether it is meant to |
| `error` | the check itself failed (registry unreachable, git failure). Reported rather than silently folded into `clean`, and the command exits non-zero |

A failed lookup is never converted into an audit state. An audit that answers "nothing
to do" when it means "I could not tell" is worse than no audit.

If the diff is empty because **the tag is missing**, that is its own finding: fix it
before relying on the answer. Do not tag the version-bump commit by reflex — it is
often on a feature branch, so it predates other merges the publish actually contained.
Identify the commit from the published tarball instead:

```bash
curl -sL "$(npm view @scope/name@X.Y.Z dist.tarball)" | tar -tz   # which modules are in?
npm view @scope/name time --json                                  # when was it cut?
```

then tag the main-line commit whose tree matches, and say why in the commit or issue.
`@mulmoclaude/core@1.8.0` was tagged this way: the tarball contained
`firestoreSafeResult` but not `presenceBeat`, which placed it exactly at the merge of
PR #2639 rather than at the branch-local bump.

---

## Release mechanics

`/publish` owns the steps. What it enforces, and why each matters:

| Step | Why |
|---|---|
| version bump + **every declared range swept** to the new version | ranges are the record of intent; a stale one hides which line a consumer was built against |
| commit + tag **before** `npm publish` | publish is irreversible; the tarball must correspond to a tagged commit |
| tag `@scope/name@X.Y.Z`, never `vX.Y.Z` | `v` prefixes belong to app releases (`/release-app`) |
| GitHub release with `--latest=false` | a package release must not displace the app's latest |
| `docs/CHANGELOG.md` entry | the only place a reader finds out a package moved and why |

Verify the tarball before publishing, not after — and verify **the tarball**, not the
working tree. `npm pack --dry-run` prints file names only, so grepping `dist/` in the
checkout passes happily for a file that `files` / `.npmignore` excludes. Pack it, extract
it, and look inside:

```bash
cd packages/<dir>
TARBALL=$(npm pack --silent)                  # the real archive, not a listing
UNPACKED=$(mktemp -d /tmp/packcheck.XXXXXX)
tar -xzf "$TARBALL" -C "$UNPACKED" --strip-components=1
grep -r "<a string only the new code contains>" "$UNPACKED"   # the ARCHIVE, not the checkout
```

Grepping `dist/` in the checkout instead would pass for a file that `files` or
`.npmignore` excludes — the check would confirm the build, not the artifact.

A vite-built package emits one bundled `index.js` plus per-module `.d.ts`, so "my new
module is missing from the tarball" is usually wrong — the code is in the bundle. Grep
for a distinctive string rather than looking for a filename. `@mulmoclaude/core@1.9.0`
was checked exactly this way (`"circular reference"`, `"no presence write acknowledged"`,
`presenceStaleAfterMs`), and the same technique identified which commit the untagged
`1.8.0` had been cut from.
