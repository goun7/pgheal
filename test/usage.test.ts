import { describe, expect, it } from "vitest";
import { analyzeIndexHygiene, findRedundantIndexes } from "../src/analysis/usage.js";
import type { IndexDef, TableWriteStats } from "../src/types.js";

const idx = (name: string, table: string, columns: string[], scans = 0, sizeBytes = 1_000_000): IndexDef => ({
  name,
  table,
  columns,
  isUnique: false,
  isValid: true,
  scans,
  sizeBytes,
});

const writes = (table: string, n: number): TableWriteStats => ({
  table,
  inserts: n,
  updates: 0,
  deletes: 0,
  liveTuples: 1000,
  deadTuples: 0,
});

describe("findRedundantIndexes", () => {
  it("flags prefix-duplicate indexes", () => {
    const indexes = [idx("i_a", "orders", ["user_id"]), idx("i_ab", "orders", ["user_id", "created_at"])];
    const redundant = findRedundantIndexes(indexes);
    expect(redundant).toHaveLength(1);
    expect(redundant[0]!.index.name).toBe("i_a");
    expect(redundant[0]!.supersededBy).toBe("i_ab");
  });

  it("does not flag different tables or non-prefix overlaps", () => {
    const indexes = [
      idx("i_a", "orders", ["user_id"]),
      idx("i_b", "invoices", ["user_id"]),
      idx("i_c", "orders", ["created_at", "user_id"]),
    ];
    expect(findRedundantIndexes(indexes)).toHaveLength(0);
  });
});

describe("analyzeIndexHygiene", () => {
  it("flags unused indexes with zero scans", () => {
    const res = analyzeIndexHygiene(
      [idx("dead_idx", "orders", ["status"]), idx("hot_idx", "orders", ["user_id"], 9999)],
      [writes("orders", 30_000)],
      30,
    );
    const names = res.drops.map((d) => d.index.name);
    expect(names).toContain("dead_idx");
    expect(names).not.toContain("hot_idx");
    expect(res.drops[0]!.reason).toBe("unused");
  });

  it("flags invalid indexes", () => {
    const bad: IndexDef = { ...idx("broken", "orders", ["x"]), isValid: false };
    const res = analyzeIndexHygiene([bad], [], 30);
    expect(res.drops[0]!.reason).toBe("invalid");
  });

  it("estimates write overhead", () => {
    const res = analyzeIndexHygiene([idx("dead_idx", "orders", ["status"], 0, 100_000_000)], [writes("orders", 300_000)], 30);
    // 300_000 inserts over stats lifetime ÷ 30 days = 10_000 writes/day × 100MB
    expect(res.totalWriteOverheadBytesPerDay).toBeGreaterThan(0);
  });
});
