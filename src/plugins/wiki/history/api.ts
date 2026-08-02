import { apiGet, apiPost, type ApiResult } from "../../../utils/api.js";
import { pluginEndpoints } from "../../api.js";
import type { WikiEndpoints } from "../index.js";

export interface SnapshotSummary {
  stamp: string;
  bytes: number;
  ts: string;
  editor: "user" | "llm" | "system";
  sessionId?: string;
  reason?: string;
}

export interface SnapshotContent extends SnapshotSummary {
  meta: Record<string, unknown>;
  body: string;
}

interface ListResponse {
  slug: string;
  snapshots: SnapshotSummary[];
}

interface ReadResponse {
  slug: string;
  snapshot: SnapshotContent;
}

interface RestoreResponse {
  slug: string;
  restored: { fromStamp: string };
}

function fillRoute(template: string, params: Record<string, string>): string {
  return template.replace(/:([a-zA-Z]+)/g, (_, key: string) => {
    const value = params[key];
    // Silently substituting "undefined" would request a page by that
    // literal name, so an unfilled placeholder has to be loud.
    if (value === undefined) throw new Error(`Missing route param ":${key}" for ${template}`);
    return encodeURIComponent(value);
  });
}

function endpoints(): WikiEndpoints {
  return pluginEndpoints<WikiEndpoints>("wiki");
}

export function fetchHistoryList(slug: string): Promise<ApiResult<ListResponse>> {
  return apiGet<ListResponse>(fillRoute(endpoints().pageHistory, { slug }));
}

export function fetchHistorySnapshot(slug: string, stamp: string): Promise<ApiResult<ReadResponse>> {
  return apiGet<ReadResponse>(fillRoute(endpoints().pageHistorySnapshot, { slug, stamp }));
}

export function restoreHistorySnapshot(slug: string, stamp: string): Promise<ApiResult<RestoreResponse>> {
  return apiPost<RestoreResponse>(fillRoute(endpoints().pageHistoryRestore, { slug, stamp }));
}
