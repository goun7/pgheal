import type { ScanResult } from "../types.js";

/**
 * Slack delivery (paper §7 Team plan feature: "7/24 otomatik PR + Slack alarmı").
 * Webhook-only: no inbound access, no data beyond the summary leaves the machine.
 */

export interface SlackSummary {
  database: string;
  provenCount: number;
  dropCount: number;
  topSpeedup: string;
  warnings: number;
  prUrl?: string | undefined;
}

export function summarize(scan: ScanResult): SlackSummary {
  const speedups = scan.recommendations.map((r) => r.simulation.speedup).filter((s): s is number => s !== null);
  const top = speedups.length > 0 ? `${Math.max(...speedups).toFixed(1)}x` : "n/a";
  return {
    database: scan.db.database,
    provenCount: scan.recommendations.length,
    dropCount: scan.cleanup.drops.length,
    topSpeedup: top,
    warnings: scan.warnings.length,
    prUrl: scan.pr?.url ?? undefined,
  };
}

export function renderSlackMessage(s: SlackSummary): string {
  const lines: string[] = [];
  lines.push(`:otter: *pgHeal scan — ${s.database}*`);
  lines.push(`• Proven index recommendations: *${s.provenCount}* (top speedup: ${s.topSpeedup})`);
  if (s.dropCount > 0) lines.push(`• Cleanup candidates (unused/redundant): *${s.dropCount}*`);
  if (s.warnings > 0) lines.push(`• :warning: warnings: ${s.warnings}`);
  if (s.prUrl) lines.push(`• PR: ${s.prUrl}`);
  return lines.join("\n");
}

export async function sendSlackNotification(webhookUrl: string, scan: ScanResult): Promise<boolean> {
  const message = renderSlackMessage(summarize(scan));
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: message }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
