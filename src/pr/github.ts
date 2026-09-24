import { Octokit } from "octokit";
import { createHash } from "node:crypto";
import type { Config } from "../config.js";
import type { MigrationFile, PrPayload, PrResult } from "../types.js";

/**
 * GitHub PR delivery via shadow branch (paper §4):
 *  - branch: pgheal/index-<fingerprint> — main is never touched
 *  - default mode is dry-run; --write is required to hit the API
 */

/**
 * Optional LLM enrichment of the PR body — deterministic fallback guaranteed.
 * Env: PGHEAL_LLM_API_URL (e.g. https://api.openai.com/v1/chat/completions),
 * PGHEAL_LLM_MODEL, PGHEAL_LLM_API_KEY. Never a hard dependency: on any error
 * the deterministic proof body is used verbatim. Timeout
 * and output cap protect CI latency; the fingerprint stays content-hash-based.
 */
export async function enrichPrBody(
  body: string,
  config: Pick<Config, "llmApiUrl" | "llmApiKey" | "llmModel">,
  added: { table: string; columns: string[]; method: string; speedup: number | null }[],
  drops: { name: string; table: string; reason: string }[],
  dialect: string,
): Promise<string> {
  if (!config.llmApiUrl || !config.llmApiKey) return body; // deterministic by default
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const facts = {
      dialect,
      added: added.map((a) => ({ ...a, speedup: a.speedup === null ? "unproven" : Math.round(a.speedup * 10) / 10 })),
      dropped: drops.map((d) => `${d.name} on ${d.table} (${d.reason})`),
    };
    const res = await fetch(config.llmApiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.llmApiKey}` },
      body: JSON.stringify({
        model: config.llmModel ?? "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are pgHeal, a PostgreSQL index tuning robot. Rewrite the PR summary in at most 5 sentences. " +
              "State only facts from the supplied JSON — never invent numbers, table or index names. " +
              "Output plain Markdown, no code fences.",
          },
          { role: "user", content: JSON.stringify(facts) },
        ],
        temperature: 0,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return body;
    const out = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const summary = out.choices?.[0]?.message?.content?.trim() ?? "";
    if (summary.length < 20) return body;
    const marker = "hypothetical indexes.\n";
    const at = body.indexOf(marker);
    if (at < 0) return body;
    const after = at + marker.length;
    return `${body.slice(0, after)}\n### 🤖 AI summary (the deterministic proof tables below remain authoritative)\n\n${summary}\n${body.slice(after)}`;
  } catch {
    return body; // LLM failure never blocks PR delivery
  } finally {
    clearTimeout(timer);
  }
}

export async function buildPayload(
  recs: { migration: MigrationFile; simulation: { candidate: { table: string; columns: string[]; method: string }; speedup?: number | null } }[],
  drops: { index: { name: string; table: string; sizeBytes: number; reason: string } }[],
  base: { repo: string; dialect: string },
  config?: Config,
): Promise<PrPayload> {
  const files = recs.map((r) => ({ path: r.migration.path, content: r.migration.content }));
  const fingerprintSrc = files.map((f) => f.path + "\n" + f.content).join("\n---\n") + JSON.stringify(drops);
  // raw-content hash: any change in the generated migration changes the branch
  const fp = sha256Short(fingerprintSrc);
  const branch = `pgheal/index-${fp}`;

  const title =
    recs.length > 0
      ? `perf(db): add ${recs.length} proven PostgreSQL index${recs.length > 1 ? "es" : ""} (pgHeal)`
      : "chore(db): remove redundant/unused PostgreSQL indexes (pgHeal)";

  const lines: string[] = [];
  lines.push("## pgHeal — Proven index changes");
  lines.push("");
  lines.push("Generated locally by pgHeal. **Zero data exfiltration**: only normalized query fingerprints");
  lines.push("and catalog statistics were used. All plans were validated with HypoPG hypothetical indexes.");
  lines.push("");

  if (recs.length > 0) {
    lines.push("### New indexes (HypoPG-proven)");
    lines.push("");
    for (const r of recs) {
      lines.push(`- \`${r.migration.path}\``);
    }
    lines.push("");
  }
  if (drops.length > 0) {
    lines.push("### Index cleanup candidates (review before merging)");
    lines.push("");
    lines.push("| Index | Table | Reason | Size |");
    lines.push("|---|---|---|---|");
    for (const d of drops) {
      lines.push(`| \`${d.index.name}\` | ${d.index.table} | ${d.index.reason} | ${d.index.sizeBytes} B |`);
    }
    lines.push("");
    lines.push("> ⚠️ DROPs are **commented out** in generated SQL; uncomment after a 30-day observation window.");
    lines.push("");
  }
  lines.push("### How to verify");
  lines.push("");
  lines.push("```sql");
  lines.push("-- Compare plans before merging:");
  lines.push("EXPLAIN (ANALYZE, BUFFERS) <your-query>;");
  lines.push("```");
  lines.push("");
  lines.push(`_Dialect: ${base.dialect} · fingerprint: \`${fp}\` · base branch: \`${base.repo} → ${base.dialect}\`_`);

  let body = lines.join("\n");
  const addedFacts = recs.map((r) => ({
    table: r.simulation.candidate.table,
    columns: r.simulation.candidate.columns,
    method: r.simulation.candidate.method,
    speedup: r.simulation.speedup ?? null,
  }));
  const dropFacts = drops.map((d) => ({ name: d.index.name, table: d.index.table, reason: d.index.reason }));
  if (config) {
    // optional LLM enrichment — deterministic proof body is the fallback and stays authoritative
    body = await enrichPrBody(body, config, addedFacts, dropFacts, base.dialect);
  }

  return { branch, title, body, files, fingerprint: fp };
}

export async function deliverPr(config: Config, payload: PrPayload): Promise<PrResult> {
  const [owner, repo] = config.githubRepo!.split("/") as [string, string];

  if (!config.write) {
    return {
      created: false,
      dryRun: true,
      branch: payload.branch,
      files: payload.files.map((f) => f.path),
      message: `Dry-run: set --write (or PGHEAL_WRITE=1) with GITHUB_TOKEN and GITHUB_REPO to open the PR. Branch would be \`${payload.branch}\`.`,
    };
  }

  // auth: GitHub App installation token (v0.6, no long-lived PAT) when the app
  // env is set; otherwise the classic GITHUB_TOKEN PAT. App mode wins.
  const { resolveAuthToken } = await import("./ghapp.js");
  const { token, mode } = await resolveAuthToken(config);
  const octokit = new Octokit({
    auth: token,
    // supports GitHub Enterprise Server and local mock servers (tests)
    ...(config.githubApiUrl ? { baseUrl: config.githubApiUrl } : {}),
  });
  void mode; // surfaced by callers via prResult message when needed
  const { data: baseRef } = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${config.baseBranch}`,
  });
  const baseSha = baseRef.object.sha;

  // create shadow branch (idempotent: reuse if exists)
  let branchSha = baseSha;
  try {
    const { data: existing } = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${payload.branch}` });
    branchSha = existing.object.sha;
  } catch {
    await octokit.rest.git.createRef({ owner, repo, ref: `refs/heads/${payload.branch}`, sha: baseSha });
  }

  // commit files via trees API
  const blobs = await Promise.all(
    payload.files.map(async (f) => ({
      path: f.path,
      sha: (
        await octokit.rest.git.createBlob({ owner, repo, content: Buffer.from(f.content, "utf8").toString("base64"), encoding: "base64" })
      ).data.sha,
    })),
  );
  const tree = await octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: branchSha,
    tree: blobs.map((b) => ({ path: b.path, mode: "100644", type: "blob", sha: b.sha })),
  });
  const commit = await octokit.rest.git.createCommit({
    owner,
    repo,
    message: payload.title,
    tree: tree.data.sha,
    parents: [branchSha],
  });
  await octokit.rest.git.updateRef({ owner, repo, ref: `heads/${payload.branch}`, sha: commit.data.sha });

  // open PR
  try {
    const { data: pr } = await octokit.rest.pulls.create({
      owner,
      repo,
      title: payload.title,
      body: payload.body,
      head: payload.branch,
      base: config.baseBranch,
    });
    return {
      created: true,
      url: pr.html_url,
      dryRun: false,
      branch: payload.branch,
      files: payload.files.map((f) => f.path),
      message: `PR opened: ${pr.html_url}`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/A pull request already exists/i.test(msg)) {
      return {
        created: false,
        dryRun: false,
        branch: payload.branch,
        files: payload.files.map((f) => f.path),
        message: "PR already exists for this fingerprint — nothing to do.",
      };
    }
    throw e;
  }
}

function sha256Short(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 10);
}
