# fix(accounting): parse the dispatch payload instead of casting it (#2695)

`entries: [null]` and `lines: [null]` return **HTTP 500**. The validators written
to turn bad input into a structured 400 are themselves throwing:

```
POST /api/accounting { "action": "addEntries", "entries": [null] }
  -> 500 TypeError: Cannot read properties of null (reading 'date')
POST /api/accounting { "action": "setOpeningBalances", "lines": [null] }
  -> 500 TypeError: Cannot read properties of null (reading 'accountCode')
```

Root cause: three `as never` casts in `router.ts` hand raw wire data to service
functions declared as taking already-validated shapes (`Account`,
`AddEntriesItem[]`, `JournalLine[]`). `as never` is assignable to anything, so
the mismatch compiles — and the validators read `item.date` / `line.accountCode`
off elements that may not be objects.

Deferred from #2694 (see the "Deferred" section of
[`fix-2692-ban-type-assertions.md`](./fix-2692-ban-type-assertions.md)); the
casts are the last three in that file.

## Measured on `main` before the fix (2026-08-02)

Driving the real Express router. The two 500s are the reported bug; the three
200s are the same root cause seen from the other side — nothing ever checked
that a line's `debit` is a number or that an account has a `type`, because the
type system was told it already had.

| payload | today | persisted |
|---|---|---|
| `entries: [null]` | **500** | — |
| `lines: [null]` | **500** | — |
| `lines: [{accountCode:"1000",debit:"abc"}]` | 200 | `"debit":"abc"` in the journal jsonl |
| `entries: [{…, memo: 42}]` | 200 | `"memo":42` |
| `account: {code:"1500"}` | 200 | account with `name`/`type` **undefined** |

The 200s cannot be fixed at the router: a shape gate there would collapse
`debit: "abc"` from `"debit must be a non-negative finite number"` into a
generic message, and the LLM would lose the information it needs to repair its
own payload. They cannot be left alone either — narrowing `unknown` to
`JournalLine` / `Account` *is* checking those fields.

## Approach: parse, don't validate

The existing helpers are validators — they answer "any problems?" but return no
typed value, so a caller still has to assert the shape it just proved. Each one
becomes a parse: takes `unknown`, narrows internally, returns the narrowed value
on success and structured issues on failure. Service signatures then become
honest and the casts have nothing left to hide.

**Every existing error message is preserved verbatim.** Narrowing happens inside
the validators, per field, so `debit: "abc"` keeps its specific message.

### `src/server/journal.ts`

- `parseJournalLine(raw, idx, errors): JournalLine | null` — shape only:
  `accountCode` a string, `debit` / `credit` non-negative finite numbers when
  present, `memo` / `taxRegistrationId` strings, tax-id length cap. A non-object
  line becomes a structured `lines[i]` error instead of a TypeError.
  Deliberately does **not** check account existence or the debit/credit-side
  rule — the journal and the opening balances disagree about those.
- `validateEntry` → `parseEntry(raw: unknown, accounts)` returning
  `{ok: true, entry} | {ok: false, errors}`. A non-object entry is its own
  error; `memo` / `replacesEntryId` are narrowed rather than persisted raw.
- `netBalance` keeps its typed signature — it now runs on parsed lines, and the
  old `typeof` guards already skipped non-numbers, so the numbers don't move.

### `src/server/openingBalances.ts`

- `validateOpening` → `parseOpening({asOfDate, lines: unknown, …})` returning the
  narrowed lines. Reuses `parseJournalLine`; the unknown-account check, the
  balance-sheet-accounts-only rule and the "asOfDate predates everything" rule
  are unchanged.
- Openings deliberately do **not** adopt the entry-level "exactly one of debit
  or credit" rule. `OpeningBalancesForm` can post a line carrying both today;
  tightening that is a separate decision, not part of a 500 → 400 fix.

### `src/server/accountNormalize.ts`

- `parseAccountInput(raw: unknown)` — `code` (existing message verbatim), `name`,
  `type` via an `isAccountType` guard over `ACCOUNT_TYPES`, optional
  `note` / `active`. Missing `name` / `type` now 400 instead of persisting an
  account the report layer cannot group. The Vue AccountsModal already always
  sends all three, so only malformed API / LLM payloads change.

### `src/server/service.ts`

- `addEntries({entries: unknown})`, `setOpeningBalances({lines: unknown})`,
  `upsertAccount({account: unknown})`.
- `collectBatchValidationFailures` → one pass returning both the failures and the
  parsed entries, so `buildBatchEntries` gets typed input.
- `isUnknownArray` for the non-empty-array check (message unchanged).

### `src/server/router.ts`

Three `as never` gone, deferral comment removed. `lines` keeps its `?? []` — an
omitted `lines` is the zero-line opening marker the UI's gate relies on, and
dropping it would turn that into a 400.

## Tests

- `test_journal.ts` / `test_openingBalances.ts` — parse-result shape, plus null
  elements, primitive elements, non-object lines, non-string memo.
- `test_router.ts` — endpoint regressions for `entries: [null]` and
  `lines: [null]` (400 with structured `details`), and an anti-degradation test
  pinning that `debit: "abc"` still yields
  `"debit must be a non-negative finite number"` rather than a generic shape
  error.
- `test_service.ts` — `upsertAccount` without `name` / `type` rejects; an
  opening with a string `debit` no longer persists.

## Out of scope

Version bump / npm publish. `@mulmoclaude/accounting-plugin@1.1.0` carries the
bug; the bump, the launcher dep-range sweep (`packages/mulmoclaude` declares
`^1.1.0`) and the tagged publish go through the `/publish` skill afterwards.
