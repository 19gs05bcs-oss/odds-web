import { analysisMatchesPostFilters, quoteMatchesFilters } from "./filters";
import {
  driftOddsPct,
  driftProbPct,
  edgePct,
  impliedProb,
  devigMultiplicative,
} from "./math";
import { sortAnalysisRows } from "./rank";
import type { AnalysisRow, AnalyzeResult, FilterState, Quote } from "./types";

function marketGroupKey(q: Quote): string {
  return `${q.eventId}|${q.marketKey}|${q.bookmakerId || "_"}`;
}

function scoreLabel(home: number | null, away: number | null): string | null {
  if (home == null || away == null) return null;
  return `${home}-${away}`;
}

/**
 * Build analysis rows from normalized quotes.
 * Fair probs: multiplicative de-vig across outcomes of the same market+bookmaker.
 * Edge is labeled "model edge" (not sharp-book CLV) when only archive books exist.
 */
export function analyzeQuotes(quotes: Quote[], filters: FilterState = {}): AnalyzeResult {
  const t0 = Date.now();
  const pre = quotes.filter((q) => quoteMatchesFilters(q, filters));

  // Group for de-vig
  const groups = new Map<string, Quote[]>();
  for (const q of pre) {
    const k = marketGroupKey(q);
    const arr = groups.get(k);
    if (arr) arr.push(q);
    else groups.set(k, [q]);
  }

  const fairByQuote = new Map<Quote, number | null>();
  for (const group of groups.values()) {
    const probs = group.map((q) => impliedProb(q.closing ?? q.opening));
    const fair = devigMultiplicative(probs);
    group.forEach((q, i) => fairByQuote.set(q, fair[i] ?? null));
  }

  const rows: AnalysisRow[] = [];
  for (const q of pre) {
    const opening = q.opening;
    const closing = q.closing;
    const fair = fairByQuote.get(q) ?? null;
    const row: AnalysisRow = {
      eventId: q.eventId,
      sourceEventId: q.sourceEventId,
      competition: q.competition,
      seasonSlug: q.seasonSlug,
      round: q.round,
      homeTeam: q.homeTeam,
      awayTeam: q.awayTeam,
      kickoffAt: q.kickoffAt,
      score: scoreLabel(q.homeScore, q.awayScore),
      marketType: q.marketType,
      marketScope: q.marketScope,
      marketName: q.marketName,
      line: q.line,
      side: q.side,
      sideName: q.sideName,
      opening,
      closing,
      driftOddsPct: driftOddsPct(opening, closing),
      driftProbPct: driftProbPct(opening, closing),
      impliedOpen: impliedProb(opening),
      impliedClose: impliedProb(closing),
      fairProb: fair,
      edgePct: edgePct(closing ?? opening, fair),
      bookmakerId: q.bookmakerId,
      bookmakerName: q.bookmakerName,
    };
    if (analysisMatchesPostFilters(row, filters)) {
      rows.push(row);
    }
  }

  const sorted = sortAnalysisRows(rows, filters.sort || "absDrift", filters.sortDir || "desc");
  const limit = filters.limit && filters.limit > 0 ? Math.min(filters.limit, 500) : 200;
  const truncated = sorted.length > limit;

  return {
    rows: sorted.slice(0, limit),
    totalMatched: sorted.length,
    truncated,
    tookMs: Date.now() - t0,
  };
}
