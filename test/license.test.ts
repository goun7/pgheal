import { describe, expect, it } from "vitest";
import { demoLicense, requireFeature, signLicense, verifyLicense } from "../src/license.js";

const SECRET = "unit-test-secret";
const NOW = Math.floor(Date.now() / 1000);

const validKey = signLicense(
  {
    sub: "acme-corp",
    exp: NOW + 30 * 86_400,
    seats: 10,
    features: ["autonomous-pr", "slack", "multi-repo"],
  },
  SECRET,
);

describe("signLicense / verifyLicense", () => {
  it("round-trips a valid license", () => {
    const res = verifyLicense(validKey, SECRET);
    expect(res.ok).toBe(true);
    expect(res.info!.sub).toBe("acme-corp");
    expect(res.info!.seats).toBe(10);
    expect(res.info!.features).toContain("multi-repo");
    expect(res.info!.daysRemaining).toBeGreaterThan(28);
  });

  it("rejects tampered payloads", () => {
    // real tampering: decode payload, change seats, re-encode, keep old signature
    const [prefix, body, mac] = [validKey.slice(0, 7), ...[]] as [string, string, string];
    void prefix;
    const rest = validKey.slice("pgheal_".length);
    const dot = rest.lastIndexOf(".");
    const b64 = rest.slice(0, dot);
    const json = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as { seats: number };
    json.seats = 9999;
    const newBody = Buffer.from(JSON.stringify(json), "utf8").toString("base64url");
    const tampered = `pgheal_${newBody}.${mac ?? rest.slice(dot + 1)}`;
    expect(verifyLicense(tampered, SECRET).ok).toBe(false);
    expect(verifyLicense(validKey, "wrong-secret").ok).toBe(false);
    expect(verifyLicense("pgheal_bogus.00", SECRET).ok).toBe(false);
    expect(verifyLicense("not-a-key", SECRET).ok).toBe(false);
  });

  it("detects expiry", () => {
    const expired = signLicense(
      { sub: "old", exp: NOW - 86_400, seats: 1, features: [] },
      SECRET,
    );
    const res = verifyLicense(expired, SECRET);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("license expired");
    expect(res.info!.expired).toBe(true);
  });
});

describe("requireFeature", () => {
  it("throws without a license", () => {
    expect(() => requireFeature(null, "multi-repo")).toThrow(/Team license/);
  });

  it("throws for unlicensed features and expired licenses", () => {
    const info = verifyLicense(validKey, SECRET).info!;
    expect(() => requireFeature(info, "priority-support")).toThrow(/not included/);
    const expiredInfo = { ...info, expired: true };
    expect(() => requireFeature(expiredInfo, "multi-repo")).toThrow(/expired/);
  });

  it("passes for licensed features", () => {
    const info = verifyLicense(validKey, SECRET).info!;
    expect(() => requireFeature(info, "multi-repo")).not.toThrow();
  });
});

describe("demoLicense", () => {
  it("produces a verifiable key with all features", () => {
    const res = verifyLicense(demoLicense(SECRET), SECRET);
    expect(res.ok).toBe(true);
    expect(res.info!.features).toContain("autonomous-pr");
  });
});
