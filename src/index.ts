#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig, maskDsn } from "./config.js";
import { runScan, reportToJson } from "./scan.js";
import { runDoctor } from "./doctor.js";
import { explainQuery } from "./explain.js";
import { sendSlackNotification } from "./notify/slack.js";
import { writeFile } from "node:fs/promises";
import { renderHtmlReport } from "./report/html.js";
import { renderSarif } from "./report/sarif.js";
import { verifyLicense, demoLicense, signLicense } from "./license.js";
import { loadWorkspace, runWorkspace } from "./workspace.js";

const program = new Command();

program
  .name("pgheal")
  .description("pgHeal — PostgreSQL autonomous index & PR robot (HypoPG-proven, zero data exfiltration)")
  .version("0.1.0");

program
  .command("scan")
  .description("Scan pg_stat_statements, prove index wins with HypoPG, print report (and open a PR with --write)")
  .option("--top <n>", "top N statements by total exec time", parseInt)
  .option("--min-total-ms <ms>", "minimum total exec time in ms", parseFloat)
  .option("--dialect <d>", "migration dialect: sql | prisma | django | rails")
  .option("--json", "also emit JSON report to stdout", false)
  .option("--write", "actually create the shadow branch and open the GitHub PR (default: dry-run)", false)
  .option("--report-file <path>", "write the markdown report to a file (CI-friendly)")
  .option("--html <path>", "also write a self-contained HTML report with plan visualization")
  .option("--sarif <path>", "write a SARIF 2.1.0 report for GitHub code scanning")
  .option("--slack-webhook <url>", "post the scan summary to a Slack webhook (overrides PGHEAL_SLACK_WEBHOOK)")
  .action(async (opts) => {
    const config = loadConfig(process.env, {
      topN: opts.top ?? undefined,
      minTotalMs: opts.minTotalMs ?? undefined,
      dialect: opts.dialect ?? undefined,
      write: opts.write === true,
    });

    console.error(`pgheal scan → ${maskDsn(config.databaseUrl)} (dry-run: ${!config.write})`);
    const result = await runScan(config, { write: config.write });

    console.log(result.report);
    if (opts.json) {
      console.log("\n```json");
      console.log(reportToJson(result));
      console.log("```");
    }
    if (opts.reportFile) {
      await writeFile(opts.reportFile, result.report, "utf8");
      console.error(`report written: ${opts.reportFile}`);
    }
    if (opts.html) {
      await writeFile(opts.html, renderHtmlReport(result), "utf8");
      console.error(`html report written: ${opts.html}`);
    }
    if (opts.sarif) {
      await writeFile(opts.sarif, renderSarif(result), "utf8");
      console.error(`sarif report written: ${opts.sarif}`);
    }
    const webhook = opts.slackWebhook ?? process.env.PGHEAL_SLACK_WEBHOOK;
    if (webhook) {
      const ok = await sendSlackNotification(webhook, result);
      console.error(ok ? "Slack notification sent." : "Slack notification failed (non-fatal).");
    }
    if (result.pr) {
      console.error(`PR: ${result.pr.message}`);
    }
    for (const w of result.warnings) console.error(`warning: ${w}`);
  });

program
  .command("doctor")
  .description("Check that the environment is ready (connectivity, pg_stat_statements, HypoPG, privileges)")
  .action(async () => {
    const config = loadConfig(process.env);
    const { checks, ready } = await runDoctor(config);
    for (const c of checks) {
      const mark = c.ok ? "✅" : "❌";
      console.log(`${mark} ${c.name}: ${c.detail}`);
      if (!c.ok && c.fix) console.log(`   fix: ${c.fix}`);
    }
    console.log(ready ? "\nReady." : "\nNot ready — fix the ❌ items above.");
    process.exitCode = ready ? 0 : 1;
  });

program
  .command("explain")
  .description("Explain a SQL file or query string with before/after HypoPG simulation (proof table)")
  .argument("<query-or-file>", "SQL string or path to a .sql file")
  .option("--analyze", "add ANALYZE to EXPLAIN (actually executes the query — read-only sessions only)", false)
  .option("--buffers", "add BUFFERS to EXPLAIN", false)
  .option("--html <path>", "write a self-contained HTML plan report")
  .action(async (q, opts) => {
    const config = loadConfig(process.env);
    let sql = q;
    if (!/\s/.test(q) && q.endsWith(".sql")) {
      const fs = await import("node:fs/promises");
      sql = await fs.readFile(q, "utf8");
    }
    const out = await explainQuery(config, sql, { analyze: opts.analyze === true, buffers: opts.buffers === true });
    console.log(out);
    if (opts.html) {
      const { renderExplainHtml } = await import("./report/html.js");
      await writeFile(opts.html, renderExplainHtml(out, sql), "utf8");
      console.error(`html report written: ${opts.html}`);
    }
  });

program
  .command("workspace")
  .description("Scan multiple repos from a workspace manifest (Team license: multi-repo)")
  .argument("<manifest>", "path to workspace.json")
  .option("--write", "open PRs in every repo (default: dry-run)", false)
  .option("--report-file <path>", "write the combined markdown report to a file")
  .action(async (manifestPath, opts) => {
    const manifest = await loadWorkspace(manifestPath);
    const run = await runWorkspace(manifest, process.env, { write: opts.write === true });
    console.log(run.report);
    if (opts.reportFile) {
      await writeFile(opts.reportFile, run.report, "utf8");
      console.error(`report written: ${opts.reportFile}`);
    }
  });

program
  .command("license")
  .description("License management: activate a key, show status, or print a demo key (dev)")
  .argument("<action>", "activate | status | demo")
  .option("--key <key>", "license key (for activate; otherwise PGHEAL_LICENSE_KEY)")
  .option("--secret <secret>", "signing secret (otherwise PGHEAL_LICENSE_SECRET)")
  .option("--issue", "vendor mode: issue a new key (requires PGHEAL_LICENSE_SECRET)", false)
  .option("--sub <id>", "issue: customer id")
  .option("--days <n>", "issue: validity in days", parseInt)
  .option("--seats <n>", "issue: database/seat count", parseInt)
  .action(async (action, opts) => {
    const secret = opts.secret ?? process.env.PGHEAL_LICENSE_SECRET;
    if (action === "demo") {
      console.log(demoLicense(secret ?? "pgheal-dev-secret"));
      return;
    }
    if (action === "issue" || opts.issue) {
      // vendor-side automation: one command from paid issue to deliverable key
      const key = signLicense(
        {
          sub: opts.sub ?? "customer",
          exp: Math.floor(Date.now() / 1000) + (opts.days ?? 30) * 86_400,
          seats: opts.seats ?? 5,
          features: ["autonomous-pr", "slack", "multi-repo", "priority-support"],
        },
        secret,
      );
      console.log(key);
      console.error(`\nissued: sub=${opts.sub ?? "customer"} days=${opts.days ?? 30} seats=${opts.seats ?? 5}`);
      console.error("deliver with:  customer runs  pgheal license activate --key <key>  (secret never leaves the vendor)");
      return;
    }
    if (!secret) {
      console.error("error: PGHEAL_LICENSE_SECRET is not set");
      process.exitCode = 1;
      return;
    }
    if (action === "activate") {
      const key = opts.key ?? process.env.PGHEAL_LICENSE_KEY;
      if (!key) {
        console.error("error: pass --key or set PGHEAL_LICENSE_KEY");
        process.exitCode = 1;
        return;
      }
      const res = verifyLicense(key, secret);
      if (res.ok) {
        console.log(`✅ license valid — ${res.info!.sub} · seats: ${res.info!.seats} · ${res.info!.daysRemaining} days remaining`);
        console.log(`   features: ${res.info!.features.join(", ")}`);
      } else {
        console.error(`❌ invalid license: ${res.reason}`);
        process.exitCode = 1;
      }
      return;
    }
    if (action === "status") {
      const res = verifyLicense(process.env.PGHEAL_LICENSE_KEY ?? "", secret);
      console.log(res.ok ? `✅ ${res.info!.sub} · ${res.info!.daysRemaining} days left` : `❌ ${res.reason ?? "no key set"}`);
      process.exitCode = res.ok ? 0 : 1;
      return;
    }
    console.error(`unknown action: ${action} (use activate | status | demo)`);
    process.exitCode = 1;
  });

program.parseAsync().catch((e) => {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
