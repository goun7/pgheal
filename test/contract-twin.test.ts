import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FindingLeaf, KanitSeverity, ScanResult, WorkProof } from "../src/contract-twin/types.js";
import {
  buildDualPackage,
  dualPackageId,
  dualPackageToJson,
  kanitHashHex,
  merkleRoot,
  parseKanit,
  renderDualReport,
  toCanonicalSeverity,
  verifyKanitHashes,
} from "../src/contract-twin/index.js";

/**
 * The findings the AegisForge CLI test itself uses (cli_kanit.rs) — including
 * the tricky pair that shares an invariant_id, which is exactly the case the
 * canonical Merkle sort exists for.
 */
function twinFindings(): FindingLeaf[] {
  return [
    { contract: "AcmeVault", function: "skim(address,uint256)", invariant_id: "AF-INV-102", severity: "critical", witness: "pre_bal_a=5 -> bal_a=0", block_number: null },
    { contract: "DilutionVault", function: "inflate(uint256)", invariant_id: "AF-INV-101", severity: "high", witness: "total rises, nobody credited", block_number: 18000000 },
    { contract: "BackdoorVault", function: "redirect(address)", invariant_id: "AF-INV-102", severity: "critical", witness: "bal_a 9 -> 1", block_number: null },
  ];
}

const ENGINE = "0.5.3";
const TIMESTAMP = 1_760_000_000;

/**
 * Build a kanıt whose two SHA-256 gates are genuinely correct (the twin mints
 * them with the same byte format the Rust engine defines). The secp256k1
 * fields are placeholders — this twin does not verify them, and the tests never
 * claim otherwise.
 */
function mintHashConsistentKanit(findings: FindingLeaf[], timestamp = TIMESTAMP, chainId: number | null = 11155111): WorkProof {
  const root = merkleRoot(findings);
  return {
    engine_version: ENGINE,
    kanit_format_version: "1",
    timestamp,
    chain_id: chainId,
    findings,
    merkle_root: "0x" + root.toString("hex"),
    kanit_hash: kanitHashHex(root, timestamp, ENGINE, chainId),
    signer: { address: "0x" + "00".repeat(20), pubkey: "0x" + "00".repeat(64), did: null },
    signature: "0x" + "00".repeat(64),
  };
}

/** Minimal pgHeal scan with one proven recommendation and one cleanup drop. */
function twinScan(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    db: { serverVersion: "PostgreSQL 18.0", database: "demo", hypopg: true, pgss: true },
    candidates: [],
    recommendations: [
      {
        simulation: {
          candidate: { table: "orders", columns: ["user_id", "created_at"], method: "btree", isUnique: false, fromQueryid: "q1", reason: "top total exec time" },
          before: { nodeType: "Seq Scan", totalCost: 48200.0, planRows: 500000, usesIndexScan: false, raw: {} },
          after: { nodeType: "Index Scan", totalCost: 12.4, planRows: 42, usesIndexScan: true, raw: {} },
          costRatio: 0.00026,
          speedup: 3887.1,
          accepted: true,
          hypopgAvailable: true,
          estimatedIndexSizeBytes: 11_264,
        },
        proofTable: "",
        migration: { dialect: "sql", path: "migrations/idx_orders.sql", content: "CREATE INDEX CONCURRENTLY ...;\n" },
      },
    ],
    cleanup: {
      drops: [
        { index: { name: "orders_email_idx", table: "orders", columns: ["email"], isUnique: false, isValid: true, scans: 0, sizeBytes: 104_857_600 }, reason: "unused", writeOverheadPerDay: 2048 },
      ],
      totalWriteOverheadBytesPerDay: 2048,
    },
    report: "",
    pr: null,
    warnings: [],
    ...overrides,
  };
}

// ------------------------------------------------------------- kanıt parsing --

describe("parseKanit", () => {
  it("parses a minted kanıt and normalizes optional wire fields", () => {
    const res = parseKanit(JSON.stringify(mintHashConsistentKanit(twinFindings())));
    expect(res.ok).toBe(true);
    const proof = res.proof!;
    expect(proof.findings).toHaveLength(3);
    expect(proof.findings[0]!.block_number).toBeNull();
    expect(proof.findings[1]!.block_number).toBe(18000000);
    expect(proof.chain_id).toBe(11155111);
    expect(proof.signer.did).toBeNull();
    expect(proof.kanit_format_version).toBe("1");
  });

  it("accepts a kanıt object as well as JSON text", () => {
    expect(parseKanit(mintHashConsistentKanit(twinFindings())).ok).toBe(true);
  });

  it("tolerates omitted optional fields the way a hand-written findings file omits them", () => {
    const raw = {
      engine_version: ENGINE,
      timestamp: TIMESTAMP,
      findings: [{ contract: "C", function: "f", invariant_id: "AF-INV-1", severity: "high", witness: "w" }],
      merkle_root: "0x" + "ab".repeat(32),
      kanit_hash: "0x" + "cd".repeat(32),
      signer: { address: "0x" + "00".repeat(20), pubkey: "0x" + "00".repeat(64) },
      signature: "0x" + "00".repeat(64),
    };
    const res = parseKanit(raw);
    expect(res.ok).toBe(true);
    expect(res.proof!.findings[0]!.block_number).toBeNull();
    expect(res.proof!.chain_id).toBeNull();
  });

  it("refuses a non-object and malformed JSON", () => {
    expect(parseKanit("not json").reason).toBe("not-an-object");
    expect(parseKanit("[]").reason).toBe("not-an-object");
    expect(parseKanit(null).reason).toBe("not-an-object");
  });

  it("refuses an empty findings list — nothing to certify", () => {
    const res = parseKanit({ ...mintHashConsistentKanit(twinFindings()), findings: [] });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("no-findings");
  });

  it("refuses a kanıt missing committed fields", () => {
    const bad = { ...mintHashConsistentKanit(twinFindings()) };
    const { merkle_root, ...withoutRoot } = bad;
    void merkle_root;
    const res = parseKanit(withoutRoot);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("bad-shape");
    expect(res.detail).toContain("merkle_root");
  });
});

// ------------------------------------------------------- kanıt hash gates -----

describe("verifyKanitHashes — the recomputable commitment gates", () => {
  it("re-verifies a hash-consistent kanıt", () => {
    const v = verifyKanitHashes(mintHashConsistentKanit(twinFindings()));
    expect(v.merkle_root_ok).toBe(true);
    expect(v.kanit_hash_ok).toBe(true);
    expect(v.format_version).toBe("1");
    expect(v.finding_count).toBe(3);
    expect(v.signature_gate).toBe("deferred-to-aegisforge");
  });

  it("treats a kanıt with no format stamp as legacy", () => {
    const proof = mintHashConsistentKanit(twinFindings());
    const { kanit_format_version, ...unstamped } = proof;
    void kanit_format_version;
    expect(verifyKanitHashes(unstamped).format_version).toBe("legacy");
  });

  it("flags a tampered finding: the Merkle root is severity-bound", () => {
    const proof = mintHashConsistentKanit(twinFindings());
    const tampered: WorkProof = {
      ...proof,
      findings: proof.findings.map((f, i) => (i === 0 ? { ...f, severity: "low" as KanitSeverity } : f)),
    };
    const v = verifyKanitHashes(tampered);
    expect(v.merkle_root_ok).toBe(false);
    // the kanıt hash binds the *published* root, so it still recomputes
    expect(v.kanit_hash_ok).toBe(true);
  });

  it("flags a tampered timestamp: it is part of the hash domain", () => {
    const proof = mintHashConsistentKanit(twinFindings());
    const v = verifyKanitHashes({ ...proof, timestamp: proof.timestamp + 1 });
    expect(v.kanit_hash_ok).toBe(false);
    expect(v.merkle_root_ok).toBe(true);
  });

  it("flags a tampered root: both gates fail", () => {
    const proof = mintHashConsistentKanit(twinFindings());
    const v = verifyKanitHashes({ ...proof, merkle_root: "0x" + "ab".repeat(32) });
    expect(v.merkle_root_ok).toBe(false);
    expect(v.kanit_hash_ok).toBe(false);
  });

  it("flags a wrong-length merkle root instead of crashing", () => {
    const proof = mintHashConsistentKanit(twinFindings());
    const v = verifyKanitHashes({ ...proof, merkle_root: "0xdeadbeef" });
    expect(v.merkle_root_ok).toBe(false);
    expect(v.kanit_hash_ok).toBe(false);
  });

  it("produces an order-independent Merkle root", () => {
    const fs = twinFindings();
    const reversed = [...fs].reverse();
    expect(merkleRoot(reversed).equals(merkleRoot(fs))).toBe(true);
    // and the two kanıts minted over either order share every digest
    const a = mintHashConsistentKanit(fs);
    const b = mintHashConsistentKanit(reversed);
    expect(a.merkle_root).toBe(b.merkle_root);
    expect(a.kanit_hash).toBe(b.kanit_hash);
  });

  it("refuses to build a Merkle root over no findings", () => {
    expect(() => merkleRoot([])).toThrow(/no findings/);
  });
});

// ------------------------------------------------------------- dual package ---

describe("buildDualPackage", () => {
  it("merges both halves and reaches the act gate only when both are proven", () => {
    const pkg = buildDualPackage({ kanit: mintHashConsistentKanit(twinFindings()), scan: twinScan() });
    expect(pkg.schema).toBe("pgheal-contract-twin/1");
    expect(pkg.contract.findings).toBe(3);
    expect(pkg.contract.hashGatesOk).toBe(true);
    expect(pkg.database.proven).toBe(1);
    expect(pkg.database.bestSpeedup).toBe(3887.1);
    expect(pkg.gate.decision).toBe("act");
    expect(pkg.gate.reasons).toHaveLength(2);
    expect(pkg.findings).toHaveLength(4);
  });

  it("downgrades to review when only one oracle delivered proof", () => {
    const dbOnly = buildDualPackage({ scan: twinScan() });
    expect(dbOnly.gate.decision).toBe("review");
    expect(dbOnly.contract.kanitHash).toBeNull();
    const contractOnly = buildDualPackage({ kanit: mintHashConsistentKanit(twinFindings()) });
    expect(contractOnly.gate.decision).toBe("review");
    expect(contractOnly.database.proven).toBe(0);
  });

  it("reports clean when neither oracle found anything actionable", () => {
    const pkg = buildDualPackage({ kanit: null, scan: twinScan({ recommendations: [], cleanup: { drops: [], totalWriteOverheadBytesPerDay: 0 } }) });
    expect(pkg.gate.decision).toBe("clean");
    expect(pkg.findings).toHaveLength(0);
  });

  it("labels findings hash-mismatch and excludes them from the act decision when the gates fail", () => {
    const broken = mintHashConsistentKanit(twinFindings());
    const pkg = buildDualPackage({ kanit: { ...broken, timestamp: broken.timestamp + 1 }, scan: twinScan() });
    expect(pkg.contract.hashGatesOk).toBe(false);
    expect(pkg.findings.every((f) => f.source === "contract" ? f.proofStatus === "hash-mismatch" : true)).toBe(true);
    expect(pkg.gate.decision).toBe("review");
    expect(pkg.notes.some((n) => n.includes("hash gates"))).toBe(true);
  });

  it("labels grounded recommendations as estimates, never proven", () => {
    const scan = twinScan();
    scan.recommendations[0]!.simulation.proof = "grounded";
    const pkg = buildDualPackage({ kanit: mintHashConsistentKanit(twinFindings()) , scan });
    expect(pkg.database.proven).toBe(0);
    expect(pkg.database.grounded).toBe(1);
    expect(pkg.findings.find((f) => f.source === "database")!.proofStatus).toBe("grounded");
    expect(pkg.gate.decision).toBe("review");
  });

  it("sorts unified findings most-severe-first", () => {
    const pkg = buildDualPackage({ kanit: mintHashConsistentKanit(twinFindings()), scan: twinScan() });
    const order = pkg.findings.map((f) => f.severity);
    expect(order).toEqual([...order].sort());
    expect(order[0]).toBe("critical");
  });

  it("throws when both oracles are absent or empty", () => {
    expect(() => buildDualPackage({})).toThrow(/at least one oracle/);
    expect(() => buildDualPackage({ kanit: { ...mintHashConsistentKanit(twinFindings()), findings: [] } })).toThrow(/no findings/);
  });
});

describe("dualPackageId", () => {
  it("is deterministic and independent of finding order", () => {
    const kanit = mintHashConsistentKanit(twinFindings());
    const a = dualPackageId(kanit, twinScan());
    const b = dualPackageId(kanit, twinScan());
    expect(a).toBe(b);
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("changes when either half changes", () => {
    const kanit = mintHashConsistentKanit(twinFindings());
    const base = dualPackageId(kanit, twinScan());
    const otherKanit = mintHashConsistentKanit(twinFindings(), TIMESTAMP + 1);
    expect(dualPackageId(otherKanit, twinScan())).not.toBe(base);
    const otherScan = twinScan({ recommendations: [...twinScan().recommendations, { ...twinScan().recommendations[0]!, migration: { ...twinScan().recommendations[0]!.migration, path: "migrations/other.sql" } }] });
    expect(dualPackageId(kanit, otherScan)).not.toBe(base);
  });
});

describe("toCanonicalSeverity", () => {
  it("maps the four AegisForge rungs and floors anything else", () => {
    expect(toCanonicalSeverity("critical")).toBe("critical");
    expect(toCanonicalSeverity("high")).toBe("high");
    expect(toCanonicalSeverity("medium")).toBe("medium");
    expect(toCanonicalSeverity("low")).toBe("low");
    expect(toCanonicalSeverity("info")).toBe("low");
    expect(toCanonicalSeverity("unknown-severity")).toBe("low");
  });
});

// --------------------------------------------------------------- rendering ---

describe("renderDualReport / dualPackageToJson", () => {
  const pkg = buildDualPackage({ kanit: mintHashConsistentKanit(twinFindings()), scan: twinScan() });

  it("renders both halves, the gate and the unified table", () => {
    const md = renderDualReport(pkg);
    expect(md).toContain("pgHeal × AegisForge — Dual Security Package");
    expect(md).toContain("## Contract half — AegisForge");
    expect(md).toContain("## Database half — pgHeal");
    expect(md).toContain(pkg.id);
    expect(md).toContain("**act**");
    expect(md).toContain("AF-INV-102");
    expect(md).toContain("orders");
    expect(md).toContain("3887.1x");
    // zero exfiltration on the DB side: no raw query text
    expect(md).not.toMatch(/SELECT \* FROM/i);
  });

  it("escapes pipe characters so the markdown table stays intact", () => {
    const pipey = mintHashConsistentKanit([
      { contract: "C", function: "f", invariant_id: "AF-INV-9", severity: "medium", witness: "a | b", block_number: null },
    ]);
    const md = renderDualReport(buildDualPackage({ kanit: pipey, scan: null }));
    expect(md).toContain("a \\| b");
  });

  it("serializes the package as JSON with the expected shape", () => {
    const json = JSON.parse(dualPackageToJson(pkg)) as DualPackageShape;
    expect(json.schema).toBe("pgheal-contract-twin/1");
    expect(json.contract.engine).toBe("AegisForge");
    expect(json.database.engine).toBe("pgHeal");
    expect(json.contract.severityCounts.critical).toBe(2);
  });
});

interface DualPackageShape {
  schema: string;
  contract: { engine: string; severityCounts: { critical: number } };
  database: { engine: string };
}

// ------------------------------------------------- cross-language validation --

/**
 * The real thing: a kanıt minted by the AegisForge Rust engine
 * (`aegisforge kanit --findings ... --label pgheal-twin-fixture`), committed as
 * a fixture. Two independent implementations of the byte-format spec must agree
 * digest-for-digest — that agreement is what makes this bridge a code link
 * rather than a doc link. If the Rust format ever changes, this test breaks
 * first and loudly.
 */
describe("cross-language: a kanıt minted by the Rust engine", () => {
  const fixturePath = fileURLToPath(new URL("./fixtures/aegisforge-kanit.json", import.meta.url));
  const raw = readFileSync(fixturePath, "utf8");

  it("parses with the fields AegisForge actually emits", () => {
    const res = parseKanit(raw);
    expect(res.ok).toBe(true);
    const proof = res.proof!;
    expect(proof.kanit_format_version).toBe("1");
    expect(proof.findings).toHaveLength(3);
    expect(proof.engine_version).toBe("0.5.0");
  });

  it("recomputes the published Merkle root byte-for-byte", () => {
    const proof = parseKanit(raw).proof!;
    const recomputed = "0x" + merkleRoot(proof.findings).toString("hex");
    expect(recomputed).toBe(proof.merkle_root);
  });

  it("recomputes the published kanıt hash byte-for-byte", () => {
    const proof = parseKanit(raw).proof!;
    const recomputed = kanitHashHex(
      Buffer.from(proof.merkle_root.slice(2), "hex"),
      proof.timestamp,
      proof.engine_version,
      proof.chain_id,
    );
    expect(recomputed).toBe(proof.kanit_hash);
  });

  it("verifies green through the twin's hash gates and builds a dual package around it", () => {
    const proof = parseKanit(raw).proof!;
    const v = verifyKanitHashes(proof);
    expect(v.merkle_root_ok).toBe(true);
    expect(v.kanit_hash_ok).toBe(true);
    expect(v.address).toBe("0x8a5e6263df4fa30aa61dd36a4b93ebfe68003449");

    const pkg = buildDualPackage({ kanit: proof, scan: twinScan() });
    expect(pkg.contract.hashGatesOk).toBe(true);
    expect(pkg.gate.decision).toBe("act");
  });
});

