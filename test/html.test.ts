import { describe, expect, it } from "vitest";
import { renderExplainHtml, renderHtmlReport } from "../src/report/html.js";
import type { ScanResult } from "../src/types.js";

const scan: ScanResult = {
  db: { serverVersion: "PostgreSQL 18.6, compiled by gcc", database: "demo", hypopg: true, pgss: true },
  candidates: [],
  recommendations: [
    {
      simulation: {
        candidate: { table: "orders", columns: ["user_id"], method: "gin", isUnique: false, fromQueryid: "q", reason: "containment on payload" },
        before: { nodeType: "Seq Scan", totalCost: 1000, planRows: 10, usesIndexScan: false, raw: {} },
        after: { nodeType: "Bitmap Index Scan", totalCost: 8, planRows: 10, usesIndexScan: true, raw: {} },
        costRatio: 0.008,
        speedup: 125,
        accepted: true,
        hypopgAvailable: true,
      },
      proofTable: "",
      migration: { dialect: "sql", path: "migrations/x.sql", content: 'CREATE INDEX USING gin ("payload");' },
    },
  ],
  cleanup: { drops: [], totalWriteOverheadBytesPerDay: 0 },
  report: "",
  pr: null,
  warnings: ["one warning"],
};

describe("renderHtmlReport", () => {
  it("is self-contained and escapes content", () => {
    const html = renderHtmlReport(scan);
    expect(html).toContain("<!doctype html>");
    expect(html).not.toContain("<script src=");
    expect(html).toContain("Bitmap Index Scan");
    expect(html).toContain("125.0x");
    expect(html).toContain("zero data exfiltration");
    expect(html).toContain("one warning");
  });

  it("renders cost bars and method badges", () => {
    const html = renderHtmlReport(scan);
    expect(html).toContain('class="bar after"');
    expect(html).toContain("badge ok\">gin<");
  });

  it("escapes html-injecting strings", () => {
    const evil = { ...scan, warnings: ["<img src=x onerror=alert(1)>"] } as ScanResult;
    const html = renderHtmlReport(evil);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });
});

describe("renderExplainHtml", () => {
  it("wraps markdown result and raw query", () => {
    const html = renderExplainHtml("### Candidate\n✅ proven", "SELECT 1");
    expect(html).toContain("SELECT 1");
    expect(html).toContain("✅ proven");
  });
});
