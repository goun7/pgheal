import { describe, expect, it } from "vitest";
import { loadWorkspace } from "../src/workspace.js";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signLicense } from "../src/license.js";

const dir = mkdtempSync(join(tmpdir(), "pgheal-ws-"));

function writeManifest(obj: unknown): string {
  const p = join(dir, `ws-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify(obj), "utf8");
  return p;
}

describe("loadWorkspace", () => {
  it("loads a valid manifest", async () => {
    const m = await loadWorkspace(
      writeManifest({ name: "acme", repos: [{ repo: "acme/api", databaseUrlEnv: "DB_API", dialect: "prisma" }] }),
    );
    expect(m.name).toBe("acme");
    expect(m.repos[0]!.databaseUrlEnv).toBe("DB_API");
  });

  it("rejects malformed manifests", async () => {
    await expect(loadWorkspace(writeManifest({ repos: [] }))).rejects.toThrow(/manifest/);
    await expect(loadWorkspace(writeManifest({ name: "x" }))).rejects.toThrow(/manifest/);
  });
});

describe("runWorkspace license gate", () => {
  it("refuses without a valid multi-repo license", async () => {
    const { runWorkspace } = await import("../src/workspace.js");
    const manifest = await loadWorkspace(
      writeManifest({ name: "acme", repos: [{ repo: "acme/api", databaseUrlEnv: "DB_API" }] }),
    );
    await expect(runWorkspace(manifest, {}, { write: false })).rejects.toThrow(/Team license/);
  });

  it("reports missing DATABASE_URL envs per repo with a valid license", async () => {
    const { runWorkspace } = await import("../src/workspace.js");
    const now = Math.floor(Date.now() / 1000);
    const key = signLicense(
      { sub: "acme", exp: now + 86_400, seats: 3, features: ["multi-repo"] },
      "ws-secret",
    );
    const manifest = await loadWorkspace(
      writeManifest({ name: "acme", repos: [{ repo: "acme/api", databaseUrlEnv: "DB_MISSING" }] }),
    );
    const run = await runWorkspace(manifest, { PGHEAL_LICENSE_KEY: key, PGHEAL_LICENSE_SECRET: "ws-secret" }, { write: false });
    expect(run.results[0]!.ok).toBe(false);
    expect(run.results[0]!.error).toContain("DB_MISSING");
  });
});
