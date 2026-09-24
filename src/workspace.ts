import { readFile } from "node:fs/promises";
import { loadConfig, type Config } from "./config.js";
import { runScan } from "./scan.js";
import type { ScanResult } from "./types.js";
import { verifyLicense, requireFeature, type LicenseInfo } from "./license.js";

/**
 * Multi-repo workspace orchestration (paper §7 Team plan, v1.0).
 * A workspace is a JSON manifest listing repos (repo + its DATABASE_URL env
 * name + dialect). Scans run sequentially (DB-friendly), each producing its own
 * PR against its own repo; a combined summary report closes the run.
 */

export interface WorkspaceRepo {
  /** "owner/name" */
  repo: string;
  /** env var name holding that repo's DATABASE_URL (never the DSN itself) */
  databaseUrlEnv: string;
  dialect?: "sql" | "prisma" | "django" | "rails";
  baseBranch?: string;
}

export interface WorkspaceManifest {
  name: string;
  repos: WorkspaceRepo[];
}

export interface WorkspaceRunResult {
  workspace: string;
  results: { repo: string; ok: boolean; proven: number; drops: number; prUrl?: string | undefined; error?: string | undefined }[];
  totalProven: number;
  totalDrops: number;
  report: string;
}

export async function loadWorkspace(path: string): Promise<WorkspaceManifest> {
  const raw = await readFile(path, "utf8");
  const manifest = JSON.parse(raw) as WorkspaceManifest;
  if (!manifest.name || !Array.isArray(manifest.repos) || manifest.repos.length === 0) {
    throw new Error('workspace manifest must be { "name": string, "repos": [{ repo, databaseUrlEnv, ... }] }');
  }
  return manifest;
}

export function licenseFromEnv(env: NodeJS.ProcessEnv): LicenseInfo | null {
  const secret = env.PGHEAL_LICENSE_SECRET;
  const key = env.PGHEAL_LICENSE_KEY;
  if (!secret || !key) return null;
  const res = verifyLicense(key, secret);
  return res.ok && res.info ? res.info : null;
}

export async function runWorkspace(
  manifest: WorkspaceManifest,
  env: NodeJS.ProcessEnv,
  opts: { write: boolean },
): Promise<WorkspaceRunResult> {
  const license = licenseFromEnv(env);
  requireFeature(license, "multi-repo");

  const results: WorkspaceRunResult["results"] = [];
  for (const r of manifest.repos) {
    const dsn = env[r.databaseUrlEnv];
    if (!dsn) {
      results.push({ repo: r.repo, ok: false, proven: 0, drops: 0, error: `env ${r.databaseUrlEnv} is not set` });
      continue;
    }
    try {
      const overrides: Partial<Config> = {
        githubRepo: r.repo,
        write: opts.write,
        dialect: r.dialect ?? "sql",
        ...(r.baseBranch ? { baseBranch: r.baseBranch } : {}),
      };
      const config = loadConfig(env, overrides);
      const scan: ScanResult = await runScan(config, { write: opts.write });
      results.push({
        repo: r.repo,
        ok: true,
        proven: scan.recommendations.length,
        drops: scan.cleanup.drops.length,
        prUrl: scan.pr?.url,
      });
    } catch (e) {
      results.push({
        repo: r.repo,
        ok: false,
        proven: 0,
        drops: 0,
        error: e instanceof Error ? e.message.slice(0, 160) : "scan failed",
      });
    }
  }

  const totalProven = results.reduce((a, r) => a + r.proven, 0);
  const totalDrops = results.reduce((a, r) => a + r.drops, 0);
  const lines: string[] = [];
  lines.push(`# pgHeal Workspace Report — ${manifest.name}`);
  lines.push("");
  lines.push(`| Repo | Status | Proven | Cleanup | PR |`);
  lines.push(`|---|---|---|---|---|`);
  for (const r of results) {
    lines.push(
      `| ${r.repo} | ${r.ok ? "✅" : `❌ ${r.error ?? ""}`} | ${r.proven} | ${r.drops} | ${r.prUrl ? "[open](" + r.prUrl + ")" : r.ok && !opts.write ? "dry-run" : "—"} |`,
    );
  }
  lines.push("");
  lines.push(`**Totals:** ${totalProven} proven recommendations · ${totalDrops} cleanup candidates · license: ${license!.sub}`);

  return { workspace: manifest.name, results, totalProven, totalDrops, report: lines.join("\n") };
}
