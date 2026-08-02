// Branch + boundary coverage for the compact preview summary.
//
// Every payload here is the real shape `router.ts` returns for that action
// (see test_router.ts, which drives the same responses over HTTP), plus the
// malformed variants the readers exist to survive.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  asPayload,
  summariseBook,
  summariseBs,
  summariseEntry,
  summariseError,
  summariseFallback,
  summarisePl,
  summarisePreview,
} from "../../src/vue/previewSummary.js";

/** Echoes the key and its interpolations, so a test asserts which branch ran
 *  and what it read — not the wording of a translation. */
const translate = (key: string, named?: Record<string, unknown>): string => (named === undefined ? key : `${key} ${JSON.stringify(named)}`);

describe("summariseError", () => {
  it("reports a string error", () => {
    assert.match(summariseError({ error: "bookId is required" }, translate) ?? "", /previewError.*bookId is required/);
  });

  it("declines when error is absent or not a string", () => {
    assert.equal(summariseError({}, translate), null);
    assert.equal(summariseError({ error: 500 }, translate), null);
    assert.equal(summariseError({ error: null }, translate), null);
  });
});

describe("summariseEntry", () => {
  const entries = [
    { id: "e1", date: "2026-02-01" },
    { id: "e2", date: "2026-02-02" },
  ];

  it("anchors to the first entry's date", () => {
    assert.match(summariseEntry({ entries }, translate) ?? "", /preview\.entry.*2026-02-01/);
  });

  it("declines when the entry lacks an id or a date", () => {
    assert.equal(summariseEntry({ entries: [{ date: "2026-02-01" }] }, translate), null);
    assert.equal(summariseEntry({ entries: [{ id: "e1" }] }, translate), null);
  });

  it("declines on a non-object element rather than throwing", () => {
    // `entries: [null]` is the shape that used to crash the accounting
    // validators (#2695); the preview must degrade, not throw.
    assert.equal(summariseEntry({ entries: [null] }, translate), null);
    assert.equal(summariseEntry({ entries: ["e1"] }, translate), null);
  });

  it("declines when entries is empty or not an array", () => {
    assert.equal(summariseEntry({ entries: [] }, translate), null);
    assert.equal(summariseEntry({ entries: "e1" }, translate), null);
    assert.equal(summariseEntry({}, translate), null);
  });

  it("declines on a non-string id or date", () => {
    assert.equal(summariseEntry({ entries: [{ id: 7, date: "2026-02-01" }] }, translate), null);
    assert.equal(summariseEntry({ entries: [{ id: "e1", date: 20260201 }] }, translate), null);
  });
});

describe("summarisePl", () => {
  const profitLoss = { from: "2026-01-01", to: "2026-12-31", netIncome: 50 };

  it("reports the period and net income", () => {
    const summary = summarisePl({ profitLoss }, translate) ?? "";
    assert.match(summary, /preview\.pl/);
    assert.match(summary, /2026-01-01/);
    assert.match(summary, /2026-12-31/);
  });

  it("keeps a zero net income — it is a real answer, not a missing one", () => {
    assert.match(summarisePl({ profitLoss: { ...profitLoss, netIncome: 0 } }, translate) ?? "", /preview\.pl/);
  });

  it("falls back to ? for a non-string from/to rather than rendering the number", () => {
    const summary = summarisePl({ profitLoss: { from: 1, to: 2, netIncome: 50 } }, translate) ?? "";
    assert.match(summary, /"from":"\?"/);
    assert.match(summary, /"to":"\?"/);
  });

  it("declines when netIncome is absent or not a number", () => {
    assert.equal(summarisePl({ profitLoss: { from: "a", to: "b" } }, translate), null);
    assert.equal(summarisePl({ profitLoss: { ...profitLoss, netIncome: "50" } }, translate), null);
  });

  it("declines when profitLoss is not a plain object", () => {
    assert.equal(summarisePl({ profitLoss: [profitLoss] }, translate), null);
    assert.equal(summarisePl({ profitLoss: null }, translate), null);
    assert.equal(summarisePl({}, translate), null);
  });
});

describe("summariseBs", () => {
  const balanceSheet = {
    asOf: "2026-02-28",
    sections: [
      { type: "asset", total: 160 },
      { type: "liability", total: 0 },
    ],
  };

  it("reports the date and the asset total", () => {
    const summary = summariseBs({ balanceSheet }, translate) ?? "";
    assert.match(summary, /preview\.bs/);
    assert.match(summary, /2026-02-28/);
    assert.match(summary, /160/);
  });

  it("renders ? when there is no asset section", () => {
    const sections = [{ type: "liability", total: 0 }];
    assert.match(summariseBs({ balanceSheet: { ...balanceSheet, sections } }, translate) ?? "", /"assets":"\?"/);
  });

  it("treats a non-numeric total as zero rather than rendering the raw value", () => {
    const sections = [{ type: "asset", total: "9" }];
    assert.match(summariseBs({ balanceSheet: { ...balanceSheet, sections } }, translate) ?? "", /"assets":"0/);
  });

  it("survives a null section instead of throwing", () => {
    // The old `sections.find(...)` reached into whatever the array held.
    assert.doesNotThrow(() => summariseBs({ balanceSheet: { ...balanceSheet, sections: [null] } }, translate));
    assert.match(summariseBs({ balanceSheet: { ...balanceSheet, sections: [null] } }, translate) ?? "", /"assets":"\?"/);
  });

  it("declines when sections is not an array or asOf is not a string", () => {
    assert.equal(summariseBs({ balanceSheet: { ...balanceSheet, sections: "x" } }, translate), null);
    assert.equal(summariseBs({ balanceSheet: { ...balanceSheet, asOf: 20260228 } }, translate), null);
  });
});

describe("summariseBook", () => {
  it("reports the created book's name and id", () => {
    const summary = summariseBook({ book: { id: "book-1", name: "Probe Co" } }, translate) ?? "";
    assert.match(summary, /preview\.bookCreated/);
    assert.match(summary, /Probe Co/);
    assert.match(summary, /book-1/);
  });

  it("declines when id or name is missing or not a string", () => {
    assert.equal(summariseBook({ book: { id: "book-1" } }, translate), null);
    assert.equal(summariseBook({ book: { name: "Probe Co" } }, translate), null);
    assert.equal(summariseBook({ book: { id: 1, name: "Probe Co" } }, translate), null);
  });

  it("declines when book is not a plain object", () => {
    assert.equal(summariseBook({ book: null }, translate), null);
    assert.equal(summariseBook({ book: ["book-1"] }, translate), null);
  });
});

describe("summariseFallback", () => {
  it("names the book when the payload carries a bookId", () => {
    assert.match(summariseFallback({ bookId: "book-1" }, translate), /previewSummary.*book-1/);
  });

  it("returns the generic line for a non-string bookId", () => {
    assert.equal(summariseFallback({ bookId: 42 }, translate), "pluginAccounting.previewGeneric");
    assert.equal(summariseFallback({}, translate), "pluginAccounting.previewGeneric");
  });
});

describe("asPayload", () => {
  it("passes a plain object through", () => {
    const value = { bookId: "b1" };
    assert.equal(asPayload(value), value);
  });

  it("reads an array as empty — the old typeof check spread it into the payload", () => {
    assert.deepEqual(asPayload([1, 2]), {});
    assert.deepEqual(asPayload(null), {});
    assert.deepEqual(asPayload("b1"), {});
  });
});

describe("summarisePreview dispatch", () => {
  it("prefers error over every other branch", () => {
    const json = { error: "boom", entries: [{ id: "e1", date: "2026-02-01" }] };
    assert.match(summarisePreview(json, undefined, translate), /previewError/);
  });

  it("picks each branch in turn", () => {
    assert.match(summarisePreview({ entries: [{ id: "e1", date: "2026-02-01" }] }, undefined, translate), /preview\.entry/);
    assert.match(summarisePreview({ profitLoss: { from: "a", to: "b", netIncome: 1 } }, undefined, translate), /preview\.pl/);
    assert.match(summarisePreview({ balanceSheet: { asOf: "2026-02-28", sections: [] } }, undefined, translate), /preview\.bs/);
    assert.match(summarisePreview({ book: { id: "b1", name: "Co" } }, undefined, translate), /preview\.bookCreated/);
  });

  it("merges jsonData over data", () => {
    assert.match(summarisePreview({ bookId: "from-data" }, { bookId: "from-json" }, translate), /from-json/);
  });

  it("falls back to the generic line for an unrecognised payload", () => {
    assert.equal(summarisePreview({ rebuilt: true }, undefined, translate), "pluginAccounting.previewGeneric");
    assert.equal(summarisePreview(undefined, undefined, translate), "pluginAccounting.previewGeneric");
  });
});
