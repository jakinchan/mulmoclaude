// Runtime plugin loader — frontend half (#1043 C-2).
//
// At app boot, before `app.mount(...)`, ask the server which plugins
// the user has installed (`/api/plugins/runtime/list`), then dynamic-
// import each plugin's `dist/vue.js` and register the resulting
// `viewComponent` / `previewComponent` into a runtime overlay that
// `getPlugin()` consults.
//
// CSS handling: each plugin ships its own bundled `dist/style.css`
// (Tailwind utility classes the plugin author chose). We inject a
// `<link rel="stylesheet">` per plugin so canvas-rendered Views look
// the same as the build-time-bundled external plugins.
//
// Failures don't abort boot — a single broken plugin logs a warning
// and the rest of the app starts normally.

import { defineAsyncComponent, defineComponent, h, markRaw, reactive } from "vue";
import type { Component } from "vue";
import type { ToolDefinition } from "gui-chat-protocol";
import { apiGet } from "../utils/api";
import { API_ROUTES } from "../config/apiRoutes";
import type { PluginEntry } from "./types";

// Lazy-imported so the module load doesn't pull in a `.vue` SFC
// for callers that only touch the server-only fallback path
// (e.g. `test/tools/test_runtimeLoader.ts` running under tsx in
// Node, where there's no Vue plugin to compile SFCs).
const PluginScopedRoot = defineAsyncComponent(() => import("../components/PluginScopedRoot.vue"));

interface RuntimePluginListing {
  name: string;
  version: string;
  toolName: string;
  description: string;
  /** Absolute URL prefix; the dist files live under it. */
  assetBase: string;
}

interface ToolPluginExport {
  toolDefinition?: ToolDefinition | undefined;
  viewComponent?: Component | undefined;
  previewComponent?: Component | undefined;
}

interface PluginVueModule {
  plugin?: ToolPluginExport | undefined;
  default?: { plugin?: ToolPluginExport };
}

/** Tool name → PluginEntry. Reactive so callers reading via
 *  `getRuntimePluginEntry(name)` / `getRuntimeToolNames()` from a
 *  template, computed, or watch automatically re-evaluate when the
 *  loader populates the registry post-mount. Without this, a
 *  component that snapshots plugin names in `setup()` (RolesView,
 *  manageRoles/View, App.vue's tool-result render path) would never
 *  see workspace-installed plugins because the loader is fire-and-
 *  forget — by the time the list fetch resolves, those components
 *  have already cached their initial reads.
 *
 *  Vue 3's `reactive(new Map())` tracks `.get()`, `.has()`, and
 *  iteration (`.keys()`, `for…of`) so the call sites don't need to
 *  change shape — they just need to be inside a reactive context. */
const runtimeRegistry = reactive(new Map<string, PluginEntry>());

export function getRuntimePluginEntry(toolName: string): PluginEntry | null {
  return runtimeRegistry.get(toolName) ?? null;
}

export function getRuntimeToolNames(): string[] {
  return Array.from(runtimeRegistry.keys());
}

/** Test-only reset. */
export function _resetRuntimeRegistryForTest(): void {
  runtimeRegistry.clear();
}

function injectStyle(href: string): void {
  // Skip if a previous boot already added it (HMR / re-mount).
  if (document.querySelector(`link[data-runtime-plugin-css="${href}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.dataset.runtimePluginCss = href;
  document.head.appendChild(link);
}

/** Build an entry from listing data only — used when the package
 *  has no `dist/vue.js` (server-only plugin) or the bundle fails
 *  to load. The role-editor picker only needs a name in
 *  `getRuntimeToolNames()`; LLM dispatch goes through the MCP
 *  server (not this entry), so empty `parameters` doesn't break
 *  tool calling. */
function listingFallbackEntry(listing: RuntimePluginListing): PluginEntry {
  return {
    toolDefinition: {
      type: "function",
      name: listing.toolName,
      description: listing.description,
      parameters: { type: "object", properties: {}, required: [] },
    },
  };
}

// Exported for unit tests so the fallback-registration contract
// is pinned without spinning up the asset HTTP route.
export async function loadOne(listing: RuntimePluginListing): Promise<void> {
  // Register the fallback first so `getRuntimeToolNames()` lists
  // the plugin immediately. If the Vue bundle loads we replace
  // the entry with the richer one; if it doesn't (server-only
  // plugin, or load failure), the fallback stays and the tool
  // still appears in the role editor.
  runtimeRegistry.set(listing.toolName, listingFallbackEntry(listing));

  const moduleUrl = `${listing.assetBase}/dist/vue.js`;

  // HEAD-probe to distinguish "package has no Vue bundle" (404 —
  // expected, server-only plugin path) from "bundle exists but
  // can't be loaded" (warn — masks real bugs otherwise). Without
  // this split, swallowing every dynamic-import failure silently
  // would hide broken UI runtime plugins (bad asset path,
  // transient fetch failure, malformed bundle) — the codex bot
  // flagged this in PR #1273 review.
  let probeStatus: number;
  try {
    const probe = await fetch(moduleUrl, { method: "HEAD" });
    probeStatus = probe.status;
  } catch (err) {
    console.warn(`[runtime-plugin] HEAD probe failed for ${listing.name}@${listing.version}`, err);
    return;
  }

  if (probeStatus === 404) {
    // Server-only plugin (no Vue View). The fallback entry
    // registered above is the final state.
    return;
  }
  if (probeStatus !== 200) {
    console.warn(`[runtime-plugin] unexpected HEAD status ${probeStatus} for ${listing.name}@${listing.version}`);
    return;
  }

  let mod: PluginVueModule;
  try {
    mod = (await import(/* @vite-ignore */ moduleUrl)) as PluginVueModule;
  } catch (err) {
    // Asset is reachable but the import threw — parse error,
    // module-evaluation crash, etc. This IS a real bug and must
    // surface; the fallback stays so the tool name doesn't
    // disappear from the role editor.
    console.warn(`[runtime-plugin] dynamic import failed (asset reachable): ${listing.name}@${listing.version}`, err);
    return;
  }
  const plugin = mod.plugin ?? mod.default?.plugin;
  if (!plugin?.toolDefinition) {
    console.warn(`[runtime-plugin] plugin export missing toolDefinition: ${listing.name}`);
    return;
  }
  // Bundle loaded — inject CSS and upgrade the entry with the
  // richer definition + view/preview components.
  injectStyle(`${listing.assetBase}/dist/style.css`);
  runtimeRegistry.set(listing.toolName, {
    toolDefinition: plugin.toolDefinition,
    viewComponent: wrapWithScopedRoot(plugin.viewComponent, listing.name),
    previewComponent: wrapWithScopedRoot(plugin.previewComponent, listing.name),
  });
}

/** Wrap a plugin's component in `<PluginScopedRoot>` so descendants can
 *  pick up the per-plugin BrowserPluginRuntime via `useRuntime()` from
 *  `gui-chat-protocol/vue` (#1110). The wrapper forwards every prop /
 *  attr / slot through to the inner component, so the host's render
 *  path stays unchanged.
 *
 *  Returns `undefined` when the plugin doesn't export the slot — the
 *  host's `getPlugin()` consumer treats absence as "no preview" /
 *  "no view". */
function wrapWithScopedRoot(inner: Component | undefined, pkgName: string): Component | undefined {
  if (!inner) return undefined;
  // `markRaw` so the host's reactive `runtimeRegistry` doesn't try to
  // proxy the component object — Vue warns + the proxy can interfere
  // with internal component identity tracking.
  return markRaw(
    defineComponent({
      name: `RuntimePluginScope:${pkgName}`,
      inheritAttrs: false,
      setup(_props, { attrs, slots }) {
        return () => h(PluginScopedRoot, { pkgName }, () => h(inner, attrs, slots));
      },
    }),
  );
}

/** Fetch the install list and dynamic-import each plugin in parallel.
 *  Resolves once every load attempt has settled (success or failure);
 *  the caller `awaits` it before mounting the app so the first render
 *  already sees the runtime tool names. */
export async function loadRuntimePlugins(): Promise<void> {
  const result = await apiGet<{ plugins: RuntimePluginListing[] }>(API_ROUTES.plugins.runtimeList);
  if (!result.ok) {
    console.warn(`[runtime-plugin] list fetch failed: ${result.error}`);
    return;
  }
  const listings = result.data.plugins;
  if (listings.length === 0) return;
  await Promise.allSettled(listings.map(loadOne));
}
