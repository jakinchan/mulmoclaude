# fix #2851 — generated collection record ids are 32 bits, and a collision lies

## The report

[#2851](https://github.com/receptron/mulmoclaude/issues/2851): `generateItemId()`
minted `randomBytes(4)` — 8 hex chars, 32 bits. The birthday bound puts a
collision at ~1.2% across a 10,000-record collection.

No data is lost: creates go through `writeItem` with `refuseOverwrite: true`, so
a collision is a 409, not an overwrite. **The bug is what the 409 says.** The
route passes `onConflict: "duplicate"`, so the message is
`item '<id>' already exists` — which tells the user (and the agent) that the
record they are creating is already there, when in truth two unrelated records
drew the same random id. Nothing retries, so the caller stops with the wrong
diagnosis. Rare enough that whoever hits it is unlikely to diagnose it correctly.

## What was decided

The issue proposed widening to `randomBytes(8)` plus a one-shot re-roll on
collision. The maintainer chose a UUID instead (issue comment), and that
subsumes both halves:

- 122 bits of entropy — a generated-id collision does not happen, so the
  re-roll has nothing to catch. The only `already exists` left is a real
  duplicate of a **user-specified** primary key, where the message is true.
- It matches the convention the repo already states: `server/utils/id.ts` —
  "Three layers, one primitive (`crypto.randomUUID()`)".

A UUID is a legal record id as-is: `SAFE_RECORD_ID_PATTERN` wants alphanumeric
at both ends and admits interior hyphens, which is exactly the v4 shape. Existing
records keep their ids — the id is opaque, only newly generated ones get longer.

## The change

**One generator instead of two mirrored ones.** `shortHexId()` (UI) and
`generateItemId()` (server) were separate implementations that a comment asked
to keep the same shape — the failure mode the issue is about, twice. Now:

- `packages/core/src/collection/core/itemId.ts` — `newItemId()`, the single
  isomorphic generator (replaces `core/shortHexId.ts`).
- `packages/core/src/collection/server/io.ts` — `generateItemId()` delegates to
  it. The server export name stays, so MulmoClaude's route and MulmoTerminal's
  `server/backends/collections.ts` are untouched.
- `CollectionView.vue` — pre-fills the create form via `newItemId`.

`shortHexId` was exported from `@mulmoclaude/core/collection`; the rename is a
breaking change to that package's surface. Nothing outside CollectionView
imported it (checked in both this repo and MulmoTerminal).

## Tests

`test/utils/collections/test_ids.ts` gains a `newItemId` block: v4 shape, 1000
distinct rolls, `generateItemId()` returns the same shape (pins the delegation),
and — the one that matters — 100 generated ids all pass `isSafeRecordId`, since
an id that fails the sanitiser would 400 every blank-id create.

## Out of scope (filed separately)

Same-class 32-bit generators found while surveying both repos:

- MulmoTerminal `server/backends/markdown.ts` — `randomUUID().slice(0, 8)` for a
  new document's filename, written with a plain `writeFile`, so a collision
  **silently overwrites** a document. MulmoClaude's counterpart
  (`buildArtifactPathRandom`) uses `shortId()` = 64 bits.
- `packages/core/src/collection/server/csvStore.ts` — `randomBytes(4)` tmp-file
  suffix while its neighbours use `randomUUID()`.

Deliberately left alone: `accounting-plugin`'s `book-<8hex>` (bounded retry
against existing books, tiny N), `makeId()` (collides only inside one
millisecond), and MulmoTerminal's `project-dir.ts` 32-bit hash, which mirrors
Claude Code's own scheme character for character.
