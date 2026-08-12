import type { AnalysisRow, SortKey } from "./types";

function cmpNullable(a: number | null, b: number | null, dir: "asc" | "desc"): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  const d = a - b;
  return dir === "asc" ? d : -d;
}

export function sortAnalysisRows(
  rows: AnalysisRow[],
  sort: SortKey = "absDrift",
  sortDir: "asc" | "desc" = "desc",
): AnalysisRow[] {
  const copy = rows.slice();
  copy.sort((a, b) => {
    switch (sort) {
      case "edge":
        return cmpNullable(a.edgePct, b.edgePct, sortDir);
      case "drift":
        return cmpNullable(a.driftProbPct ?? a.driftOddsPct, b.driftProbPct ?? b.driftOddsPct, sortDir);
      case "absDrift": {
        const aa = a.driftProbPct ?? a.driftOddsPct;
        const bb = b.driftProbPct ?? b.driftOddsPct;
        return cmpNullable(aa == null ? null : Math.abs(aa), bb == null ? null : Math.abs(bb), sortDir);
      }
      case "odds":
        return cmpNullable(a.closing, b.closing, sortDir);
      case "kickoff": {
        const ka = a.kickoffAt || "";
        const kb = b.kickoffAt || "";
        const d = ka < kb ? -1 : ka > kb ? 1 : 0;
        return sortDir === "asc" ? d : -d;
      }
      default:
        return 0;
    }
  });
  return copy;
}
