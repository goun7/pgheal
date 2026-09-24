import type { Config } from "./config.js";
import { PgClient } from "./postgres/client.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** how to fix, when not ok */
  fix?: string | undefined;
}

export async function runDoctor(config: Config): Promise<{ checks: DoctorCheck[]; ready: boolean }> {
  const checks: DoctorCheck[] = [];
  const client = new PgClient(config);

  try {
    await client.connect();
    checks.push({ name: "connectivity", ok: true, detail: "connection established" });
  } catch (e) {
    checks.push({
      name: "connectivity",
      ok: false,
      detail: e instanceof Error ? e.message : "connection failed",
      fix: "Check DATABASE_URL; ensure network access and correct credentials.",
    });
    return { checks, ready: false };
  }

  try {
    const v = await client.serverVersion();
    checks.push({ name: "server", ok: true, detail: v.split(",")[0]! });
  } catch {
    checks.push({ name: "server", ok: false, detail: "version query failed" });
  }

  const pgss = await client
    .extensionAvailable("pg_stat_statements")
    .catch(() => false);
  checks.push({
    name: "pg_stat_statements",
    ok: pgss,
    detail: pgss ? "installed" : "not installed",
    fix: pgss
      ? undefined
      : "Add 'pg_stat_statements' to shared_preload_libraries and run CREATE EXTENSION pg_stat_statements;",
  });

  const hypopg = await client.extensionAvailable("hypopg").catch(() => false);
  checks.push({
    name: "hypopg",
    ok: hypopg,
    detail: hypopg ? "installed (proven mode)" : "not installed (unproven mode)",
    fix: hypopg
      ? undefined
      : "Install HypoPG (e.g. apt-get install postgresql-18-hypopg) and run CREATE EXTENSION hypopg;",
  });

  // read-only guarantee self-check
  try {
    // SHOW's column is named after the GUC itself, so read the first column generically
    const rows = await client.query<Record<string, string>>("SHOW default_transaction_read_only");
    const value = Object.values(rows[0] ?? {})[0] ?? "off";
    const ro = value === "on";
    checks.push({
      name: "read-only session",
      ok: ro,
      detail: ro ? "session is read-only" : "session not read-only",
      fix: ro ? undefined : "pgHeal sets this automatically; check custom session settings.",
    });
  } catch {
    checks.push({ name: "read-only session", ok: false, detail: "could not verify" });
  }

  // permissions to read pg_stat_* (non-superuser needs pg_read_all_stats)
  try {
    const rows = await client.query<{ ok: boolean }>(
      "SELECT has_table_privilege(current_user, 'pg_stat_statements', 'SELECT') AS ok",
    );
    const ok = rows[0]!.ok;
    checks.push({
      name: "stats privileges",
      ok,
      detail: ok ? "can read pg_stat_statements" : "cannot read pg_stat_statements",
      fix: ok ? undefined : "GRANT pg_read_all_stats TO <your-user>;",
    });
  } catch {
    checks.push({ name: "stats privileges", ok: false, detail: "privilege check failed" });
  }

  await client.close();
  return { checks, ready: checks.every((c) => c.ok) };
}
