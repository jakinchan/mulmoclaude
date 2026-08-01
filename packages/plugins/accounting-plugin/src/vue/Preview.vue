<template>
  <!-- Compact inline summary for non-openBook tool results. The
       openBook envelope routes to View.vue (full app) instead of
       this component; everything that lands here is a
       compact-result action (addEntries, getReport, …). -->
  <div class="text-sm text-gray-700" data-testid="accounting-preview">
    <span class="material-icons text-base align-middle mr-1">account_balance</span>
    <span>{{ summary }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { isRecord, isUnknownArray } from "@mulmoclaude/common";
import { useAccountingI18n } from "./lang";
import { formatAmountNumeric } from "../shared";

const { t } = useAccountingI18n();

const props = defineProps<{ data?: unknown; jsonData?: Record<string, unknown> }>();

// Readers, not predicates: everything below the payload root arrives as
// `unknown`, so a field is a string / number only once one of these has
// looked. Twins of the server's `bodyFields.ts` readers, duplicated here
// because a browser bundle must not import the server surface.
const optionalString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const optionalNumber = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);

// Each summarise* helper returns null when its branch doesn't apply,
// keeping the dispatch in `summary` linear (no nested if-trees).

function summariseError(json: Record<string, unknown>): string | null {
  const error = optionalString(json.error);
  if (error === undefined) return null;
  return t("pluginAccounting.previewError", { error });
}

function summariseEntry(json: Record<string, unknown>): string | null {
  // addEntries returns `{ entries: [...] }`. The compact preview
  // card shows one date — use the first entry's so single-entry
  // batches (the common case from the manual UI) read naturally
  // and multi-entry batches still anchor to a meaningful date.
  const [first] = isUnknownArray(json.entries) ? json.entries : [];
  const entry = isRecord(first) ? first : undefined;
  const entryId = optionalString(entry?.id);
  const date = optionalString(entry?.date);
  if (!entryId || !date) return null;
  return t("pluginAccounting.preview.entry", { date });
}

function summarisePl(json: Record<string, unknown>): string | null {
  const { profitLoss } = json;
  if (!isRecord(profitLoss)) return null;
  const netIncome = optionalNumber(profitLoss.netIncome);
  if (netIncome === undefined) return null;
  return t("pluginAccounting.preview.pl", {
    from: optionalString(profitLoss.from) ?? "?",
    to: optionalString(profitLoss.to) ?? "?",
    net: formatAmountNumeric(netIncome),
  });
}

function summariseBs(json: Record<string, unknown>): string | null {
  const { balanceSheet } = json;
  if (!isRecord(balanceSheet)) return null;
  const date = optionalString(balanceSheet.asOf);
  const sections = isUnknownArray(balanceSheet.sections) ? balanceSheet.sections : undefined;
  if (!date || !sections) return null;
  const assets = sections.find((section) => isRecord(section) && section.type === "asset");
  return t("pluginAccounting.preview.bs", {
    date,
    assets: isRecord(assets) ? formatAmountNumeric(optionalNumber(assets.total) ?? 0) : "?",
  });
}

function summariseBook(json: Record<string, unknown>): string | null {
  const { book } = json;
  if (!isRecord(book)) return null;
  const bookId = optionalString(book.id);
  const name = optionalString(book.name);
  if (!bookId || !name) return null;
  return t("pluginAccounting.preview.bookCreated", { name, id: bookId });
}

function summariseFallback(json: Record<string, unknown>): string {
  const bookId = optionalString(json.bookId);
  if (bookId !== undefined) return t("pluginAccounting.previewSummary", { bookId });
  return t("pluginAccounting.previewGeneric");
}

function asObject(value: unknown): Record<string, unknown> {
  // Some renderers pass the structured payload via `data`, others
  // via `jsonData`. Accept either so a tool-result like
  // `{ entry: ... }` resolves to the right summariser regardless
  // of which prop the host harness picks.
  return isRecord(value) ? value : {};
}

const summary = computed<string>(() => {
  const json = { ...asObject(props.data), ...asObject(props.jsonData) };
  return summariseError(json) ?? summariseEntry(json) ?? summarisePl(json) ?? summariseBs(json) ?? summariseBook(json) ?? summariseFallback(json);
});
</script>
