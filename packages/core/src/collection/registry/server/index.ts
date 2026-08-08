// @mulmoclaude/core/collection/registry/server — node-only collection registry
// engine (Discover catalog fetch/cache, import writer, export writer). Shares the
// `configureCollectionHost` binding with @mulmoclaude/core/collection/server, so a
// host wires the workspace + logger + paths ONCE and both engines work. The
// isomorphic contract types live on @mulmoclaude/core/collection/registry.

import { fetchAllRegistries } from "./client.js";
import type { RegistryScope } from "./registriesConfig.js";
import { performImport } from "./importWriter.js";
import type { RegistryListResponse, RegistryImportResponse } from "../types.js";

export {
  CACHE_TTL_MS,
  STALE_RETRY_BACKOFF_MS,
  fetchAllRegistries,
  fetchRegistryIndex,
  findRegistry,
  listRegistries,
  resetRegistryCache,
  type FetchIndexResult,
  type IndexLoader,
  type MergedRegistryResult,
  type RegistryDescriptor,
} from "./client.js";
export {
  collectionFileUrl,
  fetchCollectionFile,
  parseJsonObject,
  previewCollection,
  rawBaseForEntry,
  type FileResult,
  type JsonObjectResult,
  type PreviewResult,
} from "./collectionFiles.js";
export {
  fetchBundle,
  fetchManifest,
  isSafeBundlePath,
  normalizedDataPath,
  parseManifest,
  withNormalizedDataPath,
  type BundleFetch,
  type ManifestFetch,
  type ManifestResult,
} from "./importCollection.js";
export { claudeSkillDir, dataSkillDir, performImport, writeImportedCollection, type ImportOrigin, type ImportResult } from "./importWriter.js";
export { EXPORT_BASE, writeCollectionExport, type ExportMeta, type ExportResult } from "./exportCollection.js";
export { performExport } from "./performExport.js";
export { parseSkillDescription } from "./skillDescription.js";
export { loadRegistriesConfig, parseRegistriesConfig, OFFICIAL_REGISTRY_NAME, type RegistryConfigEntry, type RegistryScope } from "./registriesConfig.js";
export type { RegistryEntry, RegistryIndex, ParseResult } from "../registryIndex.js";
export { parseRegistryIndex } from "../registryIndex.js";
export type { RegistrySummary, RegistryListResponse, RegistryImportResponse } from "../types.js";

/** Build the merged Discover catalog response (`GET …collectionsRegistry.list`).
 *  Wraps `fetchAllRegistries` with the per-registry summary + stale-flag shaping
 *  every host needs, so a downstream host doesn't re-implement the mapping. */
export async function listRegistry(scope: RegistryScope = {}): Promise<RegistryListResponse> {
  const merged = await fetchAllRegistries(scope);
  return {
    registries: merged.map((reg) => ({
      name: reg.name,
      status: reg.status,
      generatedAt: reg.generatedAt,
      error: reg.error,
      entryCount: reg.entries.length,
    })),
    stale: merged.some((reg) => reg.status === "stale"),
    collections: merged.flatMap((reg) => reg.entries),
  };
}

export type RegistryImportOutcome = { ok: true; response: RegistryImportResponse } | { ok: false; status: number; error: string };

/** Import a registry collection and return the host-facing response shape
 *  (`POST …collectionsRegistry.import`). On failure carries the HTTP status so
 *  the host route can pass it straight through. */
export async function importRegistry(author: string, slug: string, workspaceRoot: string, registry: string | null = null): Promise<RegistryImportOutcome> {
  const result = await performImport(author, slug, workspaceRoot, registry);
  if (!result.ok) return { ok: false, status: result.status, error: result.error };
  return {
    ok: true,
    response: { localSlug: result.localSlug, updated: result.updated, seedWritten: result.seedWritten, seedSkipped: result.seedSkipped },
  };
}
