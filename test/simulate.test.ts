/**
 * Unit tests for the HypoPG simulation path.
 *
 * `simulateCandidate` is the core analysis entry point. It is driven here with a
 * fake PgClient that scripts EXPLAIN plan payloads and catalog probes, so the
 * private `planInfo` / `findIndexNode` / `planUsesIndex` / `explainWith` /
 * `explainableText` / `simulateGroundedVector` helpers are exercised end-to-end
 * without needing a database.
 */
import { describe, expect, it } from "vitest";
import { explainStatement, simulateCandidate } from "../src/analysis/simulate.js";
import type { SimulateDeps } from "../src/analysis/simulate.js";
import { indexDdl } from "../src/analysis/ddl.js";
import type { PgClient } from "../src/postgres/client.js";
import type { IndexCandidate, StatementStats } from "../src/types.js";

const stmt = (query: string): StatementStats => ({
  queryid: "q1",
  query,
  calls: 100,
  totalExecTime: 50_000,
  meanExecTime: 500,
  rows: 10,
  hitRatio: 99,
});

const btreeCand: IndexCandidate = {
  table: "orders",
  columns: ["user_id"],
  method: "btree",
  isUnique: false,
  fromQueryid: "q1",
  reason: "test",
};

const vecCand: IndexCandidate = {
  table: "embeddings",
  columns: ["embedding"],
  method: "hnsw",
  opclass: "vector_cosine_ops",
  isUnique: false,
  fromQueryid: "q1",
  reason: "vector test",
};

const QUERY = "SELECT * FROM orders WHERE user_id = 1";
const VEC_QUERY = "SELECT * FROM embeddings ORDER BY embedding <=> $1 LIMIT 10";

/** An EXPLAIN (FORMAT JSON) payload: an array whose first element holds the Plan. */
const plan = (nodeType: string, totalCost: number, planRows = 10, children?: unknown[]): unknown[] => [
  {
    Plan: {
      "Node Type": nodeType,
      "Total Cost": totalCost,
      "Plan Rows": planRows,
      ...(children ? { Plans: children } : {}),
    },
  },
];

type QueryFn = <R extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  values?: unknown[],
) => Promise<R[]>;

interface FakeOptions {
  /** EXPLAIN payloads, popped in order for each EXPLAIN call. */
  plans?: unknown[];
  /** Return zero rows for EXPLAIN (empty queue) instead of a default Seq Scan. */
  emptyExplain?: boolean;
  hypopgOk?: boolean;
  vectorExt?: boolean;
  colIsVector?: boolean;
  typeName?: string | null;
  dims?: string | null;
  /** pg_prepared_statements.parameter_types, "|"-separated (pg array output). */
  paramTypes?: string | null;
  /** value for the size-estimate query's `est` column. */
  est?: string | null;
  /** 1-based withConnection call index that should reject. */
  throwOnConnection?: number;
}

/** Scripts EXPLAIN payloads and catalog probes so simulateCandidate runs DB-free. */
class FakeClient {
  calls: string[] = [];
  createdDdls: string[] = [];
  private connCalls = 0;
  private queue: unknown[];
  constructor(private opts: FakeOptions = {}) {
    this.queue = [...(opts.plans ?? [])];
  }
  private handle(text: string): Record<string, unknown>[] {
    if (/^EXPLAIN \(FORMAT JSON\)/.test(text)) {
      if (this.queue.length > 0) return [{ "QUERY PLAN": this.queue.shift() }];
      if (this.opts.emptyExplain) return [];
      return [{ "QUERY PLAN": plan("Seq Scan", 100)[0] }];
    }
    if (/to_regproc/.test(text)) return [{ ok: this.opts.hypopgOk ?? true }];
    if (/hypopg_create_index/.test(text)) {
      this.createdDdls.push(text);
      return [];
    }
    if (/hypopg_reset/.test(text)) return [];
    if (/^PREPARE /.test(text)) return [];
    if (/pg_prepared_statements/.test(text)) return [{ parameter_types: this.opts.paramTypes ?? null }];
    if (/^DEALLOCATE /.test(text)) return [];
    if (/pg_extension/.test(text)) return [{ ok: this.opts.vectorExt ?? false }];
    // the dimension probe contains both "typmod" and "pg_attribute" — check it first
    if (/typmod/.test(text)) return [{ n: this.opts.dims ?? null }];
    if (/pg_attribute/.test(text)) return [{ ok: this.opts.colIsVector ?? false, t: this.opts.typeName ?? null }];
    return [];
  }
  async withConnection<T>(fn: (q: QueryFn) => Promise<T>): Promise<T> {
    this.connCalls++;
    if (this.opts.throwOnConnection === this.connCalls) throw new Error("catalog query failed");
    const q: QueryFn = async (text) => {
      this.calls.push(text);
      return this.handle(text) as never;
    };
    return fn(q);
  }
  async query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    _values?: unknown[],
  ): Promise<R[]> {
    this.calls.push(text);
    if (/CEIL/.test(text)) return [{ est: this.opts.est ?? null }] as R[];
    return [] as R[];
  }
}

const asClient = (c: FakeClient): PgClient => c as unknown as PgClient;
const deps = (c: FakeClient, hypopgAvailable = true): SimulateDeps => ({
  client: asClient(c),
  hypopgAvailable,
});

describe("simulateCandidate — btree path", () => {
  it("accepts when the planner switches to an index scan at lower cost", async () => {
    const c = new FakeClient({ plans: [plan("Seq Scan", 100), plan("Index Scan", 10)], est: "4096" });
    const res = await simulateCandidate(stmt(QUERY), btreeCand, deps(c));
    expect(res.accepted).toBe(true);
    expect(res.before.nodeType).toBe("Seq Scan");
    expect(res.before.totalCost).toBe(100);
    expect(res.after?.nodeType).toBe("Index Scan");
    expect(res.after?.totalCost).toBe(10);
    expect(res.after?.usesIndexScan).toBe(true);
    expect(res.costRatio).toBe(0.1);
    expect(res.speedup).toBe(10);
    expect(res.rejectionReason).toBeUndefined();
    expect(res.hypopgAvailable).toBe(true);
    expect(res.estimatedIndexSizeBytes).toBe(4096);
  });

  it("creates the hypothetical index with the generated DDL and resets afterwards", async () => {
    const c = new FakeClient({ plans: [plan("Seq Scan", 100), plan("Index Scan", 10)] });
    await simulateCandidate(stmt(QUERY), btreeCand, deps(c));
    const ddl = indexDdl(btreeCand, { concurrently: false });
    expect(c.createdDdls).toEqual([`SELECT * FROM hypopg_create_index('${ddl}')`]);
    expect(c.calls).toContain("SELECT * FROM hypopg_reset()");
  });

  it("rejects when the planner does not use the hypothetical index", async () => {
    const c = new FakeClient({ plans: [plan("Seq Scan", 100), plan("Seq Scan", 80)] });
    const res = await simulateCandidate(stmt(QUERY), btreeCand, deps(c));
    expect(res.accepted).toBe(false);
    expect(res.rejectionReason).toBe("planner did not choose the hypothetical index");
    expect(res.costRatio).toBe(0.8);
    expect(res.speedup).toBeNull();
  });

  it("rejects when the index is used but the cost does not improve", async () => {
    const c = new FakeClient({ plans: [plan("Seq Scan", 100), plan("Index Scan", 200)] });
    const res = await simulateCandidate(stmt(QUERY), btreeCand, deps(c));
    expect(res.accepted).toBe(false);
    expect(res.rejectionReason).toBe("plan cost did not improve");
    expect(res.costRatio).toBe(2);
    expect(res.speedup).toBe(0.5);
  });

  it("descends into child plans to find the index node", async () => {
    const after = plan("Nested Loop", 30, 10, [
      { "Node Type": "Index Scan", "Total Cost": 20, "Plan Rows": 10 },
    ]);
    const c = new FakeClient({ plans: [plan("Seq Scan", 100), after] });
    const res = await simulateCandidate(stmt(QUERY), btreeCand, deps(c));
    expect(res.after?.nodeType).toBe("Index Scan");
    expect(res.after?.totalCost).toBe(20);
    expect(res.after?.usesIndexScan).toBe(true);
    expect(res.accepted).toBe(true);
    expect(res.speedup).toBe(5);
  });

  it("falls back to the plan root when no index node exists", async () => {
    const after = plan("Hash Join", 50, 10, [
      { "Node Type": "Hash" },
      { "Node Type": "Seq Scan", "Total Cost": 40, "Plan Rows": 10 },
    ]);
    const c = new FakeClient({ plans: [plan("Seq Scan", 100), after] });
    const res = await simulateCandidate(stmt(QUERY), btreeCand, deps(c));
    expect(res.after?.nodeType).toBe("Hash Join");
    expect(res.after?.usesIndexScan).toBe(false);
    expect(res.accepted).toBe(false);
    expect(res.rejectionReason).toBe("planner did not choose the hypothetical index");
  });

  it("reports unproven mode when HypoPG is unavailable", async () => {
    const c = new FakeClient({ plans: [plan("Seq Scan", 100)] });
    const res = await simulateCandidate(stmt(QUERY), btreeCand, deps(c, false));
    expect(res.accepted).toBe(false);
    expect(res.after).toBeNull();
    expect(res.costRatio).toBeNull();
    expect(res.speedup).toBeNull();
    expect(res.hypopgAvailable).toBe(false);
    expect(res.rejectionReason).toBe("HypoPG not installed — unproven mode (run pgheal doctor)");
    expect(res.before.nodeType).toBe("Seq Scan");
  });

  it("throws when the HypoPG probe fails on the simulation session", async () => {
    const c = new FakeClient({ plans: [plan("Seq Scan", 100)], hypopgOk: false });
    await expect(simulateCandidate(stmt(QUERY), btreeCand, deps(c))).rejects.toThrow(
      "HypoPG is not available on the simulation session",
    );
  });

  it("reports a null cost ratio when the baseline cost is zero", async () => {
    const c = new FakeClient({ plans: [plan("Seq Scan", 0), plan("Index Scan", 5)] });
    const res = await simulateCandidate(stmt(QUERY), btreeCand, deps(c));
    expect(res.costRatio).toBeNull();
    expect(res.accepted).toBe(false);
    expect(res.rejectionReason).toBe("plan cost did not improve");
  });

  it("omits the size estimate when estimation yields nothing", async () => {
    const c = new FakeClient({ plans: [plan("Seq Scan", 100), plan("Index Scan", 10)], est: null });
    const res = await simulateCandidate(stmt(QUERY), btreeCand, deps(c));
    expect(res).not.toHaveProperty("estimatedIndexSizeBytes");
  });

  it("strips the trailing semicolon before EXPLAIN", async () => {
    const c = new FakeClient({ plans: [plan("Seq Scan", 100), plan("Index Scan", 10)] });
    await simulateCandidate(stmt(`${QUERY};`), btreeCand, deps(c));
    const explained = c.calls.filter((t) => /^EXPLAIN \(FORMAT JSON\)/.test(t));
    expect(explained.length).toBeGreaterThan(0);
    for (const t of explained) expect(t.endsWith(";")).toBe(false);
  });
});

describe("simulateCandidate — vector grounded path", () => {
  it("never claims acceptance and labels the result grounded", async () => {
    const c = new FakeClient({ plans: [plan("Seq Scan", 100)], vectorExt: true, colIsVector: true });
    const res = await simulateCandidate(stmt(VEC_QUERY), vecCand, deps(c));
    expect(res.accepted).toBe(false);
    expect(res.proof).toBe("grounded");
    expect(res.after).toBeNull();
    expect(res.costRatio).toBeNull();
    expect(res.speedup).toBeNull();
    expect(res.before.nodeType).toBe("Seq Scan");
    expect(res.rejectionReason).toBeUndefined();
  });

  it("reports the missing pgvector extension and non-vector column", async () => {
    const c = new FakeClient({ plans: [plan("Seq Scan", 100)] });
    const res = await simulateCandidate(stmt(VEC_QUERY), vecCand, deps(c));
    expect(res.rejectionReason).toContain("pgvector extension is not installed");
    expect(res.rejectionReason).toContain("column embeddings.embedding is not a vector type");
  });

  it("suggests halfvec when a vector column exceeds 2000 dimensions", async () => {
    const c = new FakeClient({
      plans: [plan("Seq Scan", 100)],
      vectorExt: true,
      colIsVector: true,
      typeName: "vector",
      dims: "4096",
    });
    const res = await simulateCandidate(stmt(VEC_QUERY), vecCand, deps(c));
    expect(res.rejectionReason).toContain("vector(4096)");
    expect(res.rejectionReason).toContain("halfvec");
    expect(res.rejectionReason).toContain(
      "ALTER TABLE embeddings ALTER COLUMN embedding TYPE halfvec(4096)",
    );
  });

  it("does not suggest halfvec within the 2000-dimension limit", async () => {
    const c = new FakeClient({
      plans: [plan("Seq Scan", 100)],
      vectorExt: true,
      colIsVector: true,
      typeName: "vector",
      dims: "128",
    });
    const res = await simulateCandidate(stmt(VEC_QUERY), vecCand, deps(c));
    expect(res.rejectionReason).toBeUndefined();
  });

  it("notes when HypoPG is missing so even filter columns cannot be proven", async () => {
    const c = new FakeClient({ plans: [plan("Seq Scan", 100)], vectorExt: true, colIsVector: true });
    const res = await simulateCandidate(stmt(VEC_QUERY), vecCand, deps(c, false));
    expect(res.hypopgAvailable).toBe(false);
    expect(res.rejectionReason).toContain("HypoPG not installed — filter columns cannot be proven either");
  });

  it("routes ivfflat through the same grounded path", async () => {
    const c = new FakeClient({ plans: [plan("Seq Scan", 100)], vectorExt: true, colIsVector: true });
    const res = await simulateCandidate(stmt(VEC_QUERY), { ...vecCand, method: "ivfflat" }, deps(c));
    expect(res.proof).toBe("grounded");
    expect(res.accepted).toBe(false);
  });

  it("handles a vector candidate with no columns", async () => {
    const c = new FakeClient({ plans: [plan("Seq Scan", 100)] });
    const res = await simulateCandidate(stmt(VEC_QUERY), { ...vecCand, columns: [] }, deps(c));
    expect(res.proof).toBe("grounded");
    // the column name is interpolated straight from columns[0] (undefined here),
    // while the catalog probe falls back to the empty string
    expect(res.rejectionReason).toContain("column embeddings.undefined is not a vector type");
  });

  it("survives a catalog-query failure during the grounded checks", async () => {
    const c = new FakeClient({ plans: [plan("Seq Scan", 100)], throwOnConnection: 2 });
    const res = await simulateCandidate(stmt(VEC_QUERY), vecCand, deps(c));
    expect(res.proof).toBe("grounded");
    expect(res.rejectionReason).toContain("pgvector extension is not installed");
  });
});

describe("explainStatement", () => {
  it("unwraps the EXPLAIN JSON payload", async () => {
    const payload = plan("Seq Scan", 42);
    const c = new FakeClient({ plans: [payload] });
    const out = await explainStatement(asClient(c), "SELECT * FROM orders");
    expect(out).toEqual(payload);
  });

  it("strips a trailing semicolon before EXPLAIN", async () => {
    const c = new FakeClient({ plans: [plan("Seq Scan", 1)] });
    await explainStatement(asClient(c), "SELECT * FROM orders;");
    expect(c.calls[0]).toBe("EXPLAIN (FORMAT JSON) SELECT * FROM orders");
  });

  it("routes parameterized statements through PREPARE with type-derived dummy values", async () => {
    const c = new FakeClient({ plans: [plan("Index Scan", 5)], paramTypes: "integer|text" });
    await explainStatement(asClient(c), "SELECT * FROM t WHERE id = $1 AND name = $2");
    expect(c.calls.some((t) => /^PREPARE pgheal_q_/.test(t))).toBe(true);
    expect(c.calls.some((t) => /EXECUTE pgheal_q_\w+\(1, 'pgheal'\)/.test(t))).toBe(true);
    expect(c.calls.some((t) => /^DEALLOCATE pgheal_q_/.test(t))).toBe(true);
  });

  it("executes with an empty argument list when no parameter types are inferred", async () => {
    const c = new FakeClient({ plans: [plan("Index Scan", 5)] });
    await explainStatement(asClient(c), "SELECT * FROM t WHERE id = $1");
    expect(c.calls.some((t) => /EXECUTE pgheal_q_\w+\(\)/.test(t))).toBe(true);
  });

  it("returns null when EXPLAIN yields no rows", async () => {
    const c = new FakeClient({ emptyExplain: true });
    expect(await explainStatement(asClient(c), "SELECT * FROM orders")).toBeNull();
  });
});
