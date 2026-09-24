import { describe, expect, it } from "vitest";
import { renderSarif } from "../src/report/sarif.js";
import type { ScanResult } from "../src/types.js";

const scan: ScanResult = {
  db: { serverVersion: "PostgreSQL 18.0", database: "demo", hypopg: true, pgss: true },
  candidates: [],
  recommendations: [
    {
      simulation: {
        candidate: { table: "orders", columns: ["user_id", "created_at"], method: "btree", isUnique: false, fromQueryid: "q1", reason: "top" },
        before: { nodeType: "Seq Scan", totalCost: 8465.9, planRows: 500000, usesIndexScan: false, raw: {} },
        after: { nodeType: "Bitmap Heap Scan", totalCost: 35.2, planRows: 42, usesIndexScan: true, raw: {} },
        costRatio: 0.0042,
        speedup: 240.4,
        accepted: true,
        hypopgAvailable: true,
        estimatedIndexSizeBytes: 11_264,
      },
      proofTable: "",
      migration: { dialect: "sql", path: "migrations/idx_orders.sql", content: "CREATE INDEX ...;\n" },
    },
  ],
  cleanup: {
    drops: [
      {
        index: { name: "orders_email_idx", table: "orders", columns: ["email"], isUnique: false, isValid: true, scans: 0, sizeBytes: 104_857_600 },
        reason: "unused",
        writeOverheadPerDay: 2048,
      },
    ],
    totalWriteOverheadBytesPerDay: 2048,
  },
  report: "",
  pr: null,
  warnings: [],
};

describe("renderSarif", () => {
  it("emits valid SARIF 2.1.0 skeleton", () => {
    const s = JSON.parse(renderSarif(scan));
    expect(s.version).toBe("2.1.0");
    expect(s.runs).toHaveLength(1);
    expect(s.runs[0].tool.driver.name).toBe("pgHeal");
  });

  it("recommendations become warnings with fingerprint-only metadata", () => {
    const s = JSON.parse(renderSarif(scan));
    const res = s.runs[0].results[0];
    expect(res.level).toBe("warning");
    expect(res.message.text).toContain("orders");
    expect(res.message.text).toContain("240.4x");
    expect(res.properties.ddl).toContain("CREATE INDEX");
    expect(res.properties.queryFingerprint).toBe("q1");
    // zero data exfiltration: no query text in the SARIF payload
    expect(renderSarif(scan)).not.toMatch(/SELECT\s/i);
  });

  it("cleanup drops become notes", () => {
    const s = JSON.parse(renderSarif(scan));
    const res = s.runs[0].results[1];
    expect(res.level).toBe("note");
    expect(res.message.text).toContain("orders_email_idx");
    expect(res.message.text).toContain("30+ day");
  });

  it("rules are declared for every result", () => {
    const s = JSON.parse(renderSarif(scan));
    const rules = s.runs[0].tool.driver.rules;
    const results = s.runs[0].results;
    expect(rules).toHaveLength(results.length);
    for (const r of results) {
      expect(rules[r.ruleIndex].id).toBe(r.ruleId);
    }
  });
});
