/** Ortak tipler — pgHeal çekirdeği. */

export interface StatementStats {
  /** pg_stat_statements queryid */
  queryid: string;
  query: string;
  calls: number;
  /** ms (total_exec_time or legacy total_time) */
  totalExecTime: number;
  /** ms */
  meanExecTime: number;
  /** shared blocks read+written hit ratio input */
  rows: number;
  /** % (shared_blks_hit / (hit+read)) */
  hitRatio: number;
  /** exec seconds per row written by this statement (rough write pressure proxy) */
  tempBlks?: number | undefined;
}

export interface IndexDef {
  name: string;
  table: string;
  columns: string[];
  isUnique: boolean;
  isValid: boolean;
  /** from pg_stat_user_indexes */
  scans: number;
  sizeBytes: number;
}

export interface TableWriteStats {
  table: string;
  inserts: number;
  updates: number;
  deletes: number;
  /** live + dead tuples approximates row count touched */
  liveTuples: number;
  deadTuples: number;
}

export interface QueryCandidate {
  statement: StatementStats;
  /** Deterministic extracted predicates, best effort. */
  predicates: Predicate[];
  orderBy: string[];
  groupBy: string[];
  /** Advisory reason the query was selected (e.g. "top total_exec_time"). */
  reason: string;
}

export type PredicateKind = "equality" | "range" | "join" | "order" | "group" | "containment";

export interface Predicate {
  column: string;
  kind: PredicateKind;
}

export interface IndexCandidate {
  table: string;
  columns: string[];
  /** btree (default) · gin (arrays/JSONB/trgm) · brin (huge append-only ranges) */
  method: "btree" | "gin" | "brin";
  /** operator class, e.g. text_pattern_ops for left-anchored LIKE on non-C collations */
  opclass?: string | undefined;
  isUnique: boolean;
  fromQueryid: string;
  reason: string;
  /** Rejected candidates carry a reason and are filtered before reporting. */
  rejected?: string | undefined;
}

export interface PlanInfo {
  nodeType: string;
  totalCost: number;
  planRows: number;
  /** true if any node in the plan uses an index scan/bitmap index scan */
  usesIndexScan: boolean;
  /** raw EXPLAIN JSON plan root */
  raw: unknown;
}

export interface SimulationResult {
  candidate: IndexCandidate;
  before: PlanInfo;
  after: PlanInfo | null;
  /** after.totalCost / before.totalCost, lower is better */
  costRatio: number | null;
  /** absolute speedup factor (before/after), if index used */
  speedup: number | null;
  accepted: boolean;
  rejectionReason?: string | undefined;
  /** HypoPG available? If false, simulation is "unproven" mode. */
  hypopgAvailable: boolean;
  estimatedIndexSizeBytes?: number | undefined;
}

export interface DropCandidate {
  index: IndexDef;
  reason: "unused" | "redundant" | "invalid";
  /** For redundant: the surviving index name */
  supersededBy?: string | undefined;
  /** Write overhead estimate = size_bytes * writes-per-day */
  writeOverheadPerDay: number;
}

export interface CleanupResult {
  drops: DropCandidate[];
  totalWriteOverheadBytesPerDay: number;
}

export interface ScanOptions {
  topN: number;
  minTotalMs: number;
  /** require HypoPG proof (default true) */
  requireProof: boolean;
  /** unused-index scan window in days for idx_scan=0 judgement */
  unusedIndexDays: number;
}

export interface Recommendation {
  simulation: SimulationResult;
  /** Markdown proof table */
  proofTable: string;
  migration: MigrationFile;
}

export interface MigrationFile {
  /** relative path in the customer repo */
  path: string;
  content: string;
  /** which framework convention */
  dialect: "sql" | "prisma" | "django" | "rails";
}

export interface PrPayload {
  branch: string;
  title: string;
  body: string;
  files: { path: string; content: string }[];
  /** deterministic fingerprint of content */
  fingerprint: string;
}

export interface PrResult {
  created: boolean;
  url?: string | undefined;
  dryRun: boolean;
  branch: string;
  /** files that would be / were written */
  files: string[];
  message: string;
}

export interface ScanResult {
  db: { serverVersion: string; database: string; hypopg: boolean; pgss: boolean };
  candidates: QueryCandidate[];
  recommendations: Recommendation[];
  cleanup: CleanupResult;
  report: string;
  pr: PrResult | null;
  /** warnings surfaced to CLI */
  warnings: string[];
}
