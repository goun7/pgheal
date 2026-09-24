# pgHeal

![demo](docs/demo-card.svg)
[![CI](https://github.com/goun7/pgheal/actions/workflows/ci.yml/badge.svg)](https://github.com/goun7/pgheal/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/goun7/pgheal?label=version)](https://github.com/goun7/pgheal/releases)
![license](https://img.shields.io/badge/license-MIT-green)
![node](https://img.shields.io/badge/node-20%2B-blue) — PostgreSQL Autonomous Index & PR Robot

> **HypoPG-proven. Zero data exfiltration. Delivered as a GitHub PR.**

pgHeal scans `pg_stat_statements`, proposes index candidates, **proves** each one by
asking the PostgreSQL planner itself via [HypoPG](https://github.com/HypoPG/hypopg)
hypothetical indexes, and delivers the result as a clean migration + GitHub Pull
Request from a shadow branch. Your database never leaves your VPC.


## Why

- PostgreSQL is the #1 database (Stack Overflow 2025: 55.6% of professional developers).
- Monitoring tools (pganalyze $149–$399/mo, 2025) show you the problem; they don't fix it.
- The category leader OtterTune died in June 2024 — because closed-box ML + external access is the wrong model.
- pgHeal is open-source, deterministic (the planner itself votes), and ships proof.

## Quick start (demo in 60 seconds)

```bash
docker compose up --build
# → pgheal scans the demo DB and prints a proven recommendation report
```

The demo DB (Postgres 18 + HypoPG + pg_stat_statements, 500k orders, no index on
`orders(user_id)`) produces a report like:

```
### 1. `orders` → (user_id, created_at)
| Metric         | Before   | After (hypothetical) |
|----------------|----------|----------------------|
| Plan node      | Seq Scan | Index Scan           |
| Total cost     | 48200.0  | 12.4                 |
| Speedup factor | —        | ~3887x               |
```

## Local CLI

**Registry-free install** (no npmjs.com account needed) — the tarball ships on
GitHub Releases with every push:

```bash
curl -LO https://github.com/goun7/pgheal/releases/latest/download/pgheal-0.4.0.tgz
tar -xzf pgheal-0.4.0.tgz && npm i -g ./package
pgheal doctor
```

Or install straight from GitHub:

```bash
npm i -g github:goun7/pgheal
```

npm registry (`npm i -g pgheal`) will follow once the package is published
there — the release pipeline is already OIDC-ready.

Or build from source:

```bash
git clone https://github.com/goun7/pgheal && cd pgheal
npm install && npm run build
export DATABASE_URL=postgres://user:pass@host:5432/db

pgheal doctor     # connectivity, pg_stat_statements, HypoPG, privileges
pgheal scan       # proven recommendations + index hygiene report (dry-run PR)
pgheal explain "SELECT * FROM orders WHERE user_id = 7"   # single-query A/B proof
```

### Opening the PR (autonomous delivery)

```bash
export GITHUB_REPO=acme/api
export GITHUB_TOKEN=ghp_xxx        # Contents + Pull requests: read/write
pgheal scan --write                # default is dry-run; --write opens the PR
```

- Branch: `pgheal/index-<fingerprint>` (deterministic — same findings, same branch)
- Main is never touched. Merge stays a human decision.

### Options

| Flag / Env | Default | Meaning |
|---|---|---|
| `--top` / `PGHEAL_TOP_N` | 5 | Top N statements by total exec time |
| `--min-total-ms` / `PGHEAL_MIN_TOTAL_MS` | 1000 | Ignore cheaper statements |
| `--dialect` / `PGHEAL_DIALECT` | sql | `sql \| prisma \| django \| rails` |
| `PGHEAL_REQUIRE_PROOF` | true | Reject unproven candidates (HypoPG required) |
| `--write` / `PGHEAL_WRITE` | false | Actually open the GitHub PR |
| `--report-file <path>` | — | Write the markdown report to a file (CI-friendly) |
| `--sarif <path>` | — | Write a SARIF 2.1.0 report for GitHub code scanning |
| `--slack-webhook <url>` / `PGHEAL_SLACK_WEBHOOK` | — | Post the scan summary to Slack |
| `PGHEAL_GITHUB_API_URL` | github.com | Override API base (GHES / mock server) |
| `PGHEAL_LLM_API_URL` / `PGHEAL_LLM_API_KEY` / `PGHEAL_LLM_MODEL` | — | Optional OpenAI-compatible endpoint that rewrites the PR summary |
| `PGHEAL_BASE_BRANCH` | main | Base branch for shadow branches and PRs |
| `PGHEAL_LICENSE_KEY` / `PGHEAL_LICENSE_SECRET` | — | Team license (unlocks workspace/multi-repo) |

## Visual & richer explain

```bash
pgheal explain "SELECT … " --analyze --buffers --html plan.html
pgheal scan --report-file report.md --html report.html
```

`--html` writes a **self-contained** HTML report (no external assets, no telemetry):
cost bars before/after, plan-node badges (btree/gin/brin), migration SQL, and the
zero-exfiltration footer.

## SARIF & GitHub code scanning

```bash
pgheal scan --sarif pgheal.sarif
```

Upload `pgheal.sarif` with `github/codeql-action/upload-sarif` (or the
`code-scanning/upload-sarif` action) and proven index opportunities appear on
the repo's **Security → Code scanning** tab as `warning` alerts, unused-index
cleanup as `note` alerts — each with the proof numbers and migration path.
No query text is embedded, only normalized fingerprints (zero exfiltration).

## Subqueries & CTEs (v0.4)

Predicate extraction walks every `WHERE` region — outer query, `IN (SELECT …)`,
correlated scalar subqueries and `WITH` CTE bodies alike. CTE names are excluded
from table candidates, and an outer `ORDER BY` by column name is forwarded to the
CTE body so scans of the underlying table still get proven indexes.

## AI PR summary (optional)

Set an OpenAI-compatible endpoint and pgHeal adds a short human-language summary
to the PR body:

```bash
PGHEAL_LLM_API_URL=https://api.openai.com/v1/chat/completions \
PGHEAL_LLM_API_KEY=sk-… \
PGHEAL_LLM_MODEL=gpt-4o-mini \
pgheal scan --write
```

The model receives **only** the deterministic fact JSON (tables, columns,
speedup factors, drop reasons) and is told never to invent numbers. The
deterministic proof body remains authoritative below it — and if the endpoint
errors, times out (15 s) or returns garbage, the PR ships with the original
body. No key, no change: delivery stays fully deterministic.

## Team license & multi-repo workspaces (v1.0)

License keys are offline-verifiable HMAC-SHA256 signed payloads
(`pgheal_<payload>.<hmac>`) with expiry, seats and feature flags
(`autonomous-pr`, `slack`, `multi-repo`, `priority-support`).

```bash
pgheal license activate --key pgheal_…        # or PGHEAL_LICENSE_KEY + PGHEAL_LICENSE_SECRET
pgheal license status
pgheal license demo                           # dev-only demo key

pgheal workspace workspace.json --write       # scan many repos, PR each (Team: multi-repo)
```

`workspace.json` (DSNs stay in env vars — never in the manifest):

```json
{
  "name": "acme",
  "repos": [
    { "repo": "acme/api", "databaseUrlEnv": "DB_API_URL", "dialect": "prisma" },
    { "repo": "acme/web", "databaseUrlEnv": "DB_WEB_URL" }
  ]
}
```

## Beyond btree: GIN / BRIN / text_pattern_ops

pgheal proposes **access-path-appropriate** index types, each still HypoPG-proven:

| Signal in query | Candidate |
|---|---|
| JSONB/array containment (`@>`, `?`, `?\|`, `?&`) | `USING gin (col)` |
| timestamp-range on huge append-only tables | `USING brin (col)` |
| left-anchored `LIKE` on non-C collation | btree + `text_pattern_ops` opclass |

## Safety model

1. **Session is read-only** — `default_transaction_read_only = on`, plus `statement_timeout` and `lock_timeout` guards.
2. **Zero DDL/DML on your database.** Hypothetical indexes cost nothing (no disk, no locks, no writes).
3. **Zero data exfiltration.** Only normalized query fingerprints and catalog statistics exist in reports/PRs; telemetry is off by default; DSN is masked in logs.
4. **Proof or silence.** A candidate is recommended only if the planner switches to an index scan AND cost drops. Otherwise it is rejected with a reason.

## Architecture

```
src/
  index.ts            CLI (scan / doctor / explain)
  config.ts           zod-validated configuration, DSN masking
  scan.ts             orchestrator
  postgres/client.ts  read-only bounded session
  collect/pgss.ts     pg_stat_statements + index + write-stats collectors
  analysis/
    normalize.ts      deterministic SQL normalizer + fingerprint
    candidates.ts     shape extraction → index candidates
    simulate.ts       HypoPG A/B plan simulation
    usage.ts          unused/redundant/invalid index hygiene
    ddl.ts, estimate.ts
  pr/
    migrations.ts     sql/prisma/django/rails migration generators
    github.ts         shadow branch + commit + PR (Octokit)
  report/render.ts    markdown + JSON proof reports
```

## Scheduled autonomous scanning (GitHub Action)

`.github/workflows/pgheal-scan.yml` runs a cron scan on your repo:
report artifact + optional Slack notification; flip `PGHEAL_WRITE=1` (with
`permissions: pull-requests: write`) to let pgheal open the shadow-branch PR
automatically. Merge stays human.

## Joint workload optimization (v0.2)

Single-query advice can recommend overlapping indexes. pgheal evaluates
**candidate sets jointly**: HypoPG holds several hypothetical indexes at once and
candidates are grown greedily by weighted benefit
(Σ calls × cost saved, per Bruno & Chaudhuri 2005). A candidate enters the set
only if it improves the *joint* outcome.

## Tests

```bash
npm test               # unit + GitHub-API integration (mock server)
npx vitest run test/db-e2e.integration.test.ts   # real Postgres 18 + HypoPG (needs Docker)
```

The E2E suite builds the HypoPG-enabled Postgres 18 image from `docker/Dockerfile.db`,
seeds a 200k-row un-indexed workload, and asserts doctor/explain/joint-set all
prove real speedups. Skips automatically when Docker is unavailable.

## Proven end-to-end

The repo dogfoods itself: during development, a scan of the bundled 500k-row
demo workload opened a real pull request against this repository — shadow
branch, migration file, and a HypoPG proof table (`Limit → Index Scan`,
cost 16841 → 16510). The same flow ships in the CLI you are about to run.

## Known limitations (v0.4)

- HNSW/IVFFlat (vector) candidates not yet proposed.
- Prisma users: `CREATE INDEX CONCURRENTLY` needs the documented workaround (prisma/orm#14456) — the generated PR includes it.

## Releasing

Changesets-managed: PRs add a `.changeset/*.md`; the Release workflow opens a
version PR and publishes to npm via **trusted publishing (OIDC)** — no
`NPM_TOKEN` secret is involved (`id-token: write`, npm ≥ 11.5.1 on Node 24),
only after the real-database E2E suite passes. Publish contents are audited:
`dist/ + README + LICENSE` — no sources, tests or env files.

## Development

```bash
npm run typecheck   # strict TS, zero errors
npm test            # vitest unit tests
npm run build       # dist/
```

## Pricing

| Plan | Price | Includes |
|---|---|---|
| **Free (this repo)** | $0 | scan · doctor · explain · SARIF · Slack · 1 database · community support |
| **Team — 5 databases** | $49/mo | everything in Free + multi-repo `workspace` + priority support |
| **Team XL — 20 databases** | $149/mo | Team + scheduled autonomous PRs (`autonomous-pr`) |
| **Team XL+ — 100 databases** | $399/mo | Team XL + roadmap input + SLA credits |
| **Sponsors tier** | from $5/mo | Team license included at the Team tier — [sponsor here](https://github.com/sponsors/goun7) |

**How to buy (fully self-serve, no meetings):** sponsor at the Team tier or
send $49/$149/$399 via a payment link you get by opening a
[Team license request](https://github.com/goun7/pgheal/issues/new?template=team-license.yml)
→ the `paid` label triggers automatic key delivery →
`pgheal license activate --key pgheal_…`. Keys are HMAC-signed and verified
offline; the signing secret never leaves the vendor.

Managed tuning SaaS products charge $149–$399+/month and upload your query
samples. pgHeal's proof runs **inside your database** — nothing leaves it.

## Terms

Use of pgHeal is subject to the [Terms of Use](./TERMS.md). Team customers
additionally sign a license agreement with an SLA schedule.

## License

MIT
