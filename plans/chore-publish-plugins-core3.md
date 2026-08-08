# chore(release): publish the 7 plugins that depend on `@mulmoclaude/core@3.0.0`

Written 2026-08-08 for an implementing agent. **In English at the requester's instruction** —
the rest of `plans/` is Japanese.

`docs/package-releases.md` is the authority for the mechanics. This document says **which**
packages, **what version each gets**, and **why this one is not the usual "dependents do not need
republishing" case**. Do not re-derive the release loop here — follow that doc.

---

## Why this is needed

`@mulmoclaude/core@3.0.0` is published. The seven plugins that depend on it already declare
`^3.0.0` **in this repo**, but their own versions are unchanged, so **npm still serves the old
versions, which require `^2.x`**.

A caret does not float across a major. `docs/package-releases.md` lists this exact case:

> ### Publish a dependent as well when
> … the range must move across a **major**;

So the corrected ranges are currently reaching nobody. npm versions are immutable — the only way
to deliver them is a new version of each plugin.

### What a fresh install produces today

- Six plugins declare core as a plain `dependencies` → the installer adds a **nested
  `@mulmoclaude/core@2.x`** beside the top-level `3.0.0`.
- `@mulmoclaude/collection-plugin` declares it as a **peerDependency** → no second copy, but the
  declared range is now false.

The concrete hazard is not the server side (no plugin imports `@mulmoclaude/core/collection/server`,
so the host binding is not split) — it is **`@mulmoclaude/core/plugin-vue`, imported by
`html-plugin`, `markdown-plugin` and `accounting-plugin`**. Two copies of a Vue-side runtime in one
bundle is how a plugin registers into one copy while the host reads the other.

**This is not only MulmoTerminal's problem.** `packages/mulmoclaude` (the launcher, v1.12.0)
already declares `@mulmoclaude/core: ^3.0.0` while still declaring the plugins at `^2.x`, so a
fresh launcher install hits the same duplicate.

## What to publish

Verify each current version before bumping (`npm view <name> version`); the table is what the repo
said on 2026-08-08.

| package | now | → | why that bump |
|---|---|---|---|
| `@mulmoclaude/collection-plugin` | 2.0.0 | **3.0.0** | core is a **peerDependency**; moving a peer range across a major is breaking **for its consumers** |
| `@mulmoclaude/html-plugin` | 2.1.0 | **3.0.0** | same — declares core as both dep and peer |
| `@mulmoclaude/markdown-plugin` | 2.3.0 | **3.0.0** | same |
| `@mulmoclaude/accounting-plugin` | 2.0.0 | **2.1.0** | core is a plain dependency — internal, not visible to consumers |
| `@mulmoclaude/chart-plugin` | 2.0.0 | **2.1.0** | same |
| `@mulmoclaude/google-plugin` | 2.0.0 | **2.1.0** | same |
| `@mulmoclaude/mulmoscript-plugin` | 2.0.0 | **2.1.0** | same |

That list is complete — it is every package in the repo declaring `@mulmoclaude/core`, plus the
launcher (below). Re-derive it rather than trusting this table if time has passed:

```bash
node -e '
const fs=require("fs"),path=require("path");
const dirs=["packages","packages/bridges","packages/plugins","packages/services"].flatMap(r=>fs.existsSync(r)?fs.readdirSync(r).map(d=>path.join(r,d)):[]);
for(const d of dirs){const p=path.join(d,"package.json");if(!fs.existsSync(p))continue;const j=JSON.parse(fs.readFileSync(p));
const dep=(j.dependencies||{})["@mulmoclaude/core"],peer=(j.peerDependencies||{})["@mulmoclaude/core"];
if(dep||peer)console.log(j.name.padEnd(36),"v"+j.version," dep:",dep||"-"," peer:",peer||"-");}'
```

### The launcher: sweep, do not publish

`packages/mulmoclaude` declares all seven plugins. Its ranges must be swept to the new versions as
part of this work (`^3.0.0` for the three majors, `^2.1.0` for the four minors) — a range is the
record of intent, and a stale one hides which line the launcher was built against.

**Do not bump or publish the launcher in this chore.** `docs/package-releases.md` is explicit:
never bump the launcher's `version` in a `chore(release)` commit that publishes something else,
and the launcher goes through `/publish-mulmoclaude`, never the generic flow. Note in the PR that
**npm users of the launcher do not receive the new plugins until a launcher release** — that is
the owner's decision, not part of this chore.

## Order

`core@3.0.0` is already out, so all seven sit at the same level and can go in any order among
themselves. **Each package completes its own full loop before the next one starts** — bump → sweep
that package's declared ranges → validate → commit + tag → publish → release notes — per
`docs/package-releases.md`. Do not batch seven publishes behind one commit.

## Validation

Follow `docs/package-releases.md`; the parts that matter most here:

- `yarn audit:releases` **before starting**. These seven should read **`manifest drift`** — the
  `^3.0.0` range change is already in the tree and unreleased. **If any reads `code drift`,
  something else is unreleased too — stop and report it** rather than shipping it unexamined
  inside a dependency-range release.
- **Verify the tarball, not the working tree** (pack, extract, grep) — `npm pack --dry-run` prints
  names only.
- Tag `@scope/name@X.Y.Z` (never `vX.Y.Z`); tag **before** `npm publish`; GitHub release with
  `--latest=false`; one `docs/CHANGELOG.md` entry per package.

## Acceptance

1. For each of the seven: `npm view <name> dependencies` / `peerDependencies` shows
   `@mulmoclaude/core: ^3.0.0`.
2. In **MulmoTerminal** (`../mulmoterminal`), after bumping its ranges to the new versions,
   exactly **one** copy of core is installed and it is 3.x:

   ```bash
   find node_modules -path "*@mulmoclaude/core/package.json" \
     -exec node -e 'console.log(process.argv[1], require("./"+process.argv[1]).version)' {} \;
   ```

   One line, `3.x`. Two lines means a plugin still requires `^2.x`.
3. `yarn audit:releases` shows the seven as `clean`.

## Non-goals

- Do not touch `@mulmoclaude/core` — it is published and correct.
- Do not change any plugin's code. This is a version + range release; the source already declares
  what it needs.
- Do not publish the launcher (above).
- Do not bump MulmoTerminal — that happens in `../mulmoterminal` once these are on npm.

## Deviation taken while implementing (#2841)

The "Order" section above has each package commit **and tag** before publishing. That loop runs
on `main`, not in the PR: `docs/package-releases.md` warns against tagging a version-bump commit
on a feature branch, since such a commit predates the merges the publish actually contains — the
reason `@mulmoclaude/core@1.8.0` had to be re-identified from its tarball. PR #2841 therefore
carries the bumps, range sweeps and changelog only; the per-package tag → publish → release loop
runs after merge, unchanged in every other respect.

One more thing the plan did not anticipate: the pending roster does NOT go in the published
`[1.12.0]` `Ships` line. That release shipped the 2.x plugins and its record must keep saying so.
It goes under `[Unreleased]`, and `scripts/packages/check-changelog-ships.mjs` now targets that
section when it carries a roster — otherwise the gate forces a published release's history to be
rewritten every time a `chore(release)` sweeps ranges without bumping the launcher.

## Context

Why core went to 3.0.0: `plans/feat-collection-multi-root.md` (merged as #2838). The consumer-side
plan is `../mulmoterminal/plans/feat-collections-project-root.md`.
