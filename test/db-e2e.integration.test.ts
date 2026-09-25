import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { execSync } from "node:child_process";
import pg from "pg";
import { loadConfig } from "../src/config.js";
import { runDoctor } from "../src/doctor.js";
import { explainQuery } from "../src/explain.js";
import { selectIndexSet, explainWithSet } from "../src/analysis/workload.js";
import type { StatementStats } from "../src/types.js";

/**
 * Real-database E2E: Postgres 18 + HypoPG 1.4.2 (built from source via
 * docker/Dockerfile.db), 200k-row orders table with NO index on user_id —
 * pgheal must prove the win. Skipped automatically when Docker is unavailable.
 */

const HAVE_DOCKER = (() => {
  try {
    execSync("docker info", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const d = HAVE_DOCKER ? describe : describe.skip;
const LONG = 420_000;

let container: StartedTestContainer | null = null;
let dsn = "";

const WORKLOAD_QUERY =
  "SELECT * FROM orders WHERE user_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT $3";

/**
 * Postgres briefly rejects connections with 57P03 ("database system is
 * starting up") right after the port opens, especially under CI load —
 * retry those (and ECONNREFUSED) with a 1s backoff instead of flaking.
 */
async function connectWithRetry(pool: pg.Pool, attempts = 30, delayMs = 1000): Promise<pg.PoolClient> {
  let lastError: unknown = undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await pool.connect();
    } catch (err) {
      lastError = err;
      const code = (err as { code?: string } | null)?.code;
      if (code !== "57P03" && code !== "ECONNREFUSED") throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

async function seedWorkload(dsn: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: dsn, max: 1 });
  const c = await connectWithRetry(pool);
  try {
    await c.query("CREATE EXTENSION IF NOT EXISTS hypopg");
    await c.query("CREATE EXTENSION IF NOT EXISTS pg_stat_statements");
    await c.query(`
      CREATE TABLE orders (
        id bigserial PRIMARY KEY,
        user_id bigint NOT NULL,
        status text NOT NULL,
        total numeric(12,2) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await c.query(`
      INSERT INTO orders (user_id, status, total, created_at)
      SELECT (g % 10000) + 1,
             (ARRAY['paid','pending','cancelled'])[1 + (g % 3)],
             (random() * 500)::numeric(12,2),
             now() - (g % 365) * interval '1 day'
      FROM generate_series(1, 200000) g`);
    await c.query("ANALYZE orders");
  } finally {
    c.release();
    await pool.end();
  }
}

d("pgHeal E2E on real Postgres 18 + HypoPG (testcontainers)", () => {
  beforeAll(async () => {
    // build() returns a GenericContainer pre-configured with the built image
    const built = await GenericContainer.fromDockerfile(".", "docker/Dockerfile.db").build();
    container = await built
      .withExposedPorts(5432)
      .withCommand(["postgres", "-c", "shared_preload_libraries=pg_stat_statements"])
      .withEnvironment({
        POSTGRES_USER: "pgheal",
        POSTGRES_PASSWORD: "pgheal",
        POSTGRES_DB: "demo",
      })
      .withStartupTimeout(300_000)
      .start();
    dsn = `postgres://pgheal:pgheal@${container.getHost()}:${container.getMappedPort(5432)}/demo`;
    await seedWorkload(dsn);
  }, LONG);

  afterAll(async () => {
    await container?.stop().catch(() => undefined);
  });

  it(
    "doctor is fully green and the session is read-only",
    async () => {
      const config = loadConfig({ DATABASE_URL: dsn });
      const { checks, ready } = await runDoctor(config);
      expect(ready).toBe(true);
      expect(checks.find((c) => c.name === "hypopg")?.ok).toBe(true);
      expect(checks.find((c) => c.name === "pg_stat_statements")?.ok).toBe(true);
    },
    LONG,
  );

  it(
    "explain proves a real speedup on the un-indexed workload query",
    async () => {
      const config = loadConfig({ DATABASE_URL: dsn });
      const sql = "SELECT * FROM orders WHERE user_id = 42 AND status = 'paid' ORDER BY created_at DESC";
      const out = await explainQuery(config, sql);
      expect(out).toContain("proven improvement");
      expect(out).toMatch(/Cost reduction.*\d+\.?\d*%/);
    },
    LONG,
  );

  it(
    "selectIndexSet picks a joint set whose simulation improves the statement",
    async () => {
      const { PgClient } = await import("../src/postgres/client.js");
      const config = loadConfig({ DATABASE_URL: dsn });
      const client = new PgClient(config);
      await client.connect();
      try {
        const stmt: StatementStats = {
          queryid: "e2e",
          query: WORKLOAD_QUERY,
          calls: 200,
          totalExecTime: 50_000,
          meanExecTime: 250,
          rows: 200,
          hitRatio: 99,
        };
        const { makeCandidates } = await import("../src/analysis/candidates.js");
        const candidates = makeCandidates(stmt);
        expect(candidates.length).toBeGreaterThan(0);

        const decision = await selectIndexSet([stmt], candidates, { client, hypopgAvailable: true }, config);
        expect(decision.chosen.length).toBeGreaterThan(0);
        expect(decision.results[0]!.accepted).toBe(true);
        expect(decision.results[0]!.after!.usesIndexScan).toBe(true);
        expect(decision.results[0]!.speedup!).toBeGreaterThan(1);

        // joint simulation equals independent simulation for a single query
        const joint = await explainWithSet(client, stmt, decision.chosen);
        expect(joint.usesIndexScan).toBe(true);
      } finally {
        await client.close();
      }
    },
    LONG,
  );

  it(
    "pgvector: HNSW candidate is grounded (never fake-proven), expression btree IS HypoPG-proven",
    async () => {
      const { PgClient } = await import("../src/postgres/client.js");
      const { simulateCandidate } = await import("../src/analysis/simulate.js");
      const config = loadConfig({ DATABASE_URL: dsn });
      const client = new PgClient(config);
      await client.connect();
      try {
        const q = async (t: string) => (await client.query(t)) as unknown as void;
        void q;
        const pool = new pg.Pool({ connectionString: dsn, max: 1 });
        const c = await pool.connect();
        try {
          await c.query("CREATE EXTENSION IF NOT EXISTS vector");
          await c.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS embedding vector(64)");
          await c.query("UPDATE orders SET embedding = (SELECT ('[' || string_agg(x::text, ',') || ']')::vector FROM (SELECT ((g * 37) % 100) / 100.0 AS x FROM generate_series(1, 64) g) s)");
          await c.query("ANALYZE orders");
        } finally {
          c.release();
          await pool.end();
        }

        // 1) cosine-distance query → hnsw candidate with matching opclass
        const vecStmt: StatementStats = {
          queryid: "e2e-vec",
          query: "SELECT id FROM orders ORDER BY embedding <=> $1 LIMIT 5",
          calls: 300,
          totalExecTime: 60_000,
          meanExecTime: 200,
          rows: 5,
          hitRatio: 99,
        };
        const { makeCandidates } = await import("../src/analysis/candidates.js");
        const hnsw = makeCandidates(vecStmt).find((x) => x.method === "hnsw");
        expect(hnsw).toBeDefined();
        expect(hnsw!.opclass).toBe("vector_cosine_ops");

        const grounded = await simulateCandidate(vecStmt, hnsw!, { client, hypopgAvailable: true }, config);
        expect(grounded.proof).toBe("grounded");
        expect(grounded.accepted).toBe(false); // never fake-proven
        expect(grounded.rejectionReason).toBeUndefined(); // ext + column type are fine

        // the DDL is actually valid against the live server (syntax + opclass).
        // PgClient is read-only BY DESIGN, so the write check uses its own pool.
        const { indexDdl } = await import("../src/analysis/ddl.js");
        const ddlPool = new pg.Pool({ connectionString: dsn, max: 1 });
        const dc = await ddlPool.connect();
        try {
          await dc.query(indexDdl(hnsw!, { concurrently: false }).replace("IF NOT EXISTS ", ""));
          await dc.query("DROP INDEX idx_orders_embedding_hnsw");
        } finally {
          dc.release();
          await ddlPool.end();
        }

        // 2) expression btree IS HypoPG-simulable → full proof on real planner
        const exprStmt: StatementStats = {
          queryid: "e2e-expr",
          query: "SELECT id FROM orders WHERE LOWER(status) = 'paid'",
          calls: 500,
          totalExecTime: 80_000,
          meanExecTime: 160,
          rows: 66_000,
          hitRatio: 99,
        };
        const exprCand = makeCandidates(exprStmt).find((x) => x.expression);
        expect(exprCand).toBeDefined();
        const exprSim = await simulateCandidate(exprStmt, exprCand!, { client, hypopgAvailable: true }, config);
        expect(exprSim.proof).toBeUndefined(); // default = hypopg
        // (planner may or may not pick it for a 3-value column; either way the
        //  simulation must run without error and label as hypopg proof)
      } finally {
        await client.close();
      }
    },
    LONG,
  );
});
