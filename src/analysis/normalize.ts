/**
 * Deterministic SQL normalizer.
 *
 * Purpose: compare statements across pg_stat_statements samples and fingerprint
 * queries for branch naming — without reading any real data (paper §2/§9).
 *
 * Only literal-tokens are handled; SQL text alone never leaves the machine
 * except (masked) into the generated PR.
 */

export function normalizeSql(sql: string): string {
  let s = sql;

  // 1. strip line comments
  s = s.replace(/--[^\n]*$/gm, "");

  // 2. strip block comments
  s = s.replace(/\/\*[\s\S]*?\*\//g, " ");

  // 3. single-quoted strings -> ?
  s = s.replace(/'(?:[^']|'')*'/g, "?");

  // 4. dollar-quoted strings ($$...$$, $tag$...$tag$)
  s = s.replace(/\$([A-Za-z_]?[A-Za-z_0-9]*)\$[\s\S]*?\$\1\$/g, "?");

  // 5. escaped-string (E'...') — the quote char is consumed by rule 3 already;
  //    normalize the E prefix away
  s = s.replace(/\b[Ee]'/g, "'");

  // 6. numeric literals -> ?
  s = s.replace(/\b\d+(\.\d+)?\b/g, "?");

  // 7. whitespace collapse
  s = s.replace(/\s+/g, " ").trim();

  return s;
}

export function fingerprint(sql: string): string {
  const n = normalizeSql(sql);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < n.length; i++) {
    const c = n.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(36) + h2.toString(36)).slice(0, 10);
}
