import { describe, expect, it } from "vitest";
import { extractShape, isSupportedStatement, makeCandidates } from "../src/analysis/candidates.js";
import type { StatementStats } from "../src/types.js";

const stmt = (query: string): StatementStats => ({
  queryid: "q1",
  query,
  calls: 100,
  totalExecTime: 50_000,
  meanExecTime: 500,
  rows: 10,
  hitRatio: 99,
});

describe("extractShape", () => {
  it("extracts equality and range predicates", () => {
    const shape = extractShape("SELECT * FROM orders WHERE status = 'paid' AND created_at > NOW() - INTERVAL '7 days'");
    expect(shape.tables).toContain("orders");
    const eq = shape.predicates.find((p) => p.column === "status");
    expect(eq?.kind).toBe("equality");
  });

  it("extracts ORDER BY columns", () => {
    const shape = extractShape("SELECT * FROM orders WHERE user_id = 1 ORDER BY created_at DESC");
    expect(shape.orderBy).toEqual(["created_at"]);
  });

  it("extracts GROUP BY columns", () => {
    const shape = extractShape("SELECT user_id, COUNT(*) FROM orders GROUP BY user_id");
    expect(shape.groupBy).toEqual(["user_id"]);
  });

  it("strips schema qualification", () => {
    const shape = extractShape("SELECT * FROM public.orders o WHERE o.user_id = 1");
    expect(shape.tables).toContain("orders");
  });
});

describe("subqueries and CTEs (v0.4 scope expansion)", () => {
  it("supports IN (SELECT ...) subqueries", () => {
    expect(isSupportedStatement("SELECT * FROM orders WHERE user_id IN (SELECT id FROM users WHERE region = 'eu')")).toBe(true);
    const shape = extractShape("SELECT * FROM orders WHERE user_id IN (SELECT id FROM users WHERE region = 'eu')");
    expect(shape.tables).toContain("orders");
    expect(shape.tables).toContain("users");
    expect(shape.predicates.map((p) => p.column)).toContain("region");
  });

  it("supports correlated scalar subqueries", () => {
    const shape = extractShape(
      "SELECT * FROM orders o WHERE o.total > (SELECT AVG(total) FROM orders o2 WHERE o2.user_id = o.user_id)",
    );
    expect(shape.tables).toContain("orders");
    expect(shape.predicates.map((p) => p.column)).toContain("user_id");
  });

  it("supports CTEs and excludes their names from table candidates", () => {
    const sql = "WITH active AS (SELECT * FROM orders WHERE status = 'active') SELECT * FROM active WHERE user_id = 42";
    expect(isSupportedStatement(sql)).toBe(true);
    const shape = extractShape(sql);
    expect(shape.tables).toContain("orders");
    expect(shape.tables).not.toContain("active");
    expect(shape.predicates.map((p) => p.column)).toContain("status");
  });

  it("forwards outer ORDER BY to CTE bodies", () => {
    const shape = extractShape(
      "WITH recent AS (SELECT * FROM orders WHERE status = 'paid') SELECT * FROM recent ORDER BY created_at DESC",
    );
    expect(shape.orderBy).toEqual(["created_at", "created_at"]);
  });

  it("supports WITH + subquery combined", () => {
    const sql =
      "WITH eu AS (SELECT id FROM users WHERE region = 'eu') SELECT * FROM orders WHERE user_id IN (SELECT id FROM eu)";
    const shape = extractShape(sql);
    expect(shape.tables).toContain("orders");
    expect(shape.tables).toContain("users");
    expect(shape.tables).not.toContain("eu");
  });

  it("still rejects data-modifying statements including writable CTEs", () => {
    expect(isSupportedStatement("UPDATE t SET a = 1 WHERE b = 2")).toBe(false);
    expect(isSupportedStatement("DELETE FROM t WHERE b = 2")).toBe(false);
    expect(isSupportedStatement("WITH moved AS (DELETE FROM t RETURNING *) INSERT INTO t2 SELECT * FROM moved")).toBe(false);
  });

  it("treats FOR UPDATE as a read", () => {
    expect(isSupportedStatement("SELECT * FROM orders WHERE id = 1 FOR UPDATE")).toBe(true);
  });

  it("builds candidates from subquery predicates on the inner table", () => {
    const cands = makeCandidates(
      stmt("SELECT * FROM orders WHERE user_id IN (SELECT id FROM users WHERE region = 'eu')"),
    );
    const users = cands.find((c) => c.table === "users");
    expect(users).toBeDefined();
    expect(users!.columns).toContain("region");
  });
});

describe("makeCandidates", () => {
  it("builds a candidate with equality-first column order", () => {
    const cands = makeCandidates(stmt("SELECT * FROM orders WHERE tenant_id = 1 AND status = 'paid' ORDER BY created_at"));
    expect(cands.length).toBeGreaterThan(0);
    const c = cands[0]!;
    expect(c.table).toBe("orders");
    expect(c.columns[0]).toBe("tenant_id");
    expect(c.columns).toContain("status");
    expect(c.method).toBe("btree");
  });

  it("skips forbidden tables", () => {
    const cands = makeCandidates(stmt("SELECT * FROM pg_stat_activity"));
    expect(cands).toHaveLength(0);
  });

  it("returns nothing when no predicates exist", () => {
    const cands = makeCandidates(stmt("SELECT * FROM orders"));
    expect(cands).toHaveLength(0);
  });

  it("proposes gin for jsonb/array containment", () => {
    const cands = makeCandidates(stmt(`SELECT * FROM events WHERE payload @> '{"a":1}'`));
    const gin = cands.find((c) => c.method === "gin");
    expect(gin).toBeDefined();
    expect(gin!.columns).toEqual(["payload"]);
    expect(gin!.table).toBe("events");
  });

  it("keeps btree primary for plain equality", () => {
    const cands = makeCandidates(stmt("SELECT * FROM orders WHERE user_id = 1"));
    expect(cands[0]!.method).toBe("btree");
  });
});
