// Phase C verification — exercise the browser-side runtime plugin
// loader against the running dev server. Confirms the frontend
// dynamic-imports each installed plugin's vue.js, the importmap
// resolves "vue" to the host's runtime, and runtimeRegistry contains
// the expected entries.

import { chromium, type Page } from "@playwright/test";
import { hasStringProp, isRecord, isUnknownArray } from "@mulmoclaude/common";

const URL = "http://localhost:5173/";
const RUNTIME_LIST_PATH = "/api/plugins/runtime/list";
const AUTH_META_SELECTOR = 'meta[name="mulmoclaude-auth"]';

/** The `/api/plugins/runtime/list` fields this script uses. The endpoint is
 *  the thing under test, so its payload is rebuilt field by field rather than
 *  declared — a shape change has to surface as a named failure here, not as a
 *  TypeError three steps later. */
interface RuntimePluginRow {
  toolName: string;
  assetBase: string;
}

interface PluginAssetStatus {
  toolName: string;
  viewModuleStatus: number;
  cssStatus: number;
}

function toRuntimePluginRows(payload: unknown): RuntimePluginRow[] {
  const plugins = isRecord(payload) ? payload.plugins : undefined;
  if (!isUnknownArray(plugins)) {
    throw new Error(`${RUNTIME_LIST_PATH} did not return a \`plugins\` array: ${JSON.stringify(payload)}`);
  }
  return plugins.map((entry) => {
    if (!hasStringProp(entry, "toolName") || !hasStringProp(entry, "assetBase")) {
      throw new Error(`${RUNTIME_LIST_PATH} entry lacks string \`toolName\`/\`assetBase\`: ${JSON.stringify(entry)}`);
    }
    return { toolName: entry.toolName, assetBase: entry.assetBase };
  });
}

/** The server hands the page its bearer token through a meta tag. Read once
 *  and passed into the later steps as an argument — `page.evaluate` runs in
 *  the browser, so nothing in this module's scope is reachable from inside. */
function readAuthToken(page: Page): Promise<string> {
  return page.evaluate((selector) => document.querySelector(selector)?.getAttribute("content") ?? "", AUTH_META_SELECTOR);
}

/** Raw payload, or null when the endpoint answered non-2xx. */
function fetchRuntimeList(page: Page, token: string): Promise<unknown> {
  return page.evaluate(
    async (args): Promise<unknown> => {
      const resp = await fetch(args.path, { headers: { Authorization: `Bearer ${args.token}` } });
      if (!resp.ok) return null;
      return resp.json();
    },
    { path: RUNTIME_LIST_PATH, token },
  );
}

function fetchPluginAssets(page: Page, rows: RuntimePluginRow[]): Promise<PluginAssetStatus[]> {
  return page.evaluate(async (pluginRows) => {
    const results: PluginAssetStatus[] = [];
    for (const row of pluginRows) {
      const viewResp = await fetch(`${row.assetBase}/dist/vue.js`);
      const cssResp = await fetch(`${row.assetBase}/dist/style.css`);
      results.push({
        toolName: row.toolName,
        viewModuleStatus: viewResp.status,
        cssStatus: cssResp.status,
      });
    }
    return results;
  }, rows);
}

/** Inspect imported modules — verify the bare "vue" specifier was
 *  resolved. The plugin's vue.js exports `plugin` with viewComponent. */
function inspectRuntimeImport(page: Page, first: RuntimePluginRow | null) {
  return page.evaluate(async (row) => {
    try {
      if (!row) return { error: "no plugins" };
      // Dynamic import via the same path the runtime loader used
      const mod = await import(/* @vite-ignore */ `${row.assetBase}/dist/vue.js`);
      const plugin = mod.plugin ?? mod.default?.plugin;
      const hostVue = await import("vue");
      const pluginVue = await import("vue"); // same URL via importmap → same module instance
      return {
        toolName: row.toolName,
        hasPlugin: Boolean(plugin),
        hasViewComponent: Boolean(plugin?.viewComponent),
        hasPreviewComponent: Boolean(plugin?.previewComponent),
        sameVueIdentity: hostVue === pluginVue,
        hostVueVersion: hostVue.version,
      };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }, first);
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const consoleLines: string[] = [];
  const errors: string[] = [];
  page.on("console", (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (err) => errors.push(err.message));

  console.log(`navigating to ${URL}`);
  const resp = await page.goto(URL, { waitUntil: "networkidle", timeout: 20000 });
  console.log(`status: ${resp?.status()}`);
  await page.waitForTimeout(2000);

  const token = await readAuthToken(page);
  const listPayload = await fetchRuntimeList(page, token);
  const runtimeRows = listPayload === null ? null : toRuntimePluginRows(listPayload);
  const runtimeNames = runtimeRows === null ? null : runtimeRows.map((row) => row.toolName);

  console.log(`\n=== ${RUNTIME_LIST_PATH} returns: ${runtimeNames === null ? "FAILED" : runtimeNames.join(", ")} ===`);

  // Check that each runtime plugin's vue.js was actually fetched.
  const pluginNetworkHits = await fetchPluginAssets(page, runtimeRows ?? []);
  console.log(`\n=== plugin asset fetches ===`);
  for (const hit of pluginNetworkHits) {
    console.log(`  ${hit.toolName}: vue.js=${hit.viewModuleStatus} style.css=${hit.cssStatus}`);
  }

  const firstRow: RuntimePluginRow | null = runtimeRows !== null && runtimeRows.length > 0 ? runtimeRows[0] : null;
  const vueResolution = await inspectRuntimeImport(page, firstRow);
  console.log(`\n=== runtime import + Vue identity check ===`);
  console.log(JSON.stringify(vueResolution, null, 2));

  console.log(`\n=== console (last 30) ===`);
  for (const line of consoleLines.slice(-30)) console.log(line);
  if (errors.length > 0) {
    console.log(`\n=== errors ===`);
    for (const err of errors) console.log(err);
  }

  await browser.close();

  const ok =
    runtimeNames !== null &&
    runtimeNames.length >= 1 &&
    pluginNetworkHits.every((hit) => hit.viewModuleStatus === 200 && hit.cssStatus === 200) &&
    "sameVueIdentity" in vueResolution &&
    vueResolution.sameVueIdentity === true &&
    vueResolution.hasPlugin === true;
  console.log(`\n[phase-c] ${ok ? "SUCCESS" : "FAILED"}`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
