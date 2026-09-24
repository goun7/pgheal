import type { Config } from "../config.js";
import type { IndexCandidate, PlanInfo, SimulationResult, StatementStats } from "../types.js";
import type { PgClient } from "../postgres/client.js";
import { estimateIndexSize } from "./estimate.js";
import { indexDdl } from "./ddl.js";

/**
 * HypoPG-backed simulation (paper §2/§4):
 *  - hypothetical indexes cost zero CPU/disk/locks (HypoPG 1.4.2, 2025-06-30)
 *  - we ask the planner: "would you use this index? at what cost?"
 *  - acceptance rule: plan must switch to an index scan AND total cost must drop
 */

export interface SimulateDeps {
  client: PgClient;
  hypopgAvailable: boolean;
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

function planInfo(plan: unknown): PlanInfo {
  // EXPLAIN (FORMAT JSON) returns an array: [{ "Plan": {...}, ... }]
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

function planUsesIndex(plan: unknown): boolean {
  return /Index|Bitmap/.test(planInfo(plan).nodeType);
}

/** Strip trailing semicolon: EXPLAIN accepts a single statement only. */
function explainableText(sql: string): string {
  return sql.replace(/;\s*$/, "");
}

/**
 * EXPLAIN a statement (baseline plan), robust to pg_stat_statements' $N-parameterized text.
 */
export async function explainStatement(client: PgClient, sql: string): Promise<unknown> {
  return client.withConnection((q) => explainWith(q, sql));
}

function firstColumn(row: Record<string, unknown> | undefined): unknown {
  if (!row) return null;
  return Object.values(row)[0];
}

/** A realistic literal per inferred parameter type (planner-friendly, data-free). */
export function dummyValueForType(type: string): string {
  const t = type.replace(/\s+/g, "").toLowerCase();
  if (t.endsWith("[]")) return `ARRAY[]::${t}`;
  if (/^(smallint|integer|bigint|numeric|real|money)$/.test(t)) return "1";
  if (t === "doubleprecision") return "1";
  if (/^(text|character|charactervarying|name|citext|varchar|char)$/.test(t)) return "'pgheal'";
  if (t === "uuid") return "'00000000-0000-0000-0000-000000000000'::uuid";
  if (/^(boolean|bool)$/.test(t)) return "true";
  if (/^(timestampwith?timezone|timestampwithouttimezone|date|timestamptz)$/.test(t)) return "now()";
  if (t === "interval") return "interval '1 day'";
  if (t === "bytea") return "''::bytea";
  if (t === "json" || t === "jsonb") return `'{}'::json${t === "jsonb" ? "b" : ""}`;
  // multi-word type names cannot be used in `x::typename` shorthand
  if (t === "doubleprecision") return "CAST(1 AS double precision)";
  if (t === "charactervarying") return "CAST('pgheal' AS character varying)";
  if (t === "timestampwithouttimezone") return "CAST(now() AS timestamp)";
  if (t === "character" || t === "char") return "CAST('p' AS char)";
  return `NULL::${type}`;
}

async function explain(client: PgClient, sql: string): Promise<unknown> {
  return explainStatement(client, sql);
}
function quoteLiteral(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

export async function simulateCandidate(
  stmt: StatementStats,
  candidate: IndexCandidate,
  deps: SimulateDeps,
  _config?: Config,
): Promise<SimulationResult> {
  void _config;
  const { client, hypopgAvailable } = deps;

  const beforePlan = await explain(client, stmt.query);
  const before = planInfo(beforePlan);

  if (!hypopgAvailable) {
    return {
      candidate,
      before,
      after: null,
      costRatio: null,
      speedup: null,
      accepted: false,
      rejectionReason: "HypoPG not installed — unproven mode (run pgheal doctor)",
      hypopgAvailable: false,
    };
  }

  const ddl = indexDdl(candidate, { concurrently: false });
  // HypoPG indexes are session-scoped AND pgss text may be parameterized:
  // create the hypothetical index, re-plan (PREPARE+EXPLAIN EXECUTE if needed)
  // and reset — all on ONE dedicated pooled connection.
  const afterPlan = await client.withConnection(async (q) => {
    // availability was checked on a pooled connection; this dedicated one must
    // have it too, or hypopg_create_index would silently reject every DDL.
    // to_regproc probes the FUNCTION's existence (hypopg() row-set is empty
    // right after a reset, so counting its rows would always be false).
    const chk = await q<{ ok: boolean }>(
      "SELECT (to_regproc('hypopg') IS NOT NULL OR to_regproc('hypopg_create_index') IS NOT NULL) AS ok",
    );
    if (!chk[0]?.ok) throw new Error("HypoPG is not available on the simulation session");
    await q(`SELECT * FROM hypopg_create_index(${quoteLiteral(ddl)})`);
    const plan = await explainWith(q, stmt.query);
    await q("SELECT * FROM hypopg_reset()").catch(() => undefined);
    return plan;
  });

  const after = planInfo(afterPlan);
  const used = planUsesIndex(afterPlan);

  const beforeCost = before.totalCost;
  const afterCost = after.totalCost;

  const accepted = used && afterCost < beforeCost;
  const rejectionReason =
    !used
      ? "planner did not choose the hypothetical index"
      : afterCost >= beforeCost
        ? "plan cost did not improve"
        : undefined;

  const result: SimulationResult = {
    candidate,
    before,
    after,
    costRatio: beforeCost > 0 ? afterCost / beforeCost : null,
    speedup: used && afterCost > 0 ? beforeCost / afterCost : null,
    accepted,
    rejectionReason,
    hypopgAvailable: true,
  };

  // size estimate for every simulated candidate (best-effort; 0 = unknown)
  const est = await estimateIndexSize(client, candidate);
  if (est > 0) result.estimatedIndexSizeBytes = est;
  return result;
}

/** EXPLAIN via a dedicated connection's query fn (session-scoped PREPARE allowed). */
async function explainWith(
  q: <R extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<R[]>,
  sql: string,
): Promise<unknown> {
  const text = explainableText(sql);
  if (!/\$\d+\b/.test(text)) {
    const rows = await q(`EXPLAIN (FORMAT JSON) ${text}`);
    return firstColumn(rows[0]);
  }
  const name = `pgheal_q_${Date.now().toString(36)}`;
  await q(`PREPARE ${name} AS ${text}`);
  const typeRows = await q<{ parameter_types: string | null }>(
    // array_to_string: multi-word type names ("double precision") arrive quoted
    // in pg array text output; '|' is a safe separator (never in a type name)
    `SELECT array_to_string(parameter_types, '|') AS parameter_types FROM pg_prepared_statements WHERE name = '${name}'`,
  );
  const rawTypes = typeRows[0]?.parameter_types;
  const types: string[] = rawTypes ? rawTypes.split("|").filter(Boolean) : [];
  const dummies = types.map(dummyValueForType);
  const rows = await q<Record<string, unknown>>(`EXPLAIN (FORMAT JSON) EXECUTE ${name}(${dummies.join(", ")})`);
  await q(`DEALLOCATE ${name}`).catch(() => undefined);
  return firstColumn(rows[0]);
}
