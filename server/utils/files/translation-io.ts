// Domain file I/O for the translation cache. One JSON file per
// namespace under `data/translation/`. All writes go through the
// atomic helper per project rule.

import path from "node:path";
import { WORKSPACE_DIRS, workspacePath } from "../../workspace/paths.js";
import { loadJsonFile, writeJsonAtomic } from "./json.js";
import { isRecord, isStringRecord } from "../types.js";
import { emptyDictionary } from "../../services/translation/cache.js";
import type { DictionaryFile } from "../../services/translation/types.js";

function root(workspaceRoot?: string): string {
  return workspaceRoot ?? workspacePath;
}

export function dictionaryPath(namespace: string, workspaceRoot?: string): string {
  return path.join(root(workspaceRoot), WORKSPACE_DIRS.translation, `${namespace}.json`);
}

// Cache files live under the user's workspace and can be hand-edited
// or corrupted; treat the disk shape as untrusted and fall back to
// an empty dictionary on anything we can't recognize. Without this
// guard a `{}` or `{ sentences: null }` file would crash later at
// `dict.sentences[sentence]` and turn every request for the namespace
// into a 500 until the file was repaired.
function isValidDictionary(value: unknown): value is DictionaryFile {
  if (!isRecord(value) || !isRecord(value.sentences)) return false;
  return Object.values(value.sentences).every(isStringRecord);
}

export function loadDictionary(namespace: string, workspaceRoot?: string): DictionaryFile {
  const raw = loadJsonFile<unknown>(dictionaryPath(namespace, workspaceRoot), null);
  if (!isValidDictionary(raw)) return emptyDictionary();
  return raw;
}

export async function saveDictionary(namespace: string, dict: DictionaryFile, workspaceRoot?: string): Promise<void> {
  await writeJsonAtomic(dictionaryPath(namespace, workspaceRoot), dict);
}
