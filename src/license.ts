import { createHmac, randomUUID } from "node:crypto";

/**
 * pgHeal Team license keys (paper §7, v1.0 SaaS).
 *
 * Format:  pgheal_<payloadB64url>.<hmacHex>
 * Payload: { v, sub, exp, seats, features }
 * Signature: HMAC-SHA256(payload, secret).
 *
 * Why HMAC (not Ed25519): keys are verified offline on the customer machine, so
 * any scheme — public or symmetric — ultimately trusts a secret embedded in the
 * binary. HMAC keeps the toolchain dependency-free and symmetric for the vendor
 * (one secret signs and verifies). Tampering with the payload breaks the HMAC.
 */

export type Feature =
  | "autonomous-pr" // scheduled scans may open PRs with --write
  | "slack"
  | "multi-repo" // workspace orchestration
  | "priority-support";

export interface LicensePayload {
  v: 1;
  /** customer id */
  sub: string;
  /** expiry, unix seconds */
  exp: number;
  seats: number;
  features: Feature[];
}

export interface LicenseInfo extends LicensePayload {
  /** days remaining (negative = expired) */
  daysRemaining: number;
  expired: boolean;
}

const PREFIX = "pgheal_";

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

export function signLicense(
  payload: Omit<LicensePayload, "v">,
  secret: string,
): string {
  const full: LicensePayload = { v: 1, ...payload };
  const body = b64url(Buffer.from(JSON.stringify(full), "utf8"));
  const mac = createHmac("sha256", secret).update(body).digest("hex");
  return `${PREFIX}${body}.${mac}`;
}

export function verifyLicense(
  key: string,
  secret: string,
  now: number = Math.floor(Date.now() / 1000),
): { ok: boolean; reason?: string; info?: LicenseInfo } {
  if (!key.startsWith(PREFIX)) return { ok: false, reason: "bad prefix" };
  const rest = key.slice(PREFIX.length);
  const dot = rest.lastIndexOf(".");
  if (dot <= 0) return { ok: false, reason: "malformed key" };
  const body = rest.slice(0, dot);
  const mac = rest.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  if (mac.length !== expected.length || mac !== expected) {
    return { ok: false, reason: "signature mismatch" };
  }
  try {
    const payload = JSON.parse(fromB64url(body).toString("utf8")) as LicensePayload;
    if (payload.v !== 1) return { ok: false, reason: "unsupported version" };
    const expired = payload.exp <= now;
    return {
      ok: !expired,
      ...(expired ? { reason: "license expired" } : {}),
      info: {
        ...payload,
        expired,
        daysRemaining: Math.floor((payload.exp - now) / 86_400),
      },
    };
  } catch {
    return { ok: false, reason: "payload parse error" };
  }
}

/** Entitlement gate: throw unless the feature is licensed and not expired. */
export function requireFeature(license: LicenseInfo | null, feature: Feature): void {
  if (!license) throw new Error(`feature "${feature}" requires a Team license (pgheal license activate)`);
  if (license.expired) throw new Error("license expired — renew at https://pgheal.dev/billing");
  if (!license.features.includes(feature)) {
    throw new Error(`feature "${feature}" is not included in this license (features: ${license.features.join(", ")})`);
  }
}

/** Seat-count gate for workspace members. */
export function seatsAllow(license: LicenseInfo, usedSeats: number): boolean {
  return usedSeats < license.seats;
}

/** Demo key generator for local dev/tests. */
export function demoLicense(secret: string, days = 365): string {
  return signLicense(
    {
      sub: `demo-${randomUUID().slice(0, 8)}`,
      exp: Math.floor(Date.now() / 1000) + days * 86_400,
      seats: 5,
      features: ["autonomous-pr", "slack", "multi-repo", "priority-support"],
    },
    secret,
  );
}
