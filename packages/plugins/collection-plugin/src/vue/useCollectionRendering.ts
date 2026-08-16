// Rendering + linked-data layer for collection surfaces, extracted from
// CollectionView.vue so the list/detail view AND the calendar view's record
// panel share one implementation (and one set of ref/embed caches). This is a
// thin composition layer: it wires two concerns and returns their union.
//
//   • `useLinkedCollectionCaches` — owns the per-target caches + the fan-out
//     fetch that fills them (stale-write guard, best-effort fetch).
//   • `useCollectionRendering.renderers` — pure, cache-parameterized renderers
//     (embed views, ref labels, sub-cells, derived formulas).
//   • `useCollectionRendering.helpers` — leaf, stateless formatters re-exposed
//     for template convenience via `STATELESS_RENDERERS`.
//
// Pure-but-stateful: instantiate ONCE per collection surface and pass the
// returned object down to child panels.

import type { Ref } from "vue";
import { useCollectionUiGetter } from "./scopedUi";
import { deriveAll } from "@mulmoclaude/core/collection";
import type {
  BacklinksView,
  CollectionDetail,
  CollectionItem,
  CollectionSchema,
  CollectionFieldSpec as FieldSpec,
  CollectionFieldType as FieldType,
  EmbedCache,
  EmbedView,
  RefCache,
  RefOption,
  RefRecordCache,
} from "@mulmoclaude/core/collection";
import {
  currencySymbolForLocale,
  detailText,
  formatCell,
  formatMoney,
  hasTableRows,
  inputTypeFor,
  isServerStamped,
  isExternalUrl,
  resolveCurrency,
  stepForFieldType,
  tableRows,
} from "./useCollectionRendering.helpers";
import { useLinkedCollectionCaches } from "./useLinkedCollectionCaches";
import {
  buildBacklinksViews,
  buildEmbedViews,
  embedOptionsFor,
  evaluateDerived,
  lookupRefDisplay,
  refOptionsFor,
  renderDerived,
  renderRollup,
  renderSubCell,
  withRollupValues,
} from "./useCollectionRendering.renderers";

export interface CollectionRendering {
  refCache: Ref<RefCache>;
  refRecordCache: Ref<RefRecordCache>;
  embedCache: Ref<EmbedCache>;
  resetLinkedCaches: () => void;
  loadLinkedCollections: (schema: CollectionSchema, expectedSlug: string) => Promise<void>;
  refDisplay: (targetSlug: string, itemSlug: string) => string;
  refOptions: (targetSlug: string) => RefOption[];
  embedOptions: (targetSlug: string) => RefOption[];
  embedViewsFor: (record: CollectionItem | null) => Record<string, EmbedView>;
  backlinksViewsFor: (record: CollectionItem | null) => Record<string, BacklinksView>;
  /** Rollup cell text: the aggregate as a plain number, em-dash when the
   *  source collection couldn't be resolved. Callable per LIST cell —
   *  source derivation is memoized per cache generation. */
  rollupDisplay: (field: FieldSpec, record: CollectionItem | null) => string;
  resolveCurrency: (field: FieldSpec, record: CollectionItem | null | undefined) => string | undefined;
  currencySymbol: (currency: string | undefined) => string;
  formatMoney: (value: unknown, currency: string | undefined, displayLocale: string) => string;
  formatCell: (value: unknown, type: FieldType) => string;
  detailText: (value: unknown) => string;
  isExternalUrl: (value: unknown) => boolean;
  artifactUrl: (value: unknown) => string | null;
  fileRoutePath: (value: unknown) => string | null;
  tableRows: (value: unknown) => Record<string, unknown>[];
  hasTableRows: (value: unknown) => boolean;
  formatSubCell: (subField: FieldSpec, value: unknown, record: CollectionItem | null) => string;
  inputTypeFor: (type: FieldType, value?: unknown) => string;
  isServerStamped: (value: unknown) => boolean;
  stepFor: (type: FieldType) => string | undefined;
  deriveAll: (schema: CollectionSchema, base: CollectionItem, refRecords: RefRecordCache) => CollectionItem;
  evaluateDerivedAgainstItem: (field: FieldSpec, fieldKey: string, item: CollectionItem) => number | null;
  /** Full enrichment for ONE record in the client's compute order —
   *  rollups first, then the formula pass — so a `derived` formula that
   *  references a rollup resolves exactly like server enrichment. Use
   *  this (not raw `deriveAll`) wherever a whole record's computed
   *  values are needed (live edit preview, sort). */
  deriveRecord: (item: CollectionItem) => CollectionItem;
  derivedDisplay: (field: FieldSpec, computedValue: unknown, record: CollectionItem | null) => string;
}

// Leaf formatters re-exposed on the interface for template convenience — pure
// functions with no dependency on the reactive caches or locale.
const STATELESS_RENDERERS = {
  resolveCurrency,
  formatMoney,
  formatCell,
  detailText,
  isExternalUrl,
  tableRows,
  hasTableRows,
  inputTypeFor,
  isServerStamped,
  stepFor: stepForFieldType,
  deriveAll,
};

export function useCollectionRendering(collection: Ref<CollectionDetail | null>, locale: Ref<string>): CollectionRendering {
  // Resolved during setup, called at render time: the card's scope can only be
  // injected here, but the binding itself must stay lazy (a renderer may run
  // before — or without — a host binding).
  const uiFor = useCollectionUiGetter();
  const caches = useLinkedCollectionCaches(collection);
  const { refCache, refRecordCache, embedCache } = caches;
  return {
    ...caches,
    ...STATELESS_RENDERERS,
    refDisplay: (targetSlug, itemSlug) => lookupRefDisplay(refCache.value, targetSlug, itemSlug),
    refOptions: (targetSlug) => refOptionsFor(refCache.value, targetSlug),
    embedOptions: (targetSlug) => embedOptionsFor(embedCache.value, targetSlug),
    embedViewsFor: (record) => buildEmbedViews(collection.value?.schema ?? null, embedCache.value, record, locale.value),
    backlinksViewsFor: (record) => buildBacklinksViews(collection.value?.schema ?? null, embedCache.value, record, locale.value),
    rollupDisplay: (field, record) => renderRollup(field, record, collection.value?.schema ?? null, embedCache.value),
    currencySymbol: (currency) => currencySymbolForLocale(currency, locale.value),
    // A `file` field holds a workspace-relative path; the host resolves it to a
    // served artifact URL (html/svg) or null. The host owns the path guard
    // (absolute / `..`-traversal rejected before building the URL).
    artifactUrl: (value) => uiFor().fileAssetUrl(value),
    // In-app File Explorer route for a workspace path — the fallback for `file`
    // values that aren't a directly-served artifact.
    fileRoutePath: (value) => uiFor().fileRoutePath(value),
    formatSubCell: (subField, value, record) => renderSubCell(subField, value, record, refCache.value, locale.value),
    evaluateDerivedAgainstItem: (field, fieldKey, item) =>
      evaluateDerived(field, fieldKey, item, collection.value?.schema ?? null, refRecordCache.value, embedCache.value),
    deriveRecord: (item) => {
      const schema = collection.value?.schema ?? null;
      if (!schema) return item;
      return deriveAll(schema, withRollupValues(schema, item, embedCache.value), refRecordCache.value);
    },
    derivedDisplay: (field, computedValue, record) => renderDerived(field, computedValue, record, locale.value),
  };
}
