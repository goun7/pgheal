/**
 * The dual-package bridge — merge an AegisForge kanıt with a pgHeal scan into
 * one artifact.
 *
 * Both tools sell the same customer the same shape of thing: machine-checkable
 * proof instead of an LLM's guess. AegisForge's oracle is the SMT/fuzz engine
 * over EVM bytecode (attested by a kanıt); pgHeal's is the PostgreSQL planner
 * itself through HypoPG. The dual package is what the "DB + contract security"
 * conversation is actually about: both halves in one place, each carrying its
 * own proof, with a merged gate that says what is actionable and — just as
 * importantly — what is only evidence.
 *
 * Nothing here inflates a claim past its evidence. A kanıt whose recomputed
 * hashes disagree is labeled `hash-mismatch`, never `signed-kanit`; a vector
 * index pgHeal cannot simulate is `grounded`, never `hypopg-proven`. That
 * discipline is the whole point of both tools.
 */

import { createHash } from "node:crypto";
import type {
  ContractSummary,
  DualGate,
  DualPackage,
  DatabaseSummary,
  FindingLeaf,
  KanitSeverity,
  UnifiedFinding,
  UnifiedSeverity,
  WorkProof,
} from "./types.js";
import type { Recommendation, ScanResult, SimulationResult } from "../types.js";
import { kanitHashGatesOk, verifyKanitHashes } from "./kanit.js";

/** Severity rank, most severe first — canonical order keeps the package stable. */
export const SEVERITY_ORDER: Record<UnifiedSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

/** Map a wire severity (any string, hash-bound) onto the canonical ladder. */
export function toCanonicalSeverity(raw: string): KanitSeverity {
  switch (raw) {
    case "critical":
    case "high":
    case "medium":
    case "low":
      return raw;
    default:
      // unknown values stay on the lowest rung — never silently promoted
      return "low";
  }
}

/** Deterministic fingerprint for a kanıt, or a stable marker when absent. */
function kanitFingerprint(proof: WorkProof | null): string {
  return proof === null ? "no-kanit" : proof.kanit_hash;
}

/** Deterministic fingerprint for a pgHeal recommendation. */
function recommendationFingerprint(rec: Recommendation): string {
  const c = rec.simulation.candidate;
  return [c.table, c.columns.join(","), c.method, rec.migration.path].join(":");
}

/**
 * The dual-package id: a SHA-256 over both halves' fingerprints, each side
 * sorted so the id does not depend on the order findings happened to arrive in
 * — the same canonicalization the kanıt Merkle tree uses.
 */
export function dualPackageId(kanit: WorkProof | null, scan: ScanResult | null): string {
  const contractSide = kanitFingerprint(kanit);
  const dbSide = (scan?.recommendations ?? [])
    .map((r) => recommendationFingerprint(r))
    .sort()
    .join("|");
  const cleanupSide = (scan?.cleanup?.drops ?? [])
    .map((d) => d.index.name)
    .sort()
    .join("|");
  const preimage = `${contractSide}::${dbSide}::${cleanupSide}`;
  return "0x" + createHash("sha256").update(preimage, "utf8").digest("hex");
}

/** Severity of a pgHeal recommendation on the shared ladder. */
function recommendationSeverity(sim: SimulationResult): UnifiedSeverity {
  // a grounded candidate (e.g. HNSW) is an honest estimate, never a proven win
  if (sim.proof === "grounded") return "low";
  if (sim.speedup === null) return "low";
  if (sim.speedup >= 100) return "high";
  if (sim.speedup >= 10) return "medium";
  return "low";
}

function contractFindingToUnified(
  f: FindingLeaf,
  gatesOk: boolean,
  index: number,
): UnifiedFinding {
  const severity = toCanonicalSeverity(f.severity);
  return {
    id: `contract:${f.invariant_id}:${f.contract}:${index}`,
    source: "contract",
    severity,
    title: `${f.contract}.${f.function} violates ${f.invariant_id}`,
    detail: f.witness,
    evidence: gatesOk
      ? `kanıt witness — Merkle-bound (severity ${f.severity}${f.block_number !== null ? `, block ${f.block_number}` : ""})`
      : `published witness — kanıt hash gates FAILED, treat as unverified claim`,
    proofStatus: gatesOk ? "signed-kanit" : "hash-mismatch",
    action: gatesOk
      ? "fix the invariant before deploy; re-scan with AegisForge to mint a clean kanıt"
      : "re-run `aegisforge verify` before trusting this finding",
    locator: { contract: f.contract, function: f.function },
  };
}

function recommendationToUnified(rec: Recommendation, index: number): UnifiedFinding {
  const sim = rec.simulation;
  const c = sim.candidate;
  const proven = sim.proof !== "grounded" && sim.accepted && sim.hypopgAvailable;
  const speedup = sim.speedup === null ? "n/a" : `${sim.speedup.toFixed(1)}x`;
  return {
    id: `database:${c.table}:${c.columns.join(",")}:${index}`,
    source: "database",
    severity: recommendationSeverity(sim),
    title: `Index opportunity on ${c.table} (${c.columns.join(", ")})`,
    detail: `${c.reason} — migration: ${rec.migration.path}`,
    evidence: proven
      ? `HypoPG-proven: ${sim.before.totalCost.toFixed(1)} → ${(sim.after?.totalCost ?? 0).toFixed(1)} cost (${speedup} speedup)`
      : sim.proof === "grounded"
        ? "grounded, not proven — filter columns proven, index gain estimated"
        : "planner did not switch to an index scan (rejected with a reason)",
    proofStatus: proven ? "hypopg-proven" : sim.proof === "grounded" ? "grounded" : "unproven",
    action: proven
      ? `apply ${rec.migration.path} (CONCURRENTLY, outside a transaction)`
      : "not actionable without a proven plan",
    locator: { table: c.table, columns: [...c.columns] },
  };
}

function contractSummary(
  kanit: WorkProof | null,
  gatesOk: boolean,
): ContractSummary {
  const counts: Record<KanitSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of kanit?.findings ?? []) counts[toCanonicalSeverity(f.severity)] += 1;
  return {
    engine: "AegisForge",
    engineVersion: kanit?.engine_version ?? "unknown",
    kanitHash: kanit?.kanit_hash ?? null,
    merkleRoot: kanit?.merkle_root ?? null,
    signer: kanit?.signer.address ?? null,
    chainId: kanit?.chain_id ?? null,
    findings: kanit?.findings.length ?? 0,
    severityCounts: counts,
    hashGatesOk: gatesOk,
  };
}

function databaseSummary(scan: ScanResult | null): DatabaseSummary {
  const recs = scan?.recommendations ?? [];
  const proven = recs.filter((r) => r.simulation.proof !== "grounded" && r.simulation.accepted && r.simulation.hypopgAvailable);
  const grounded = recs.filter((r) => r.simulation.proof === "grounded");
  const speedups = proven
    .map((r) => r.simulation.speedup)
    .filter((s): s is number => s !== null);
  return {
    engine: "pgHeal",
    proven: proven.length,
    grounded: grounded.length,
    cleanupCandidates: scan?.cleanup?.drops.length ?? 0,
    writeOverheadBytesPerDay: scan?.cleanup?.totalWriteOverheadBytesPerDay ?? 0,
    bestSpeedup: speedups.length > 0 ? Math.max(...speedups) : null,
  };
}

/**
 * Build the dual package. Either side may be null (a customer may run only one
 * oracle), but not both — a package certifying nothing is not a package.
 */
export function buildDualPackage(input: {
  kanit?: WorkProof | null;
  scan?: ScanResult | null;
}): DualPackage {
  const kanit = input.kanit ?? null;
  const scan = input.scan ?? null;

  if (kanit === null && scan === null) {
    throw new Error("dual package needs at least one oracle — pass a kanıt, a scan, or both");
  }
  if (kanit !== null && kanit.findings.length === 0) {
    throw new Error("kanıt has no findings — an empty work proof certifies nothing");
  }

  const verdict = kanit === null ? null : verifyKanitHashes(kanit);
  const gatesOk = verdict === null ? false : kanitHashGatesOk(verdict);

  const contractFindings = (kanit?.findings ?? []).map((f, i) => contractFindingToUnified(f, gatesOk, i));
  const dbFindings = (scan?.recommendations ?? []).map((r, i) => recommendationToUnified(r, i));

  const findings: UnifiedFinding[] = [...contractFindings, ...dbFindings].sort((a, b) => {
    const d = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    // stable tiebreak: source, then id — so two equal-severity findings never
    // shuffle between runs and the package id stays deterministic
    return d !== 0 ? d : a.source !== b.source ? (a.source < b.source ? -1 : 1) : a.id < b.id ? -1 : 1;
  });

  const contract = contractSummary(kanit, gatesOk);
  const database = databaseSummary(scan);
  const gate = dualGate(contract, database, kanit, scan);

  const notes: string[] = [];
  if (kanit !== null && !gatesOk) {
    notes.push(
      "AegisForge kanıt failed the recomputed hash gates — contract findings are labeled hash-mismatch and excluded from the act decision.",
    );
  }
  if (database.grounded > 0) {
    notes.push(
      `${database.grounded} pgHeal recommendation(s) are grounded (HypoPG cannot simulate the index method) — estimates, not proofs.`,
    );
  }
  if (verdict !== null) {
    notes.push(
      "Signature and address gates of the kanıt are secp256k1 and are deferred to `aegisforge verify` — this twin recomputes only the SHA-256 commitments.",
    );
  }

  return {
    schema: "pgheal-contract-twin/1",
    id: dualPackageId(kanit, scan),
    contract,
    database,
    findings,
    gate,
    notes,
  };
}

/** The merged verdict: what is proven, by which oracle, and what to do about it. */
function dualGate(
  contract: ContractSummary,
  database: DatabaseSummary,
  kanit: WorkProof | null,
  scan: ScanResult | null,
): DualGate {
  const contractProven = kanit !== null && contract.findings > 0 && contract.hashGatesOk;
  const dbProven = database.proven > 0;
  const reasons: string[] = [];

  if (contractProven) {
    reasons.push(
      `AegisForge: ${contract.findings} finding(s) attested by a kanıt whose Merkle root and kanıt hash re-verify (${contract.severityCounts.critical} critical, ${contract.severityCounts.high} high).`,
    );
  } else if (kanit !== null) {
    reasons.push(
      contract.hashGatesOk
        ? `AegisForge: kanıt parsed but carries no findings — nothing to attest.`
        : `AegisForge: kanıt present but its recomputed hash gates FAILED — findings are unverified claims, not proof.`,
    );
  } else {
    reasons.push("AegisForge: no kanıt supplied — the contract half is absent from this package.");
  }

  if (dbProven) {
    reasons.push(
      `pgHeal: ${database.proven} HypoPG-proven index recommendation(s)` +
        (database.bestSpeedup !== null ? ` (best ${database.bestSpeedup.toFixed(1)}x speedup)` : "") +
        ".",
    );
  } else if (scan !== null) {
    reasons.push(
      database.proven === 0 && database.grounded > 0
        ? "pgHeal: only grounded (non-simulable) recommendations — estimates, not proofs."
        : "pgHeal: scan supplied but no recommendation was planner-proven (proof or silence).",
    );
  } else {
    reasons.push("pgHeal: no scan supplied — the database half is absent from this package.");
  }

  const decision = contractProven && dbProven ? "act" : contractProven || dbProven ? "review" : "clean";
  return { decision, reasons };
}
