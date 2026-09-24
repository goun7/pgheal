import { describe, expect, it } from "vitest";
import { dedupeCandidates, planInfoOf } from "../src/analysis/workload.js";
import type { IndexCandidate } from "../src/types.js";

const cand = (table: string, columns: string[], fromQueryid = "q1"): IndexCandidate => ({
  table,
  columns,
  method: "btree",
  isUnique: false,
  fromQueryid,
  reason: "test",
});

describe("dedupeCandidates", () => {
  it("drops prefix candidates superseded by wider ones on the same table", () => {
    const uniq = dedupeCandidates([
      cand("orders", ["user_id", "status"], "q1"),
      cand("orders", ["user_id"], "q2"),
      cand("orders", ["user_id", "status"], "q3"),
      cand("users", ["email"], "q4"),
    ]);
    expect(uniq).toHaveLength(2);
    const orders = uniq.find((c) => c.table === "orders")!;
    // the wider index covers the prefix query, so the prefix candidate is dropped
    expect(orders.columns).toEqual(["user_id", "status"]);
    expect(orders.fromQueryid).toBe("q1");
  });

  it("keeps different tables separate", () => {
    expect(dedupeCandidates([cand("a", ["x"]), cand("b", ["x"])]).length === 2).toBe(true);
  });
});

describe("planInfoOf", () => {
  it("parses EXPLAIN (FORMAT JSON) array shape", () => {
    const plan = [
      {
        Plan: {
          "Node Type": "Gather Merge",
          "Total Cost": 8465.86,
          "Plan Rows": 7,
          Plans: [
            {
              "Node Type": "Index Scan",
              "Total Cost": 0.56,
              "Plan Rows": 8,
              "Index Name": "idx_x",
            },
          ],
        },
      },
    ];
    const info = planInfoOf(plan);
    expect(info.nodeType).toBe("Index Scan"); // dives into children
    expect(info.usesIndexScan).toBe(true);
    expect(info.totalCost).toBe(0.56);
  });

  it("reports seq scans as non-index", () => {
    const info = planInfoOf([{ Plan: { "Node Type": "Seq Scan", "Total Cost": 100, "Plan Rows": 1 } }]);
    expect(info.usesIndexScan).toBe(false);
    expect(info.totalCost).toBe(100);
  });
});
