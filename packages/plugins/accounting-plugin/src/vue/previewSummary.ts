// The line of text the compact preview card shows for a non-openBook tool
// result. Pure and Vue-free: `Preview.vue` is the template plus a `computed`
// that calls `summarisePreview`, so these branches are reachable from
// `tsx --test` (which cannot load an SFC).
//
// Everything below the payload root arrives as `unknown` — the dispatch
// envelope is built server-side and replayed from the chat log — so a field is
// a string or a number only once one of the readers below has looked.

import { isRecord, isUnknownArray } from "@mulmoclaude/common";

import { formatAmountNumeric } from "../shared";

/** The subset of the plugin's i18n surface these summaries need, injected so
 *  the module stays free of Vue and of the locale wiring. */
export type TranslateFn = (key: string, named?: Record<string, unknown>) => string;

const optionalString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const optionalNumber = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);

// Each summarise* helper returns null when its branch doesn't apply, keeping
// the dispatch below linear (no nested if-trees).

export function summariseError(json: Record<string, unknown>, translate: TranslateFn): string | null {
  const error = optionalString(json.error);
  if (error === undefined) return null;
  return translate("pluginAccounting.previewError", { error });
}

export function summariseEntry(json: Record<string, unknown>, translate: TranslateFn): string | null {
  // addEntries returns `{ entries: [...] }`. The card shows one date — the
  // first entry's, so single-entry batches (the common case from the manual
  // UI) read naturally and multi-entry batches still anchor to a real date.
  const [first] = isUnknownArray(json.entries) ? json.entries : [];
  const entry = isRecord(first) ? first : undefined;
  const entryId = optionalString(entry?.id);
  const date = optionalString(entry?.date);
  if (!entryId || !date) return null;
  return translate("pluginAccounting.preview.entry", { date });
}

export function summarisePl(json: Record<string, unknown>, translate: TranslateFn): string | null {
  const { profitLoss } = json;
  if (!isRecord(profitLoss)) return null;
  const netIncome = optionalNumber(profitLoss.netIncome);
  if (netIncome === undefined) return null;
  return translate("pluginAccounting.preview.pl", {
    from: optionalString(profitLoss.from) ?? "?",
    to: optionalString(profitLoss.to) ?? "?",
    net: formatAmountNumeric(netIncome),
  });
}

export function summariseBs(json: Record<string, unknown>, translate: TranslateFn): string | null {
  const { balanceSheet } = json;
  if (!isRecord(balanceSheet)) return null;
  const date = optionalString(balanceSheet.asOf);
  const sections = isUnknownArray(balanceSheet.sections) ? balanceSheet.sections : undefined;
  if (!date || !sections) return null;
  const assets = sections.find((section) => isRecord(section) && section.type === "asset");
  return translate("pluginAccounting.preview.bs", {
    date,
    assets: isRecord(assets) ? formatAmountNumeric(optionalNumber(assets.total) ?? 0) : "?",
  });
}

export function summariseBook(json: Record<string, unknown>, translate: TranslateFn): string | null {
  const { book } = json;
  if (!isRecord(book)) return null;
  const bookId = optionalString(book.id);
  const name = optionalString(book.name);
  if (!bookId || !name) return null;
  return translate("pluginAccounting.preview.bookCreated", { name, id: bookId });
}

export function summariseFallback(json: Record<string, unknown>, translate: TranslateFn): string {
  const bookId = optionalString(json.bookId);
  if (bookId !== undefined) return translate("pluginAccounting.previewSummary", { bookId });
  return translate("pluginAccounting.previewGeneric");
}

/** Merge the two props a host might carry the payload on. `isRecord` rejects
 *  arrays, which the old `typeof value === "object"` check spread into the
 *  payload. */
export const asPayload = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

export function summarisePreview(data: unknown, jsonData: unknown, translate: TranslateFn): string {
  const json = { ...asPayload(data), ...asPayload(jsonData) };
  return (
    summariseError(json, translate) ??
    summariseEntry(json, translate) ??
    summarisePl(json, translate) ??
    summariseBs(json, translate) ??
    summariseBook(json, translate) ??
    summariseFallback(json, translate)
  );
}
