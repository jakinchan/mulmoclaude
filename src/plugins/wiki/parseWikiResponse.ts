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

// One malformed row drops the whole list: a partially-rendered index reads
// as "pages disappeared", which is worse than keeping the previous list.
const parsePageEntries = (value: unknown): WikiPageEntry[] | undefined => {
  if (!isUnknownArray(value)) return undefined;
  const entries = value.flatMap((entry) => parsePageEntry(entry) ?? []);
  return entries.length === value.length ? entries : undefined;
};

/** Pull the `data` envelope out of a `/api/wiki` response, keeping only the
 *  fields the views apply. Returns null when the response carries none. */
export const extractWikiData = (json: unknown): Partial<WikiData> | null => {
  if (!isRecord(json) || !isRecord(json.data)) return null;
  const { action, title, content, pageEntries, pageExists } = json.data;
  return {
    action: typeof action === "string" ? action : undefined,
    title: typeof title === "string" ? title : undefined,
    content: typeof content === "string" ? content : undefined,
    pageEntries: parsePageEntries(pageEntries),
    pageExists: typeof pageExists === "boolean" ? pageExists : undefined,
  };
};
