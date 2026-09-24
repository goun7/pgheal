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

async function seedWorkload(dsn: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: dsn, max: 1 });
  const c = await pool.connect();
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
});
