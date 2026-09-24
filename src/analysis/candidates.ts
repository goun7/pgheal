import type { IndexCandidate, Predicate, StatementStats } from "../types.js";
import { fingerprint, normalizeSql } from "./normalize.js";

/**
 * Deterministic index-candidate generation (paper §4).
 * Grounded in AutoAdmin '98 "what-if" doctrine: propose → simulate → accept only proven plans.
 */

const FORBIDDEN_TABLES = /(pg_catalog|information_schema|pg_stat|pgheal)/i;
export { FORBIDDEN_TABLES };

interface QueryShape {
  tables: string[];
  predicates: Predicate[];
  orderBy: string[];
  groupBy: string[];
}

function stripWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Clause keywords that terminate a FROM/WHERE scan region at paren depth 0.
 * WHERE regions must NOT stop at nested FROMs (subqueries keep their predicates).
 */
const REGION_STOP =
  /^(?:GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|OFFSET|WINDOW|UNION|INTERSECT|EXCEPT|RETURNING|FOR\s+UPDATE|FOR\s+SHARE|FETCH\s+FIRST|FROM|WHERE|SELECT)\b/i;

/**
 * Text after a keyword until the enclosing clause or paren ends.
 * Depth starts at 0 for the region itself; a `)` closing an outer paren ends it.
 */
function regionUntil(norm: string, start: number): string {
  let depth = 0;
  for (let i = start; i < norm.length; i++) {
    const ch = norm[i]!;
    if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      if (depth === 0) return norm.slice(start, i);
      depth--;
    } else if (depth === 0 && /[A-Za-z_]/.test(ch) && !/[A-Za-z_0-9]/.test(norm[i - 1] ?? " ")) {
      if (REGION_STOP.test(norm.slice(i))) return norm.slice(start, i);
    }
  }
  return norm.slice(start);
}

/** Every `<keyword> <region>` occurrence — subqueries and CTE bodies included. */
function keywordRegions(norm: string, keyword: RegExp): string[] {
  const out: string[] = [];
  const re = new RegExp(keyword.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(norm))) {
    out.push(regionUntil(norm, m.index + m[0].length));
  }
  return out;
}

/** CTE names (`name AS (` / `name (cols) AS (`) are not physical tables. */
function cteNames(norm: string): Set<string> {
  const out = new Set<string>();
  const re = /([A-Za-z_][\w]*)\s*(?:\([^)]*\))?\s+AS\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(norm))) {
    if (m[1]) out.add(m[1].toLowerCase());
  }
  return out;
}

/** Best-effort shape extractor for SELECT statements (flat, subqueries, CTEs). */
export function extractShape(sql: string): QueryShape {
  const norm = stripWhitespace(normalizeSql(sql));
  const shape: QueryShape = { tables: [], predicates: [], orderBy: [], groupBy: [] };
  const ctes = cteNames(norm);

  // table sources: every FROM region (outer query, subqueries, CTE bodies)
  for (const fromRegion of keywordRegions(norm, /\bFROM\b/)) {
    for (const raw of fromRegion.split(",")) {
      const t = stripWhitespace(raw.split(/\s+as\s+/i)[0]!).split(/\s+/)[0]!;
      if (t && /^[A-Za-z_][\w.]*$/.test(t) && !ctes.has(stripAlias(t).toLowerCase())) {
        shape.tables.push(stripAlias(t));
      }
    }
  }
  const joinRe = /\bJOIN\s+((?:ONLY\s+)?[A-Za-z_][\w.]*)/gi;
  let jm: RegExpExecArray | null;
  while ((jm = joinRe.exec(norm))) {
    if (jm[1] && !ctes.has(stripAlias(jm[1]).toLowerCase())) shape.tables.push(stripAlias(jm[1]));
  }

  // ORDER BY must be parsed BEFORE the vector scan below: distance operators
  // usually appear in ORDER BY (`ORDER BY embedding <=> $1`)
  const orderMatch = /\bORDER\s+BY\s+([\s\S]*?)(?=\bLIMIT\b|\bFOR\s+UPDATE\b|$)/i.exec(norm);
  if (orderMatch?.[1]) {
    shape.orderBy = orderMatch[1]
      .split(",")
      .map((c) => columnName(stripWhitespace(c)))
      .filter(Boolean);
  }

  // predicates: every WHERE region (outer query, subqueries, CTE bodies)
  const whereFragments: string[] = [];
  for (const whereRegion of keywordRegions(norm, /\bWHERE\b/)) {
    whereFragments.push(whereRegion);
    for (const p of splitTopLevel(whereRegion)) {
      const kind = classifyPredicate(p);
      if (kind === null) continue;
      for (const c of columnsOfPredicate(p)) shape.predicates.push({ column: c, kind });
    }
  }
  // specialized access-path signals
  for (const c of containmentColumns(whereFragments.join(" "))) {
    shape.predicates.push({ column: c, kind: "containment" });
  }
  // pgvector distance operators (<-> L2, <=> cosine, <#> inner product)
  for (const c of vectorDistanceColumns(whereFragments.join(" ") + " " + shape.orderBy.join(" "))) {
    shape.predicates.push({ column: c, kind: "vector-distance" });
  }
  // functional predicates worth EXPRESSION indexes (HypoPG-simulable btree)
  for (const e of expressionPredicateColumns(whereFragments.join(" "))) {
    shape.predicates.push(e);
  }

  const groupMatch = /\bGROUP\s+BY\s+([\s\S]*?)(?=\bHAVING\b|\bORDER\s+BY\b|\bLIMIT\b|$)/i.exec(norm);
  if (groupMatch?.[1]) {
    shape.groupBy = groupMatch[1]
      .split(",")
      .map((c) => columnName(stripWhitespace(c)))
      .filter(Boolean);
  }

  // v0.4: outer ORDER BY / GROUP BY by column name also helps the CTE body scan
  // that produces those columns — forward them so `SELECT * FROM recent_orders
  // ORDER BY created_at` can prove an index on the underlying table.
  if (ctes.size > 0) {
    if (shape.orderBy.length > 0) shape.orderBy.push(...shape.orderBy);
    if (shape.groupBy.length > 0) shape.groupBy.push(...shape.groupBy);
  }

  return shape;
}

function stripAlias(t: string): string {
  // "public.orders" -> "orders" ; strip schema qualification for candidate naming
  const bare = t.includes(".") ? t.split(".").pop()! : t;
  return bare.replace(/"/g, "");
}

function classifyPredicate(p: string): "equality" | "range" | null {
  if (/\b(IS\s+NULL|IS\s+NOT\s+NULL)\b/i.test(p)) return null;
  if (/[=]/.test(p.replace(/[!=<>]=?/g, "")) || /[^<>=!]=[^=]/.test(p) || /=/.test(p)) {
    // equality if '=' present and not part of <=, >=, !=, <>
    if (!/[<>]=?|!=|<>/.test(p)) return "equality";
  }
  if (/\bLIKE\b|\bILIKE\b/i.test(p)) return "range"; // may help via text_pattern_ops (prefix) or gin+trgm
  if (/[<>]=?|!=|<>|\bBETWEEN\b|\bIN\s*\(/i.test(p)) return "range";
  return null;
}

/** Columns used with LIKE/ILIKE — left-anchored prefix candidates. */
export function likePrefixColumns(predicates: Predicate[]): string[] {
  return [
    ...new Set(
      predicates
        .filter((p) => p.kind === "range")
        .map((p) => p.column),
    ),
  ];
}

/** Columns used with JSONB/array containment operators (@>, ?, ?|, ?&) → gin candidates. */
export function containmentColumns(whereClause: string): string[] {
  const out: string[] = [];
  const re = /([A-Za-z_][\w.]*)\s*(?:@>|\?\||\?&|\?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(whereClause))) {
    if (m[1]) out.push(m[1].includes(".") ? m[1].split(".").pop()! : m[1]);
  }
  return [...new Set(out)];
}

/** Columns used with pgvector distance operators → HNSW candidates (method chosen with opclass). */
export function vectorDistanceColumns(text: string): string[] {
  const out: string[] = [];
  const re = /([A-Za-z_][\w.]*)\s*(?:<->|<=>|<#>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[1]) out.push(m[1].includes(".") ? m[1].split(".").pop()! : m[1]);
  }
  return [...new Set(out)];
}

/**
 * Functional predicates worth EXPRESSION indexes: `LOWER(col) = ?`,
 * `DATE(col) = ?`, `col::date = ?`. HypoPG simulates expression btrees, so
 * these get full planner proof (v0.5's safe half).
 */
export function expressionPredicateColumns(text: string): Predicate[] {
  const out: Predicate[] = [];
  const re = /\b(LOWER|UPPER|DATE)\s*\(\s*([A-Za-z_][\w.]*)\s*\)|([A-Za-z_][\w.]*)::(date|text)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let expr: string | undefined;
    let col: string | undefined;
    if (m[1]) {
      // LOWER/UPPER/DATE(func) — keep the writer's case for the DDL expression
      const fn = m[1] === "DATE" ? "DATE" : m[1].toUpperCase();
      expr = `${fn}("${m[2]!.split(".").pop()!}")`;
      col = m[2]!.split(".").pop()!;
    } else if (m[3]) {
      expr = `("${m[3]!.split(".").pop()!}")::${m[4]!}`;
      col = m[3]!.split(".").pop()!;
    }
    if (col && expr) out.push({ column: col, kind: "equality", expression: expr });
  }
  return out;
}

/** Timestamp-ish range columns — brin evaluation marker (huge append-only tables). */
export function brinEligibleColumns(predicates: Predicate[]): string[] {
  return [
    ...new Set(
      predicates
        .filter((p) => p.kind === "range")
        .map((p) => p.column)
        .filter((c) => /(_at|_date|^date|time)$/i.test(c)),
    ),
  ];
}

/** Extract bare column names from a predicate fragment (both sides of an operator). */
function columnsOfPredicate(p: string): string[] {
  const out: string[] = [];
  // left side: e.g. "o.user_id" / "user_id" / "LOWER(email)" (function call skipped in v0.1)
  const left = /([A-Za-z_][\w.]*)\s*(?:=|<>|!=|<=|>=|<|>|\bBETWEEN\b|\bIN\b|\bLIKE\b|\bILIKE\b)/i.exec(p);
  if (left?.[1]) {
    const c = left[1];
    if (/^[A-Za-z_][\w.]*$/.test(c) && !/^(LOWER|UPPER|DATE|COALESCE|DATE_TRUNC|EXTRACT)$/i.test(c)) {
      out.push(c.includes(".") ? c.split(".").pop()! : c);
    }
  }
  // right side: capture "col = other.col" join-style predicates
  const right = /=\s*([A-Za-z_][\w.]*)\s*($|\bAND\b|\bOR\b)/i.exec(p);
  if (right?.[1]) {
    const c = right[1];
    if (/^[A-Za-z_][\w.]*$/.test(c)) out.push(c.includes(".") ? c.split(".").pop()! : c);
  }
  return [...new Set(out)];
}

function columnName(c: string): string {
  const bare = c.replace(/\s+(ASC|DESC)\b/i, "").replace(/"/g, "");
  return bare.includes(".") ? bare.split(".").pop()! : bare;
}

/** Split on AND at paren-depth 0 (top level only). */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  const tokens = s.split(/(\bAND\b|\(|\))/i); // conjunction: AND
  for (const tok of tokens) {
    if (tok === undefined || tok === "") continue;
    if (/^\($/.test(tok)) {
      depth++;
      cur += tok;
    } else if (/^\)$/.test(tok)) {
      depth = Math.max(0, depth - 1);
      cur += tok;
    } else if (/^AND$/i.test(tok) && depth === 0) {
      out.push(stripWhitespace(cur));
      cur = "";
    } else {
      cur += tok;
    }
  }
  if (stripWhitespace(cur)) out.push(stripWhitespace(cur));
  return out.filter((p) => p.length > 0);
}

/**
 * SELECT statements are in scope — flat, subqueries and CTEs alike (v0.4 scope
 * expansion; paper §10 roadmap). Writes and utility statements are not.
 */
export function isSupportedStatement(sql: string): boolean {
  const n = normalizeSql(sql);
  if (!/\bselect\b/i.test(n)) return false;
  // `FOR UPDATE` mentions UPDATE but is a pure read-lock; data-modifying CTEs stay excluded.
  const withoutForUpdate = n.replace(/\bFOR\s+UPDATE\b/gi, " ");
  return !/\b(INSERT|UPDATE|DELETE|MERGE)\b/i.test(withoutForUpdate);
}

export function makeCandidates(stmt: StatementStats): IndexCandidate[] {
  const fp = fingerprint(stmt.query);
  const shape = extractShape(stmt.query);
  const out: IndexCandidate[] = [];

  for (const table of [...new Set(shape.tables)].slice(0, 3)) {
    if (FORBIDDEN_TABLES.test(table)) continue;

    const eq = shape.predicates.filter((p) => p.kind === "equality");
    const rng = shape.predicates.filter((p) => p.kind === "range");
    const ginCols = shape.predicates.filter((p) => p.kind === "containment").map((p) => p.column);
    const vecCols = shape.predicates.filter((p) => p.kind === "vector-distance").map((p) => p.column);
    const exprPreds = shape.predicates.filter((p) => p.expression);

    // Which predicates belong to this table? v0.1 heuristic: unqualified columns
    // are attributed to the first table; qualified ones to their own table.
    const eqCols = eq
      .map((p) => p.column)
      .filter((c) => shape.tables[0] === table || !c.includes("."));
    const rngCols = rng.map((p) => p.column);

    const tail = shape.groupBy.length ? shape.groupBy : shape.orderBy;

    // GIN candidates: containment on jsonb/array columns (planner verifies value)
    for (const col of ginCols) {
      out.push({
        table,
        columns: [col],
        method: "gin",
        isUnique: false,
        fromQueryid: stmt.queryid,
        reason: `jsonb/array containment on ${col} — top statement ${fp} (${stmt.calls} calls)`,
      });
    }

    // HNSW candidates: pgvector distance ordering/filtering (v0.5). HypoPG can
    // NOT simulate hnsw — simulate.ts routes these to the grounded path.
    // opclass must match the query's distance operator:
    //   <-> → vector_l2_ops · <=> → vector_cosine_ops · <#> → vector_ip_ops
    const vecOp = /<=>|<->|<#>/.exec(stmt.query)?.[0];
    const vecOpclass = vecOp === "<->" ? "vector_l2_ops" : vecOp === "<#>" ? "vector_ip_ops" : "vector_cosine_ops";
    for (const col of vecCols) {
      out.push({
        table,
        columns: [col],
        method: "hnsw",
        opclass: vecOpclass,
        isUnique: false,
        fromQueryid: stmt.queryid,
        reason: `pgvector distance ordering on ${col} (${vecOp ?? "<=>"}) — top statement ${fp} (${stmt.calls} calls)`,
      });
      // v0.6: IVFFlat as the alternative candidate — faster to build, lower
      // recall; the customer picks per their accuracy/latency trade-off.
      out.push({
        table,
        columns: [col],
        method: "ivfflat",
        opclass: vecOpclass,
        isUnique: false,
        fromQueryid: stmt.queryid,
        reason: `pgvector distance on ${col} (${vecOp ?? "<=>"}) — IVFFlat alternative (faster build, lower recall; lists≈sqrt(rows))`,
      });
    }

    // EXPRESSION candidates: LOWER/UPPER/DATE/::cast predicates get a
    // functional btree — HypoPG CAN simulate these (full planner proof).
    for (const p of exprPreds) {
      if (!p.expression || p.column.includes(".")) continue;
      out.push({
        table,
        columns: [p.column],
        method: "btree",
        expression: p.expression,
        isUnique: false,
        fromQueryid: stmt.queryid,
        reason: `functional predicate on ${p.expression} — HypoPG-simulable expression btree`,
      });
    }

    const cols: string[] = [];
    for (const c of [...eqCols, ...rngCols, ...(tail ?? [])]) {
      if (c && !cols.includes(c) && cols.length < 4) cols.push(c);
    }
    if (!cols.length) continue;

    out.push({
      table,
      columns: cols,
      method: "btree",
      isUnique: false,
      fromQueryid: stmt.queryid,
      reason: `top statement ${fp} — ${stmt.calls} calls, ${Math.round(stmt.totalExecTime)} ms total`,
    });
  }

  return out;
}
