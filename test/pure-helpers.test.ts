/**
 * Unit tests for the pure helpers behind candidate generation.
 *
 * These functions take SQL text or predicate arrays and return derived
 * index-shape information without touching a database, so they can be
 * unit-tested directly (the DB-backed paths live in the integration suite).
 */
import { describe, expect, it } from "vitest";

import {
  brinEligibleColumns,
  containmentColumns,
  expressionPredicateColumns,
  isSupportedStatement,
  likePrefixColumns,
  vectorDistanceColumns,
} from "../src/analysis/candidates.js";
import { dummyValueForType } from "../src/analysis/simulate.js";
import type { Predicate } from "../src/types.js";

describe("dummyValueForType", () => {
  it("emits a literal for numeric types", () => {
    expect(dummyValueForType("integer")).toBe("1");
    expect(dummyValueForType("bigint")).toBe("1");
    expect(dummyValueForType("smallint")).toBe("1");
    expect(dummyValueForType("numeric")).toBe("1");
    expect(dummyValueForType("real")).toBe("1");
    expect(dummyValueForType("money")).toBe("1");
  });

  it("emits a quoted literal for text types", () => {
    expect(dummyValueForType("text")).toBe("'pgheal'");
    expect(dummyValueForType("character varying")).toBe("'pgheal'");
    expect(dummyValueForType("varchar")).toBe("'pgheal'");
    expect(dummyValueForType("citext")).toBe("'pgheal'");
  });

  it("emits a typed uuid", () => {
    expect(dummyValueForType("uuid")).toBe("'00000000-0000-0000-0000-000000000000'::uuid");
  });

  it("emits booleans", () => {
    expect(dummyValueForType("boolean")).toBe("true");
    expect(dummyValueForType("bool")).toBe("true");
  });

  it("emits now() for timestamps and dates", () => {
    expect(dummyValueForType("timestamp with time zone")).toBe("now()");
    expect(dummyValueForType("timestamptz")).toBe("now()");
    expect(dummyValueForType("date")).toBe("now()");
  });

  it("emits typed empty literals for json/jsonb/bytea", () => {
    expect(dummyValueForType("json")).toBe("'{}'::json");
    expect(dummyValueForType("jsonb")).toBe("'{}'::jsonb");
    expect(dummyValueForType("bytea")).toBe("''::bytea");
  });

  it("emits an empty typed array for array types", () => {
    expect(dummyValueForType("integer[]")).toBe("ARRAY[]::integer[]");
    expect(dummyValueForType("text[]")).toBe("ARRAY[]::text[]");
  });

  it("falls back to NULL for unknown types", () => {
    expect(dummyValueForType("somethingweird")).toBe("NULL::somethingweird");
  });
});

describe("isSupportedStatement", () => {
  it("accepts plain SELECTs", () => {
    expect(isSupportedStatement("SELECT * FROM t WHERE a = 1")).toBe(true);
  });

  it("accepts SELECT ... FOR UPDATE as a read", () => {
    expect(isSupportedStatement("SELECT * FROM t WHERE a = 1 FOR UPDATE")).toBe(true);
  });

  it("rejects writes", () => {
    expect(isSupportedStatement("INSERT INTO t VALUES (1)")).toBe(false);
    expect(isSupportedStatement("UPDATE t SET a = 1")).toBe(false);
    expect(isSupportedStatement("DELETE FROM t")).toBe(false);
    expect(isSupportedStatement("MERGE INTO t USING s ON 1=1 WHEN MATCHED THEN NOTHING")).toBe(false);
  });

  it("rejects non-SQL text", () => {
    expect(isSupportedStatement("")).toBe(false);
    expect(isSupportedStatement("garbage")).toBe(false);
  });
});

describe("likePrefixColumns", () => {
  it("collects range-predicate columns, deduped and ordered", () => {
    const preds: Predicate[] = [
      { column: "created_at", kind: "range" },
      { column: "status", kind: "equality" },
      { column: "created_at", kind: "range" },
    ];
    expect(likePrefixColumns(preds)).toEqual(["created_at"]);
  });

  it("returns an empty array when there are no range predicates", () => {
    expect(likePrefixColumns([{ column: "a", kind: "equality" }])).toEqual([]);
    expect(likePrefixColumns([])).toEqual([]);
  });
});

describe("containmentColumns", () => {
  it("extracts jsonb/array containment columns", () => {
    expect(containmentColumns("tags @> ARRAY['x']")).toEqual(["tags"]);
    expect(containmentColumns("meta ? 'key'")).toEqual(["meta"]);
  });

  it("strips table qualifiers to the bare column", () => {
    expect(containmentColumns("t.meta @> 'x'")).toEqual(["meta"]);
  });

  it("deduplicates", () => {
    expect(containmentColumns("a @> 1 AND a @> 2")).toEqual(["a"]);
  });

  it("returns an empty array when there is no containment operator", () => {
    expect(containmentColumns("a = 1")).toEqual([]);
    expect(containmentColumns("")).toEqual([]);
  });
});

describe("vectorDistanceColumns", () => {
  it("extracts pgvector L2 / cosine distance columns", () => {
    expect(vectorDistanceColumns("emb <-> '[1,2]'")).toEqual(["emb"]);
    expect(vectorDistanceColumns("emb <=> '[1,2]'")).toEqual(["emb"]);
  });

  it("strips table qualifiers", () => {
    expect(vectorDistanceColumns("items.emb <-> '[1]'")).toEqual(["emb"]);
  });

  it("deduplicates", () => {
    expect(vectorDistanceColumns("a <-> 1 AND a <-> 2")).toEqual(["a"]);
  });

  it("returns an empty array without distance operators", () => {
    expect(vectorDistanceColumns("a = 1")).toEqual([]);
    expect(vectorDistanceColumns("")).toEqual([]);
  });
});

describe("expressionPredicateColumns", () => {
  it("wraps LOWER/UPPER calls in an expression index shape", () => {
    const out = expressionPredicateColumns("LOWER(email) = 'x'");
    expect(out).toHaveLength(1);
    expect(out[0]!.column).toBe("email");
    expect(out[0]!.expression).toContain("LOWER");
  });

  it("wraps DATE casts", () => {
    const out = expressionPredicateColumns("DATE(created_at) = '2026-01-01'");
    expect(out[0]!.column).toBe("created_at");
    expect(out[0]!.expression).toContain("DATE");
  });

  it("handles col::date casts", () => {
    const out = expressionPredicateColumns("created_at::date = '2026-01-01'");
    expect(out[0]!.column).toBe("created_at");
  });

  it("strips schema qualifiers to the last segment", () => {
    const out = expressionPredicateColumns("LOWER(s.email) = 'x'");
    expect(out[0]!.column).toBe("email");
  });

  it("returns an empty array without functional predicates", () => {
    expect(expressionPredicateColumns("email = 'x'")).toEqual([]);
    expect(expressionPredicateColumns("")).toEqual([]);
  });
});

describe("brinEligibleColumns", () => {
  it("keeps range columns whose name suggests time-series storage", () => {
    const preds: Predicate[] = [
      { column: "created_at", kind: "range" },
      { column: "name", kind: "range" },
    ];
    const out = brinEligibleColumns(preds);
    expect(out).toContain("created_at");
    expect(out).not.toContain("name");
  });

  it("returns an empty array without range predicates", () => {
    expect(brinEligibleColumns([{ column: "created_at", kind: "equality" }])).toEqual([]);
    expect(brinEligibleColumns([])).toEqual([]);
  });
});
