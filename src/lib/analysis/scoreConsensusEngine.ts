import type { CompactOddsRow } from "@/lib/archiveCache";

/**
 * "V54 Rejim Motoru" (Regime-Based Correct-Score Portfolio Engine).
 *
 * Kaynak: Ali'nin test_v54_blackburn_sheffutd.py betiği. ESKİ motor (hacim/
 * konsensüs tabanlı CORRECT_SCORE ranking) tamamen bu mantıkla DEĞİŞTİRİLDİ.
 *
 * Yöntem özeti (script ile birebir aynı):
 *  1) 1X2 (HOME_DRAW_AWAY/FULL_TIME) tüm büro kotasyonlarının medyanından
 *     vig-normalize edilmiş Ev/Beraberlik/Deplasman olasılığı çıkarılır.
 *  2) Over/Under 2.5 (FULL_TIME) tüm büro kotasyonlarının medyanından
 *     2 yönlü implied Üst 2.5 olasılığı çıkarılır.
 *  3) Bu iki olasılığa göre maç bir "rejime" atanır (DOM_H / DOM_H_HYPER /
 *     DOM_A / DOM_A_HYPER / LOCK / OPEN) ve her rejim için sabit, elle
 *     ayarlanmış 4'lü bir skor portföyü döndürülür (ilk 3 = çekirdek/Hit@3,
 *     4.'sü = sigorta/Hit@4).
 *  4) Bu 4 skorun piyasa CORRECT_SCORE medyan oranı (varsa) sadece GÖSTERİM
 *     amaçlı eklenir — eski motorun aksine burada CS oranları sıralamayı
 *     BELİRLEMEZ, sadece rejim + O/U belirler.
 *
 * NOT — YORUM SINIRI: Bu bir "kesin skor tahmini" değil, kural-tabanlı bir
 * rejim sınıflandırması + heuristik skor portföyüdür. 1X2/OU kotasyonu
 * bulunamazsa script'teki gibi varsayılan (fallback) oranlara düşülür — bu
 * durumda sonuç daha az güvenilirdir.
 */

export type ScoreConsensusSlot = {
  score: string; // "2:1" formatında
  marketOdds: number | null; // bu skor için piyasa medyan CORRECT_SCORE oranı (varsa)
  tier: "core" | "insurance"; // ilk 3 = Hit@3 çekirdek, 4. = Hit@4 sigorta
  isActual: boolean; // gerçekleşen skor bu mu
};

export type ScoreConsensus = {
  regimeCode: string; // DOM_H_HYPER | DOM_H | DOM_A_HYPER | DOM_A | LOCK | OPEN
  regimeLabel: string; // Türkçe açıklama, script'teki "reg" metninin karşılığı
  confidenceLabel: string; // "STANDART" | "YÜKSEK (...)" — script'teki confidence
  homeProb: number; // yüzde
  drawProb: number; // yüzde
  awayProb: number; // yüzde
  over25Prob: number; // yüzde
  under25Prob: number; // yüzde
  portfolio: ScoreConsensusSlot[]; // 4 slot, azalan öncelik sırası
  actualScore: string | null;
  hit3: boolean | null; // gerçek skor ilk 3'te mi (maç oynandıysa)
  hit4: boolean | null; // gerçek skor 4'ünde mi
};

// script'teki varsayılan (fallback) medyanlar — hiç kotasyon yoksa kullanılır
const FALLBACK_H = 2.8;
const FALLBACK_D = 3.4;
const FALLBACK_A = 2.45;
const FALLBACK_OVER = 1.9;
const FALLBACK_UNDER = 1.9;

const HARD_UNDER_MAX = 0.44; // p_over <= bu -> "kısır" / alt destekli
const HYPER_OVER_MIN = 0.6; // p_over >= bu -> yüksek tempolu / gol baskısı
const HARD_OVER_MIN = 0.55; // p_over >= bu -> favori rejimlerde 3./4. slot değişir
const DOM_THRESHOLD = 0.5; // p_h veya p_a >= bu -> tek taraflı favori rejimi
const HEAVY_FAV_THRESHOLD = 0.58; // "Ağır Favori" etiketi eşiği

// tableRows.ts/marketSignals.ts ile AYNI kural: değerler bazen string gelebilir,
// current boşsa opening'e düşülür.
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

/** "score:2:1" ya da "2:1" -> {score:"2:1", h:2, a:1} | null */
function parseScoreToken(sideTok: string): { score: string; h: number; a: number } | null {
  const stripped = sideTok.startsWith("score:") ? sideTok.slice(6) : sideTok;
  const parts = stripped.split(":");
  if (parts.length !== 2) return null;
  const h = Number(parts[0]);
  const a = Number(parts[1]);
  if (!Number.isInteger(h) || !Number.isInteger(a) || h < 0 || a < 0) return null;
  return { score: `${h}:${a}`, h, a };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** 3 yönlü vig-normalize implied probability (script: normalize_1x2). */
function normalize1x2(h: number, d: number, a: number): [number, number, number] {
  const ih = 1 / h;
  const id = 1 / d;
  const ia = 1 / a;
  const s = ih + id + ia;
  return [ih / s, id / s, ia / s];
}

/** 2 yönlü vig-normalize implied probability — Üst 2.5 olasılığı (script: implied_two). */
function impliedOver(over: number, under: number): number {
  const io = 1 / over;
  const iu = 1 / under;
  return io / (io + iu);
}

type Regime = {
  code: string;
  label: string;
  confidence: string;
  ranked: string[]; // "2:1" formatında 4 skor, azalan öncelik
};

/** script'teki if/elif zincirinin birebir karşılığı. */
function resolveRegime(
  pH: number,
  pA: number,
  isHyperOver: boolean,
  isHardUnder: boolean,
  isHardOver: boolean,
): Regime {
  if (pH >= DOM_THRESHOLD) {
    if (isHyperOver) {
      return {
        code: "DOM_H_HYPER",
        label: "Yüksek Tempolu Ev Favori",
        confidence: "YÜKSEK (Gol Baskısı)",
        ranked: ["2:1", "3:1", "2:2", "3:2"],
      };
    }
    if (isHardUnder) {
      return {
        code: "DOM_H",
        label: "Kısır Ev Favori",
        confidence: "YÜKSEK (Alt Destekli)",
        ranked: ["2:0", "1:0", "1:1", "2:1"],
      };
    }
    return {
      code: "DOM_H",
      label: "Ev Favori",
      confidence: pH >= HEAVY_FAV_THRESHOLD ? "YÜKSEK (Ağır Favori)" : "STANDART",
      ranked: ["2:0", "1:1", "2:1", isHardOver ? "3:1" : "1:0"],
    };
  }

  if (pA >= DOM_THRESHOLD) {
    if (isHyperOver) {
      return {
        code: "DOM_A_HYPER",
        label: "Yüksek Tempolu Deplasman Favori",
        confidence: "YÜKSEK (Gol Baskısı)",
        ranked: ["1:2", "1:3", "2:2", "2:3"],
      };
    }
    if (isHardUnder) {
      return {
        code: "DOM_A",
        label: "Kısır Deplasman Favori",
        confidence: "YÜKSEK (Alt Destekli)",
        ranked: ["0:1", "0:2", "1:1", "0:0"],
      };
    }
    return {
      code: "DOM_A",
      label: "Deplasman Favori",
      confidence: pA >= HEAVY_FAV_THRESHOLD ? "YÜKSEK (Ağır Favori)" : "STANDART",
      ranked: ["0:2", "1:2", "0:1", isHardOver ? "1:3" : "2:2"],
    };
  }

  if (isHardUnder) {
    return {
      code: "LOCK",
      label: "Kilit Alt",
      confidence: "YÜKSEK (Piyasa Kilidi)",
      ranked: pH >= pA ? ["1:1", "1:0", "0:0", "2:0"] : ["1:1", "0:1", "0:0", "0:2"],
    };
  }

  return {
    code: "OPEN",
    label: "Dengeli / Açık",
    confidence: "STANDART",
    ranked: pH >= pA ? ["1:1", "2:1", "1:2", "2:2"] : ["1:1", "1:2", "2:1", "2:2"],
  };
}

export function computeScoreConsensus(
  odds: CompactOddsRow[] | null | undefined,
  // V54 rejim motoru büro bazlı ayrım yapmıyor (script gibi tüm kotasyonlar
  // birlikte medyanlanıyor) — imza SmartAnalysisClient.tsx çağrısıyla uyumlu
  // kalsın diye korunuyor, kullanılmıyor.
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
    if (type === "HOME_DRAW_AWAY") {
      const side = String(sideTok);
      if (side === "H") hOdds.push(val);
      else if (side === "D") dOdds.push(val);
      else if (side === "A") aOdds.push(val);
      continue;
    }
    if (type === "OVER_UNDER") {
      const side = String(sideTok);
      if (side === "OVER:2.5") overOdds.push(val);
      else if (side === "UNDER:2.5") underOdds.push(val);
      continue;
    }
    if (type === "CORRECT_SCORE") {
      const parsed = parseScoreToken(String(sideTok));
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

  const regime = resolveRegime(pH, pA, isHyperOver, isHardUnder, isHardOver);

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
