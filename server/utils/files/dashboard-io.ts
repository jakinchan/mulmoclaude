// Domain IO for `config/dashboard.json` — the dashboard layout (tile
// order + per-tile view mode, and per-row view-area heights for the
// favorites grid). Follows the `*-io.ts` pattern: all writes go through
// `writeFileAtomic`; a missing file reads as an empty layout.

import path from "node:path";
import { WORKSPACE_FILES, workspacePath } from "../../workspace/paths.js";
import { writeFileAtomic } from "./atomic.js";
import { readTextSafe } from "./safe.js";
import { isRecord } from "../types.js";
import type { DashboardTile, DashboardFile } from "../../../src/types/dashboard.js";

function dashboardFilePath(workspaceRoot?: string): string {
  return path.join(workspaceRoot ?? workspacePath, WORKSPACE_FILES.dashboard);
}

/** Coerce arbitrary JSON into a clean `DashboardTile[]`: drop malformed
 *  entries (empty slug / non-string fields), keep `viewMode` only when a
 *  non-empty string, and dedupe on `slug` keeping the first occurrence.
 *  Exported for the route validator and unit tests — pure, no IO. */
export function normalizeDashboard(input: unknown): DashboardTile[] {
  if (!Array.isArray(input)) return [];
  const out: DashboardTile[] = [];
  for (const raw of input) {
    if (!isRecord(raw)) continue;
    const { slug, viewMode } = raw;
    if (typeof slug !== "string" || slug.length === 0) continue;
    if (out.some((existing) => existing.slug === slug)) continue;
    const tile: DashboardTile = { slug };
    if (typeof viewMode === "string" && viewMode.length > 0) tile.viewMode = viewMode;
    out.push(tile);
  }
  return out;
}

/** Coerce a per-row height array: each entry is a positive finite number
 *  or `0` (meaning "default"), with trailing zeros trimmed so the stored
 *  array stays compact. */
function normalizeHeightArray(input: unknown): number[] {
  if (!Array.isArray(input)) return [];
  const coerced = input.map((value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0));
  let end = coerced.length;
  while (end > 0 && coerced[end - 1] === 0) end--;
  return coerced.slice(0, end);
}

/** Coerce arbitrary JSON into a clean per-column-mode row-height map:
 *  `{ "<columns>": number[] }`. Keys must be positive integers (the grid
 *  column count); empty arrays are dropped. Heights are kept per layout
 *  so the 1- and 2-column views never share (and clobber) each other's
 *  row heights. Pure, no IO. */
export function normalizeRowHeights(input: unknown): Record<string, number[]> {
  if (!isRecord(input)) return {};
  const out: Record<string, number[]> = {};
  for (const [key, value] of Object.entries(input)) {
    const columns = Number(key);
    if (!Number.isInteger(columns) || columns < 1) continue;
    const heights = normalizeHeightArray(value);
    if (heights.length > 0) out[String(columns)] = heights;
  }
  return out;
}

/** Read the dashboard layout. Missing / unreadable / malformed file
 *  → an empty layout (never throws on absent state). */
export async function readDashboard(workspaceRoot?: string): Promise<DashboardFile> {
  const text = await readTextSafe(dashboardFilePath(workspaceRoot));
  if (text === null) return { tiles: [], rowHeights: {} };
  try {
    const parsed = JSON.parse(text) as Partial<DashboardFile>;
    return { tiles: normalizeDashboard(parsed?.tiles), rowHeights: normalizeRowHeights(parsed?.rowHeights) };
  } catch {
    return { tiles: [], rowHeights: {} };
  }
}

/** Replace the full layout. Normalises (validate + dedupe + trim) before
 *  writing so the on-disk file is always clean. Returns the written
 *  layout so callers can echo the canonical result. */
export async function writeDashboard(input: { tiles?: unknown; rowHeights?: unknown }, workspaceRoot?: string): Promise<DashboardFile> {
  const payload: DashboardFile = {
    tiles: normalizeDashboard(input.tiles),
    rowHeights: normalizeRowHeights(input.rowHeights),
  };
  await writeFileAtomic(dashboardFilePath(workspaceRoot), `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}
