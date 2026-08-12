import { sideMatchesFilter } from "./labels";
import type { AnalysisRow, FilterState, Quote } from "./types";

function inDateRange(iso: string | null, from?: string | null, to?: string | null): boolean {
  if (!iso) return !(from || to);
  if (from && iso < from) return false;
  if (to && iso > to) return false;
  return true;
}

export function quoteMatchesFilters(q: Quote, f: FilterState): boolean {
  if (f.seasonSlug && q.seasonSlug !== f.seasonSlug) return false;
  if (f.competition && (q.competition || "").toLowerCase().indexOf(f.competition.toLowerCase()) === -1) {
    return false;
  }
  if (f.round && q.round !== f.round) return false;
  if (f.marketType && q.marketType !== f.marketType) return false;
  if (f.marketScope && q.marketScope !== f.marketScope) return false;
  if (f.bookmakerId && q.bookmakerId !== f.bookmakerId) return false;
  if (f.side && !sideMatchesFilter(q.side, q.sideName, f.side)) return false;
  // Primary: closing odds band (Excel-like). Fall back to opening if no close.
  const odds = q.closing ?? q.opening;
  if (f.minOdds != null && (odds == null || odds < f.minOdds)) return false;
  if (f.maxOdds != null && (odds == null || odds > f.maxOdds)) return false;
  if (f.targetOdds != null) {
    if (odds == null) return false;
    const tol = f.oddsTolerance != null && f.oddsTolerance >= 0 ? f.oddsTolerance : 0.05;
    if (Math.abs(odds - f.targetOdds) > tol) return false;
  }
  if (!inDateRange(q.kickoffAt, f.dateFrom, f.dateTo)) return false;
  return true;
}

export function analysisMatchesPostFilters(row: AnalysisRow, f: FilterState): boolean {
  if (f.minAbsDriftPct != null) {
    const d = row.driftProbPct ?? row.driftOddsPct;
    if (d == null || Math.abs(d) < f.minAbsDriftPct) return false;
  }
  if (f.minEdgePct != null) {
    if (row.edgePct == null || row.edgePct < f.minEdgePct) return false;
  }
  return true;
}

export function parseFilterState(input: Record<string, unknown> | URLSearchParams): FilterState {
  const get = (k: string): string | null => {
    if (input instanceof URLSearchParams) {
      const v = input.get(k);
      return v && v.trim() ? v.trim() : null;
    }
    const v = input[k];
    if (v == null) return null;
    const s = String(v).trim();
    return s ? s : null;
  };
  const num = (k: string): number | null => {
    const s = get(k);
    if (s == null) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };

  const sort = get("sort") as FilterState["sort"];
  const sortDir = get("sortDir") as FilterState["sortDir"];

  return {
    seasonSlug: get("seasonSlug") || get("season"),
    competition: get("competition"),
    round: get("round"),
    marketType: get("marketType") || get("market"),
    marketScope: get("marketScope") || get("scope"),
    bookmakerId: get("bookmakerId") || get("bookmaker"),
    side: get("side"),
    minOdds: num("minOdds"),
    maxOdds: num("maxOdds"),
    targetOdds: num("targetOdds"),
    oddsTolerance: num("oddsTolerance") ?? num("tol"),
    minAbsDriftPct: num("minAbsDriftPct") ?? num("minDrift"),
    minEdgePct: num("minEdgePct") ?? num("minEdge"),
    dateFrom: get("dateFrom"),
    dateTo: get("dateTo"),
    // Default: cluster similar odds (not drift radar)
    sort: sort || "odds",
    sortDir: sortDir === "asc" || sortDir === "desc" ? sortDir : "asc",
    limit: num("limit") ?? 200,
  };
}

/** True when user clicked Uygula (or shared a runnable URL). */
export function hasRunnableFilters(input: URLSearchParams | FilterState): boolean {
  if (input instanceof URLSearchParams) {
    return input.get("run") === "1" || input.get("apply") === "1";
  }
  return Boolean(
    input.marketType ||
      input.minOdds != null ||
      input.maxOdds != null ||
      input.targetOdds != null ||
      input.side,
  );
}
