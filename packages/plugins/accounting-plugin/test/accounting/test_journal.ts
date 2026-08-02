import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_TAX_REGISTRATION_ID_LENGTH,
  isValidCalendarDate,
  makeEntry,
  makeVoidEntries,
  netBalance,
  parseEntry,
  voidedIdSet,
  type EntryParseResult,
  type ValidationError,
} from "../../src/server/journal.js";
import type { Account, JournalEntry, JournalLine } from "../../src/shared/types.js";

/** Reading issues off a parse result: the ok branch carries the entry,
 *  not an empty error list, so tests ask for the issues explicitly. */
function issuesOf(result: EntryParseResult): ValidationError[] {
  return result.ok ? [] : result.errors;
}

const ACCOUNTS: Account[] = [
  { code: "1000", name: "Cash", type: "asset" },
  { code: "2000", name: "AP", type: "liability" },
  { code: "4000", name: "Sales", type: "income" },
];

function balancedLines(): JournalLine[] {
  return [
    { accountCode: "1000", debit: 100 },
    { accountCode: "4000", credit: 100 },
  ];
}

/** Every fixture below is a two-line entry, so a missing line is a test failure, not a branch. */
function firstTwo<T>(items: T[]): [T, T] {
  const [first, second] = items;
  assert.ok(first);
  assert.ok(second);
  return [first, second];
}

describe("netBalance", () => {
  it("sums debit minus credit", () => {
    assert.equal(netBalance(balancedLines()), 0);
    assert.equal(
      netBalance([
        { accountCode: "1000", debit: 50 },
        { accountCode: "4000", credit: 30 },
      ]),
      20,
    );
  });
});

describe("isValidCalendarDate", () => {
  it("accepts real calendar dates", () => {
    assert.equal(isValidCalendarDate("2026-04-15"), true);
    assert.equal(isValidCalendarDate("2024-02-29"), true); // leap day
  });
  it("rejects shape-correct but impossible dates", () => {
    assert.equal(isValidCalendarDate("2026-02-31"), false);
    assert.equal(isValidCalendarDate("2026-13-01"), false);
    assert.equal(isValidCalendarDate("2025-02-29"), false); // non-leap
  });
  it("rejects malformed strings", () => {
    assert.equal(isValidCalendarDate("2026/04/15"), false);
    assert.equal(isValidCalendarDate("not-a-date"), false);
    assert.equal(isValidCalendarDate(""), false);
  });
});

describe("parseEntry", () => {
  it("accepts a balanced entry and returns it narrowed", () => {
    const result = parseEntry({ date: "2026-04-01", lines: balancedLines(), memo: "Sale" }, ACCOUNTS);
    assert.equal(result.ok, true);
    assert.deepEqual(issuesOf(result), []);
    // The point of parsing over validating: the caller gets a value it
    // doesn't have to re-assert before handing to makeEntry.
    assert.ok(result.ok);
    assert.equal(result.entry.date, "2026-04-01");
    assert.equal(result.entry.memo, "Sale");
    assert.deepEqual(result.entry.lines, balancedLines());
  });
  it("rejects malformed dates", () => {
    const result = parseEntry({ date: "2026/04/01", lines: balancedLines() }, ACCOUNTS);
    assert.equal(result.ok, false);
    assert.ok(issuesOf(result).some((err) => err.field === "date"));
  });
  it("rejects unknown account codes", () => {
    const result = parseEntry(
      {
        date: "2026-04-01",
        lines: [
          { accountCode: "9999", debit: 100 },
          { accountCode: "4000", credit: 100 },
        ],
      },
      ACCOUNTS,
    );
    assert.equal(result.ok, false);
    assert.ok(issuesOf(result).some((err) => err.field.includes("accountCode")));
  });
  it("rejects unbalanced entries", () => {
    const result = parseEntry(
      {
        date: "2026-04-01",
        lines: [
          { accountCode: "1000", debit: 100 },
          { accountCode: "4000", credit: 90 },
        ],
      },
      ACCOUNTS,
    );
    assert.equal(result.ok, false);
    assert.ok(issuesOf(result).some((err) => err.message.includes("must balance")));
  });
  it("rejects single-line entries", () => {
    const result = parseEntry({ date: "2026-04-01", lines: [{ accountCode: "1000", debit: 100 }] }, ACCOUNTS);
    assert.equal(result.ok, false);
  });
  it("rejects lines with both debit and credit set", () => {
    const result = parseEntry(
      {
        date: "2026-04-01",
        lines: [
          { accountCode: "1000", debit: 50, credit: 30 },
          { accountCode: "4000", credit: 20 },
        ],
      },
      ACCOUNTS,
    );
    assert.equal(result.ok, false);
  });
  it("tolerates floating-point noise within ±0.005", () => {
    // 0.1 + 0.2 = 0.30000000000000004 in IEEE-754 — must not flunk
    const result = parseEntry(
      {
        date: "2026-04-01",
        lines: [
          { accountCode: "1000", debit: 0.1 },
          { accountCode: "1000", debit: 0.2 },
          { accountCode: "4000", credit: 0.3 },
        ],
      },
      ACCOUNTS,
    );
    assert.equal(result.ok, true);
  });
  it("accepts a line with a taxRegistrationId at the length cap", () => {
    const taxId = "T".repeat(MAX_TAX_REGISTRATION_ID_LENGTH);
    const result = parseEntry(
      {
        date: "2026-04-01",
        lines: [
          { accountCode: "1000", debit: 100, taxRegistrationId: taxId },
          { accountCode: "4000", credit: 100 },
        ],
      },
      ACCOUNTS,
    );
    assert.equal(result.ok, true);
  });
  it("rejects a taxRegistrationId longer than the length cap (after trim)", () => {
    const tooLong = "T".repeat(MAX_TAX_REGISTRATION_ID_LENGTH + 1);
    const result = parseEntry(
      {
        date: "2026-04-01",
        lines: [
          { accountCode: "1000", debit: 100, taxRegistrationId: tooLong },
          { accountCode: "4000", credit: 100 },
        ],
      },
      ACCOUNTS,
    );
    assert.equal(result.ok, false);
    assert.ok(issuesOf(result).some((err) => err.field === "lines[0].taxRegistrationId"));
  });
  it("ignores leading/trailing whitespace when checking the length cap", () => {
    // 32 chars padded with whitespace on both sides: trimmed length
    // is at the cap, so the entry should still be accepted.
    const padded = `  ${"T".repeat(MAX_TAX_REGISTRATION_ID_LENGTH)}  `;
    const result = parseEntry(
      {
        date: "2026-04-01",
        lines: [
          { accountCode: "1000", debit: 100, taxRegistrationId: padded },
          { accountCode: "4000", credit: 100 },
        ],
      },
      ACCOUNTS,
    );
    assert.equal(result.ok, true);
  });
});

// #2695: these all used to read `item.date` / `line.accountCode` off a
// value that isn't an object, so the validator itself threw and the
// route answered 500 — from the code written to produce a 400.
describe("parseEntry — non-object input", () => {
  it("reports a null entry instead of throwing", () => {
    const result = parseEntry(null, ACCOUNTS);
    assert.equal(result.ok, false);
    assert.deepEqual(
      issuesOf(result).map((err) => err.field),
      ["entry"],
    );
  });
  it("reports a primitive entry", () => {
    assert.equal(parseEntry(42, ACCOUNTS).ok, false);
    assert.equal(parseEntry("nope", ACCOUNTS).ok, false);
  });
  it("reports a null line against its own index", () => {
    const result = parseEntry({ date: "2026-04-01", lines: [null, { accountCode: "4000", credit: 100 }] }, ACCOUNTS);
    assert.equal(result.ok, false);
    assert.ok(issuesOf(result).some((err) => err.field === "lines[0]"));
  });
  it("reports a primitive line against its own index", () => {
    const result = parseEntry({ date: "2026-04-01", lines: [{ accountCode: "1000", debit: 100 }, "nope"] }, ACCOUNTS);
    assert.equal(result.ok, false);
    assert.ok(issuesOf(result).some((err) => err.field === "lines[1]"));
  });
  it("keeps the specific field message for a mistyped amount", () => {
    // The anti-degradation check: a shape gate at the route would have
    // answered "entries are malformed" and left the caller guessing.
    const result = parseEntry(
      {
        date: "2026-04-01",
        lines: [
          { accountCode: "1000", debit: "abc" },
          { accountCode: "4000", credit: 100 },
        ],
      },
      ACCOUNTS,
    );
    assert.equal(result.ok, false);
    assert.ok(
      issuesOf(result).some((err) => err.field === "lines[0].debit" && err.message === "debit must be a non-negative finite number"),
      JSON.stringify(issuesOf(result)),
    );
  });
  it("rejects a non-string memo rather than persisting it raw", () => {
    const result = parseEntry({ date: "2026-04-01", lines: balancedLines(), memo: 42 }, ACCOUNTS);
    assert.equal(result.ok, false);
    assert.ok(issuesOf(result).some((err) => err.field === "memo"));
  });
  it("rejects a non-string accountCode", () => {
    const result = parseEntry(
      {
        date: "2026-04-01",
        lines: [
          { accountCode: 1000, debit: 100 },
          { accountCode: "4000", credit: 100 },
        ],
      },
      ACCOUNTS,
    );
    assert.equal(result.ok, false);
    assert.ok(issuesOf(result).some((err) => err.field === "lines[0].accountCode"));
  });
  it("does not claim an entry is unbalanced when a line was unreadable", () => {
    // 100 debit against 100 credit — it balances. An unreadable line
    // contributes nothing to the sum, so reporting the difference would
    // send the caller off to fix amounts that were never wrong.
    const result = parseEntry(
      {
        date: "2026-04-01",
        lines: [
          { accountCode: 1000, debit: 100 },
          { accountCode: "4000", credit: 100 },
        ],
      },
      ACCOUNTS,
    );
    assert.equal(result.ok, false);
    assert.equal(
      issuesOf(result).some((err) => err.message.includes("must balance")),
      false,
      JSON.stringify(issuesOf(result)),
    );
  });
  it("still reports a genuine imbalance when every line is readable", () => {
    const result = parseEntry(
      {
        date: "2026-04-01",
        lines: [
          { accountCode: "1000", debit: 100 },
          { accountCode: "4000", credit: 90 },
        ],
      },
      ACCOUNTS,
    );
    assert.ok(issuesOf(result).some((err) => err.message.includes("must balance")));
  });
});

describe("makeEntry", () => {
  it("attaches a UUID, timestamp, and default kind=normal", () => {
    const entry = makeEntry({ date: "2026-04-01", lines: balancedLines() });
    assert.match(entry.id, /^[0-9a-f]{8}-[0-9a-f]{4}-/);
    assert.equal(entry.kind, "normal");
    assert.ok(entry.createdAt.endsWith("Z"));
  });
  it("clones the lines array (caller can mutate input safely)", () => {
    const lines = balancedLines();
    const entry = makeEntry({ date: "2026-04-01", lines });
    const [mutatedLine] = firstTwo(lines);
    mutatedLine.debit = 999;
    const [clonedLine] = firstTwo(entry.lines);
    assert.equal(clonedLine.debit, 100);
  });
  it("trims taxRegistrationId and preserves it on the persisted line", () => {
    const entry = makeEntry({
      date: "2026-04-01",
      lines: [
        { accountCode: "1000", debit: 100, taxRegistrationId: "  T1234567890123  " },
        { accountCode: "4000", credit: 100 },
      ],
    });
    const [taxedLine, plainLine] = firstTwo(entry.lines);
    assert.equal(taxedLine.taxRegistrationId, "T1234567890123");
    assert.equal(plainLine.taxRegistrationId, undefined);
  });
  it("normalizes empty / whitespace-only taxRegistrationId to absent", () => {
    const entry = makeEntry({
      date: "2026-04-01",
      lines: [
        { accountCode: "1000", debit: 100, taxRegistrationId: "" },
        { accountCode: "4000", credit: 100, taxRegistrationId: "   " },
      ],
    });
    const [emptyIdLine, blankIdLine] = firstTwo(entry.lines);
    assert.equal(emptyIdLine.taxRegistrationId, undefined);
    assert.equal(blankIdLine.taxRegistrationId, undefined);
  });
});

describe("makeVoidEntries", () => {
  it("reverse swaps debit / credit; marker references the original", () => {
    const original = makeEntry({ date: "2026-04-01", lines: balancedLines() });
    const { reverse, marker } = makeVoidEntries(original, "typo", "2026-04-30");
    assert.equal(reverse.kind, "void");
    assert.equal(reverse.voidedEntryId, original.id);
    const [reversedDebit, reversedCredit] = firstTwo(reverse.lines);
    assert.equal(reversedDebit.credit, 100);
    assert.equal(reversedDebit.debit, undefined);
    assert.equal(reversedCredit.debit, 100);
    assert.equal(marker.kind, "void-marker");
    assert.equal(marker.voidedEntryId, original.id);
    assert.equal(marker.lines.length, 0);
  });
  it("memo quotes the original entry-level memo and date when present", () => {
    const original = makeEntry({ date: "2026-04-01", lines: balancedLines(), memo: "Office rent" });
    const { reverse } = makeVoidEntries(original, undefined, "2026-04-30");
    assert.equal(reverse.memo, "void of 'Office rent' on 2026-04-01");
  });
  it("memo falls back to the first line memo when entry-level memo is missing", () => {
    const original = makeEntry({
      date: "2026-04-01",
      lines: [
        { accountCode: "1000", debit: 100, memo: "Cash deposit" },
        { accountCode: "4000", credit: 100 },
      ],
    });
    const { reverse } = makeVoidEntries(original, undefined, "2026-04-30");
    assert.equal(reverse.memo, "void of 'Cash deposit' on 2026-04-01");
  });
  it("memo uses the date-only template when no original memo exists", () => {
    const original = makeEntry({ date: "2026-04-01", lines: balancedLines() });
    const { reverse } = makeVoidEntries(original, undefined, "2026-04-30");
    assert.equal(reverse.memo, "void of entry on 2026-04-01");
  });
  it("memo appends the user-supplied reason after a colon when present", () => {
    const original = makeEntry({ date: "2026-04-01", lines: balancedLines(), memo: "Office rent" });
    const { reverse } = makeVoidEntries(original, "duplicate", "2026-04-30");
    assert.equal(reverse.memo, "void of 'Office rent' on 2026-04-01: duplicate");
  });
  it("preserves taxRegistrationId on each reversed line", () => {
    const original = makeEntry({
      date: "2026-04-01",
      lines: [
        { accountCode: "1000", debit: 100, taxRegistrationId: "T1234567890123" },
        { accountCode: "4000", credit: 100 },
      ],
    });
    const { reverse } = makeVoidEntries(original, undefined, "2026-04-30");
    const [taxedReverseLine, plainReverseLine] = firstTwo(reverse.lines);
    assert.equal(taxedReverseLine.taxRegistrationId, "T1234567890123");
    assert.equal(plainReverseLine.taxRegistrationId, undefined);
  });
});

describe("voidedIdSet", () => {
  it("collects ids referenced by void-marker entries", () => {
    const entryA = makeEntry({ date: "2026-04-01", lines: balancedLines() });
    const entryB = makeEntry({ date: "2026-04-02", lines: balancedLines() });
    const { reverse, marker } = makeVoidEntries(entryA, "x", "2026-04-30");
    const all: JournalEntry[] = [entryA, entryB, reverse, marker];
    const voided = voidedIdSet(all);
    assert.equal(voided.has(entryA.id), true);
    assert.equal(voided.has(entryB.id), false);
    assert.equal(voided.has(reverse.id), false);
  });
});
