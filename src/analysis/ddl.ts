import type { IndexCandidate } from "../types.js";

/** Index DDL generation with deterministic naming. */

export function indexName(candidate: IndexCandidate): string {
  const cols = candidate.columns.join("_");
  const suffix = candidate.method === "btree" ? "" : `_${candidate.method}`;
  return `idx_${candidate.table}_${cols}${suffix}`.slice(0, 63); // PG identifier limit
}

export function indexDdl(candidate: IndexCandidate, opts: { concurrently: boolean }): string {
  const name = indexName(candidate);
  const concurrent = opts.concurrently ? "CONCURRENTLY " : "";
  if (candidate.method === "gin") {
    const col = candidate.columns[0] ?? "";
    return `CREATE ${concurrent}INDEX IF NOT EXISTS ${name} ON "${candidate.table}" USING gin ("${col}");`;
  }
  if (candidate.method === "brin") {
    const col = candidate.columns[0] ?? "";
    return `CREATE ${concurrent}INDEX IF NOT EXISTS ${name} ON "${candidate.table}" USING brin ("${col}");`;
  }
  const cols = candidate.columns
    .map((c) => (candidate.opclass ? `"${c}" ${candidate.opclass}` : `"${c}"`))
    .join(", ");
  return `CREATE ${concurrent}INDEX IF NOT EXISTS ${name} ON "${candidate.table}" (${cols});`;
}

/** Prisma's migrate does not wrap custom SQL in a transaction when told not to. */
export function prismaInstructions(): string[] {
  return [
    "Prisma does not support CREATE INDEX CONCURRENTLY inside regular migrations (prisma/orm#14456).",
    "Apply the SQL manually first: psql \"$DATABASE_URL\" -f <this-file>.sql",
    'Then mark it applied: npx prisma migrate resolve --applied "<migration-name>"',
  ];
}
