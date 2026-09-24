import { describe, expect, it } from "vitest";
import { humanBytes, proofTable } from "../src/report/render.js";
import type { SimulationResult } from "../src/types.js";

const sim: SimulationResult = {
  candidate: {
    table: "orders",
    columns: ["user_id"],
    method: "btree",
    isUnique: false,
    fromQueryid: "q1",
    reason: "top statement",
  },
  before: { nodeType: "Seq Scan", totalCost: 48200, planRows: 100000, usesIndexScan: false, raw: {} },
  after: { nodeType: "Index Scan", totalCost: 12.4, planRows: 42, usesIndexScan: true, raw: {} },
  costRatio: 12.4 / 48200,
  speedup: 48200 / 12.4,
  accepted: true,
  hypopgAvailable: true,
  estimatedIndexSizeBytes: 2048,
};

describe("proofTable", () => {
  it("renders before/after costs", () => {
    const t = proofTable(sim);
    expect(t).toContain("Seq Scan");
    expect(t).toContain("Index Scan");
    expect(t).toContain("48200.0".replace("48200.0", "48200.0")); // cost rendered
    expect(t).toContain("3887.1x"); // 48200/12.4
  });

  it("renders n/a when no after plan", () => {
    const t = proofTable({ ...sim, after: null, costRatio: null, speedup: null });
    expect(t).toContain("n/a");
  });
});

describe("humanBytes", () => {
  it("formats sizes", () => {
    expect(humanBytes(512)).toBe("512 B");
    expect(humanBytes(2048)).toBe("2.0 KB");
    expect(humanBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(humanBytes(3 * 1024 ** 3)).toBe("3.00 GB");
  });
});
