import type { Config } from "./config.js";
import type { QueryCandidate, Recommendation, ScanResult, StatementStats } from "./types.js";
import { PgClient } from "./postgres/client.js";
import { fetchIndexes, fetchTableWrites, fetchTopStatements } from "./collect/pgss.js";
import { isSupportedStatement, makeCandidates } from "./analysis/candidates.js";
import { selectIndexSet } from "./analysis/workload.js";
import { analyzeIndexHygiene } from "./analysis/usage.js";
import { buildMigration } from "./pr/migrations.js";
import { renderReport, reportToJson } from "./report/render.js";
import { buildPayload, deliverPr } from "./pr/github.js";

/** Scan orchestrator — the autonomous engine (paper §4). */

export async function runScan(config: Config, options: { write: boolean }): Promise<ScanResult> {
  const warnings: string[] = [];
  const client = new PgClient(config);
  await client.connect();

  try {
    const [serverVersion, hypopg, pgss] = await Promise.all([
      client.serverVersion(),
      client.extensionAvailable("hypopg"),
      client.extensionAvailable("pg_stat_statements"),
    ]);

    if (!pgss) warnings.push("pg_stat_statements is not installed — nothing to scan. Enable it in shared_preload_libraries.");
    if (!hypopg) warnings.push("HypoPG is not installed — recommendations will run in unproven mode and be suppressed.");

    let statements: StatementStats[] = [];
    if (pgss) {
      statements = await fetchTopStatements(client, config.topN, config.minTotalMs);
    }

    const candidates: QueryCandidate[] = statements
      .filter((s) => isSupportedStatement(s.query))
      .map((s) => ({
        statement: s,
        predicates: [],
        orderBy: [],
        groupBy: [],
        reason: `total ${Math.round(s.totalExecTime)} ms across ${s.calls} calls`,
      }));

    const recommendations: Recommendation[] = [];
    if (hypopg && pgss && candidates.length > 0) {
      // v0.2: joint workload optimization — greedy set selection by weighted
      // benefit (Bruno & Chaudhuri 2005), all plans HypoPG-simulated.
      const allCandidates = candidates.flatMap((qc) => makeCandidates(qc.statement));
      const statements = candidates.map((qc) => qc.statement);
      try {
        const decision = await selectIndexSet(
          statements,
          allCandidates,
          { client, hypopgAvailable: hypopg },
          config,
        );
        // each chosen index is reported with an honest proof row: prefer the
        // joint plan of the statement that PROPOSED the index (results[i]
        // corresponds to statements[i] positionally); fall back to the first
        // improved statement, and label proofs borrowed from other statements.
        for (const cand of decision.chosen) {
          const originQid = allCandidates.find(
            (c) => c.table === cand.table && c.columns.join(",") === cand.columns.join(","),
          )?.fromQueryid;
          const ownIdx = originQid ? statements.findIndex((s) => s.queryid === originQid) : -1;
          const proof =
            (ownIdx >= 0 ? decision.results[ownIdx] : undefined) ??
            decision.results.find((r) => r.accepted) ??
            decision.results[0];
          if (proof) {
            const borrowed = ownIdx < 0 || !decision.results[ownIdx]?.accepted;
            recommendations.push({
              simulation: {
                ...proof,
                candidate: {
                  ...proof.candidate,
                  table: cand.table,
                  columns: cand.columns,
                  method: cand.method,
                  reason: borrowed ? `${cand.reason} (proof from the workload's best-improving statement)` : cand.reason,
                },
              },
              proofTable: "",
              migration: buildMigration(cand, config.dialect),
            });
          }
        }
        if (decision.chosen.length > 1) {
          warnings.push(
            `joint optimization selected ${decision.chosen.length} indexes evaluated together (weighted saving: ${Math.round(decision.weightedSaving)} cost-units × calls)`,
          );
        }
      } catch (e) {
        warnings.push(
          `workload optimization failed, falling back to per-statement proof: ${e instanceof Error ? e.message.slice(0, 120) : "error"}`,
        );
        // fallback: independent per-statement proof (v0.1 behavior)
        for (const qc of candidates) {
          for (const cand of makeCandidates(qc.statement)) {
            try {
              const { simulateCandidate } = await import("./analysis/simulate.js");
              const sim = await simulateCandidate(qc.statement, cand, { client, hypopgAvailable: hypopg }, config);
              if (sim.accepted) {
                recommendations.push({
                  simulation: sim,
                  proofTable: "",
                  migration: buildMigration(cand, config.dialect),
                });
              }
            } catch (e2) {
              warnings.push(
                `simulation failed for query ${qc.statement.queryid}: ${e2 instanceof Error ? e2.message.slice(0, 120) : "error"}`,
              );
            }
          }
        }
      }
    }

    // index hygiene
    const indexes = await fetchIndexes(client);
    const writes = await fetchTableWrites(client);
    const cleanup = analyzeIndexHygiene(indexes, writes, config.unusedIndexDays);

    // if no proven recommendations but drops exist, PR carries cleanup only
    const result: ScanResult = {
      db: { serverVersion, database: await currentDatabase(client), hypopg, pgss },
      candidates,
      recommendations,
      cleanup,
      report: "",
      pr: null,
      warnings,
    };
    result.report = renderReport(result);

    if (config.githubRepo && config.githubToken) {
      const payload = await buildPayload(
        recommendations.map((r) => ({ migration: r.migration, simulation: r.simulation })),
        cleanup.drops.map((d) => ({
          index: { name: d.index.name, table: d.index.table, sizeBytes: d.index.sizeBytes, reason: d.reason },
        })),
        { repo: config.githubRepo, dialect: config.dialect },
        config,
      );
      result.pr = await deliverPr({ ...config, write: options.write }, payload);
    } else {
      result.pr = {
        created: false,
        dryRun: true,
        branch: "pgheal/index-<fingerprint>",
        files: recommendations.map((r) => r.migration.path),
        message: "GITHUB_REPO / GITHUB_TOKEN not set — PR skipped. Set them to enable GitHub delivery.",
      };
    }

    return result;
  } finally {
    await client.close();
  }
}

async function currentDatabase(client: PgClient): Promise<string> {
  const rows = await client.query<{ db: string }>("SELECT current_database() AS db");
  return rows[0]!.db;
}

export { reportToJson };
