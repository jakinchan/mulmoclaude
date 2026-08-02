import { promises, readFileSync } from "fs";
import { writeFileAtomic, writeFileAtomicSync } from "./atomic.js";
import { isEnoent } from "./safe.js";
import { log } from "../../system/logger/index.js";

// Returns defaultValue on ENOENT or parse failure (user data files must not take down the server); rethrows EACCES/EPERM.
export function loadJsonFile<T>(filePath: string, defaultValue: T): T {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    if (isEnoent(err)) return defaultValue;
    log.error("json", "loadJsonFile read failed", {
      path: filePath,
      error: String(err),
    });
    throw err;
  }
  try {
    // Cast kept (#2692): `loadSchedulerItems` / `loadUserTasks` propagate this
    // `T` into files the same request rewrites, so filtering unrecognised
    // entries here would delete the user's data. Removing it needs those two
    // persistence paths to gain real per-entry validation first.
    return JSON.parse(raw) as T;
  } catch (err) {
    log.error("json", "loadJsonFile parse failed, using default", {
      path: filePath,
      error: String(err),
    });
    return defaultValue;
  }
}

export async function writeJsonAtomic(filePath: string, data: unknown, opts: Parameters<typeof writeFileAtomic>[2] = {}): Promise<void> {
  await writeFileAtomic(filePath, JSON.stringify(data, null, 2), opts);
}

/** Sync sibling of `writeJsonAtomic`. The `JSON.stringify(d, null, 2)`
 *  + `writeFileAtomicSync` shape was repeated across half a dozen
 *  sync IO modules; this collapses them. */
export function writeJsonAtomicSync(filePath: string, data: unknown, opts: Parameters<typeof writeFileAtomicSync>[2] = {}): void {
  writeFileAtomicSync(filePath, JSON.stringify(data, null, 2), opts);
}

export async function readJsonOrNull<T>(filePath: string): Promise<T | null> {
  try {
    const content = await promises.readFile(filePath, "utf-8");
    const parsed: T = JSON.parse(content);
    return parsed;
  } catch {
    return null;
  }
}
