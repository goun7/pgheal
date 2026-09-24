# pgheal

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
