/**
 * contract-twin — the AegisForge (Temporit) ↔ pgHeal dual-package bridge.
 *
 * Public surface: parse and re-verify an AegisForge kanıt, merge it with a
 * pgHeal scan into one dual package, and render the combined report. The twin
 * links the contract-security oracle to the database oracle so both halves of
 * the "DB + contract security" sale land in one artifact — each side still
 * carrying its own proof.
 */

export type {
  ContractSummary,
  DatabaseSummary,
  DualGate,
  DualPackage,
  FindingLeaf,
  FindingSource,
  KanitHashVerdict,
  KanitParseErrorReason,
  KanitParseResult,
  KanitSeverity,
  ProofStatus,
  Signer,
  UnifiedFinding,
  UnifiedSeverity,
  WorkProof,
} from "./types.js";

export {
  KANIT_FORMAT_LEGACY,
  KANIT_FORMAT_VERSION,
  kanitHashGatesOk,
  kanitHashHex,
  kanitPreimage,
  leafHash,
  merkleRoot,
  parseKanit,
  verifyKanitHashes,
} from "./kanit.js";

export {
  SEVERITY_ORDER,
  buildDualPackage,
  dualPackageId,
  toCanonicalSeverity,
} from "./bridge.js";

export { dualPackageToJson, renderDualReport } from "./render.js";
