// Normalises the two shapes a persisted `attachments` array can hold into
// the one shape the chips render from. Sessions recorded before #2308 hold
// bare path strings; everything since holds `{ path, filename? }`.
//
// Every reader of that field goes through here — session jsonl, SSE
// broadcast, and the synthetic text-response result all converge on
// `AttachmentEntry[]`, so no component has to know both shapes exist.

import { isRecord, isNonEmptyString } from "../types";
import type { AttachmentEntry } from "../../types/attachment";

function toEntry(item: unknown): AttachmentEntry | undefined {
  if (isNonEmptyString(item)) return { path: item };
  if (!isRecord(item)) return undefined;
  const { path, filename } = item;
  if (!isNonEmptyString(path)) return undefined;
  return isNonEmptyString(filename) ? { path, filename } : { path };
}

/** Widen an `attachments` field to `AttachmentEntry[]`, dropping anything
 *  that carries no usable path. Takes `unknown` on purpose: the value comes
 *  off disk or the wire, so a session written by an older (or newer) build
 *  must degrade to "no chips" rather than throw mid-render. */
export function normalizeAttachments(raw: unknown): AttachmentEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: AttachmentEntry[] = [];
  for (const item of raw) {
    const entry = toEntry(item);
    if (entry) entries.push(entry);
  }
  return entries;
}
