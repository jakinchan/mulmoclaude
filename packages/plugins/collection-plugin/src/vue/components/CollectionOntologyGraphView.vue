<template>
  <div class="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden" data-testid="collections-map-panel">
    <div v-if="loading" class="flex flex-col items-center justify-center py-20 text-sm text-slate-500 gap-3">
      <div class="h-8 w-8 border-2 border-indigo-600/20 border-t-indigo-600 rounded-full animate-spin"></div>
      <span>{{ t("common.loading") }}</span>
    </div>

    <div v-else-if="loadError" class="flex items-center gap-3 p-4 text-sm text-red-800">
      <span class="material-icons text-red-600">error</span>
      <span>{{ t("collectionsView.loadFailed") }}</span>
    </div>

    <div v-else-if="graph.nodes.length === 0" class="px-6 py-12 text-center text-sm text-slate-500" data-testid="collections-map-empty">
      <span class="material-icons text-4xl text-slate-300 mb-2">hub</span>
      <p>{{ t("collectionsView.mapEmpty") }}</p>
    </div>

    <div v-else ref="container" class="w-full h-[32rem]" data-testid="collections-map-canvas" />
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import * as echarts from "echarts";
import { buildOntologyGraph, type OntologyGraph, type OntologyGraphEdge, type OntologyGraphNode } from "@mulmoclaude/core/collection";
import { escapeHtml } from "@mulmoclaude/core/wiki";
import { useCollectionI18n } from "../lang";
import { collectionUi } from "../uiContext";

const emit = defineEmits<{ open: [slug: string] }>();

const { t } = useCollectionI18n();
const cui = collectionUi();

const container = ref<HTMLDivElement | null>(null);
const loading = ref(true);
const loadError = ref(false);
const graph = ref<OntologyGraph>({ nodes: [], edges: [] });
// Managed imperatively — not a `ref` — so ECharts internals don't get
// wrapped in Vue reactivity (mirrors WikiGraphView / the chart plugin).
let instance: echarts.ECharts | null = null;

// Log-scaled by record count so a big collection reads bigger without
// dwarfing the graph; ghosts stay minimal.
// `recordCount === null` means the backend couldn't be counted (engine
// failed to load, session closed) — size it like an empty collection rather
// than pretending to know, and let the tooltip say so.
const nodeSize = (node: OntologyGraphNode): number => (node.missing ? 14 : Math.min(40, 20 + Math.round(Math.log2((node.recordCount ?? 0) + 1) * 4)));

const nodeItem = (node: OntologyGraphNode): object => ({
  id: node.slug,
  name: node.title,
  symbolSize: nodeSize(node),
  itemStyle: node.missing ? { color: "#e2e8f0", borderColor: "#94a3b8", borderType: "dashed", borderWidth: 1 } : { color: "#4f46e5" },
  label: node.missing ? { color: "#94a3b8" } : undefined,
  missing: node.missing === true,
  recordCount: node.recordCount,
});

// Display-only relations (embed / uncollapsed backlinks / rollup) draw
// dashed; only a stored `ref` link is solid.
const edgeItem = (edge: OntologyGraphEdge): object => ({
  source: edge.from,
  target: edge.to,
  lineStyle: edge.kind === "ref" ? undefined : { type: "dashed" },
  label: { show: true, formatter: edge.field, fontSize: 9, color: "#64748b" },
  field: edge.field,
  kind: edge.kind,
  reverseFields: edge.reverseFields,
});

const nodeTooltip = (data: { id: string; name: string; missing: boolean; recordCount: number | null }): string => {
  if (data.missing) return `<b>${escapeHtml(data.id)}</b><br>${escapeHtml(t("collectionsView.mapMissingHint"))}`;
  const count = data.recordCount === null ? t("collectionsView.mapRecordCountUnknown") : t("collectionsView.mapRecordCount", { count: data.recordCount });
  return `<b>${escapeHtml(data.name)}</b><br>${escapeHtml(data.id)} · ${escapeHtml(count)}`;
};

const edgeTooltip = (data: { source: string; target: string; field: string; kind: string; reverseFields?: string[] }): string => {
  const reverse = data.reverseFields?.length ? ` ⇄ ${data.reverseFields.join(", ")}` : "";
  return `${escapeHtml(data.source)} —${escapeHtml(data.field)}→ ${escapeHtml(data.target)}<br><span style="color:#64748b">${escapeHtml(data.kind)}${escapeHtml(reverse)}</span>`;
};

// echarts hands the formatter an untyped callback param, so read the item back
// out field by field. `nodeItem` / `edgeItem` above are the only producers;
// anything else degrades to empty labels instead of rendering `undefined`.
const asString = (value: unknown): string => (typeof value === "string" ? value : "");

const toTooltipNode = (data: unknown): { id: string; name: string; missing: boolean; recordCount: number | null } => {
  if (typeof data !== "object" || data === null) return { id: "", name: "", missing: false, recordCount: null };
  return {
    id: asString("id" in data ? data.id : undefined),
    name: asString("name" in data ? data.name : undefined),
    missing: "missing" in data && data.missing === true,
    recordCount: "recordCount" in data && typeof data.recordCount === "number" ? data.recordCount : null,
  };
};

const toTooltipEdge = (data: unknown): { source: string; target: string; field: string; kind: string; reverseFields: string[] } => {
  if (typeof data !== "object" || data === null) return { source: "", target: "", field: "", kind: "", reverseFields: [] };
  const rawReverse: unknown = "reverseFields" in data ? data.reverseFields : undefined;
  const reverse: unknown[] = Array.isArray(rawReverse) ? rawReverse : [];
  return {
    source: asString("source" in data ? data.source : undefined),
    target: asString("target" in data ? data.target : undefined),
    field: asString("field" in data ? data.field : undefined),
    kind: asString("kind" in data ? data.kind : undefined),
    reverseFields: reverse.filter((item): item is string => typeof item === "string"),
  };
};

const tooltipFormatter = (params: unknown): string => {
  if (typeof params !== "object" || params === null) return "";
  const data: unknown = "data" in params ? params.data : undefined;
  const isEdge = "dataType" in params && params.dataType === "edge";
  return isEdge ? edgeTooltip(toTooltipEdge(data)) : nodeTooltip(toTooltipNode(data));
};

const buildOption = (value: OntologyGraph): echarts.EChartsCoreOption => ({
  tooltip: { show: true, formatter: tooltipFormatter },
  series: [
    {
      type: "graph",
      layout: "force",
      roam: true,
      draggable: true,
      label: { show: true, position: "right", fontSize: 11 },
      force: { repulsion: 180, edgeLength: 120, gravity: 0.08 },
      emphasis: { focus: "adjacency" },
      lineStyle: { color: "#cbd5e1", width: 1.5, curveness: 0.1 },
      edgeSymbol: ["none", "arrow"],
      edgeSymbolSize: 7,
      data: value.nodes.map(nodeItem),
      links: value.edges.map(edgeItem),
    },
  ],
});

const render = (): void => {
  const element = container.value;
  if (!element) return;
  if (!instance) {
    instance = echarts.init(element);
    instance.on("click", (params) => {
      if (params.dataType !== "node") return;
      const clicked: unknown = params.data;
      if (typeof clicked !== "object" || clicked === null) return;
      const nodeId = "id" in clicked ? clicked.id : undefined;
      const missing = "missing" in clicked ? clicked.missing : undefined;
      if (typeof nodeId === "string" && missing !== true) emit("open", nodeId);
    });
  }
  instance.setOption(buildOption(graph.value), true);
};

const load = async (): Promise<void> => {
  loading.value = true;
  loadError.value = false;
  const result = await cui.fetchOntology?.();
  loading.value = false;
  if (!result?.ok) {
    loadError.value = true;
    return;
  }
  graph.value = buildOntologyGraph(result.data.entries);
  // The canvas div only mounts after `loading` flips — wait for it.
  await nextTick();
  render();
};

const handleResize = (): void => {
  instance?.resize();
};

onMounted(() => {
  void load();
  window.addEventListener("resize", handleResize);
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", handleResize);
  instance?.dispose();
  instance = null;
});
</script>
