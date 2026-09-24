import { describe, expect, it } from "vitest";
import { indexDdl, indexName } from "../src/analysis/ddl.js";
import { buildMigration } from "../src/pr/migrations.js";
import type { IndexCandidate } from "../src/types.js";

const cand: IndexCandidate = {
  table: "orders",
  columns: ["user_id", "created_at"],
  method: "btree",
  isUnique: false,
  fromQueryid: "123",
  reason: "top statement",
};

describe("indexDdl", () => {
  it("generates concurrent index creation by default flag control", () => {
    expect(indexDdl(cand, { concurrently: true })).toBe(
      'CREATE CONCURRENTLY INDEX IF NOT EXISTS idx_orders_user_id_created_at ON "orders" ("user_id", "created_at");',
    );
    expect(indexDdl(cand, { concurrently: false })).not.toContain("CONCURRENTLY");
  });

  it("generates gin ddl without opclass and with _gin suffix", () => {
    const gin: IndexCandidate = { ...cand, columns: ["payload"], method: "gin" };
    expect(indexDdl(gin, { concurrently: true })).toBe(
      'CREATE CONCURRENTLY INDEX IF NOT EXISTS idx_orders_payload_gin ON "orders" USING gin ("payload");',
    );
  });

  it("generates brin ddl for append-only range columns", () => {
    const brin: IndexCandidate = { ...cand, columns: ["created_at"], method: "brin" };
    expect(indexDdl(brin, { concurrently: false })).toBe(
      'CREATE INDEX IF NOT EXISTS idx_orders_created_at_brin ON "orders" USING brin ("created_at");',
    );
  });

  it("supports operator classes (text_pattern_ops) for prefix LIKE", () => {
    const like: IndexCandidate = { ...cand, columns: ["email"], opclass: "text_pattern_ops" };
    expect(indexDdl(like, { concurrently: false })).toContain('("email" text_pattern_ops)');
  });

  it("truncates names to PG identifier limit", () => {
    const c: IndexCandidate = { ...cand, columns: Array.from({ length: 10 }, (_, i) => `very_long_column_name_${i}`) };
    expect(indexName(c).length).toBeLessThanOrEqual(63);
  });
});

describe("buildMigration", () => {
  it("sql dialect writes to migrations/", () => {
    const m = buildMigration(cand, "sql");
    expect(m.path).toMatch(/^migrations\/\d{8,14}_idx_orders_user_id_created_at\.sql$/);
    expect(m.content).toContain("CREATE CONCURRENTLY INDEX");
  });

  it("prisma dialect includes CONCURRENTLY workaround instructions", () => {
    const m = buildMigration(cand, "prisma");
    expect(m.path).toContain("prisma/migrations/");
    expect(m.content).toContain("prisma migrate resolve --applied");
  });

  it("django dialect uses AddIndexConcurrently with atomic=False", () => {
    const m = buildMigration(cand, "django");
    expect(m.content).toContain("AddIndexConcurrently");
    expect(m.content).toContain("atomic = False");
  });

  it("rails dialect disables ddl transactions", () => {
    const m = buildMigration(cand, "rails");
    expect(m.content).toContain("disable_ddl_transaction!");
    expect(m.content).toContain("algorithm: :concurrently");
  });
});
