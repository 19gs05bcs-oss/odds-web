import type { OddsCriterion } from "./profile";
import research from "./smartAnalysisData.json";

export type SmartResearch = typeof research;

export type SmartInsight = {
  id: string;
  severity: "info" | "good" | "warn";
  title: string;
  body: string;
};

export type SmartRecommendation = {
  bookmakerId: string;
  bookmakerName: string;
  tolerance: number;
  minPoolSize: number;
  useStackedCriteria: boolean;
  insights: SmartInsight[];
};

const BASELINE_1X2 = 1 / 3;

export function getSmartResearch(): SmartResearch {
  return research;
}

function fmtPct(v: number, digits = 1): string {
  return `${(v * 100).toFixed(digits)}%`;
}

function bookmakerEdge(bookmakerId: string): number | null {
  const row = research.bookmakerRanking.find((b) => b.id === bookmakerId);
  return row?.edgePp ?? null;
}

function bookmakerName(bookmakerId: string): string | null {
  const row = research.bookmakerRanking.find((b) => b.id === bookmakerId);
  return row?.name ?? null;
}

/** Research-backed defaults for profile narrowing. */
export function getSmartRecommendation(
  criteria: OddsCriterion[],
  currentBookmakerId: string,
  currentTolerance: number,
  matchedCount?: number,
): SmartRecommendation {
  const rec = research.recommendations;
  const insights: SmartInsight[] = [];

  insights.push({
    id: "sample",
    severity: "info",
    title: "Archive calibration",
    body: `PL 4 seasons · ${research.sampleEvents.toLocaleString()} finished matches · composite 1X2 favourite hits ${fmtPct(research.composite1x2.topPickPct ?? 0)}.`,
  });

  const top = research.bookmakerRanking[0];
  if (top) {
    insights.push({
      id: "bm-edge",
      severity: top.edgePp > 0.02 ? "good" : "info",
      title: "Sharpest best-price book (1X2)",
      body: `${top.name} (#${top.id}) — actual ${fmtPct(top.actualWinPct)} vs implied ${fmtPct(top.avgImpliedPct)} (+${(top.edgePp * 100).toFixed(1)} pp, n=${top.n}).`,
    });
  }

  const tolKey = String(rec.tolerance);
  const tolRow = research.toleranceSweep[tolKey as keyof typeof research.toleranceSweep];
  if (tolRow) {
    const lift = tolRow.sameOutcomePct / 100 - BASELINE_1X2;
    insights.push({
      id: "tol",
      severity: lift > 0.08 ? "good" : "info",
      title: `Tolerance ±${(rec.tolerance * 100).toFixed(0)}%`,
      body: `Avg archive pool ~${Math.round(tolRow.avgPool)} matches; same 1X2 outcome ${tolRow.sameOutcomePct.toFixed(1)}% vs ${(BASELINE_1X2 * 100).toFixed(0)}% random baseline (+${(lift * 100).toFixed(1)} pp).`,
    });
  }

  if (criteria.length >= 2) {
    const st = research.stackedProfile;
    insights.push({
      id: "stack",
      severity: criteria.length >= 3 ? "good" : "warn",
      title: "Stacked filters",
      body:
        criteria.length >= 3
          ? `Multi-market stack narrows pool to ~${Math.round(st.avgPool)} matches (same-outcome ~${st.sameOutcomePct.toFixed(1)}% in research).`
          : `Add 1–2 more markets (e.g. Over 2.5, BTTS) to tighten pool from ~${tolRow ? Math.round(tolRow.avgPool) : 80} → ~${Math.round(st.avgPool)} matches.`,
    });
  }

  const curEdge = currentBookmakerId ? bookmakerEdge(currentBookmakerId) : null;
  if (currentBookmakerId && curEdge != null && curEdge < -0.02) {
    const name = bookmakerName(currentBookmakerId) ?? `#${currentBookmakerId}`;
    insights.push({
      id: "cur-bm",
      severity: "warn",
      title: "Bookmaker swap?",
      body: `${name} underperforms implied by ${(Math.abs(curEdge) * 100).toFixed(1)} pp on 1X2 best-price picks. Try ${rec.bookmakerName} (#${rec.bookmakerId}).`,
    });
  }

  if (matchedCount != null && matchedCount > 0) {
    const min = rec.minPoolSize;
    insights.push({
      id: "pool",
      severity: matchedCount < min ? "warn" : matchedCount > 150 ? "warn" : "good",
      title: "Current pool",
      body:
        matchedCount < min
          ? `${matchedCount} matches — widen tolerance or drop a filter (target ≥${min}).`
          : matchedCount > 150
            ? `${matchedCount} matches — tighten tolerance or add a market filter.`
            : `${matchedCount} matches — healthy narrowing band for pattern search.`,
    });
  }

  if (currentTolerance === 0 && criteria.length > 0) {
    insights.push({
      id: "tol-zero",
      severity: "warn",
      title: "Tolerance is 0",
      body: "Exact odds matches are rare across seasons. Use ±2–3% relative tolerance for meaningful archive pools.",
    });
  }

  insights.push({
    id: "data-source",
    severity: "info",
    title: "Veri kaynağı",
    body: "Analyze zaten events.markets_json kullanıyor — ayrı event_quotes tablosu şart değil. O tablo yalnızca 20 bookmaker'ın tam grid'ini SQL'de sorgulamak istersen (opsiyonel performans optimizasyonu).",
  });

  return {
    bookmakerId: rec.bookmakerId,
    bookmakerName: rec.bookmakerName,
    tolerance: rec.tolerance,
    minPoolSize: rec.minPoolSize,
    useStackedCriteria: rec.useStackedCriteria,
    insights,
  };
}

/** Score how well current settings align with research (0–100). */
export function scoreSmartSettings(
  criteria: OddsCriterion[],
  bookmakerId: string,
  tolerance: number,
  matchedCount?: number,
): number {
  let score = 50;
  const rec = research.recommendations;
  if (bookmakerId === rec.bookmakerId || !bookmakerId) score += 15;
  const edge = bookmakerId ? bookmakerEdge(bookmakerId) : null;
  if (edge != null && edge > 0) score += Math.min(15, edge * 100);
  if (Math.abs(tolerance - rec.tolerance) <= 0.01) score += 15;
  else if (tolerance > 0) score += 5;
  if (criteria.length >= 2) score += 10;
  if (matchedCount != null && matchedCount >= rec.minPoolSize && matchedCount <= 120) score += 10;
  return Math.min(100, Math.max(0, score));
}
