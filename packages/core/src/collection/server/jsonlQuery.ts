// Aggregation-query executor for FILE-BACKED collections: the same DSL
// (`core/queryZ.ts`) and the same DuckDB engine as the CSV store, run
// over a temp JSONL of the collection's rows. Deliberately takes
// ALREADY-LOADED rows rather than pointing DuckDB at the record files,
// for two correctness reasons:
//
//   1. **Computed fields.** Stored record files never contain `derived` /
//      `rollup` / `toggle` values — the caller passes ENRICHED rows
//      (`listItems` → `enrichItems`), so "sum of invoice totals" works
//      even when `total` is a formula.
//   2. **The symlink defense.** A `read_json('<dataDir>/*.json')` glob
//      would follow a symlinked record file (the exact file-disclosure
//      hole `listItems`' lstat check closes) — DuckDB only ever sees
//      content that already passed the guarded reader.
//
// The temp JSONL lives in the same 0700 cache dir as CSV decode copies,
// is written 0600 (shared OS tmpdir), and is unlinked when the query
// finishes. Caller wiring lives in `queryRunner.ts` (NOT `store.ts` —
// enrichment lives in `derive.ts`, which itself consumes `storeFor`, so
// wiring it into the store would create an import cycle).

import { mkdir, open, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { CollectionItem } from "../core/schema";
import type { CollectionQuery, CollectionQueryAggregate } from "../core/queryZ";
import { compileJsonlQuery } from "./csvQuery";
import { cacheDir, normalizeCsvValue, queryCsv } from "./csvStore";
import { log } from "./host";
import { isErrorWithCode } from "@mulmoclaude/common";

/** SQL semantics for an aggregate-only query over ZERO rows: one scalar
 *  row (`count` = 0, everything else NULL) — the same shape the CSV path
 *  produces for a header-only file, so callers reading `rows[0]` never
 *  break on storage kind or emptiness. A grouped query over zero rows is
 *  zero groups (`[]`), also matching SQL. Synthesized here because DuckDB
 *  has no empty file to infer a schema from. */
function emptyCollectionResult(query: CollectionQuery): Record<string, unknown>[] {
  if ((query.groupBy?.length ?? 0) > 0) return [];
  const aggregates = Object.entries(query.aggregates ?? {});
  return [Object.fromEntries(aggregates.map(([alias, aggregate]: [string, CollectionQueryAggregate]) => [alias, aggregate.op === "count" ? 0 : null]))];
}

/** The SOURCE columns a query reads: groupBy columns, aggregate input
 *  columns, and where fields. (orderBy resolves to groupBy columns or
 *  aggregate ALIASES — never to a new source column — so it adds none.) */
function referencedSourceColumns(query: CollectionQuery): string[] {
  const columns = new Set<string>(query.groupBy ?? []);
  for (const aggregate of Object.values(query.aggregates ?? {})) {
    if (aggregate.column !== undefined) columns.add(aggregate.column);
  }
  for (const cond of query.where ?? []) columns.add(cond.field);
  return [...columns];
}

/** Referenced columns that appear in NO row — a freshly-added optional
 *  field, or a derived field whose inputs no record has yet. DuckDB only
 *  infers columns from keys that occur in the JSONL, so without help a
 *  valid query on such a field binder-errors here while the CSV path
 *  (whose header always declares the column) returns NULLs. Padding the
 *  FIRST line with `col: null` makes the column exist (full-scan
 *  inference unions keys across lines) with matching NULL semantics. */
function absentReferencedColumns(rows: CollectionItem[], query: CollectionQuery): string[] {
  const present = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) present.add(key);
  return referencedSourceColumns(query).filter((column) => !present.has(column));
}

/** Run a validated query over enriched collection rows. */
export async function runQueryOverRows(rows: CollectionItem[], query: CollectionQuery): Promise<Record<string, unknown>[]> {
  if (rows.length === 0) return emptyCollectionResult(query);
  await mkdir(cacheDir(), { recursive: true, mode: 0o700 });
  const jsonlPath = path.join(cacheDir(), `q-${randomBytes(8).toString("hex")}.jsonl`);
  try {
    // Stream row-by-row — a map+join would duplicate an uncapped
    // collection as one giant string before writing it. The first line
    // carries null placeholders for referenced-but-absent columns (see
    // `absentReferencedColumns`); a row's own values always win.
    const nullPads = Object.fromEntries(absentReferencedColumns(rows, query).map((column) => [column, null]));
    const handle = await open(jsonlPath, "wx", 0o600);
    try {
      let first = true;
      for (const row of rows) {
        await handle.write(`${JSON.stringify(first ? { ...nullPads, ...row } : row)}\n`);
        first = false;
      }
    } finally {
      await handle.close();
    }
    const { sql, params } = compileJsonlQuery(query);
    const result = await queryCsv(sql, [jsonlPath, ...params]);
    return result.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalizeCsvValue(value)])));
  } finally {
    // The finally covers the WRITE too — a partially-written file from a
    // rejected write must not linger in the shared tmpdir. A failed unlink
    // (other than "never created") is only logged: throwing here would
    // mask the query's own error.
    await unlink(jsonlPath).catch((err: unknown) => {
      if (!isErrorWithCode(err) || err.code !== "ENOENT") log.warn("collections", "temp JSONL cleanup failed", { path: jsonlPath, error: String(err) });
    });
  }
}
