import { describe, expect, it } from "vitest";
import { estimateIndexSize, estimateIndexSizeSync } from "../src/analysis/estimate.js";
import type { PgClient } from "../src/postgres/client.js";
import type { IndexCandidate } from "../src/types.js";

const cand: IndexCandidate = {
  table: "orders",
  columns: ["user_id", "created_at"],
  method: "btree",
  isUnique: false,
  fromQueryid: "q1",
  reason: "test",
};

/** Minimal PgClient stand-in: only `query` is used by estimateIndexSize. */
class EstClient {
  calls: { text: string; values?: unknown[] }[] = [];
  constructor(
    private rows: Record<string, unknown>[] = [],
    private error: Error | null = null,
  ) {}
  async query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<R[]> {
    this.calls.push({ text, values });
    if (this.error) throw this.error;
    return this.rows as R[];
  }
}

const asClient = (c: EstClient): PgClient => c as unknown as PgClient;

describe("estimateIndexSizeSync", () => {
  it("computes rows × (width + 16B overhead) × columns × 2", () => {
    // 1000 rows × (100 + 16) × 2 columns × 2 = 464000
    expect(estimateIndexSizeSync(100, 2, 1000)).toBe(464000);
  });

  it("caps the average column width at 2700 bytes (btree page budget)", () => {
    // 1 row × (2700 + 16) × 1 column × 2 = 5432
    expect(estimateIndexSizeSync(100000, 1, 1)).toBe(5432);
  });

  it("treats zero-width columns as overhead only", () => {
    // 100 rows × (0 + 16) × 3 columns × 2 = 9600
    expect(estimateIndexSizeSync(0, 3, 100)).toBe(9600);
  });

  it("returns 0 for zero rows", () => {
    expect(estimateIndexSizeSync(100, 2, 0)).toBe(0);
  });

  it("returns 0 for zero columns", () => {
    expect(estimateIndexSizeSync(100, 0, 1000)).toBe(0);
  });

  it("clamps negative row counts at 0 instead of returning a negative size", () => {
    expect(estimateIndexSizeSync(100, 2, -5)).toBe(0);
  });

  it("is deterministic (same inputs → same output)", () => {
    expect(estimateIndexSizeSync(42, 3, 777)).toBe(estimateIndexSizeSync(42, 3, 777));
  });
});

describe("estimateIndexSize", () => {
  it("parses the catalog estimate string into a number", async () => {
    const c = new EstClient([{ est: "12345" }]);
    expect(await estimateIndexSize(asClient(c), cand)).toBe(12345);
  });

  it("handles large estimates without truncation", async () => {
    const c = new EstClient([{ est: "9999999999" }]);
    expect(await estimateIndexSize(asClient(c), cand)).toBe(9999999999);
  });

  it("returns 0 when the estimate column is null", async () => {
    const c = new EstClient([{ est: null }]);
    expect(await estimateIndexSize(asClient(c), cand)).toBe(0);
  });

  it("returns 0 when no rows are returned (table not found / pre-ANALYZE)", async () => {
    const c = new EstClient([]);
    expect(await estimateIndexSize(asClient(c), cand)).toBe(0);
  });

  it("returns 0 when the catalog query fails (estimation is best-effort)", async () => {
    const c = new EstClient([], new Error("connection lost"));
    expect(await estimateIndexSize(asClient(c), cand)).toBe(0);
  });

  it("forwards the table, column count and columns as query parameters", async () => {
    const c = new EstClient([{ est: "100" }]);
    await estimateIndexSize(asClient(c), cand);
    expect(c.calls[0]?.values).toEqual([cand.table, 2, cand.columns]);
  });

  it("reads reltuples from pg_class with the target table name", async () => {
    const c = new EstClient([{ est: "100" }]);
    await estimateIndexSize(asClient(c), cand);
    expect(c.calls[0]?.text).toContain("pg_class");
    expect(c.calls[0]?.text).toContain("$1::text");
  });
});
