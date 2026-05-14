# Skill catalog UI + Star action — PR-B of #1335

## Goal

After PR-A moved preset skills out of `<workspace>/.claude/skills/` into `<workspace>/data/skills/catalog/preset/`, the catalog dir was populated but invisible to users — there was no UI to browse it and no way to ★ Star an entry back into the active layer without manual `cp -r`. PR-B closes both gaps.

## Approach

### Backend

1. **`server/workspace/skills/catalog.ts`** (new) — exports:
   - `CatalogSource = "preset"` (string union, extensible in PR-C to `"anthropic" | "community"`).
   - `CATALOG_SOURCES` const tuple + `isCatalogSource(value): value is CatalogSource` type guard for the route's request validation.
   - `CatalogEntry` shape: `{ slug, name, description, source, alreadyActive }`. `alreadyActive` is set by checking `<workspace>/.claude/skills/<slug>/` so the UI renders "★ Starred" vs "☆ Star".
   - `listCatalogEntries(opts?)` — walks every catalog source, parses SKILL.md frontmatter, returns the entries sorted by slug.
   - `starCatalogEntry(source, slug, opts?)` — validates slug against a path-traversal whitelist, copies the catalog slug-dir tree (incl. nested `scripts/` etc.) into `.claude/skills/`, returns a discriminated `StarResult` for the route's status-code mapping (`starred` / `already-active` / `not-found` / `invalid-slug`).
   - Both functions accept `{ workspaceRoot? }` so tests can run against `mkdtempSync` trees. Default is the live `workspacePath` import.
   - Internally uses `WORKSPACE_DIRS` (relative segments), NOT `WORKSPACE_PATHS` (absolute, rooted at the live `workspacePath`) — joining the latter with a caller-supplied `workspaceRoot` would silently discard the override.

2. **`server/api/routes/skills.ts`** — two new endpoints:
   - `GET /api/skills/catalog` → `{ entries: CatalogEntry[] }`.
   - `POST /api/skills/catalog/star` body `{ source, slug }` → `{ starred: true, slug }` on 200; 409 already-active; 404 not-found; 400 invalid-slug.

3. **`src/plugins/manageSkills/meta.ts`** — declare `catalogList` + `catalogStar` routes; the META aggregator auto-merges them into `API_ROUTES.skills.*` and the `SkillsEndpoints` typed map.

### UI

4. **`src/plugins/manageSkills/View.vue`** — add a catalog section to the left column below the active skills list:
   - Header "Preset catalog" (i18n: `pluginManageSkills.catalogPresetHeading`).
   - One row per catalog entry: name + description (truncated) + button.
   - Button: `☆ Star` (clickable) or `★ Starred` (disabled) depending on `alreadyActive`.
   - On Star: POST to `endpoints.catalogStar.url`, then refresh both lists (so the row flips to Starred and the active list shows the new entry).
   - `starringSlug` tracks the in-flight slug to disable the button mid-request.
   - Errors surface in a small red message below the list.

5. **i18n** — 5 new keys × 8 locales:
   - `catalogPresetHeading`, `catalogStar`, `catalogStarred`, `errCatalogListFailed`, `errCatalogStarFailed`.
   - `☆` / `★` chars are baked into the i18n strings (not raw text in the template) to satisfy the `@intlify/vue-i18n/no-raw-text` lint rule. Each locale translates the action word but keeps the star icon.

### Tests

6. **`test/workspace/skills/test_catalog.ts`** — 16 cases covering:
   - `isCatalogSource` accept/reject.
   - `listCatalogEntries`: empty catalog, valid entries, malformed SKILL.md skip, hidden entries skip, `alreadyActive` true / false.
   - `starCatalogEntry`: happy path, recursive subdir copy (scripts/), already-active conflict, not-found, path-traversal rejection, path separator rejection, empty / dot-prefixed slug rejection.

## What this does NOT do

- **Run once** (▶ button to inject the SKILL.md body into the current chat as a one-off): deferred to PR-B2.
- **Preview** (📖 modal showing description + body without starring): deferred to PR-B2.
- **Hierarchical sub-sections** (Anthropic / Community as siblings of Preset): the layout is a single flat group today; sub-sections land with PR-C when there are actually anthropic + community entries to show.
- **Slug collision handling** when starring would clobber an existing `.claude/skills/<slug>/`: the backend returns `already-active` (409), the UI doesn't try to disambiguate yet. The "namespace prefix" idea from the issue (`anthropic-pdf-extractor`) is deferred — `preset` slugs are already `mc-*` prefixed so collisions are unlikely until PR-C.
- **`stars.json` registry**: still not introduced. "Presence in `.claude/skills/`" remains the implicit star state. PR-C may introduce one for SHA pinning, but it's not needed for PR-B.

## Acceptance

- Settings → Skills shows a "Preset catalog" section below the active skills.
- Each catalog entry has a working ★ Star button. After clicking, the row flips to "★ Starred" and the entry appears in the active list immediately (no reload needed).
- Catalog tests pass against tmpdirs.
- `yarn format`, `yarn lint`, `yarn typecheck`, `yarn build`, `yarn test` all green.
- No i18n raw-text lint warnings.
