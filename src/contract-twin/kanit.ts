/**
 * kanıt ingestion — parse an AegisForge kanıt and re-verify its recomputable
 * hash gates in pure TypeScript.
 *
 * Every digest here is rebuilt from the published fields alone, following the
 * byte-format spec in `crates/aegisforge/src/kanit.rs` of the AegisForge repo:
 * length-prefixed (`u32` big-endian) fields, domain-separated leaves/nodes, a
 * canonically-sorted Merkle tree (odd levels duplicate the last node, RFC 6962
 * §2.1) and a final preimage over root + timestamp + engine version + chain id.
 * Two independent implementations of that spec agreeing digest-for-digest is what
 * makes this a real code link rather than a doc link — the cross-language check
 * lives in `test/contract-twin.test.ts` against a kanıt minted by the Rust
 * engine itself.
 *
 * The two secp256k1/keccak gates are deliberately NOT attempted here: faking
 * them would be exactly the "claim, not proof" failure both tools exist to
 * prevent, so they stay deferred to `aegisforge verify` (see
 * `KanitHashVerdict.signature_gate`).
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  FindingLeaf,
  KanitParseErrorReason,
  KanitParseResult,
  KanitHashVerdict,
  WorkProof,
} from "./types.js";

/** Domain-separation tags — must match the Rust constants byte-for-byte. */
const LEAF_DOMAIN = Buffer.from("aegisforge-kanit-leaf-v1", "utf8");
const NODE_DOMAIN = Buffer.from("aegisforge-kanit-node-v1", "utf8");
const KANIT_DOMAIN = Buffer.from("aegisforge-kanit-v1", "utf8");

/** The kanıt byte-format version this verifier understands. */
export const KANIT_FORMAT_VERSION = "1";
/** Reported for a kanıt that carries no format stamp (it still verifies). */
export const KANIT_FORMAT_LEGACY = "legacy";

// ---------------------------------------------------------------- schemas ----

const SeveritySchema = z.string().min(1);

const FindingLeafSchema = z.object({
  contract: z.string().min(1),
  function: z.string().min(1),
  invariant_id: z.string().min(1),
  severity: SeveritySchema,
  witness: z.string().min(1),
  // minted kanıts always emit the key (null when absent); findings files may omit
  block_number: z.number().int().nonnegative().nullish(),
});

const SignerSchema = z.object({
  address: z.string().min(1),
  pubkey: z.string().min(1),
  did: z.string().nullish(),
});

const WorkProofSchema = z.object({
  engine_version: z.string().min(1),
  kanit_format_version: z.string().nullish(),
  timestamp: z.number().int().nonnegative(),
  chain_id: z.number().int().nonnegative().nullish(),
  findings: z.array(FindingLeafSchema).min(1),
  merkle_root: z.string().min(1),
  kanit_hash: z.string().min(1),
  signer: SignerSchema,
  signature: z.string().min(1),
});

// ------------------------------------------------------------- byte format ---

function u32be(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

function u64be(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n), 0);
  return b;
}

function sha256(parts: Buffer[]): Buffer {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
}

function pushField(out: Buffer[], s: string): void {
  out.push(u32be(s.length), Buffer.from(s, "utf8"));
}

/** The exact leaf encoding a verifier must reproduce (see the Rust spec). */
function leafCanonicalBytes(f: FindingLeaf): Buffer {
  const out: Buffer[] = [LEAF_DOMAIN];
  pushField(out, f.contract);
  pushField(out, f.function);
  pushField(out, f.invariant_id);
  pushField(out, f.severity);
  pushField(out, f.witness);
  if (f.block_number !== null) {
    out.push(Buffer.from([1]), u64be(f.block_number));
  } else {
    out.push(Buffer.from([0]));
  }
  return Buffer.concat(out);
}

/** SHA-256 over the canonical leaf bytes — one Merkle leaf. */
export function leafHash(f: FindingLeaf): Buffer {
  return sha256([leafCanonicalBytes(f)]);
}

/** Canonical sort key; sorting by it makes the root order-independent. */
function sortKey(f: FindingLeaf): [string, string, string, string] {
  return [f.invariant_id, f.contract, f.function, f.witness];
}

/** Lexicographic tuple comparison — matches Rust's slice `cmp` for ASCII keys. */
function compareKeys(
  a: [string, string, string, string],
  b: [string, string, string, string],
): number {
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/** Sorted leaf hashes — minter and verifier must walk the same order. */
function sortedLeafHashes(findings: FindingLeaf[]): Buffer[] {
  return [...findings]
    .sort((a, b) => compareKeys(sortKey(a), sortKey(b)))
    .map((f) => leafHash(f));
}

/**
 * The Merkle root over the findings. Empty findings have no root — certifying
 * nothing is not proof of work, so this throws like the Rust engine does.
 */
export function merkleRoot(findings: FindingLeaf[]): Buffer {
  if (findings.length === 0) {
    throw new Error("kanıt has no findings — an empty work proof certifies nothing");
  }
  let level = sortedLeafHashes(findings);
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      // odd out: the last node is its own sibling
      const right = i + 1 < level.length ? level[i + 1]! : left;
      next.push(sha256([NODE_DOMAIN, left, right]));
    }
    level = next;
  }
  return level[0]!;
}

/** The exact kanıt preimage (see the byte-format spec). */
export function kanitPreimage(
  root: Buffer,
  timestamp: number,
  engineVersion: string,
  chainId: number | null,
): Buffer {
  const out: Buffer[] = [
    KANIT_DOMAIN,
    root,
    u64be(timestamp),
    u32be(engineVersion.length),
    Buffer.from(engineVersion, "utf8"),
  ];
  if (chainId !== null) {
    out.push(Buffer.from([1]), u64be(chainId));
  } else {
    out.push(Buffer.from([0]));
  }
  return Buffer.concat(out);
}

/** SHA-256 over the kanıt preimage, `0x`-prefixed hex. */
export function kanitHashHex(
  root: Buffer,
  timestamp: number,
  engineVersion: string,
  chainId: number | null,
): string {
  return "0x" + sha256([kanitPreimage(root, timestamp, engineVersion, chainId)]).toString("hex");
}

// ------------------------------------------------------------------ parse ----

/**
 * Parse a kanıt from JSON. Tolerant where the wire format is optional
 * (`block_number`, `chain_id`, `did`, `kanit_format_version` — normalized to
 * `null`/absent) and strict where the commitment lives (findings, hashes,
 * signer). Never returns a half-parsed kanıt: on failure `ok` is false and
 * `reason` names the problem.
 */
export function parseKanit(input: string | Record<string, unknown>): KanitParseResult {
  let raw: unknown;
  try {
    raw = typeof input === "string" ? (JSON.parse(input) as unknown) : input;
  } catch (e) {
    return {
      ok: false,
      reason: "not-an-object",
      detail: e instanceof Error ? e.message : "invalid JSON",
    };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "not-an-object", detail: "kanıt must be a JSON object" };
  }
  const parsed = WorkProofSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.join(".") ?? "<root>";
    return {
      ok: false,
      reason: first?.code === "too_small" && path.endsWith("findings") ? "no-findings" : "bad-shape",
      detail: `${path}: ${first?.message ?? "validation failed"}`,
    };
  }
  const p = parsed.data;
  const proof: WorkProof = {
    engine_version: p.engine_version,
    kanit_format_version: p.kanit_format_version === null ? undefined : p.kanit_format_version,
    timestamp: p.timestamp,
    chain_id: p.chain_id ?? null,
    findings: p.findings.map((f) => ({
      contract: f.contract,
      function: f.function,
      invariant_id: f.invariant_id,
      severity: f.severity,
      witness: f.witness,
      block_number: f.block_number ?? null,
    })),
    merkle_root: p.merkle_root,
    kanit_hash: p.kanit_hash,
    signer: {
      address: p.signer.address,
      pubkey: p.signer.pubkey,
      did: p.signer.did ?? null,
    },
    signature: p.signature,
  };
  return { ok: true, proof };
}

// ---------------------------------------------------------------- verify ----

/** Decode a `0x`-prefixed hex string into exactly N bytes, or null. */
function hexFixed(s: string, n: number): Buffer | null {
  const body = s.startsWith("0x") ? s.slice(2) : s;
  if (body.length !== 2 * n) return null;
  try {
    const b = Buffer.from(body, "hex");
    return b.length === n ? b : null;
  } catch {
    return null;
  }
}

/**
 * Re-verify the two recomputable gates of a kanıt from its published fields
 * alone. No secret, no out-of-band channel — recompute every hash, compare.
 *
 * The format gate is checked first and reflected in `format_version`: a kanıt
 * stamping a layout this verifier does not know is reported as a bad shape by
 * `parseKanit`, and one with no stamp verifies as `legacy` (the layout
 * predating the stamp is the layout this code still builds). This function
 * never throws — a verdict names every gate instead, the way pgHeal reports
 * rejection reasons instead of silently dropping candidates.
 */
export function verifyKanitHashes(proof: WorkProof): KanitHashVerdict {
  const root = hexFixed(proof.merkle_root, 32);
  const kanit = hexFixed(proof.kanit_hash, 32);

  let merkleRootOk = false;
  let kanitHashOk = false;
  if (root !== null) {
    // gate 1: the published root must be the root of the published findings
    merkleRootOk = merkleRoot(proof.findings).equals(root);
    if (kanit !== null) {
      // gate 2: the published kanıt hash must recompute from the published inputs
      kanitHashOk =
        kanitHashHex(root, proof.timestamp, proof.engine_version, proof.chain_id) === proof.kanit_hash;
    }
  }

  return {
    format_version: proof.kanit_format_version === undefined ? KANIT_FORMAT_LEGACY : proof.kanit_format_version,
    merkle_root_ok: merkleRootOk,
    kanit_hash_ok: kanitHashOk,
    finding_count: proof.findings.length,
    merkle_root: proof.merkle_root,
    kanit_hash: proof.kanit_hash,
    address: proof.signer.address,
    signature_gate: "deferred-to-aegisforge",
  };
}

/**
 * True only when every recomputable hash gate is green. The signature and
 * address gates still need `aegisforge verify` — see `signature_gate`.
 */
export function kanitHashGatesOk(verdict: KanitHashVerdict): boolean {
  return verdict.merkle_root_ok && verdict.kanit_hash_ok;
}

/** Re-exported for callers that want the error-reason union without the type. */
export type { KanitParseErrorReason };
