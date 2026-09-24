# pgHeal — Terms of Use

_Last updated: 2026-09-24_

## 1. Acceptance

By downloading, installing or running the pgHeal CLI, or by using the
website (https://goun7.github.io/pgheal/), you agree to these terms. If you
do not agree, do not use the software.

## 2. The software

- The pgHeal CLI is open-source software licensed under the **MIT License**
  (see LICENSE). These terms add usage rules; they do not replace the MIT
  license.
- pgHeal connects **only** to databases you configure. It runs read-only
  (`default_transaction_read_only=on`) and generates recommendations; it does
  not modify your database. Migrations it produces are applied by **you**, and
  merging a pull request remains a **human decision**.

## 3. No performance guarantee

Recommendations are planner-cost estimates produced with HypoPG hypothetical
indexes. Real-world results depend on your data, statistics and workload.
Always validate with `EXPLAIN (ANALYZE, BUFFERS)` before applying anything to
production. pgHeal makes no warranty of any particular performance outcome.

## 4. Your responsibilities

- You are responsible for the security of your `DATABASE_URL`, GitHub tokens
  and license keys.
- You are responsible for compliance with the laws applicable to your use.
- Do not point pgHeal at databases you are not authorized to analyze.

## 5. Optional third-party endpoints

Features you explicitly enable — the AI PR summary (`PGHEAL_LLM_API_URL`)
and Slack notifications — send only the documented fact summaries to
endpoints **you** configure. pgHeal has no telemetry and never sends query
text, rows or credentials anywhere by itself.

## 6. Paid plans

Team licenses (multi-repo `workspace`, priority support) are governed by a
separate signed license agreement, which prevails over these terms for
paying customers.

## 7. Limitation of liability

To the maximum extent permitted by law, the authors are not liable for any
indirect, incidental or consequential damages arising from use of the
software. The software is provided "as is", without warranty of any kind.

## 8. Changes

These terms may be updated; material changes are announced in release notes.
Continued use after an update constitutes acceptance.

## 9. Contact

Security: see [SECURITY.md](./SECURITY.md). Everything else: open a GitHub
issue at https://github.com/goun7/pgheal/issues
