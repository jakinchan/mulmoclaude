// `/api/wiki` answers with an untyped JSON envelope. The index / page
// views read its fields straight into refs that the template renders, so
// each one is rebuilt from a checked value rather than asserted.

import { isRecord, isStringArray, isUnknownArray } from "../../utils/types";
import type { WikiData, WikiPageEntry } from "./index";

const parsePageEntry = (value: unknown): WikiPageEntry | null => {
  if (!isRecord(value)) return null;
  const { title, slug, description, tags } = value;
  if (typeof title !== "string" || typeof slug !== "string" || typeof description !== "string") return null;
  return { title, slug, description, tags: isStringArray(tags) ? tags : [] };
};

// Null on one malformed row: the callers all read this as `?? []`, so handing
// back a short list — or `undefined` — would empty the visible index instead
// of keeping it.
const parsePageEntries = (value: unknown): WikiPageEntry[] | null => {
  if (!isUnknownArray(value)) return null;
  const entries = value.flatMap((entry) => parsePageEntry(entry) ?? []);
  return entries.length === value.length ? entries : null;
};

const isOptionalString = (value: unknown): value is string | undefined => value === undefined || typeof value === "string";
const isOptionalBoolean = (value: unknown): value is boolean | undefined => value === undefined || typeof value === "boolean";

/** Pull the `data` envelope out of a `/api/wiki` response, keeping only the
 *  fields the views apply.
 *
 *  A field that is PRESENT but the wrong type rejects the whole envelope
 *  (null), because `useFreshPluginData` skips `apply` on null and the view
 *  keeps the state it already had. Only a genuinely ABSENT field is left
 *  `undefined`, which is what the views' own `?? default` is there for. */
export const extractWikiData = (json: unknown): Partial<WikiData> | null => {
  if (!isRecord(json) || !isRecord(json.data)) return null;
  const { action, title, content, pageEntries, pageExists } = json.data;
  if (!isOptionalString(action) || !isOptionalString(title) || !isOptionalString(content) || !isOptionalBoolean(pageExists)) return null;
  const entries = pageEntries === undefined ? undefined : parsePageEntries(pageEntries);
  if (entries === null) return null;
  return { action, title, content, pageEntries: entries, pageExists };
};
