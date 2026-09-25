# pgheal

## 0.6.0

### Minor Changes

- [`98849ec`](https://github.com/goun7/pgheal/commit/98849ec1908d5fc35e44a9679c22ca27e6ea5dd3) Thanks [@goun7](https://github.com/goun7)! - v0.6: **Tokenless GitHub delivery** — authenticate as a GitHub App
  (`PGHEAL_GITHUB_APP_ID` + `PGHEAL_GITHUB_APP_INSTALLATION_ID` +
  `PGHEAL_GITHUB_APP_KEY_PATH`): a 10-minute RS256 app JWT is exchanged for a
  1-hour installation token; no long-lived PAT is stored, logged, or rotated.
  `GITHUB_TOKEN` remains as fallback and app mode wins automatically when the
  app env is present. Vector candidates now propose **both HNSW and IVFFlat**
  (`lists=100`) per query with method-aware naming, and `vector(n)` columns
  with n > 2000 get a **halfvec migration note** instead of an unbuildable
  index. `explain --analyze` is locked to SELECT/WITH — mutating statements
  and DDL are rejected before execution.

## 0.5.0

### Minor Changes

- [`d1dc679`](https://github.com/goun7/pgheal/commit/d1dc679a0b62f4b792b48795c4a696c46197e99e) Thanks [@goun7](https://github.com/goun7)! - v0.5: **pgvector workloads, honestly proven.** `<->`/`<=>`/`<#>` ORDER BY
  scans become HNSW candidates with operator-matched opclasses
  (`vector_l2_ops`/`vector_cosine_ops`/`vector_ip_ops`). Because HypoPG cannot
  simulate ANN indexes, these are never fake-proven: they ship with a 🟡
  **grounded** label (extension present, column is truly `vector`, filter
  columns proven where possible) and a ready `CREATE INDEX CONCURRENTLY` DDL
  — re-scan after applying for the real before/after. Expression indexes
  (`LOWER()`, `DATE()`, casts) are fully HypoPG-proven. The demo image now
  builds pgvector 0.8.6 and the E2E suite exercises the grounded path on a
  real server.

## 0.4.0

### Minor Changes

- [`435c46a`](https://github.com/goun7/pgheal/commit/435c46a031d36fb072707460a353984f8871f1d0) Thanks [@goun7](https://github.com/goun7)! - v0.4: subqueries & CTEs now in scope — predicate extraction walks every WHERE
  region (IN (SELECT …), correlated subqueries, WITH bodies); CTE names are
  excluded from table candidates and outer ORDER BY is forwarded to CTE bodies.
  SARIF 2.1.0 output (`scan --sarif`) for GitHub code scanning. Optional LLM PR
  summary (`PGHEAL_LLM_API_URL/KEY/MODEL`) — the model only ever sees the
  deterministic fact JSON, and the proof body is the fallback. Single-file
  landing page (`docs/`, GitHub Pages).
  
  Robustness/honesty audit: joint workload sets report each index with its own
  statement's proof (no win-copying); HypoPG silent rejection is detected
  (statement-level baseline propagation + to_regproc session probe); index size
  estimates use pg_stats.avg_width (fixes the attlen=-1 varlena undercount).
