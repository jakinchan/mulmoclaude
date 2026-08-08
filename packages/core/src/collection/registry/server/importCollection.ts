// Import-side fetch + transform helpers for a registry collection. The writer
// (writes into .claude/skills/, materializes seed, records provenance) builds on
// these; kept separate so the pure, security-critical parts are unit-tested.
//
// Files to fetch come from the collection's manifest.json (published by the
// registry's build-index). Every manifest path is re-checked for safety here —
// the host must never write outside the target skill dir even if the manifest is
// malformed/poisoned.

import { isRecord } from "../guards.js";
import { fetchCollectionFile, parseJsonObject, rawBaseForEntry } from "./collectionFiles.js";
import type { RegistryEntry } from "../registryIndex.js";
import type { RegistryScope } from "./registriesConfig.js";

const MANIFEST_FILE = "manifest.json";
const STATUS_BAD_GATEWAY = 502;

/** A manifest entry must be a relative path that stays inside the collection dir:
 *  no absolute paths, no backslashes, no empty / `.` / `..` segments. */
export function isSafeBundlePath(rel: unknown): rel is string {
  if (typeof rel !== "string" || rel.length === 0) return false;
  if (rel.startsWith("/") || rel.includes("\\")) return false;
  return !rel.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

export type ManifestResult = { ok: true; files: string[] } | { ok: false; error: string };

export function parseManifest(value: unknown): ManifestResult {
  if (!isRecord(value) || !Array.isArray(value.files)) return { ok: false, error: "manifest is missing a files[] array" };
  const unsafe = value.files.find((file) => !isSafeBundlePath(file));
  if (unsafe !== undefined) return { ok: false, error: `manifest contains an unsafe path: ${String(unsafe)}` };
  return { ok: true, files: value.files.filter(isSafeBundlePath) };
}

/** `data/collections/<localSlug>/items` — the host owns dataPath, never the
 *  registry's authored value, so imported collections can't collide on disk. */
export function normalizedDataPath(localSlug: string): string {
  return `data/collections/${localSlug}/items`;
}

export function withNormalizedDataPath(schema: Record<string, unknown>, localSlug: string): Record<string, unknown> {
  return { ...schema, dataPath: normalizedDataPath(localSlug) };
}

export type ManifestFetch = { ok: true; files: string[] } | { ok: false; status: number; error: string };

export async function fetchManifest(entry: RegistryEntry, scope: RegistryScope = {}): Promise<ManifestFetch> {
  const rawBase = rawBaseForEntry(entry, scope);
  if (!rawBase) return { ok: false, status: STATUS_BAD_GATEWAY, error: `registry "${entry.registryName}" is no longer configured` };
  const file = await fetchCollectionFile(rawBase, entry.path, MANIFEST_FILE);
  if (!file.ok) return { ok: false, status: file.status, error: `manifest.json: ${file.error}` };
  const obj = parseJsonObject(file.text, "manifest.json");
  if (!obj.ok) return { ok: false, status: STATUS_BAD_GATEWAY, error: obj.error };
  const manifest = parseManifest(obj.value);
  if (!manifest.ok) return { ok: false, status: STATUS_BAD_GATEWAY, error: manifest.error };
  return { ok: true, files: manifest.files };
}

export type BundleFetch = { ok: true; files: Map<string, string> } | { ok: false; status: number; error: string };

/** Fetch every manifest file. Paths are already safety-checked by parseManifest. */
export async function fetchBundle(entry: RegistryEntry, fileList: readonly string[], scope: RegistryScope = {}): Promise<BundleFetch> {
  const rawBase = rawBaseForEntry(entry, scope);
  if (!rawBase) return { ok: false, status: STATUS_BAD_GATEWAY, error: `registry "${entry.registryName}" is no longer configured` };
  const files = new Map<string, string>();
  for (const rel of fileList) {
    const file = await fetchCollectionFile(rawBase, entry.path, rel);
    if (!file.ok) return { ok: false, status: file.status, error: `${rel}: ${file.error}` };
    files.set(rel, file.text);
  }
  return { ok: true, files };
}
