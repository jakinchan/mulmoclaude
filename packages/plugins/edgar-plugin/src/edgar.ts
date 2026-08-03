// SEC EDGAR API client.
//
// Enforces the two non-negotiable rules of edgar.gov programmatic access:
//   1. Every request includes a User-Agent header with a contact address
//      (sourced from the plugin's config — the missing-config flow in
//      `index.ts` handles the bootstrap).
//   2. Max 10 requests/second. We throttle to 9 to stay safely below.
//
// Concurrency-safe: throttle is serialised through a single
// promise chain so N parallel callers can't all sleep on the
// same `lastReleaseAt` and burst past the cap. Earlier flat
// Date.now()-based gate was racy.
//
// Each `runtime.fetch` call carries an explicit hostname allowlist
// + AbortController timeout (15 s) — network failures and timeouts
// are wrapped with URL context for the LLM.

import type { PluginRuntime } from "gui-chat-protocol";
import { FETCH_TIMEOUT_MS, MIN_INTERVAL_MS } from "./time";

// Re-exported for the throttle-invariant unit test (test/test_throttle.ts
// pins `MIN_INTERVAL_MS` against the observed gap between calls).
export { MIN_INTERVAL_MS };

const ALLOWED_HOSTS = ["www.sec.gov", "data.sec.gov", "efts.sec.gov"];

interface TickerEntry {
  cik_str: number;
  ticker: string;
  title: string;
}

export interface FilingSummary {
  accessionNumber: string;
  form: string;
  filingDate: string;
  reportDate: string;
  primaryDocument: string;
  primaryDocDescription: string;
}

export interface ResolvedCompany {
  cik: string;
  name: string;
  ticker?: string;
}

export interface EdgarClient {
  resolve(tickerOrCik: string): Promise<ResolvedCompany>;
  getRecentFilings(cik: string, opts: { formTypes?: string[] | undefined; limit?: number | undefined }): Promise<{ name: string; filings: FilingSummary[] }>;
  getFilingDocument(cik: string, accessionNumber: string, primaryDocument: string): Promise<{ url: string; text: string }>;
  getCompanyFacts(cik: string): Promise<unknown>;
  getCompanyConcept(cik: string, taxonomy: string, concept: string): Promise<unknown>;
  fullTextSearch(query: string, opts: { forms?: string[] | undefined; dateRange?: { from: string; to: string } | undefined }): Promise<unknown>;
}

interface EdgarDeps {
  fetch: PluginRuntime["fetch"];
  log: PluginRuntime["log"];
  /** Resolves to the `User-Agent` header value, e.g. `"Jane Doe jane@example.com"`. */
  getUserAgent: () => Promise<string>;
}

/** Pad a numeric CIK to the 10-digit zero-padded form EDGAR uses. */
export function padCik(cik: string | number): string {
  return String(cik).replace(/^CIK/i, "").padStart(10, "0");
}

// Concurrency-safe throttle. Pattern mirrors bookmarks-plugin's
// per-plugin write lock. Module-level state — single Node
// process per plugin load means a single throttle is correct.
let lastReleaseAt = 0;
let throttleChain: Promise<unknown> = Promise.resolve();

/** Exported for unit tests. The chain ordering + ≥ MIN_INTERVAL_MS
 *  gap between releases are the contract. */
export function throttledSlot<T>(work: () => Promise<T>): Promise<T> {
  const next = throttleChain
    .catch(() => undefined)
    .then(async () => {
      const wait = MIN_INTERVAL_MS - (Date.now() - lastReleaseAt);
      if (wait > 0) {
        await new Promise((resolveTimer) => setTimeout(resolveTimer, wait));
      }
      try {
        return await work();
      } finally {
        lastReleaseAt = Date.now();
      }
    });
  // Swallow rejections on the chain head so a thrown handler
  // doesn't poison the next caller; each caller still sees its
  // own error because we return `next`.
  throttleChain = next.catch(() => undefined);
  return next;
}

export function createEdgarClient(deps: EdgarDeps): EdgarClient {
  let tickerCache: Map<string, TickerEntry> | null = null;

  async function edgarFetch(url: string): Promise<Response> {
    return throttledSlot(async () => {
      const userAgent = await deps.getUserAgent();
      const abortController = new AbortController();
      const timer = setTimeout(() => abortController.abort(), FETCH_TIMEOUT_MS);
      try {
        const response = await deps.fetch(url, {
          headers: {
            "User-Agent": userAgent,
            Accept: "application/json, text/html;q=0.9",
          },
          allowedHosts: ALLOWED_HOSTS,
          signal: abortController.signal,
        });
        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(`EDGAR ${response.status} for ${url}\n${body.slice(0, 500)}`);
        }
        return response;
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          throw new Error(`EDGAR request timed out after ${FETCH_TIMEOUT_MS}ms for ${url}`);
        }
        if (err instanceof Error && err.message.startsWith("EDGAR ")) throw err;
        throw new Error(`EDGAR network error for ${url}: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        clearTimeout(timer);
      }
    });
  }

  async function loadTickers(): Promise<Map<string, TickerEntry>> {
    if (tickerCache) return tickerCache;
    const response = await edgarFetch("https://www.sec.gov/files/company_tickers.json");
    const data = (await response.json()) as Record<string, TickerEntry>;
    const map = new Map<string, TickerEntry>();
    for (const entry of Object.values(data)) {
      map.set(entry.ticker.toUpperCase(), entry);
    }
    tickerCache = map;
    return map;
  }

  async function resolve(tickerOrCik: string): Promise<ResolvedCompany> {
    const trimmed = tickerOrCik.trim();
    if (/^\d{1,10}$/.test(trimmed) || /^CIK\d+$/i.test(trimmed)) {
      return { cik: padCik(trimmed), name: "" };
    }
    const tickers = await loadTickers();
    const hit = tickers.get(trimmed.toUpperCase());
    if (!hit) {
      throw new Error(`Ticker "${trimmed}" not found in SEC company_tickers.json. Pass a CIK directly if the company is foreign or delisted.`);
    }
    return { cik: padCik(hit.cik_str), name: hit.title, ticker: hit.ticker };
  }

  async function getRecentFilings(
    cik: string,
    opts: { formTypes?: string[] | undefined; limit?: number | undefined } = {},
  ): Promise<{ name: string; filings: FilingSummary[] }> {
    const response = await edgarFetch(`https://data.sec.gov/submissions/CIK${cik}.json`);
    const data = (await response.json()) as {
      name: string;
      filings: {
        recent: {
          accessionNumber: string[];
          form: string[];
          filingDate: string[];
          reportDate: string[];
          primaryDocument: string[];
          primaryDocDescription: string[];
        };
      };
    };
    const { recent } = data.filings;
    // `recent` is six PARALLEL arrays keyed by position, and nothing in
    // the feed guarantees they are the same length. A short column would
    // otherwise put `undefined` into a field declared `string`, and the
    // `filing.form.toUpperCase()` filter below would throw on it.
    const columnAt = (column: readonly string[], idx: number): string => column[idx] ?? "";
    const all: FilingSummary[] = recent.accessionNumber.map((accessionNumber, idx) => ({
      accessionNumber,
      form: columnAt(recent.form, idx),
      filingDate: columnAt(recent.filingDate, idx),
      reportDate: columnAt(recent.reportDate, idx),
      primaryDocument: columnAt(recent.primaryDocument, idx),
      primaryDocDescription: columnAt(recent.primaryDocDescription, idx),
    }));
    const formTypes = opts.formTypes?.map((form) => form.toUpperCase());
    const filtered = formTypes ? all.filter((filing) => formTypes.includes(filing.form.toUpperCase())) : all;
    return { name: data.name, filings: filtered.slice(0, opts.limit ?? 25) };
  }

  async function getFilingDocument(cik: string, accessionNumber: string, primaryDocument: string): Promise<{ url: string; text: string }> {
    const accClean = accessionNumber.replace(/-/g, "");
    const url = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accClean}/${primaryDocument}`;
    const response = await edgarFetch(url);
    return { url, text: await response.text() };
  }

  async function getCompanyFacts(cik: string): Promise<unknown> {
    const response = await edgarFetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`);
    return await response.json();
  }

  async function getCompanyConcept(cik: string, taxonomy: string, concept: string): Promise<unknown> {
    const response = await edgarFetch(`https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/${taxonomy}/${concept}.json`);
    return await response.json();
  }

  async function fullTextSearch(
    query: string,
    opts: { forms?: string[] | undefined; dateRange?: { from: string; to: string } | undefined } = {},
  ): Promise<unknown> {
    const params = new URLSearchParams({ q: query });
    if (opts.forms?.length) params.set("forms", opts.forms.join(","));
    if (opts.dateRange) {
      params.set("dateRange", "custom");
      params.set("startdt", opts.dateRange.from);
      params.set("enddt", opts.dateRange.to);
    }
    const response = await edgarFetch(`https://efts.sec.gov/LATEST/search-index?${params.toString()}`);
    deps.log.debug("full-text search", { query, forms: opts.forms?.length });
    return await response.json();
  }

  return {
    resolve,
    getRecentFilings,
    getFilingDocument,
    getCompanyFacts,
    getCompanyConcept,
    fullTextSearch,
  };
}
