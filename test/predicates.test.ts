/**
 * Edge-case coverage for the pure candidate helpers.
 *
 * The base behaviour of these functions is already covered by
 * test/pure-helpers.test.ts; this file only targets the branches that one
 * misses (extra operators, cast variants, unsupported functions) plus the
 * FORBIDDEN_TABLES export, which had no coverage at all.
 */
import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_TABLES,
  containmentColumns,
  expressionPredicateColumns,
  vectorDistanceColumns,
} from "../src/analysis/candidates.js";

describe("containmentColumns — array-key operators", () => {
  it("detects the any-element ?| operator", () => {
    expect(containmentColumns("tags ?| array['red', 'blue']")).toEqual(["tags"]);
  });

  it("detects the all-elements ?& operator", () => {
    expect(containmentColumns("tags ?& array['red']")).toEqual(["tags"]);
  });
});

describe("vectorDistanceColumns — inner product operator", () => {
  it("detects the <#> inner product operator", () => {
    expect(vectorDistanceColumns("embedding <#> $1")).toEqual(["embedding"]);
  });

  it("detects distance columns inside an ORDER BY clause", () => {
    expect(vectorDistanceColumns("ORDER BY embedding <=> $1 LIMIT 10")).toEqual(["embedding"]);
  });
});

describe("expressionPredicateColumns — cast and case variants", () => {
  it("wraps ::text casts", () => {
    expect(expressionPredicateColumns("name::text = ?")).toEqual([
      { column: "name", kind: "equality", expression: '("name")::text' },
    ]);
  });

  it("normalizes a lowercase upper() call to UPPER in the expression", () => {
    expect(expressionPredicateColumns("upper(email) = ?")).toEqual([
      { column: "email", kind: "equality", expression: 'UPPER("email")' },
    ]);
  });

  it("collects several functional predicates from a single clause", () => {
    const out = expressionPredicateColumns("LOWER(a) = 1 AND DATE(b) = 2");
    expect(out.map((p) => p.column)).toEqual(["a", "b"]);
    expect(out.map((p) => p.expression)).toEqual(['LOWER("a")', 'DATE("b")']);
  });

  it("ignores unsupported functions such as COALESCE", () => {
    expect(expressionPredicateColumns("COALESCE(x, 1) = 2")).toEqual([]);
  });
});

describe("FORBIDDEN_TABLES", () => {
  it("matches catalog and internal schemas", () => {
    expect(FORBIDDEN_TABLES.test("pg_catalog.pg_stat_activity")).toBe(true);
    expect(FORBIDDEN_TABLES.test("information_schema.tables")).toBe(true);
    expect(FORBIDDEN_TABLES.test("pg_stat_user_indexes")).toBe(true);
    expect(FORBIDDEN_TABLES.test("pgheal_result")).toBe(true);
  });

  it("does not match user tables", () => {
    expect(FORBIDDEN_TABLES.test("orders")).toBe(false);
    expect(FORBIDDEN_TABLES.test("public.orders")).toBe(false);
  });
});
