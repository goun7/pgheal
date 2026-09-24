import type { IndexCandidate } from "../types.js";
import type { PgClient } from "../postgres/client.js";

/**
 * Rough index size estimate from catalog statistics (read-only, no data access).
 * size ≈ reltuples × (avg column width + entry overhead) × 2 btree factor.
 *
 * Column width source: pg_stats.avg_width of exactly the index columns (varlena
 * types report attlen = -1 in pg_attribute, so attlen alone underestimates text
 * columns badly — pg_stats is authoritative; attlen (max, non-varlena) and a 24B
 * default are the fallbacks, e.g. before the first ANALYZE).
 */
export async function estimateIndexSize(client: PgClient, candidate: IndexCandidate): Promise<number> {
  try {
    const rows = await client.query<{ est: string | null }>(
      `WITH target AS (SELECT $1::text AS table_name)
       SELECT CEIL(c.reltuples * (
         16 + GREATEST(
           COALESCE(
             (SELECT AVG(s.avg_width) FROM pg_stats s
              WHERE s.tablename = c.relname
                AND s.schemaname = c.relnamespace::regnamespace::text
                AND s.attname = ANY($3::text[])),
             (SELECT COALESCE(NULLIF(MAX(a.attlen), -1), 24) FROM pg_attribute a
              WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped),
             24
           ) * $2::int * 2
         )
       ))::bigint::text AS est
       FROM pg_class c
       JOIN target t ON t.table_name = c.relname
       WHERE c.relkind IN ('r','p') LIMIT 1`,
      [candidate.table, candidate.columns.length, candidate.columns],
    );
    const est = rows[0]?.est;
    return est ? Number(est) : 0;
  } catch {
    return 0; // estimation is best-effort; never fail a scan for it
  }
}

/** Deterministic size estimate for tests: rows × (colWidth + 16B overhead) × 2. */
export function estimateIndexSizeSync(avgRowBytes: number, columns: number, rowCount: number): number {
  const perEntry = Math.min(avgRowBytes, 2700) + 16;
  return Math.max(0, Math.round(rowCount * perEntry * columns * 2));
}
