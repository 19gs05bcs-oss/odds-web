import type { CompactOddsRow } from "@/lib/archiveCache";

export type ScoreConsensusSlot = {
  score: string;
  marketOdds: number | null;
  tier: "core" | "insurance";
  isActual: boolean;
};

export type ScoreConsensus = {
  regimeCode: string;
  regimeLabel: string;
  confidenceLabel: string;
  homeProb: number;
  drawProb: number;
  awayProb: number;
  over25Prob: number;
  under25Prob: number;
  portfolio: ScoreConsensusSlot[];
  actualScore: string | null;
  hit3: boolean | null;
  hit4: boolean | null;
};

const FALLBACK_H = 2.5;
const FALLBACK_D = 3.4;
const FALLBACK_A = 2.8;
const FALLBACK_OVER = 1.95;
const FALLBACK_UNDER = 1.85;

const HARD_UNDER_MAX = 0.44;
const HYPER_OVER_MIN = 0.6;
const HARD_OVER_MIN = 0.55;
const DOM_THRESHOLD = 0.43;
const HEAVY_FAV_THRESHOLD = 0.58;

function parseOddsNum(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1.01 ? n : null;
}

function pickOddsValue(opening: unknown, current: unknown): number | null {
  return parseOddsNum(current) ?? parseOddsNum(opening);
}

function isActive(active: unknown): boolean {
  return !(active === false || active === 0 || active === "0" || active === "false");
}

function parseScoreToken(sideTok: string): { score: string; h: number; a: number } | null {
  const stripped = sideTok.startsWith("score:") ? sideTok.slice(6) : sideTok;
  const parts = stripped.replace("-", ":").split(":");
  if (parts.length !== 2) return null;
  const h = Number(parts[0]);
  const a = Number(parts[1]);
  if (!Number.isInteger(h) || !Number.isInteger(a) || h < 0 || a < 0) return null;
  return { score: `${h}:${a}`, h, a };
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function normalize1x2(h: number, d: number, a: number): [number, number, number] {
  const ih = 1 / h;
  const id = 1 / d;
  const ia = 1 / a;
  const s = ih + id + ia;
  return [ih / s, id / s, ia / s];
}

function impliedOver(over: number, under: number): number {
  const io = 1 / over;
  const iu = 1 / under;
  return io / (io + iu);
}

type Regime = {
  code: string;
  label: string;
  confidence: string;
  ranked: string[];
};

/** V55.2 Saf Piyasa Konsensüsü */
function resolveDynamicRegime(
  pH: number,
  pD: number,
  pA: number,
  pOver: number,
  isHyperOver: boolean,
  isHardUnder: boolean,
  isHardOver: boolean,
  csOddsByScore: Map<string, number[]>,
): Regime {
  let code = "OPEN";
  let label = "Dengeli / Açık";
  let confidence = "STANDART";

  const isHomeFav = pH >= DOM_THRESHOLD && pH > pA * 1.12;
  const isAwayFav = pA >= DOM_THRESHOLD && pA > pH * 1.12;

  if (isHomeFav) {
    if (isHyperOver) {
      code = "DOM_H_HYPER";
      label = "Yüksek Tempolu Ev Favori";
      confidence = "YÜKSEK (Gol Baskısı)";
    } else if (isHardUnder) {
      code = "DOM_H";
      label = "Kısır Ev Favori";
      confidence = "YÜKSEK (Alt Destekli)";
    } else {
      code = "DOM_H";
      label = "Ev Favori";
      confidence = pH >= HEAVY_FAV_THRESHOLD ? "YÜKSEK (Ağır Favori)" : "STANDART";
    }
  } else if (isAwayFav) {
    if (isHyperOver) {
      code = "DOM_A_HYPER";
      label = "Yüksek Tempolu Deplasman Favori";
      confidence = "YÜKSEK (Gol Baskısı)";
    } else if (isHardUnder) {
      code = "DOM_A";
      label = "Kısır Deplasman Favori";
      confidence = "YÜKSEK (Alt Destekli)";
    } else {
      code = "DOM_A";
      label = "Deplasman Favori";
      confidence = pA >= HEAVY_FAV_THRESHOLD ? "YÜKSEK (Ağır Favori)" : "STANDART";
    }
  } else if (isHardUnder) {
    code = "LOCK";
    label = "Kilit Alt";
    confidence = "YÜKSEK (Piyasa Kilidi)";
  } else {
    code = "OPEN";
    label = "Dengeli / Açık";
    confidence = "STANDART";
  }

  const scoredCandidates: { score: string; power: number }[] = [];
  const pUnder = 1.0 - pOver;

  if (csOddsByScore.size >= 4) {
    for (const [score, oddsList] of csOddsByScore.entries()) {
      const medOdd = median(oddsList);
      if (medOdd <= 1.0) continue;

      const parsed = parseScoreToken(score);
      if (!parsed) continue;
      const { h, a } = parsed;

      // 1. Büro Zımni Olasılığı (Implied Probability)
      const baseProb = (1.0 / medOdd) * 100;

      // 2. 1X2 Taraf Hizalaması
      let sideWeight = 1.0;
      if (h > a) {
        sideWeight = pH / 0.33;
      } else if (a > h) {
        sideWeight = pA / 0.33;
      } else {
        sideWeight = pD / 0.33;
      }

      // 3. 2.5 Gol Baremi Hizalaması
      const totGoals = h + a;
      const ouWeight = totGoals >= 3 ? pOver / 0.5 : pUnder / 0.5;

      // Nihai Güç Puanı
      const power = baseProb * sideWeight * ouWeight;
      scoredCandidates.push({ score, power });
    }

    scoredCandidates.sort((a, b) => b.power - a.power);
  }

  let ranked: string[] = [];
  if (scoredCandidates.length >= 4) {
    ranked = scoredCandidates.slice(0, 4).map((item) => item.score);
  } else {
    // Oran yoksa varsayılan koridor
    if (isHomeFav) {
      ranked = ["2:1", "1:0", "2:0", "3:1"];
    } else if (isAwayFav) {
      ranked = ["1:2", "0:1", "0:2", "1:3"];
    } else {
      ranked = pH >= pA ? ["1:1", "1:0", "2:1", "2:0"] : ["1:1", "0:1", "1:2", "0:2"];
    }
  }

  return { code, label, confidence, ranked };
}

export function computeScoreConsensus(
  odds: CompactOddsRow[] | null | undefined,
  bookmakers: Record<string, string> | null | undefined,
  homeScore?: string | number | null,
  awayScore?: string | number | null,
): ScoreConsensus | null {
  if (!odds?.length) return null;

  const hOdds: number[] = [];
  const dOdds: number[] = [];
  const aOdds: number[] = [];
  const overOdds: number[] = [];
  const underOdds: number[] = [];
  const csOddsByScore = new Map<string, number[]>();

  for (const row of odds) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const [, mtype, scope, sideTok, opening, current, active] = row;
    if (String(scope) !== "FULL_TIME" || !isActive(active)) continue;
    const val = pickOddsValue(opening, current);
    if (val == null) continue;

    const type = String(mtype);
    const side = String(sideTok);

    if (type === "HOME_DRAW_AWAY" || type === "1X2") {
      if (side === "H" || side === "1") hOdds.push(val);
      else if (side === "D" || side === "X") dOdds.push(val);
      else if (side === "A" || side === "2") aOdds.push(val);
      continue;
    }
    if (type === "OVER_UNDER" || type === "TOTAL") {
      if (side.includes("2.5") || type.includes("2.5")) {
        if (side.includes("OVER") || side === "O") overOdds.push(val);
        else if (side.includes("UNDER") || side === "U") underOdds.push(val);
      }
      continue;
    }
    if (type === "CORRECT_SCORE") {
      const parsed = parseScoreToken(side);
      if (!parsed) continue;
      if (!csOddsByScore.has(parsed.score)) csOddsByScore.set(parsed.score, []);
      csOddsByScore.get(parsed.score)!.push(val);
    }
  }

  const medH = hOdds.length ? median(hOdds) : FALLBACK_H;
  const medD = dOdds.length ? median(dOdds) : FALLBACK_D;
  const medA = aOdds.length ? median(aOdds) : FALLBACK_A;
  const [pH, pD, pA] = normalize1x2(medH, medD, medA);

  const medOver = overOdds.length ? median(overOdds) : FALLBACK_OVER;
  const medUnder = underOdds.length ? median(underOdds) : FALLBACK_UNDER;
  const pOver = impliedOver(medOver, medUnder);
  const pUnder = 1 - pOver;

  const isHardUnder = pOver <= HARD_UNDER_MAX;
  const isHyperOver = pOver >= HYPER_OVER_MIN;
  const isHardOver = pOver >= HARD_OVER_MIN;

  const regime = resolveDynamicRegime(
    pH,
    pD,
    pA,
    pOver,
    isHyperOver,
    isHardUnder,
    isHardOver,
    csOddsByScore,
  );

  const hs = homeScore != null ? Number(homeScore) : null;
  const as_ = awayScore != null ? Number(awayScore) : null;
  const actualScore =
    hs != null && as_ != null && Number.isFinite(hs) && Number.isFinite(as_)
      ? `${hs}:${as_}`
      : null;

  const portfolio: ScoreConsensusSlot[] = regime.ranked.map((score, i) => {
    const quotes = csOddsByScore.get(score);
    return {
      score,
      marketOdds: quotes?.length ? Math.round(median(quotes) * 100) / 100 : null,
      tier: i < 3 ? "core" : "insurance",
      isActual: actualScore === score,
    };
  });

  void bookmakers;

  return {
    regimeCode: regime.code,
    regimeLabel: regime.label,
    confidenceLabel: regime.confidence,
    homeProb: Math.round(pH * 1000) / 10,
    drawProb: Math.round(pD * 1000) / 10,
    awayProb: Math.round(pA * 1000) / 10,
    over25Prob: Math.round(pOver * 1000) / 10,
    under25Prob: Math.round(pUnder * 1000) / 10,
    portfolio,
    actualScore,
    hit3: actualScore ? regime.ranked.slice(0, 3).includes(actualScore) : null,
    hit4: actualScore ? regime.ranked.includes(actualScore) : null,
  };
}
