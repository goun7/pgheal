import type { ScanResult } from "../types.js";

/**
 * Self-contained HTML reports (no external assets, no telemetry — paper §9).
 * Two shapes: full scan report and single-query explain comparison.
 */

const CSS = `
:root { color-scheme: light dark; }
body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; margin: 2rem auto; max-width: 960px; padding: 0 1rem; line-height: 1.55; }
h1 { font-size: 1.5rem; } h2 { font-size: 1.2rem; margin-top: 2rem; }
table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
th, td { border: 1px solid #8884; padding: 0.45rem 0.7rem; text-align: left; }
th { background: #8881; }
code, pre { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 0.9em; }
pre { background: #8881; padding: 0.8rem 1rem; border-radius: 8px; overflow-x: auto; }
.badge { display: inline-block; padding: 0.1rem 0.6rem; border-radius: 999px; font-size: 0.8rem; font-weight: 600; }
.ok { background: #16a34a22; color: #16a34a; } .bad { background: #dc262622; color: #dc2626; }
.bar-wrap { background: #8881; border-radius: 6px; height: 1.1rem; position: relative; overflow: hidden; }
.bar { height: 100%; background: #3b82f6; }
.bar.after { background: #16a34a; }
.muted { opacity: 0.7; font-size: 0.9rem; }
footer { margin-top: 3rem; border-top: 1px solid #8884; padding-top: 1rem; }
`;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function costBar(before: number, after: number): string {
  const max = Math.max(before, after, 1);
  const wB = Math.max(2, Math.round((before / max) * 100));
  const wA = Math.max(2, Math.round((after / max) * 100));
  return (
    `<div class="bar-wrap" title="before ${before.toFixed(1)}"><div class="bar" style="width:${wB}%"></div></div>` +
    `<div class="bar-wrap" title="after ${after.toFixed(1)}"><div class="bar after" style="width:${wA}%"></div></div>`
  );
}

export function renderHtmlReport(scan: ScanResult): string {
  const recs = scan.recommendations
    .map((r, i) => {
      const sim = r.simulation;
      const speedup = sim.speedup ? `${sim.speedup.toFixed(1)}x` : "n/a";
      return `
<section>
  <h2>${i + 1}. <code>${esc(sim.candidate.table)}</code> → (${esc(sim.candidate.columns.join(", "))}) <span class="badge ok">${esc(sim.candidate.method)}</span></h2>
  <p class="muted">${esc(sim.candidate.reason)}</p>
  <table>
    <tr><th>Metric</th><th>Before</th><th>After (hypothetical)</th></tr>
    <tr><td>Plan node</td><td>${esc(sim.before.nodeType)}</td><td>${esc(sim.after?.nodeType ?? "n/a")}</td></tr>
    <tr><td>Total cost</td><td>${sim.before.totalCost.toFixed(1)}</td><td>${sim.after ? sim.after.totalCost.toFixed(1) : "n/a"}</td></tr>
    <tr><td>Speedup</td><td>—</td><td><strong>${esc(speedup)}</strong></td></tr>
  </table>
  ${sim.after ? costBar(sim.before.totalCost, sim.after.totalCost) : ""}
  <pre>${esc(r.migration.content.trim())}</pre>
</section>`;
    })
    .join("\n");

  const drops =
    scan.cleanup.drops.length > 0
      ? `<table><tr><th>Index</th><th>Table</th><th>Reason</th><th>Size</th></tr>${scan.cleanup.drops
          .map(
            (d) =>
              `<tr><td><code>${esc(d.index.name)}</code></td><td>${esc(d.index.table)}</td><td>${esc(d.reason)}</td><td>${(d.index.sizeBytes / 1024 / 1024).toFixed(1)} MB</td></tr>`,
          )
          .join("")}</table>`
      : "";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>pgHeal Report — ${esc(scan.db.database)}</title><style>${CSS}</style></head>
<body>
<h1>pgHeal Report — <code>${esc(scan.db.database)}</code></h1>
<p class="muted">${esc(scan.db.serverVersion.split(",")[0] ?? "")} · HypoPG: ${scan.db.hypopg ? "✅" : "❌"} · pg_stat_statements: ${scan.db.pgss ? "✅" : "❌"}</p>
${recs || "<p>No proven improvements found — workload looks well-indexed. 🎉</p>"}
${drops ? `<h2>Cleanup candidates</h2>${drops}` : ""}
${scan.warnings.length ? `<h2>Warnings</h2><ul>${scan.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}
<footer><span class="badge ok">zero data exfiltration</span> <span class="muted">Generated locally by pgHeal — only normalized fingerprints and catalog statistics were used.</span></footer>
</body></html>`;
}

export function renderExplainHtml(markdown: string, sql: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>pgHeal Explain</title><style>${CSS}</style></head>
<body>
<h1>pgHeal Explain — plan comparison</h1>
<h2>Query</h2>
<pre>${esc(sql.trim())}</pre>
<h2>Result</h2>
<pre>${esc(markdown)}</pre>
<footer><span class="badge ok">HypoPG hypothetical index — zero disk, zero locks</span></footer>
</body></html>`;
}
