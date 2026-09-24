import { describe, expect, it } from "vitest";
import { loadConfig, maskDsn } from "../src/config.js";

const baseEnv = {
  DATABASE_URL: "postgres://user:secret@db.example.com:5432/app",
};

describe("loadConfig", () => {
  it("applies defaults", () => {
    const c = loadConfig(baseEnv);
    expect(c.topN).toBe(5);
    expect(c.dialect).toBe("sql");
    expect(c.requireProof).toBe(true);
    expect(c.write).toBe(false);
  });

  it("rejects non-postgres DSN", () => {
    expect(() => loadConfig({ DATABASE_URL: "mysql://x" })).toThrow();
  });

  it("requires DATABASE_URL", () => {
    expect(() => loadConfig({})).toThrow();
  });

  it("validates github repo format", () => {
    expect(() => loadConfig({ ...baseEnv, GITHUB_REPO: "justname" })).toThrow();
    const ok = loadConfig({ ...baseEnv, GITHUB_REPO: "acme/api" });
    expect(ok.githubRepo).toBe("acme/api");
  });

  it("parses numeric env overrides", () => {
    const c = loadConfig({ ...baseEnv, PGHEAL_TOP_N: "12", PGHEAL_MIN_TOTAL_MS: "500.5" });
    expect(c.topN).toBe(12);
    expect(c.minTotalMs).toBe(500.5);
  });

  it("allowlist: PGHEAL_REQUIRE_PROOF=false disables proof", () => {
    const c = loadConfig({ ...baseEnv, PGHEAL_REQUIRE_PROOF: "false" });
    expect(c.requireProof).toBe(false);
  });
});

describe("maskDsn", () => {
  it("masks password", () => {
    expect(maskDsn("postgres://user:secret@db.example.com:5432/app")).toBe(
      "postgres://user:***@db.example.com:5432/app",
    );
  });
});
