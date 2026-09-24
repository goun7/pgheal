import { describe, expect, it } from "vitest";
import { fingerprint, normalizeSql } from "../src/analysis/normalize.js";

describe("normalizeSql", () => {
  it("collapses whitespace", () => {
    expect(normalizeSql("SELECT\n  *\tFROM   orders")).toBe("SELECT * FROM orders");
  });

  it("replaces string literals", () => {
    expect(normalizeSql("SELECT * FROM users WHERE email = 'a@b.com'")).toBe(
      "SELECT * FROM users WHERE email = ?",
    );
  });

  it("replaces numeric literals", () => {
    expect(normalizeSql("SELECT * FROM orders WHERE total > 42.5")).toBe(
      "SELECT * FROM orders WHERE total > ?",
    );
  });

  it("strips line and block comments", () => {
    expect(normalizeSql("SELECT 1 -- trailing\n /* block */ FROM t")).toBe("SELECT ? FROM t");
  });

  it("handles escaped quotes in strings", () => {
    expect(normalizeSql("SELECT * FROM t WHERE name = 'O''Brien'")).toBe("SELECT * FROM t WHERE name = ?");
  });
});

describe("fingerprint", () => {
  it("is stable across formatting differences", () => {
    const a = fingerprint("SELECT * FROM orders WHERE user_id = 7");
    const b = fingerprint("SELECT *  FROM orders\n  WHERE user_id = 99");
    expect(a).toBe(b);
  });

  it("differs for different queries", () => {
    const a = fingerprint("SELECT * FROM orders WHERE user_id = 7");
    const b = fingerprint("SELECT * FROM invoices WHERE user_id = 7");
    expect(a).not.toBe(b);
  });

  it("produces branch-safe short ids", () => {
    const fp = fingerprint("SELECT 1");
    expect(fp).toMatch(/^[0-9a-z]{1,10}$/);
  });
});
