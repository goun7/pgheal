import type { ScanResult } from "../types.js";
import { humanBytes } from "./render.js";

/**
 * SARIF 2.1.0 output — upload to GitHub code scanning and index opportunities
 * appear on the Security tab (paper §4 CI mode; docs §SARIF).
 *
 * Proven index recommendations become `warning` results; unused/redundant
 * index cleanup becomes `note` results. Query text is never embedded — only
 * normalized fingerprints and table/column names (zero data exfiltration).
 */
export function renderSarif(scan: ScanResult): string {
  const sarif = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "pgHeal",
            informationUri: "https://github.com/goun7/pgheal",
            version: "0.1.0",
            rules: [
              ...scan.recommendations.map((r, i) => ({
                id: `pgheal/index/${i + 1}`,
                name: "ProvenIndexOpportunity",
                shortDescription: { text: `HypoPG-proven index opportunity on ${r.simulation.candidate.table}` },
                helpUri: "https://github.com/goun7/pgheal#scan",
              })),
              ...scan.cleanup.drops.map((d, i) => ({
                id: `pgheal/cleanup/${i + 1}`,
                name: "UnusedIndex",
                shortDescription: { text: `Unused/redundant index ${d.index.name}` },
                helpUri: "https://github.com/goun7/pgheal#index-hygiene",
              })),
            ],
          },
        },
        results: [
          ...scan.recommendations.map((r, i) => ({
            ruleId: `pgheal/index/${i + 1}`,
            ruleIndex: i,
            level: "warning" as const,
            message: {
              text:
                `Proven index on ${r.simulation.candidate.table} (${r.simulation.candidate.columns.join(", ")}, ` +
                `${r.simulation.candidate.method}): ` +
                (r.simulation.speedup !== null ? `${r.simulation.speedup.toFixed(1)}x speedup, ` : "") +
                (r.simulation.costRatio !== null ? `${Math.round(100 * (1 - r.simulation.costRatio))}% cost reduction` : "") +
                ` — migration: ${r.migration.path}`,
            },
            properties: {
              table: r.simulation.candidate.table,
              columns: r.simulation.candidate.columns.join(","),
              method: r.simulation.candidate.method,
              speedup: r.simulation.speedup,
              costRatio: r.simulation.costRatio,
              queryFingerprint: r.simulation.candidate.fromQueryid,
              migration: r.migration.path,
              ddl: r.migration.content.trim(),
            },
          })),
          ...scan.cleanup.drops.map((d, i) => ({
            ruleId: `pgheal/cleanup/${i + 1}`,
            ruleIndex: scan.recommendations.length + i,
            level: "note" as const,
            message: {
              text:
                `Index ${d.index.name} on ${d.index.table}: ${d.reason}` +
                ` (${humanBytes(d.index.sizeBytes)}, ~${humanBytes(d.writeOverheadPerDay)} write overhead/day)` +
                " — requires a 30+ day zero-scan observation window before dropping",
            },
            properties: {
              index: d.index.name,
              table: d.index.table,
              reason: d.reason,
              sizeBytes: d.index.sizeBytes,
            },
          })),
        ],
      },
    ],
  };
  return JSON.stringify(sarif, null, 2);
}
