import type { DropCandidate, IndexDef, TableWriteStats } from "../types.js";

/**
 * Index hygiene analysis (paper §4 step 2).
 * Redundant indexes tax every write; HypoPG-style proof is unnecessary here because
 * pg_stat_user_indexes gives direct evidence of non-usage.
 */

const MIN_OBSERVATION_DAYS = 30; // paper default: 30-day window

export function findUnusedIndexes(indexes: IndexDef[], minScans: number): DropCandidate[] {
  return indexes
    .filter((i) => i.isValid && !i.isUnique && i.scans <= minScans)
    .map((i) => ({
      index: i,
      reason: "unused" as const,
      writeOverheadPerDay: 0, // filled by caller with write stats
    }));
}

export function findRedundantIndexes(indexes: IndexDef[]): DropCandidate[] {
  const out: DropCandidate[] = [];
  for (const a of indexes) {
    for (const b of indexes) {
      if (a === b) continue;
      if (a.table !== b.table) continue;
      if (!a.isValid || !b.isValid) continue;
      // b is redundant if its column list is a strict prefix of a's
      const isPrefix =
        b.columns.length > 0 &&
        a.columns.length > b.columns.length &&
        b.columns.every((c, i) => a.columns[i] === c);
      if (isPrefix) {
        out.push({
          index: b,
          reason: "redundant",
          supersededBy: a.name,
          writeOverheadPerDay: 0,
        });
      }
    }
  }
  // dedupe: same index flagged by multiple survivors keeps the first
  const seen = new Set<string>();
  return out.filter((d) => {
    if (seen.has(d.index.name)) return false;
    seen.add(d.index.name);
    return true;
  });
}

export function findInvalidIndexes(indexes: IndexDef[]): DropCandidate[] {
  return indexes.filter((i) => !i.isValid).map((i) => ({ index: i, reason: "invalid" as const, writeOverheadPerDay: 0 }));
}

export function analyzeIndexHygiene(
  indexes: IndexDef[],
  writes: TableWriteStats[],
  unusedIndexDays: number,
): { drops: DropCandidate[]; totalWriteOverheadBytesPerDay: number } {
  void unusedIndexDays; // window handled by stats reset policy upstream; kept for API stability
  const writesByTable = new Map(writes.map((w) => [w.table, w]));
  const unused = findUnusedIndexes(indexes, 0);
  const redundant = findRedundantIndexes(indexes);
  const invalid = findInvalidIndexes(indexes);

  const drops = [...unused, ...redundant, ...invalid].map((d) => {
    const w = writesByTable.get(d.index.table);
    const dailyWrites = w ? (w.inserts + w.updates + w.deletes) / MIN_OBSERVATION_DAYS : 0;
    return { ...d, writeOverheadPerDay: Math.round(d.index.sizeBytes * dailyWrites) };
  });

  const totalWriteOverheadBytesPerDay = drops.reduce((acc, d) => acc + d.writeOverheadPerDay, 0);
  return { drops, totalWriteOverheadBytesPerDay };
}
