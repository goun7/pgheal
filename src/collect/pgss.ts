import type { StatementStats, IndexDef, TableWriteStats } from "../types.js";
import type { PgClient } from "../postgres/client.js";

/** Collectors — read from pg_catalog / pg_stat_* only. No DDL, no DML. */

/**
 * Top-N statements by total execution time from pg_stat_statements.
 * Column names changed in PG13 (total_time → total_exec_time); PG18 removed the
 * old names entirely, so we detect the available columns at runtime.
 */
async function pgssColumns(client: PgClient): Promise<{ total: string; mean: string }> {
  const rows = await client.query<{ has_new: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_name = 'pg_stat_statements' AND column_name = 'total_exec_time'
     ) AS has_new`,
  );
  return rows[0]!.has_new ? { total: "total_exec_time", mean: "mean_exec_time" } : { total: "total_time", mean: "mean_time" };
}

export async function fetchTopStatements(
  client: PgClient,
  topN: number,
  minTotalMs: number,
): Promise<StatementStats[]> {
  const cols = await pgssColumns(client);
  const rows = await client.query<{
    queryid: string;
    query: string;
    calls: string;
    total_exec: string;
    mean_exec: string;
    rows: string;
    hit_ratio: string | null;
    temp_blks: string | null;
  }>(
    `SELECT
       queryid::text AS queryid,
       query,
       calls,
       COALESCE(${cols.total}, 0) AS total_exec,
       COALESCE(${cols.mean}, 0) AS mean_exec,
       rows,
       CASE WHEN (shared_blks_hit + shared_blks_read) > 0
            THEN round(100.0 * shared_blks_hit / (shared_blks_hit + shared_blks_read), 1)
            ELSE NULL END AS hit_ratio,
       temp_blks_written AS temp_blks
     FROM pg_stat_statements
     WHERE query NOT LIKE 'COPY %'
       AND query NOT LIKE '%pg_stat%'
       AND query NOT LIKE '%pgheal%'
       AND query NOT LIKE 'DO %'
       AND query NOT LIKE 'ALTER %'
       AND query NOT LIKE 'CREATE %'
       AND query NOT LIKE 'DROP %'
       AND query NOT LIKE 'VACUUM %'
       AND query NOT LIKE 'ANALYZE %'
       AND query NOT LIKE 'BEGIN %'
       AND query NOT LIKE 'COMMIT%'
       AND query NOT LIKE 'ROLLBACK%'
       AND query NOT LIKE 'SET %'
       AND query NOT LIKE 'RESET%'
       AND query NOT LIKE 'DEALLOCATE%'
       AND query NOT LIKE 'DISCARD%'
       AND query NOT LIKE 'LOCK %'
       AND query NOT LIKE 'INSERT INTO pgheal%'
       AND query NOT LIKE '%/* pgheal_skip */%'
     ORDER BY ${cols.total} DESC
     LIMIT $1`,
    [topN],
  );
  return rows.map(mapRow).filter((s) => s.totalExecTime >= minTotalMs);
}

interface RawStatementRow {
  queryid: string;
  query: string;
  calls: string;
  total_exec: string;
  mean_exec: string;
  rows: string;
  hit_ratio: string | null;
  temp_blks: string | null;
}

function mapRow(r: RawStatementRow): StatementStats {
  return {
    queryid: r.queryid,
    query: r.query.replace(/\s+/g, " ").trim().slice(0, 2000),
    calls: Number(r.calls),
    totalExecTime: Number(r.total_exec),
    meanExecTime: Number(r.mean_exec),
    rows: Number(r.rows),
    hitRatio: r.hit_ratio === null ? 0 : Number(r.hit_ratio),
    tempBlks: r.temp_blks === null ? undefined : Number(r.temp_blks),
  };
}

/**
 * All non-primary indexes on ordinary/partitioned user tables with usage stats.
 * Columns are resolved through pg_index.indkey in positional order.
 */
export async function fetchIndexes(client: PgClient): Promise<IndexDef[]> {
  const rows = await client.query<{
    name: string;
    table: string;
    columns: string | null;
    is_unique: boolean;
    is_valid: boolean;
    scans: string;
    size_bytes: string;
  }>(
    `SELECT
       i.relname AS name,
       t.relname AS "table",
       COALESCE((
         SELECT string_agg(a.attname, ',' ORDER BY x.ord)
         FROM pg_index ix2
         JOIN LATERAL unnest(ix2.indkey) WITH ORDINALITY AS x(attnum, ord) ON true
         JOIN pg_attribute a ON a.attrelid = ix2.indrelid AND a.attnum = x.attnum
         WHERE ix2.indexrelid = i.oid
           AND a.attnum > 0
       ), '') AS columns,
       ix0.indisunique AS is_unique,
       ix0.indisvalid AS is_valid,
       COALESCE(s.idx_scan, 0) AS scans,
       COALESCE(pg_relation_size(i.oid), 0) AS size_bytes
     FROM pg_class i
     JOIN pg_index ix0 ON ix0.indexrelid = i.oid
     JOIN pg_class t ON t.oid = ix0.indrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = i.oid
     WHERE t.relkind IN ('r', 'p')
       AND n.nspname NOT IN ('pg_catalog', 'information_schema')
     ORDER BY pg_relation_size(i.oid) DESC`,
  );
  return rows.map((r) => ({
    name: r.name,
    table: r.table,
    columns: (r.columns ?? "").split(",").filter(Boolean),
    isUnique: r.is_unique,
    isValid: r.is_valid,
    scans: Number(r.scans),
    sizeBytes: Number(r.size_bytes),
  }));
}

/** Per-table write pressure — used for write-overhead estimation of index drops. */
export async function fetchTableWrites(client: PgClient): Promise<TableWriteStats[]> {
  const rows = await client.query<{
    table: string;
    n_tup_ins: string;
    n_tup_upd: string;
    n_tup_del: string;
    n_live_tup: string;
    n_dead_tup: string;
  }>(
    `SELECT relname AS "table",
            n_tup_ins, n_tup_upd, n_tup_del,
            n_live_tup, n_dead_tup
     FROM pg_stat_user_tables
     WHERE schemaname = current_schema()`,
  );
  return rows.map((r) => ({
    table: r.table,
    inserts: Number(r.n_tup_ins),
    updates: Number(r.n_tup_upd),
    deletes: Number(r.n_tup_del),
    liveTuples: Number(r.n_live_tup),
    deadTuples: Number(r.n_dead_tup),
  }));
}
