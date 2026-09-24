import pg from "pg";
import type { Config } from "../config.js";

/**
 * Read-only, timeout-bounded Postgres session.
 *
 * Safety model (paper §2):
 *  - connection opens with default_transaction_read_only=on
 *  - statement_timeout + lock_timeout bound every query
 *  - pgHeal issues zero DDL/DML by design
 */
export class PgClient {
  private pool: pg.Pool | null = null;

  constructor(private readonly config: Config) {}

  async connect(): Promise<void> {
    if (this.pool) return;
    this.pool = new pg.Pool({
      connectionString: this.config.databaseUrl,
      connectionTimeoutMillis: this.config.connectTimeoutMs,
      max: 2, // analysis-only: keep footprint minimal
      statement_timeout: this.config.statementTimeoutMs,
      lock_timeout: 1000,
      application_name: "pgheal-agent",
      // applied server-side at session start, on every pooled connection
      options: "-c default_transaction_read_only=on -c lock_timeout=1s",
    });
  }

  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<T[]> {
    if (!this.pool) throw new Error("PgClient not connected — call connect() first");
    const res = await this.pool.query<T>(text, values as never[]);
    return res.rows;
  }

  /**
   * Run a sequence of statements on one dedicated pooled connection.
   * Required for session-scoped objects (PREPARE / HypoPG indexes) that must
   * span multiple queries within the same session.
   */
  async withConnection<T>(fn: (query: <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]) => Promise<R[]>) => Promise<T>): Promise<T> {
    if (!this.pool) throw new Error("PgClient not connected — call connect() first");
    const client = await this.pool.connect();
    const query = async <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<R[]> => {
      const res = await client.query<R>(text, values as never[]);
      return res.rows;
    };
    try {
      return await fn(query);
    } finally {
      client.release();
    }
  }

  async serverVersion(): Promise<string> {
    const rows = await this.query<{ version: string }>("SELECT version()");
    return rows[0]!.version;
  }

  async serverMajorVersion(): Promise<number> {
    const rows = await this.query<{ num: string }>("SHOW server_version_num");
    return parseInt(rows[0]!.num.slice(0, 2), 10) + 0; // "180234" -> 18 (two-digit major works for PG10+)
  }

  async extensionAvailable(ext: "hypopg" | "pg_stat_statements"): Promise<boolean> {
    const rows = await this.query<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_available_extensions WHERE name = $1
       ) AND EXISTS (
         SELECT 1 FROM pg_extension WHERE extname = $1
       ) AS ok`,
      [ext],
    );
    return rows[0]!.ok;
  }

  async close(): Promise<void> {
    await this.pool?.end();
    this.pool = null;
  }
}
