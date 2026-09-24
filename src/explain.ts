import type { Config } from "./config.js";
import { PgClient } from "./postgres/client.js";
import { simulateCandidate } from "./analysis/simulate.js";
import { makeCandidates } from "./analysis/candidates.js";
import { proofTable } from "./report/render.js";

/** Single-query explanation: baseline plan + HypoPG A/B proof table. */

export interface ExplainOptions {
  /** EXPLAIN ANALYZE — actually executes; only safe on read-only sessions */
  analyze?: boolean | undefined;
  /** EXPLAIN BUFFERS */
  buffers?: boolean | undefined;
}

export async function explainQuery(config: Config, sql: string, options: ExplainOptions = {}): Promise<string> {
  const client = new PgClient(config);
  await client.connect();
  try {
    const hypopg = await client.extensionAvailable("hypopg");
    const stmt = {
      queryid: "manual",
      query: sql,
      calls: 0,
      totalExecTime: 0,
      meanExecTime: 0,
      rows: 0,
      hitRatio: 0,
    };
    const candidates = makeCandidates(stmt);
    const lines: string[] = [];
    const flags = explainFlags(options);

    if (!candidates.length) {
      lines.push("No index candidates extracted from this statement (flat SELECT with WHERE/JOIN works best).");
      const rows = await client.query<{ plan: unknown }>(`EXPLAIN (${flags}) ${sql}`);
      lines.push("Baseline plan:");
      lines.push("```json");
      lines.push(JSON.stringify(rows[0]?.plan ?? null, null, 2).slice(0, 2000));
      lines.push("```");
      return lines.join("\n");
    }

    for (const cand of candidates) {
      const sim = await simulateCandidate(stmt, cand, { client, hypopgAvailable: hypopg }, config);
      lines.push(`### Candidate: ${cand.table} (${cand.columns.join(", ")})`);
      lines.push("");
      lines.push(proofTable(sim));
      lines.push("");
      if (sim.accepted) lines.push("✅ Planner would use this index — proven improvement.");
      else lines.push(`❌ Not proven: ${sim.rejectionReason ?? "unknown"}`);
      lines.push("");
    }
    return lines.join("\n");
  } finally {
    await client.close();
  }
}

/** Build EXPLAIN option flags; ANALYZE/BUFFERS reach the baseline plan (simulation stays estimate-based). */
function explainFlags(o: ExplainOptions): string {
  const parts = ["FORMAT JSON"];
  if (o.buffers) parts.push("BUFFERS");
  if (o.analyze) parts.push("ANALYZE");
  return parts.join(", ");
}
