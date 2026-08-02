// Domain IO for `config/shortcuts.json` — the manually-pinned launcher
// shortcuts (collections / feeds). Follows the `*-io.ts` pattern: all
// writes go through `writeFileAtomic`; a missing file reads as `[]`.

import path from "node:path";
import { WORKSPACE_FILES, workspacePath } from "../../workspace/paths.js";
import { writeFileAtomic } from "./atomic.js";
import { readTextSafe } from "./safe.js";
import { isRecord } from "../types.js";
import { SHORTCUT_KINDS, sameShortcut, type Shortcut, type ShortcutsFile } from "../../../src/types/shortcuts.js";

function shortcutsFilePath(workspaceRoot?: string): string {
  return path.join(workspaceRoot ?? workspacePath, WORKSPACE_FILES.shortcuts);
}

/** Coerce arbitrary JSON into a clean `Shortcut[]`: drop malformed
 *  entries (bad kind / empty slug / non-string fields) and dedupe on
 *  `(kind, slug)` keeping the first occurrence. Exported for the route
 *  validator and unit tests — pure, no IO. */
export function normalizeShortcuts(input: unknown): Shortcut[] {
  if (!Array.isArray(input)) return [];
  const out: Shortcut[] = [];
  for (const raw of input) {
    if (!isRecord(raw)) continue;
    const { slug, title, icon } = raw;
    // `find` over the literal list narrows to `ShortcutKind` by construction —
    // a membership predicate would only assert it.
    const kind = SHORTCUT_KINDS.find((candidate) => candidate === raw.kind);
    if (kind === undefined) continue;
    if (typeof slug !== "string" || slug.length === 0) continue;
    const entry: Shortcut = {
      kind,
      slug,
      title: typeof title === "string" ? title : slug,
      icon: typeof icon === "string" && icon.length > 0 ? icon : "bookmark",
    };
    if (out.some((existing) => sameShortcut(existing, entry))) continue;
    out.push(entry);
  }
  return out;
}

/** Read the pinned shortcuts. Missing / unreadable / malformed file
 *  → `[]` (never throws on absent state). */
export async function readShortcuts(workspaceRoot?: string): Promise<Shortcut[]> {
  const text = await readTextSafe(shortcutsFilePath(workspaceRoot));
  if (text === null) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    return normalizeShortcuts(isRecord(parsed) ? parsed.shortcuts : undefined);
  } catch {
    return [];
  }
}

/** Replace the full shortcut list. Normalises (validate + dedupe)
 *  before writing so the on-disk file is always clean. Returns the
 *  written list so callers can echo the canonical result. */
export async function writeShortcuts(shortcuts: unknown, workspaceRoot?: string): Promise<Shortcut[]> {
  const clean = normalizeShortcuts(shortcuts);
  const payload: ShortcutsFile = { shortcuts: clean };
  await writeFileAtomic(shortcutsFilePath(workspaceRoot), `${JSON.stringify(payload, null, 2)}\n`);
  return clean;
}
