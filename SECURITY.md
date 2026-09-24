# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.4.x | ✅ |
| < 0.4 | ❌ |

## Reporting a vulnerability

**Please do not open a public issue for security reports.**

Use GitHub's private vulnerability reporting:
**https://github.com/goun7/pgheal/security/advisories/new**

You will get an acknowledgment within **72 hours** and a fix timeline within
**7 days**. Credit is given in the release notes unless you prefer otherwise.

## Scope and design guarantees

pgHeal is a **read-only analysis tool**. Its safety model (enforced in
`src/postgres/client.ts`) is part of the security surface:

- every connection opens with `default_transaction_read_only=on` and
  `lock_timeout=1s` — the agent cannot write to your database
- `statement_timeout` bounds every query; `max: 2` pooled connections cap load
- HypoPG hypothetical indexes live only inside the simulating session
- nothing but **normalized query fingerprints and catalog counters** is ever
  sent anywhere; query text, rows, and literals never leave the machine

A valid report includes any of:

1. a code path that can execute DDL/DML against the scanned database
2. query text, rows, or literals leaving the machine (exfiltration)
3. the GitHub token or license secret being logged, echoed, or leaked
4. injection into the generated migration/PR content (SQL/Markdown/HTML)

## What is explicitly out of scope

- attacks requiring write access to the target database already
- the optional LLM endpoint receiving the fact JSON — that is by design and
  documented; only the endpoint URL/owner you configure receives it
