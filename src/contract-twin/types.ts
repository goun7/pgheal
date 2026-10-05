/**
 * contract-twin — the AegisForge (Temporit) half of pgHeal's "dual package".
 *
 * pgHeal's README already links AegisForge as *the contract twin*: the same
 * "prove it, don't guess it" funnel pointed at EVM bytecode instead of the
 * PostgreSQL planner, mints a signed kanıt where pgHeal carries HypoPG cost
 * numbers. This module is the code link — it ingests an AegisForge kanıt,
 * re-verifies the commitment gates anyone can recompute, and merges it with a
 * pgHeal scan into one dual package ("DB + contract security", one customer).
 *
 * The wire types below mirror the Rust structs field-for-field and keep their
 * snake_case names, so a kanıt JSON emitted by `aegisforge kanit` parses here
 * and — critically — re-hashes to the same digests. The byte format they follow
 * is documented in `crates/aegisforge/src/kanit.rs` of the AegisForge repo.
 */

/** AegisForge's severity ladder (`FindingLeaf::severity`). */
export type KanitSeverity = "critical" | "high" | "medium" | "low";

/** Unified severity adds pgHeal's own informational tier (index hygiene notes). */
export type UnifiedSeverity = KanitSeverity | "info";

/**
 * One detected contract violation — a leaf of the kanıt Merkle tree. Every
 * field is published plaintext because an outsider recomputes the tree from it.
 */
export interface FindingLeaf {
  /** Contract name or `0x`-address where the violation was found. */
  contract: string;
  /** Function (or selector) whose execution reaches the violation. */
  function: string;
  /** Stable invariant id (`AF-INV-101`, ...). */
  invariant_id: string;
  /** Kept verbatim: it is hash-bound, so any string can appear on the wire. */
  severity: string;
  /** The concrete counterexample / exploit trace the solver returned. */
  witness: string;
  /** On-chain block number when the violation was observed live, else null. */
  block_number: number | null;
}

/** The signer identity carried inside the kanıt. */
export interface Signer {
  /** `0x` + 40 hex — keccak256(pubkey)[12..32]. */
  address: string;
  /** `0x` + 128 hex — uncompressed secp256k1 public key, no `04` prefix. */
  pubkey: string;
  /** Kredent DID (`did:agent:68:key:...`) when the signer is a registered agent. */
  did: string | null;
}

/** A signed proof-of-work minted by AegisForge — the kanıt. */
export interface WorkProof {
  engine_version: string;
  /** Byte-format version of the kanıt; absent on kanıts minted before the stamp. */
  kanit_format_version?: string | undefined;
  /** Unix seconds when the kanıt was minted (part of the hash domain). */
  timestamp: number;
  chain_id: number | null;
  findings: FindingLeaf[];
  /** `0x` + 64 hex — Merkle root over all findings. */
  merkle_root: string;
  /** `0x` + 64 hex — SHA-256 over the kanıt preimage. */
  kanit_hash: string;
  signer: Signer;
  /** `0x` + 128 hex — raw ECDSA r‖s over `kanit_hash`. */
  signature: string;
}

/**
 * The hash gates of a kanıt, recomputed in TypeScript from the published fields
 * alone. These are the two gates that are pure SHA-256 and therefore
 * cross-language reproducible; the address and secp256k1 signature gates stay
 * with `aegisforge verify` (see `signature_gate`).
 */
export interface KanitHashVerdict {
  /** `"1"` for a current kanıt, `"legacy"` for one minted before the stamp. */
  format_version: string;
  /** The published root equals the root of the published findings. */
  merkle_root_ok: boolean;
  /** The published kanıt hash recomputes from root + timestamp + version + chain. */
  kanit_hash_ok: boolean;
  finding_count: number;
  merkle_root: string;
  kanit_hash: string;
  address: string;
  /**
   * Always `"deferred-to-aegisforge"`: the addr↔pubkey (keccak256) and ECDSA
   * gates need secp256k1, which this TypeScript twin does not implement. The
   * twin never fakes them — run `aegisforge verify kanit.json` for the full
   * four-gate check, the same way pgHeal refuses to ship unproven candidates.
   */
  signature_gate: "deferred-to-aegisforge";
}

/** Why a kanıt could not be parsed. */
export type KanitParseErrorReason =
  | "not-an-object"
  | "no-findings"
  | "bad-shape"
  | "bad-hex-length";

/** Result of parsing a kanıt — pgHeal's explicit-result convention. */
export interface KanitParseResult {
  ok: boolean;
  proof?: WorkProof | undefined;
  reason?: KanitParseErrorReason | undefined;
  detail?: string | undefined;
}

/** Which half of the dual package a unified finding came from. */
export type FindingSource = "contract" | "database";

/**
 * How the finding was established. The twin never upgrades a claim past its own
 * evidence: a kanıt whose recomputed hashes disagree is `hash-mismatch`, never
 * `signed-kanit`.
 */
export type ProofStatus =
  | "signed-kanit"
  | "hypopg-proven"
  | "grounded"
  | "hash-mismatch"
  | "unproven";

/** One finding, normalized across both oracles. */
export interface UnifiedFinding {
  /** Deterministic id: `<source>:<fingerprint>`. */
  id: string;
  source: FindingSource;
  severity: UnifiedSeverity;
  title: string;
  detail: string;
  /** The machine-checkable evidence: kanıt witness, or the planner's cost delta. */
  evidence: string;
  proofStatus: ProofStatus;
  action: string;
  /** Where the finding lives — contract side or DB side, only the relevant keys. */
  locator: {
    contract?: string | undefined;
    function?: string | undefined;
    table?: string | undefined;
    columns?: string[] | undefined;
    index?: string | undefined;
  };
}

/** The merged verdict of the dual package. */
export interface DualGate {
  /**
   * `act` — both oracles delivered proof (a kanıt that re-hashes green AND a
   * HypoPG-proven index): the "DB + contract security" conversation is live.
   * `review` — exactly one half is proven; the other half is evidence, not proof.
   * `clean` — neither oracle found anything actionable.
   */
  decision: "act" | "review" | "clean";
  /** One line per half, naming what was proven and what was not. */
  reasons: string[];
}

/** The contract half of the summary. */
export interface ContractSummary {
  engine: "AegisForge";
  engineVersion: string;
  kanitHash: string | null;
  merkleRoot: string | null;
  signer: string | null;
  chainId: number | null;
  findings: number;
  severityCounts: Record<KanitSeverity, number>;
  /** Both recomputable hash gates passed. */
  hashGatesOk: boolean;
}

/** The database half of the summary. */
export interface DatabaseSummary {
  engine: "pgHeal";
  proven: number;
  /** HypoPG cannot simulate these (e.g. HNSW) — honestly labeled, never faked. */
  grounded: number;
  cleanupCandidates: number;
  /** Estimated bytes of write overhead per day from the drop candidates. */
  writeOverheadBytesPerDay: number;
  /** Best speedup factor among the proven recommendations, null if none. */
  bestSpeedup: number | null;
}

/**
 * The dual package — one artifact bundling contract-security findings and
 * database indexing advice for the same customer, with each side carrying its
 * own proof and the merged gate saying what is actionable.
 */
export interface DualPackage {
  schema: "pgheal-contract-twin/1";
  /** Deterministic SHA-256 fingerprint: same inputs ⇒ same id, either order. */
  id: string;
  contract: ContractSummary;
  database: DatabaseSummary;
  /** Unified findings, most severe first; canonical order keeps the id stable. */
  findings: UnifiedFinding[];
  gate: DualGate;
  notes: string[];
}
