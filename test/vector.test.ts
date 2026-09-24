import { describe, expect, it } from "vitest";
import { extractShape, makeCandidates, vectorDistanceColumns, expressionPredicateColumns } from "../src/analysis/candidates.js";
import { indexDdl, indexName } from "../src/analysis/ddl.js";
import type { IndexCandidate, StatementStats } from "../src/types.js";

const stmt = (query: string): StatementStats => ({
  queryid: "qv",
  query,
  calls: 42,
  totalExecTime: 9_000,
  meanExecTime: 214,
  rows: 5,
  hitRatio: 99,
});

describe("vectorDistanceColumns", () => {
  it("detects all three pgvector operators", () => {
    expect(vectorDistanceColumns("SELECT * FROM docs ORDER BY embedding <=> $1")).toEqual(["embedding"]);
    expect(vectorDistanceColumns("SELECT * FROM t WHERE a <-> point ORDER BY id")).toEqual(["a"]);
    expect(vectorDistanceColumns("SELECT embedding <#> $1 FROM t")).toEqual(["embedding"]);
  });
});

describe("expressionPredicateColumns", () => {
  it("extracts LOWER/UPPER/DATE and ::cast expressions with DDL text", () => {
    const p = expressionPredicateColumns("SELECT * FROM users WHERE LOWER(email) = $1");
    expect(p).toEqual([{ column: "email", kind: "equality", expression: 'LOWER("email")' }]);
    const p2 = expressionPredicateColumns("SELECT * FROM events WHERE DATE(created_at) = '2026-01-01'");
    expect(p2[0]!.expression).toBe('DATE("created_at")');
    const p3 = expressionPredicateColumns("SELECT * FROM logs WHERE day::date = $1");
    expect(p3[0]!.expression).toBe('("day")::date');
  });
});

describe("hnsw candidates", () => {
  it("are generated with the operator-matched opclass", () => {
    const cands = makeCandidates(stmt("SELECT id FROM docs ORDER BY embedding <=> $1 LIMIT 10"));
    const hnsw = cands.find((c) => c.method === "hnsw");
    expect(hnsw).toBeDefined();
    expect(hnsw!.columns).toEqual(["embedding"]);
    expect(hnsw!.opclass).toBe("vector_cosine_ops");
  });

  it("map <-> to vector_l2_ops and <#> to vector_ip_ops", () => {
    expect(makeCandidates(stmt("SELECT * FROM t ORDER BY v <-> $1")).find((c) => c.method === "hnsw")!.opclass).toBe("vector_l2_ops");
    expect(makeCandidates(stmt("SELECT * FROM t ORDER BY v <#> $1")).find((c) => c.method === "hnsw")!.opclass).toBe("vector_ip_ops");
  });

  it("produce correct HNSW DDL with parameters", () => {
    const c: IndexCandidate = {
      table: "docs", columns: ["embedding"], method: "hnsw", opclass: "vector_cosine_ops",
      isUnique: false, fromQueryid: "q", reason: "test",
    };
    expect(indexDdl(c, { concurrently: false })).toBe(
      'CREATE INDEX IF NOT EXISTS idx_docs_embedding_hnsw ON "docs" USING hnsw ("embedding" vector_cosine_ops) WITH (m = 16, ef_construction = 64);',
    );
  });
});

describe("expression candidates", () => {
  it("carry the expression and render functional DDL", () => {
    const cands = makeCandidates(stmt("SELECT * FROM users WHERE LOWER(email) = $1 AND tenant_id = 2"));
    const expr = cands.find((c) => c.expression);
    expect(expr).toBeDefined();
    expect(expr!.columns).toEqual(["email"]);
    expect(indexDdl(expr!, { concurrently: true })).toContain('(LOWER("email"))');
    expect(indexName(expr!)).toContain("_expr");
  });
});
