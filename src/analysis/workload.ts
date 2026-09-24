import type { IndexCandidate, PlanInfo, SimulationResult, StatementStats } from "../types.js";
import type { Config } from "../config.js";
import type { PgClient } from "../postgres/client.js";
import { estimateIndexSize } from "./estimate.js";
import { indexDdl } from "./ddl.js";
import { explainStatement } from "./simulate.js";

/**
 * Multi-query index set selection (paper §10; Bruno & Chaudhuri, SIGMOD 2005,
 * "Automatic Physical Database Tuning: A Relaxation-Based Approach").
 *
 * Independent per-candidate simulation can accept two overlapping indexes that
 * each look good alone. HypoPG holds several hypothetical indexes at once, so
 * we evaluate the JOINT value of a candidate set per statement and grow the set
 * greedily by weighted total benefit:
 *
 *   benefit(set) = Σ_statements calls(s) × max(0, cost_before(s) − cost_with_set(s))
 */

export interface WorkloadDeps {
  client: PgClient;
  hypopgAvailable: boolean;
}

export interface WorkloadEntry {
  statement: StatementStats;
  before: PlanInfo;
}

export interface SetDecision {
  /** chosen candidates, in greedy insertion order */
  chosen: IndexCandidate[];
  /** per-statement joint simulations for the final set */
  results: SimulationResult[];
  /** Σ calls × cost-units saved across the workload */
  weightedSaving: number;
}

/**
 * Candidates grouped by table; a candidate that is a strict prefix of another
 * on the same table is dropped (the wider one covers it — cost is re-verified
 * by the planner during simulation anyway).
 */
export function dedupeCandidates(candidates: IndexCandidate[]): IndexCandidate[] {
  const byTable = new Map<string, IndexCandidate[]>();
  for (const c of candidates) {
    const list = byTable.get(c.table) ?? [];
    list.push(c);
    byTable.set(c.table, list);
  }
  const out: IndexCandidate[] = [];
  for (const [, list] of byTable) {
    // keep c unless some other candidate strictly extends it
    for (const c of list) {
      const isPrefixOfOther = list.some(
        (o) =>
          o !== c &&
          o.columns.length > c.columns.length &&
          c.columns.every((col, i) => o.columns[i] === col),
      );
      if (!isPrefixOfOther && !out.some((o) => o.table === c.table && o.columns.join(",") === c.columns.join(","))) {
        out.push(c);
      }
    }
  }
  return out;
}

interface PlanNode {
  "Node Type"?: string;
  "Total Cost"?: number;
  "Plan Rows"?: number;
  Plans?: PlanNode[];
}

function findIndexNode(node: PlanNode | undefined): PlanNode | null {
  if (!node) return null;
  if (/Index|Bitmap/.test(node["Node Type"] ?? "")) return node;
  for (const child of node.Plans ?? []) {
    const hit = findIndexNode(child);
    if (hit) return hit;
  }
  return null;
}

export function planInfoOf(plan: unknown): PlanInfo {
  // EXPLAIN (FORMAT JSON) returns an array: [{ "Plan": {...} }]
  let unwrapped: unknown = plan;
  if (Array.isArray(unwrapped)) unwrapped = unwrapped[0];
  const root = (unwrapped as { Plan?: PlanNode } | undefined)?.Plan;
  const hit = findIndexNode(root) ?? root;
  return {
    nodeType: hit?.["Node Type"] ?? "Unknown",
    totalCost: hit?.["Total Cost"] ?? 0,
    planRows: hit?.["Plan Rows"] ?? 0,
    usesIndexScan: /Index|Bitmap/.test(hit?.["Node Type"] ?? ""),
    raw: plan,
  };
}

/** Plan a statement with a whole set of hypothetical indexes (one session). */
export async function explainWithSet(
  client: PgClient,
  stmt: StatementStats,
  set: IndexCandidate[],
): Promise<PlanInfo> {
  return client.withConnection(async (q) => {
    for (const c of set) {
      const ddl = indexDdl(c, { concurrently: false });
      await q(`SELECT * FROM hypopg_create_index('${ddl.replace(/'/g, "''")}')`);
    }
    try {
      // PREPARE + EXPLAIN EXECUTE on THIS connection so the hypothetical
      // indexes are visible to the planner (session-scoped by design)
      const plan = await explainViaQueryFn(q, stmt.query);
      return planInfoOf(plan);
    } finally {
      await q("SELECT * FROM hypopg_reset()").catch(() => undefined);
    }
  });
}

async function explainViaQueryFn(
  q: <R extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<R[]>,
  sql: string,
): Promise<unknown> {
  const text = sql.replace(/;\s*$/, "");
  if (!/\$\d+\b/.test(text)) {
    const rows = await q(`EXPLAIN (FORMAT JSON) ${text}`);
    return Object.values(rows[0] ?? {})[0];
  }
  const name = `pgheal_w_${Date.now().toString(36)}`;
  await q(`PREPARE ${name} AS ${text}`);
  const typeRows = await q<{ parameter_types: string | null }>(
    `SELECT array_to_string(parameter_types, '|') AS parameter_types FROM pg_prepared_statements WHERE name = '${name}'`,
  );
  const types: string[] = typeRows[0]?.parameter_types ? typeRows[0].parameter_types.split("|").filter(Boolean) : [];
  const { dummyValueForType } = await import("./simulate.js");
  const dummies = types.map(dummyValueForType);
  const rows = await q<Record<string, unknown>>(`EXPLAIN (FORMAT JSON) EXECUTE ${name}(${dummies.join(", ")})`);
  await q(`DEALLOCATE ${name}`).catch(() => undefined);
  return Object.values(rows[0] ?? {})[0];
}

function e2message(e: unknown): string {
  return e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160);
}

/** Greedy set selection by marginal weighted benefit. */
export async function selectIndexSet(
  statements: StatementStats[],
  candidates: IndexCandidate[],
  deps: WorkloadDeps,
  _config?: Config,
): Promise<SetDecision> {
  const { client, hypopgAvailable } = deps;
  const uniq = dedupeCandidates(candidates);
  const chosen: IndexCandidate[] = [];

  if (!hypopgAvailable || statements.length === 0 || uniq.length === 0) {
    return { chosen: [], results: [], weightedSaving: 0 };
  }

  // 1) baseline plans (unexplainable statements are surfaced, not swallowed —
  //    HypoPG silently rejects unparseable DDL and would otherwise fake "no win")
  const entries: WorkloadEntry[] = [];
  const skipped: string[] = [];
  for (const stmt of statements) {
    try {
      const before = planInfoOf(await explainStatement(client, stmt.query));
      entries.push({ statement: stmt, before });
    } catch (e) {
      skipped.push(`query ${stmt.queryid}: ${e instanceof Error ? e.message.slice(0, 120) : "explain failed"}`);
    }
  }
  if (skipped.length > 0) {
    throw new Error(`workload planning failed: ${skipped[0]!}${skipped.length > 1 ? ` (+${skipped.length - 1} more)` : ""}`);
  }
  if (entries.length === 0) return { chosen: [], results: [], weightedSaving: 0 };

  const jointCosts = new Map<string, number>(); // queryid -> best known cost with current set
  for (const e of entries) jointCosts.set(e.statement.queryid, e.before.totalCost);

  // 2) greedy growth
  let weightedSaving = 0;
  const remaining = [...uniq];

  for (;;) {
    let bestGain = 0;
    let bestCandidate: IndexCandidate | null = null;
    let bestCosts: { queryid: string; cost: number }[] = [];

    for (const cand of remaining) {
      const trial = [...chosen, cand];
      const costs: { queryid: string; cost: number }[] = [];
      let gain = 0;
      let ok = true;
      for (const e of entries) {
        try {
          const plan = await explainWithSet(client, e.statement, trial);
          costs.push({ queryid: e.statement.queryid, cost: plan.totalCost });
          const prev = jointCosts.get(e.statement.queryid) ?? e.before.totalCost;
          if (plan.usesIndexScan && plan.totalCost < prev) {
            gain += (prev - plan.totalCost) * e.statement.calls;
          }
        } catch (err) {
          // propagate: HypoPG rejects unknown SQL with a bare "hypothetical" error —
          // swallowing it here would silently bias the optimizer against truth
          throw new Error(`joint simulation failed for query ${e.statement.queryid}: ${e2message(err)}`);
        }
      }
      if (ok && gain > bestGain + 1e-9) {
        bestGain = gain;
        bestCandidate = cand;
        bestCosts = costs;
      }
    }

    if (!bestCandidate || bestGain <= 0) break;
    chosen.push(bestCandidate);
    remaining.splice(remaining.indexOf(bestCandidate), 1);
    for (const c of bestCosts) jointCosts.set(c.queryid, c.cost);
    weightedSaving = bestGain; // last round's marginal gain is the final increment
    if (chosen.length >= 8) break; // safety bound
  }

  // nothing survived the joint-benefit test: report silence (paper §9 "proof or silence")
  if (chosen.length === 0) return { chosen: [], results: [], weightedSaving: 0 };

  // 3) final joint simulation per statement (report + PR proof)
  const results: SimulationResult[] = [];
  const sizeCache = new Map<string, number>();
  for (const c of chosen) {
    if (!sizeCache.has(c.table)) sizeCache.set(c.table, await estimateIndexSize(client, c));
  }
  const totalEstSize = [...sizeCache.values()].reduce((a, b) => a + b, 0);

  for (const e of entries) {
    let withSet: PlanInfo;
    try {
      withSet = await explainWithSet(client, e.statement, chosen);
    } catch (err) {
      throw new Error(`joint simulation failed for query ${e.statement.queryid}: ${e2message(err)}`);
    }
    const beforeCost = e.before.totalCost;
    const afterCost = withSet.totalCost;
    const improved = withSet.usesIndexScan && afterCost < beforeCost;
    const primary = chosen[0]!;
    results.push({
      candidate: {
        ...primary,
        columns: chosen.flatMap((c) => c.columns).filter((v, i, a) => a.indexOf(v) === i),
        table: [...new Set(chosen.map((c) => c.table))][0] ?? primary.table,
        reason:
          chosen.length > 1
            ? `joint set (${chosen.length} indexes) selected by weighted workload benefit`
            : primary.reason,
      },
      before: e.before,
      after: withSet,
      costRatio: beforeCost > 0 ? afterCost / beforeCost : null,
      speedup: improved && afterCost > 0 ? beforeCost / afterCost : null,
      accepted: improved,
      rejectionReason: improved ? undefined : "joint set did not improve this statement",
      hypopgAvailable: true,
      estimatedIndexSizeBytes: totalEstSize,
    });
  }

  return { chosen, results, weightedSaving };
}
