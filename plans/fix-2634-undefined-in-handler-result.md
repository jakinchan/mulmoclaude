# One `undefined` in a reply takes down the whole reply

Issue: #2634 · accident report: receptron/mulmoterminal#1042 · interim host-side guard: receptron/mulmoterminal#1044

## The trap

Firestore rejects `undefined` at ANY depth, and the runner writes a handler's
return value straight into the command document:

```ts
await updateDoc(ref, { status: "done", result: await handler(params) ?? null, … });
```

`?? null` covers a handler that returns nothing. It does nothing for an `undefined`
buried in the returned structure — and there, `updateDoc` throws, `status: "done"`
never lands, and the remote waits until it times out.

So the symptom is not "one field is missing". It is **"nothing arrives"**: one
`work: undefined` in one session emptied MulmoTerminal's whole session list on the
phone, with the cause visible only in the host's own console.

Firestore's error names the document, never the field:

```text
Unsupported field value: undefined (found in field result.sessions.11.work
  in document users/…/hosts/…/commands/…)
```

…and `result.sessions.11.work` is the one piece of information that made the
diagnosis possible. The guard's job is to produce that line without losing the reply.

## Change — `packages/core/src/remote-host/server/firestoreSafeResult.ts` (new)

The runner is the single write site, so checking just before the write covers
every host that uses core.

- `undefinedPaths(value)` → every offending path in `a.b.0.c` form.
- `stripUndefined(value)` → the same value with object keys dropped and array holes
  turned into `null`, so surrounding indexes still line up.
- `matchesPathPattern(path, pattern)` / `unexpectedPaths(paths, expected)`
  → which of those paths are worth reporting. It takes the paths, not the value, so
  the runner walks the reply once — that walk is also what tells it whether
  stripping (a full copy) is needed at all.

Wired into `runHandler`: report the unexpected paths through `onEvent`, then write
the stripped value.

**Strip, don't throw.** Throwing reproduces the exact outcome this prevents — the
whole reply lost. A missing optional field costs one row's worth of detail.

**Not `ignoreUndefinedProperties`.** That setting turns this class of bug into "the
value just doesn't arrive", with nothing logged and nothing to grep for.

### Two kinds of `undefined`, one of which is a bug

- **A bug** — the sender put it somewhere it must not be. Has to be findable.
- **Normal** — an optional field with no value this time. Reported on every reply,
  it trains everyone to ignore the warning.

Both must be stripped (Firestore's rule is not negotiable); only the first should be
reported. `HostRunnerOptions.expectedUndefined` declares the second, per method:

```ts
expectedUndefined: { listSessions: ["sessions.*.work"] }   // `*` = exactly one segment
```

Matching is segment-wise, not by regex: no escaping of dots in caller-supplied
patterns, and no pattern can turn into a catastrophic backtrack.

## Traps this walks into deliberately (both cost a fix in mulmoterminal#1044)

- **Sparse arrays.** `flatMap` / `map` SKIP holes, so `[1, , 3]` walked clean and
  Firestore refused the write anyway. `Array.from` visits every index.
- **The reply being `undefined` itself.** Reporting it and then returning it
  unchanged left the write just as broken; it becomes `null`, which is what the
  runner already substituted for a missing result.

## Tests

`packages/core/test/remote-host/test_firestoreSafeResult.ts` — nested paths, every
offending path (not just the first), the sparse-array hole, the root case, index
alignment after stripping, `*` matching exactly one segment, a dot never behaving as
a regex wildcard, and the rule that declaring a path silences the report but never
the strip.

## Not in this PR

- **#2633** (presence failures are invisible; the listener gives up after ~31 s) —
  same file, unrelated failure, its own PR (#2637).
- Publishing `@mulmoclaude/core`. mulmoterminal can drop
  `server/backends/remoteHost/firestoreSafeResult.ts` once this ships to npm.
