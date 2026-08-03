# fix #2779 — Windows CI: tests must not use `/dev/null` as a JSONL sink

## Problem

`lint_test (Windows)` is red on `main` (`4c5ab67`, run 30779639961), Node 22.x and 24.x, at
`yarn run test:coverage`. Linux and macOS are green. 15 tests fail with:

```
Error: ENOENT: no such file or directory, open 'D:\dev\null'
  errno: -4058, code: 'ENOENT', syscall: 'open', path: 'D:\\dev\\null'
```

## Root cause

Two test files pass the POSIX null device as a session's results file:

- `test/events/test_session_store.ts:290` — `sessionOpts({ resultsFilePath: "/dev/null" })`
- `test/routes/test_sessionToolContext.ts:12` — `resultsFilePath: "/dev/null"`

`pushToolResult` **awaits** `enqueueJsonlAppend` (the write is queued so a `tool_result` can't
reach disk before its `tool_call`), so a rejected `fs.appendFile` fails the test rather than being
swallowed the way `applyEventToSession`'s fire-and-forget append is.

On Windows a leading-slash path is resolved against the current drive: `/dev/null` becomes
`D:\dev\null`, and `D:\dev` does not exist, so the open fails. Reproduced the identical error
locally by appending to a path whose parent is missing.

Both files came from the #2754 / #2758 work and are the first tests in them that write.

`test/events/test_session_store.ts:24` has the same latent trap in its shared `sessionOpts`
default, `"/tmp/fake.jsonl"` → `D:\tmp\fake.jsonl`. It passes today only because its callers either
never write or write through the error-swallowing path — a new test that awaits a write would turn
it red.

## Fix

Follow the convention the rest of the suite already uses for tests that write a JSONL
(`test/tool-trace/test_index.ts`, `test/events/test_persistToolCalls.ts`,
`test/routes/test_wikiInternalSnapshotRoute.ts`): a real file under `mkdtemp(join(tmpdir(), …))`,
removed in `after`.

1. `test/events/test_session_store.ts`
   - `before`/`after` hooks create and remove one temp dir for the file.
   - `sessionOpts` defaults `resultsFilePath` to `<tmpdir>/results.jsonl`, replacing
     `"/tmp/fake.jsonl"`.
   - The `latestToolResult` block's `opts()` override disappears — `sessionOpts()` is now correct
     for it, so the call sites use `sessionOpts()` directly.
2. `test/routes/test_sessionToolContext.ts` — same temp-dir hooks; `session()` uses that path.

No production change. `sessionJsonlAbsPath` already builds real paths with `node:path`, and the
awaited write in `pushToolResult` is deliberate.

## Verification

- `yarn test` — the two affected files, then the whole suite.
- `yarn format` / `yarn lint` / `yarn typecheck` / `yarn build`.
- `grep` for remaining `/dev/null` and `/tmp/` literals in `test/` used as a filesystem path.
- Ground truth is the Windows job on the PR: macOS cannot prove the drive-relative resolution is
  gone. Watch `lint_test (Windows)` on both Node versions before merging.
