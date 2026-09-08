import type { CompactOddsRow } from "@/lib/fixtures";

/**
 * Similarity aramasından ÖNCE, seçilen maçın kendi 1X2 (HOME_DRAW_AWAY/FULL_TIME)
 * oranlarından hesaplanan piyasa sinyalleri: büro saçılması (dispersion), net
 * arbitraj (surebet) ve marj yığılması (margin skew — büroların risk maliyetini
 * hangi tarafa yükledikleri).
 *
 * NOT — YORUM SINIRI: skew/dispersion sinyalleri "sharp money kanıtı" DEĞİL,
 * sadece piyasanın o an nasıl fiyatlandığının bir özeti. Az sayıda büronun
 * olduğu maçlarda (bkz. LOW_CONFIDENCE_BM_COUNT) tek bir büronun garip fiyatı
 * bile sinyali domine edebilir — bu yüzden confidence alanı ayrıca taşınıyor,
 * UI bunu "kesin" gibi sunmamalı.
 */

export type Side = "H" | "D" | "A";

const SIDES: Side[] = ["H", "D", "A"];

export type SideStat = {
  mean: number;
  stdev: number;
  cv: number; // yüzde
  min: number;
  max: number;
  bestBookmaker: string; // o taraf için en yüksek oranı veren büro
};

export type ArbitrageLeg = {
  side: Side;
  bookmaker: string;
  odds: number;
};

export type MarketSignals = {
  bmCount: number;
  confidence: "high" | "low";
  dispersion: Record<Side, SideStat>;
  avgDispersionPct: number;
  arbitrage: { profitPct: number; legs: ArbitrageLeg[] } | null;
  skew: Record<Side, number>; // yüzde, üçü toplamda ~100
  protectedSide: Side;
  protectedSkewPct: number;
};

export const LOW_CONFIDENCE_BM_COUNT = 10;
export const SKEW_SIGNAL_THRESHOLD = 75;
export const DISPERSION_SIGNAL_THRESHOLD = 12;
const MIN_BOOKMAKERS = 3;

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdev(xs: number[], m: number): number {
  if (xs.length < 2) return 0;
  const variance = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

// tableRows.ts'teki parseOddsNum/oddsValue ile AYNI kural: değerler bazen
// string gelebiliyor (Number(v) ile coerce edilmeli) ve current boşsa
// opening'e düşülüyor — bunu yapmazsak çoğu büro "eksik" sayılıp elenir.
function parseOddsNum(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1.01 ? n : null;
}

function pickOddsValue(opening: unknown, current: unknown): number | null {
  return parseOddsNum(current) ?? parseOddsNum(opening);
}

export function computeMarketSignals(
  odds: CompactOddsRow[] | null | undefined,
  bookmakers: Record<string, string> | null | undefined,
): MarketSignals | null {
  if (!odds?.length) return null;
  const bmNames = bookmakers ?? {};

  // bmId -> side -> current odds
  const byBm = new Map<number, Partial<Record<Side, number>>>();
  for (const row of odds) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const [bmId, mtype, scope, sideTok, opening, current, active] = row;
    if (String(mtype) !== "HOME_DRAW_AWAY" || String(scope) !== "FULL_TIME") continue;
    if (active === false || active === 0 || active === "0" || active === "false") continue;
    const side = String(sideTok);
    if (side !== "H" && side !== "D" && side !== "A") continue; // p:<id> vb. edge-case'ler atlanır
    const val = pickOddsValue(opening, current);
    if (val == null) continue;
    const bmNum = Number(bmId);
    if (!byBm.has(bmNum)) byBm.set(bmNum, {});
    byBm.get(bmNum)![side as Side] = val;
  }

  const complete = [...byBm.entries()].filter(
    ([, o]) => o.H != null && o.D != null && o.A != null,
  ) as [number, Record<Side, number>][];

  if (complete.length < MIN_BOOKMAKERS) return null;

  const bmName = (id: number) => bmNames[String(id)] ?? `BM_${id}`;

  // --- 1) Dispersion ---
  const dispersion = {} as Record<Side, SideStat>;
  for (const side of SIDES) {
    const withBm = complete.map(([id, o]) => ({ id, val: o[side] }));
    const vals = withBm.map((x) => x.val);
    const m = mean(vals);
    const sd = stdev(vals, m);
    const cv = m > 0 ? (sd / m) * 100 : 0;
    const best = withBm.reduce((a, b) => (b.val > a.val ? b : a));
    dispersion[side] = {
      mean: round2(m),
      stdev: round3(sd),
      cv: round2(cv),
      min: Math.min(...vals),
      max: Math.max(...vals),
      bestBookmaker: bmName(best.id),
    };
  }
  const avgDispersionPct = round2(mean(SIDES.map((s) => dispersion[s].cv)));

  // --- 2) Arbitraj ---
  const margin = SIDES.reduce((sum, s) => sum + 1 / dispersion[s].max, 0);
  const arbitrage =
    margin < 1
      ? {
          profitPct: round2((1 - margin) * 100),
          legs: SIDES.map((side) => ({
            side,
            bookmaker: dispersion[side].bestBookmaker,
            odds: dispersion[side].max,
          })),
        }
      : null;

  // --- 3) Margin skew ---
  const skewSums: Record<Side, number> = { H: 0, D: 0, A: 0 };
  let skewCount = 0;
  for (const [, o] of complete) {
    const raw = { H: 1 / o.H, D: 1 / o.D, A: 1 / o.A };
    const totalInv = raw.H + raw.D + raw.A;
    const bmMargin = totalInv - 1;
    if (bmMargin <= 0.005) continue;
    for (const side of SIDES) {
      const fair = raw[side] / totalInv;
      skewSums[side] += (raw[side] - fair) / bmMargin;
    }
    skewCount += 1;
  }
  const skew = { H: 0, D: 0, A: 0 } as Record<Side, number>;
  if (skewCount > 0) {
    for (const side of SIDES) skew[side] = round1((skewSums[side] / skewCount) * 100);
  }
  const protectedSide = SIDES.reduce((a, b) => (skew[b] > skew[a] ? b : a));

  return {
    bmCount: complete.length,
    confidence: complete.length >= LOW_CONFIDENCE_BM_COUNT ? "high" : "low",
    dispersion,
    avgDispersionPct,
    arbitrage,
    skew,
    protectedSide,
    protectedSkewPct: skew[protectedSide],
  };
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}
function round2(n: number) {
  return Math.round(n * 100) / 100;
}
function round3(n: number) {
  return Math.round(n * 1000) / 1000;
}

export const SIDE_LABEL_TR: Record<Side, string> = {
  H: "Ev Sahibi (1)",
  D: "Beraberlik (X)",
  A: "Deplasman (2)",
};
