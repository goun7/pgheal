/**
 * Unit tests for the internal parsing helpers of candidate generation.
 *
 * These functions were previously exercised only indirectly through
 * extractShape/makeCandidates. They are the actual SQL-shape primitives
 * (whitespace, region scanning, CTE detection, predicate classification),
 * so they get direct behaviour tests here: normal cases, edge cases and
 * malformed input.
 */
import { describe, expect, it } from "vitest";

import {
  brinEligibleColumns,
  classifyPredicate,
  columnsOfPredicate,
  columnName,
  containmentColumns,
  cteNames,
  extractShape,
  isSupportedStatement,
  keywordRegions,
  likePrefixColumns,
  makeCandidates,
  regionUntil,
  splitTopLevel,
  stripAlias,
  stripWhitespace,
  vectorDistanceColumns,
} from "../src/analysis/candidates.js";
import type { StatementStats } from "../src/types.js";

const stmt = (query: string): StatementStats => ({
  queryid: "q-internals",
  query,
  calls: 10,
  totalExecTime: 1_000,
  meanExecTime: 100,
  rows: 1,
  hitRatio: 90,
});

describe("stripWhitespace", () => {
  it("collapses runs of whitespace into a single space", () => {
    expect(stripWhitespace("a    b")).toBe("a b");
    expect(stripWhitespace("a\t\tb")).toBe("a b");
    expect(stripWhitespace("a\n\nb")).toBe("a b");
    expect(stripWhitespace("a \t\n b")).toBe("a b");
  });

  it("trims leading and trailing whitespace", () => {
    expect(stripWhitespace("   hello   ")).toBe("hello");
    expect(stripWhitespace("\t\n  x  \n")).toBe("x");
  });

  it("returns the identical string when there is no whitespace to fix", () => {
    expect(stripWhitespace("abc")).toBe("abc");
    expect(stripWhitespace("")).toBe("");
  });

  it("handles whitespace-only input", () => {
    expect(stripWhitespace("     ")).toBe("");
    expect(stripWhitespace("\n")).toBe("");
  });

  it("preserves inner single spaces", () => {
    expect(stripWhitespace("SELECT * FROM t")).toBe("SELECT * FROM t");
  });
});

describe("regionUntil", () => {
  it("reads until the end when no terminator follows", () => {
    const norm = "a = 1";
    expect(regionUntil(norm, 0)).toBe("a = 1");
  });

  it("stops at a closing paren that closes an outer group (depth 0)", () => {
    const norm = "a = 1) or b = 2";
    // region starts at 0; the ) at depth 0 terminates it
    expect(regionUntil(norm, 0)).toBe("a = 1");
  });

  it("does not stop at parens that belong to a nested group", () => {
    const norm = "x in (1, 2) and y = 3";
    // start inside the paren group: nested ( ) must be walked through
    const open = norm.indexOf("(");
    expect(regionUntil(norm, open)).toBe("(1, 2) and y = 3");
  });

  it("stops at a clause keyword at depth 0", () => {
    const norm = "from orders where a = 1";
    const fromEnd = "from ".length;
    expect(regionUntil(norm, fromEnd)).toBe("orders ");
  });

  it("does not stop at clause keywords nested inside parens", () => {
    const norm = "from (select 1 from t) x";
    const fromEnd = "from ".length;
    // the inner `from` sits at depth 1, so the region runs to the alias
    expect(regionUntil(norm, fromEnd)).toBe("(select 1 from t) x");
  });

  it("treats keywords case-insensitively", () => {
    const norm = "from orders WHERE a = 1";
    expect(regionUntil(norm, "from ".length)).toBe("orders ");
  });

  it("returns an empty region when start is at the end of the string", () => {
    const norm = "select 1";
    expect(regionUntil(norm, norm.length)).toBe("");
  });
});

describe("keywordRegions", () => {
  it("collects the region following every keyword occurrence", () => {
    const norm = "from a where x = 1 and y in (select 1 from b)";
    const regions = keywordRegions(norm, /\bfrom\b/);
    // outer FROM region stops at the WHERE clause terminator
    expect(regions).toContain(" a ");
    // nested FROM (inside the subquery) is still found as its own region
    expect(regions).toContain(" b");
  });

  it("matches keywords case-insensitively regardless of the passed flags", () => {
    const norm = "FROM a WHERE x = 1";
    // region starts one char past the keyword, so it keeps its leading space
    expect(keywordRegions(norm, /\bfrom\b/)).toEqual([" a "]);
  });

  it("returns an empty array when the keyword is absent", () => {
    expect(keywordRegions("select 1", /\bfrom\b/)).toEqual([]);
    expect(keywordRegions("", /\bfrom\b/)).toEqual([]);
  });

  it("respects paren depth: nested keywords are not treated as clause ends", () => {
    const norm = "from (select 1 from b) x";
    const regions = keywordRegions(norm, /\bfrom\b/);
    // outer FROM region must NOT stop at the inner FROM (depth 1)
    expect(regions).toContain(" (select 1 from b) x");
  });
});

describe("cteNames", () => {
  it("collects `name AS (` CTE names lowercased", () => {
    expect(cteNames("with Active as (select 1) select * from active")).toEqual(new Set(["active"]));
  });

  it("collects `name (cols) AS (` form", () => {
    expect(cteNames("with eu (id) as (select 1) select * from eu")).toEqual(new Set(["eu"]));
  });

  it("collects multiple CTEs", () => {
    const sql = "with a as (select 1), b as (select 2) select * from a join b on 1=1";
    expect(cteNames(sql)).toEqual(new Set(["a", "b"]));
  });

  it("returns an empty set when there are no CTEs", () => {
    expect(cteNames("select * from orders")).toEqual(new Set());
    expect(cteNames("")).toEqual(new Set());
  });

  it("does not treat a plain table alias as a CTE", () => {
    // `select 1 as x` has no `AS (` so nothing is collected
    expect(cteNames("select 1 as x")).toEqual(new Set());
  });
});

describe("stripAlias", () => {
  it("strips schema qualification, keeping the last segment", () => {
    expect(stripAlias("public.orders")).toBe("orders");
    expect(stripAlias("api.public.orders")).toBe("orders");
  });

  it("returns an unqualified name unchanged", () => {
    expect(stripAlias("orders")).toBe("orders");
  });

  it("removes double quotes", () => {
    expect(stripAlias('"orders"')).toBe("orders");
    expect(stripAlias('public."orders"')).toBe("orders");
  });
});

describe("classifyPredicate", () => {
  it("classifies a plain equality as equality", () => {
    expect(classifyPredicate("status = ?")).toBe("equality");
    expect(classifyPredicate("o.user_id = ?")).toBe("equality");
  });

  it("classifies comparison operators as range", () => {
    expect(classifyPredicate("created_at > ?")).toBe("range");
    expect(classifyPredicate("created_at >= ?")).toBe("range");
    expect(classifyPredicate("created_at < ?")).toBe("range");
    expect(classifyPredicate("created_at <= ?")).toBe("range");
    expect(classifyPredicate("a <> ?")).toBe("range");
    expect(classifyPredicate("a != ?")).toBe("range");
  });

  it("classifies LIKE/ILIKE as range", () => {
    expect(classifyPredicate("name like ?")).toBe("range");
    expect(classifyPredicate("name ilike ?")).toBe("range");
  });

  it("classifies BETWEEN and IN (...) as range", () => {
    expect(classifyPredicate("created_at between ? and ?")).toBe("range");
    expect(classifyPredicate("id in (1, 2, 3)")).toBe("range");
  });

  it("returns null for IS NULL / IS NOT NULL", () => {
    expect(classifyPredicate("deleted_at is null")).toBe(null);
    expect(classifyPredicate("deleted_at is not null")).toBe(null);
  });

  it("returns null for fragments it cannot classify", () => {
    expect(classifyPredicate("a and b")).toBe(null);
    expect(classifyPredicate("count(*)")).toBe(null);
    expect(classifyPredicate("")).toBe(null);
  });
});

describe("columnsOfPredicate", () => {
  it("extracts the left-hand column of an operator predicate", () => {
    expect(columnsOfPredicate("user_id = ?")).toEqual(["user_id"]);
    expect(columnsOfPredicate("created_at > ?")).toEqual(["created_at"]);
    expect(columnsOfPredicate("name like ?")).toEqual(["name"]);
  });

  it("strips table qualifiers from the left-hand column", () => {
    expect(columnsOfPredicate("o.user_id = ?")).toEqual(["user_id"]);
  });

  it("captures the right-hand column of a join-style equality", () => {
    expect(columnsOfPredicate("o.user_id = u.id")).toEqual(["user_id", "id"]);
  });

  it("skinks function-call left sides (function names are not columns)", () => {
    expect(columnsOfPredicate("LOWER(email) = ?")).toEqual([]);
    expect(columnsOfPredicate("COALESCE(x, 0) = ?")).toEqual([]);
  });

  it("deduplicates identical columns", () => {
    expect(columnsOfPredicate("a = a")).toEqual(["a"]);
  });

  it("returns an empty array for fragments without columns", () => {
    expect(columnsOfPredicate("? = ?")).toEqual([]);
    expect(columnsOfPredicate("")).toEqual([]);
  });
});

describe("columnName", () => {
  it("strips ASC/DESC modifiers", () => {
    expect(columnName("created_at desc")).toBe("created_at");
    expect(columnName("created_at asc")).toBe("created_at");
  });

  it("strips table qualifiers", () => {
    expect(columnName("o.created_at")).toBe("created_at");
  });

  it("removes double quotes", () => {
    expect(columnName('"created_at"')).toBe("created_at");
  });

  it("handles a qualified quoted column with direction", () => {
    expect(columnName('o."created_at" desc')).toBe("created_at");
  });

  it("returns a plain column name unchanged", () => {
    expect(columnName("created_at")).toBe("created_at");
  });
});

describe("splitTopLevel", () => {
  it("splits top-level AND conjuncts", () => {
    expect(splitTopLevel("a = 1 and b = 2 and c = 3")).toEqual(["a = 1", "b = 2", "c = 3"]);
  });

  it("does not split AND nested inside parens", () => {
    expect(splitTopLevel("a = 1 and (b = 2 and c = 3)")).toEqual(["a = 1", "(b = 2 and c = 3)"]);
  });

  it("matches AND case-insensitively", () => {
    expect(splitTopLevel("a = 1 AND b = 2")).toEqual(["a = 1", "b = 2"]);
  });

  it("returns a single element when there is no AND", () => {
    expect(splitTopLevel("a = 1")).toEqual(["a = 1"]);
  });

  it("drops empty fragments", () => {
    expect(splitTopLevel("")).toEqual([]);
    expect(splitTopLevel("   ")).toEqual([]);
  });

  it("keeps parenthesised groups attached to their conjunct", () => {
    expect(splitTopLevel("(a = 1 or b = 2) and c = 3")).toEqual(["(a = 1 or b = 2)", "c = 3"]);
  });
});

describe("likePrefixColumns", () => {
  it("collects range-predicate columns deduped, in first-seen order", () => {
    const out = likePrefixColumns([
      { column: "name", kind: "range" },
      { column: "status", kind: "equality" },
      { column: "name", kind: "range" },
    ]);
    expect(out).toEqual(["name"]);
  });

  it("returns an empty array with no range predicates", () => {
    expect(likePrefixColumns([{ column: "a", kind: "equality" }])).toEqual([]);
    expect(likePrefixColumns([])).toEqual([]);
  });

  it("keeps distinct range columns", () => {
    const out = likePrefixColumns([
      { column: "name", kind: "range" },
      { column: "city", kind: "range" },
    ]);
    expect(out).toEqual(["name", "city"]);
  });
});

describe("containmentColumns", () => {
  it("extracts columns for @>, ?, ?|, ?& operators", () => {
    expect(containmentColumns("tags @> ARRAY['x']")).toEqual(["tags"]);
    expect(containmentColumns("meta ? 'k'")).toEqual(["meta"]);
    expect(containmentColumns("arr ?| array['a']")).toEqual(["arr"]);
    expect(containmentColumns("arr ?& array['a']")).toEqual(["arr"]);
  });

  it("strips table qualifiers", () => {
    expect(containmentColumns("t.meta @> 'x'")).toEqual(["meta"]);
  });

  it("deduplicates", () => {
    expect(containmentColumns("a @> 1 and a @> 2")).toEqual(["a"]);
  });

  it("returns an empty array without containment operators", () => {
    expect(containmentColumns("a = 1")).toEqual([]);
    expect(containmentColumns("")).toEqual([]);
  });
});

describe("vectorDistanceColumns", () => {
  it("extracts columns for <->, <=>, <#> operators", () => {
    expect(vectorDistanceColumns("emb <-> '[1]'")).toEqual(["emb"]);
    expect(vectorDistanceColumns("emb <=> '[1]'")).toEqual(["emb"]);
    expect(vectorDistanceColumns("emb <#> '[1]'")).toEqual(["emb"]);
  });

  it("strips table qualifiers", () => {
    expect(vectorDistanceColumns("items.emb <-> '[1]'")).toEqual(["emb"]);
  });

  it("deduplicates", () => {
    expect(vectorDistanceColumns("a <-> 1 and a <-> 2")).toEqual(["a"]);
  });

  it("returns an empty array without distance operators", () => {
    expect(vectorDistanceColumns("a = 1")).toEqual([]);
    expect(vectorDistanceColumns("")).toEqual([]);
  });
});

describe("brinEligibleColumns", () => {
  it("keeps range columns whose name suggests time-series storage", () => {
    const out = brinEligibleColumns([
      { column: "created_at", kind: "range" },
      { column: "order_date", kind: "range" },
      { column: "deleted_at", kind: "range" },
    ]);
    expect(out).toContain("created_at");
    expect(out).toContain("order_date");
    expect(out).toContain("deleted_at");
  });

  it("filters out non-time-series range columns", () => {
    const out = brinEligibleColumns([
      { column: "name", kind: "range" },
      { column: "total", kind: "range" },
    ]);
    expect(out).toEqual([]);
  });

  it("ignores equality predicates even on time-series names", () => {
    expect(brinEligibleColumns([{ column: "created_at", kind: "equality" }])).toEqual([]);
    expect(brinEligibleColumns([])).toEqual([]);
  });

  it("deduplicates", () => {
    const out = brinEligibleColumns([
      { column: "created_at", kind: "range" },
      { column: "created_at", kind: "range" },
    ]);
    expect(out).toEqual(["created_at"]);
  });
});

describe("extractShape (extended)", () => {
  it("extracts tables from a plain FROM clause", () => {
    expect(extractShape("SELECT * FROM orders").tables).toEqual(["orders"]);
  });

  it("extracts tables joined with JOIN ... ON", () => {
    const shape = extractShape("SELECT * FROM orders o JOIN users u ON o.user_id = u.id");
    expect(shape.tables).toContain("orders");
    expect(shape.tables).toContain("users");
  });

  it("extracts predicates from join ON clauses via WHERE regions only", () => {
    const shape = extractShape("SELECT * FROM orders WHERE user_id = 42");
    const eq = shape.predicates.find((p) => p.column === "user_id");
    expect(eq?.kind).toBe("equality");
  });

  it("extracts range predicates", () => {
    const shape = extractShape("SELECT * FROM orders WHERE created_at > NOW()");
    const rng = shape.predicates.find((p) => p.column === "created_at");
    expect(rng?.kind).toBe("range");
  });

  it("extracts LIKE predicates as range", () => {
    const shape = extractShape("SELECT * FROM users WHERE name LIKE 'pg%'");
    const like = shape.predicates.find((p) => p.column === "name");
    expect(like?.kind).toBe("range");
  });

  it("extracts containment predicates from @>", () => {
    const shape = extractShape("SELECT * FROM events WHERE payload @> '{\"a\":1}'");
    expect(shape.predicates.map((p) => p.column)).toContain("payload");
    expect(shape.predicates.find((p) => p.column === "payload")?.kind).toBe("containment");
  });

  it("extracts vector-distance predicates from ORDER BY", () => {
    const shape = extractShape("SELECT * FROM items ORDER BY emb <=> '[1,2]'");
    const vec = shape.predicates.find((p) => p.column === "emb");
    expect(vec?.kind).toBe("vector-distance");
  });

  it("extracts expression predicates (LOWER/UPPER/DATE/cast)", () => {
    const shape = extractShape("SELECT * FROM users WHERE LOWER(email) = 'x'");
    const expr = shape.predicates.find((p) => p.expression);
    expect(expr?.column).toBe("email");
    expect(expr?.expression).toContain("LOWER");
  });

  it("extracts GROUP BY columns", () => {
    expect(extractShape("SELECT user_id, COUNT(*) FROM orders GROUP BY user_id").groupBy).toEqual(["user_id"]);
  });

  it("extracts ORDER BY columns, stripping direction and qualifier", () => {
    expect(extractShape("SELECT * FROM orders ORDER BY o.created_at DESC").orderBy).toEqual(["created_at"]);
  });

  it("excludes CTE names from table candidates", () => {
    const shape = extractShape(
      "WITH active AS (SELECT * FROM orders WHERE status = 'active') SELECT * FROM active WHERE user_id = 42",
    );
    expect(shape.tables).toContain("orders");
    expect(shape.tables).not.toContain("active");
  });

  it("parses nested subqueries", () => {
    const shape = extractShape(
      "SELECT * FROM orders WHERE user_id IN (SELECT id FROM users WHERE region = 'eu' AND active = true)",
    );
    expect(shape.tables).toContain("users");
    expect(shape.predicates.map((p) => p.column)).toContain("region");
    expect(shape.predicates.map((p) => p.column)).toContain("active");
  });

  it("handles a statement with no clauses gracefully", () => {
    const shape = extractShape("SELECT 1");
    expect(shape.tables).toEqual([]);
    expect(shape.predicates).toEqual([]);
    expect(shape.orderBy).toEqual([]);
    expect(shape.groupBy).toEqual([]);
  });

  it("normalizes literals before parsing", () => {
    const shape = extractShape("SELECT * FROM orders WHERE status = 'paid' AND total > 100");
    expect(shape.predicates.map((p) => p.column)).toContain("status");
    expect(shape.predicates.map((p) => p.column)).toContain("total");
  });
});

describe("isSupportedStatement (extended)", () => {
  it("accepts plain and parenthesised SELECTs", () => {
    expect(isSupportedStatement("SELECT * FROM t WHERE a = 1")).toBe(true);
    expect(isSupportedStatement("(SELECT * FROM t)")).toBe(true);
  });

  it("accepts SELECT ... FOR UPDATE / FOR SHARE as reads", () => {
    expect(isSupportedStatement("SELECT * FROM t WHERE a = 1 FOR UPDATE")).toBe(true);
    expect(isSupportedStatement("SELECT * FROM t WHERE a = 1 FOR SHARE")).toBe(true);
  });

  it("accepts CTE-backed reads", () => {
    expect(isSupportedStatement("WITH a AS (SELECT 1) SELECT * FROM a")).toBe(true);
  });

  it("rejects writes and utility statements", () => {
    expect(isSupportedStatement("INSERT INTO t VALUES (1)")).toBe(false);
    expect(isSupportedStatement("UPDATE t SET a = 1")).toBe(false);
    expect(isSupportedStatement("DELETE FROM t")).toBe(false);
    expect(isSupportedStatement("MERGE INTO t USING s ON 1=1 WHEN MATCHED THEN NOTHING")).toBe(false);
  });

  it("rejects writable CTEs", () => {
    expect(isSupportedStatement("WITH m AS (DELETE FROM t RETURNING *) INSERT INTO t2 SELECT * FROM m")).toBe(false);
  });

  it("rejects non-SQL text and empty input", () => {
    expect(isSupportedStatement("")).toBe(false);
    expect(isSupportedStatement("garbage")).toBe(false);
  });
});

describe("makeCandidates (extended)", () => {
  it("skips forbidden system tables (matched on the bare table name)", () => {
    // FORBIDDEN_TABLES is tested after schema/alias stripping, so these
    // bare names are filtered out...
    expect(makeCandidates(stmt("SELECT * FROM pg_stat_activity WHERE pid = 1"))).toHaveLength(0);
    expect(makeCandidates(stmt("SELECT * FROM pgheal WHERE id = 1"))).toHaveLength(0);
  });

  it("still proposes candidates for schema-qualified catalog relations whose bare name is allowed", () => {
    // ...while `pg_catalog.pg_class` strips to `pg_class`, which is not on the list
    const cands = makeCandidates(stmt("SELECT * FROM pg_catalog.pg_class WHERE relname = 'x'"));
    expect(cands.length).toBeGreaterThan(0);
    expect(cands.every((c) => c.table === "pg_class")).toBe(true);
  });

  it("proposes gin for containment", () => {
    const cands = makeCandidates(stmt("SELECT * FROM events WHERE payload @> '{\"a\":1}'"));
    const gin = cands.find((c) => c.method === "gin");
    expect(gin).toBeDefined();
    expect(gin!.columns).toEqual(["payload"]);
    expect(gin!.table).toBe("events");
  });

  it("proposes hnsw + ivfflat for vector distance with matching opclass", () => {
    const cands = makeCandidates(stmt("SELECT * FROM items ORDER BY emb <=> '[1,2]'"));
    const hnsw = cands.find((c) => c.method === "hnsw");
    const ivf = cands.find((c) => c.method === "ivfflat");
    expect(hnsw).toBeDefined();
    expect(ivf).toBeDefined();
    expect(hnsw!.opclass).toBe("vector_cosine_ops");
    expect(ivf!.opclass).toBe("vector_cosine_ops");
    expect(hnsw!.columns).toEqual(["emb"]);
  });

  it("maps the L2 operator to vector_l2_ops", () => {
    const cands = makeCandidates(stmt("SELECT * FROM items ORDER BY emb <-> '[1,2]'"));
    expect(cands.find((c) => c.method === "hnsw")?.opclass).toBe("vector_l2_ops");
  });

  it("maps the inner-product operator to vector_ip_ops", () => {
    const cands = makeCandidates(stmt("SELECT * FROM items ORDER BY emb <#> '[1,2]'"));
    expect(cands.find((c) => c.method === "hnsw")?.opclass).toBe("vector_ip_ops");
  });

  it("proposes an expression btree for LOWER(...) predicates", () => {
    const cands = makeCandidates(stmt("SELECT * FROM users WHERE LOWER(email) = 'x'"));
    const expr = cands.find((c) => c.expression);
    expect(expr).toBeDefined();
    expect(expr!.method).toBe("btree");
    expect(expr!.columns).toEqual(["email"]);
    expect(expr!.expression).toContain("LOWER");
  });

  it("returns nothing when no predicates or tail columns exist", () => {
    expect(makeCandidates(stmt("SELECT * FROM orders"))).toHaveLength(0);
  });

  it("keeps btree primary for plain equality with correct table", () => {
    const cands = makeCandidates(stmt("SELECT * FROM orders WHERE user_id = 1"));
    expect(cands.length).toBeGreaterThan(0);
    expect(cands[0]!.method).toBe("btree");
    expect(cands[0]!.table).toBe("orders");
    expect(cands[0]!.columns).toContain("user_id");
  });

  it("attributes qualified predicates to their own table", () => {
    const cands = makeCandidates(
      stmt("SELECT * FROM orders o JOIN users u ON o.user_id = u.id WHERE o.status = 'paid'"),
    );
    const orders = cands.find((c) => c.table === "orders");
    expect(orders).toBeDefined();
    expect(orders!.columns).toContain("status");
  });

  it("stamps candidates with queryid and a human-readable reason", () => {
    const cands = makeCandidates(stmt("SELECT * FROM orders WHERE user_id = 1"));
    expect(cands.length).toBeGreaterThan(0);
    for (const c of cands) {
      expect(c.fromQueryid).toBe("q-internals");
      expect(c.reason.length).toBeGreaterThan(0);
      expect(c.isUnique).toBe(false);
    }
  });
});
