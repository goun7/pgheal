/**
 * Edge-case tests for indexName / indexDdl naming and DDL generation.
 *
 * ddl.test.ts covers the happy paths; this file targets the branches that
 * the v0.5+ features added: expression indexes (`_expr` naming), pgvector
 * hnsw/ivfflat DDL with opclass mapping, and opclass fallbacks.
 */
import { describe, expect, it } from "vitest";
import { indexDdl, indexName } from "../src/analysis/ddl.js";
import type { IndexCandidate } from "../src/types.js";

const base: IndexCandidate = {
  table: "orders",
  columns: ["user_id"],
  method: "btree",
  isUnique: false,
  fromQueryid: "q1",
  reason: "test",
};

describe("indexName", () => {
  it("joins multiple columns with underscores for btree", () => {
    expect(indexName({ ...base, columns: ["user_id", "created_at"] })).toBe("idx_orders_user_id_created_at");
  });

  it("appends the method suffix for non-btree methods", () => {
    expect(indexName({ ...base, method: "gin" })).toBe("idx_orders_user_id_gin");
    expect(indexName({ ...base, method: "brin" })).toBe("idx_orders_user_id_brin");
    expect(indexName({ ...base, method: "hnsw" })).toBe("idx_orders_user_id_hnsw");
    expect(indexName({ ...base, method: "ivfflat" })).toBe("idx_orders_user_id_ivfflat");
  });

  it("uses the `_expr` suffix for expression indexes", () => {
    const name = indexName({ ...base, expression: 'LOWER("email")' });
    expect(name).toBe("idx_orders_user_id_expr");
  });

  it("truncates to the 63-char Postgres identifier limit", () => {
    const long = indexName({
      ...base,
      table: "a_very_long_table_name_indeed",
      columns: ["very_long_column_name_one", "very_long_column_name_two", "very_long_column_name_three"],
    });
    expect(long.length).toBeLessThanOrEqual(63);
  });

  it("produces deterministic names (same input → same output)", () => {
    const c = { ...base, columns: ["a", "b"], method: "gin" };
    expect(indexName(c)).toBe(indexName(c));
  });
});

describe("indexDdl — pgvector methods", () => {
  it("generates hnsw DDL with the opclass and WITH options", () => {
    const out = indexDdl({ ...base, method: "hnsw", opclass: "vector_l2_ops" }, { concurrently: false });
    expect(out).toBe(
      'CREATE INDEX IF NOT EXISTS idx_orders_user_id_hnsw ON "orders" USING hnsw ("user_id" vector_l2_ops) WITH (m = 16, ef_construction = 64);',
    );
  });

  it("generates ivfflat DDL with the opclass and lists", () => {
    const out = indexDdl({ ...base, method: "ivfflat", opclass: "vector_ip_ops" }, { concurrently: false });
    expect(out).toBe(
      'CREATE INDEX IF NOT EXISTS idx_orders_user_id_ivfflat ON "orders" USING ivfflat ("user_id" vector_ip_ops) WITH (lists = 100);',
    );
  });

  it("falls back to vector_cosine_ops when no opclass is given", () => {
    expect(indexDdl({ ...base, method: "hnsw" }, { concurrently: false })).toContain("vector_cosine_ops");
    expect(indexDdl({ ...base, method: "ivfflat" }, { concurrently: false })).toContain("vector_cosine_ops");
  });

  it("honors the concurrently flag for vector methods", () => {
    expect(indexDdl({ ...base, method: "hnsw" }, { concurrently: true })).toContain("CREATE CONCURRENTLY INDEX");
    expect(indexDdl({ ...base, method: "ivfflat" }, { concurrently: true })).toContain("CREATE CONCURRENTLY INDEX");
  });
});

describe("indexDdl — expression indexes", () => {
  it("emits the expression as the index target for btree", () => {
    const out = indexDdl({ ...base, expression: 'LOWER("email")' }, { concurrently: false });
    expect(out).toBe('CREATE INDEX IF NOT EXISTS idx_orders_user_id_expr ON "orders" (LOWER("email"));');
  });

  it("supports CONCURRENTLY for expression indexes", () => {
    const out = indexDdl({ ...base, expression: 'DATE("created_at")' }, { concurrently: true });
    expect(out).toContain("CREATE CONCURRENTLY INDEX");
    expect(out).toContain('DATE("created_at")');
  });
});

describe("indexDdl — method-specific shapes", () => {
  it("emits a single quoted column for gin", () => {
    expect(indexDdl({ ...base, method: "gin" }, { concurrently: false })).toContain('USING gin ("user_id")');
  });

  it("emits a single quoted column for brin", () => {
    expect(indexDdl({ ...base, method: "brin" }, { concurrently: false })).toContain('USING brin ("user_id")');
  });

  it("applies opclasses to each btree column when provided", () => {
    const out = indexDdl({ ...base, columns: ["email"], opclass: "text_pattern_ops" }, { concurrently: false });
    expect(out).toContain('("email" text_pattern_ops)');
  });

  it("quotes every column in a multi-column btree index", () => {
    const out = indexDdl({ ...base, columns: ["a", "b"] }, { concurrently: false });
    expect(out).toContain('("a", "b")');
  });

  it("always uses IF NOT EXISTS", () => {
    for (const method of ["btree", "gin", "brin", "hnsw", "ivfflat"] as const) {
      expect(indexDdl({ ...base, method }, { concurrently: false })).toContain("IF NOT EXISTS");
    }
  });
});
