import type { CompactOddsRow } from "@/lib/archiveCache";

/**
 * Pattern Signal Engine — scan_live_ou_btts_calibrated.py ile AYNI model.
 *
 * goalEngine.ts / htftEngine.ts'ten temel farkı: bu motor tek bir maçın kendi
 * oran hareketinden bir "profil" çıkarmıyor. Bunun yerine `match_feature_codes`
 * tablosundan (bitmiş maçlar) türetilen, out-of-sample doğrulanmış bir
 * "(ft_code, uo_code) -> hit-rate" kalıp veritabanına (`PatternDb`) karşı canlı
 * fikstürün oran-kodunu eşleştirip, kalıbın geçmiş isabet oranı YETERLİ ve
 * canlı piyasa o yöne YETERLİ düştüyse sinyal üretir.
 *
 * Bu dosya saf/DB'siz: pattern_db'yi ve canlı fixture satırlarını nereden
 * çektiği route'un (src/app/api/signals/route.ts) sorumluluğunda. Böylece
 * hem test edilebilir hem de goalEngine/htftEngine'in mevcut mantığına
 * dokunmadan ayrı bir motor olarak yaşar.
 */

// ---------------------------------------------------------------------------
// Pattern DB (match_feature_codes / rating_pattern_stats agregasyonu)
// ---------------------------------------------------------------------------

export type PatternStats = {
  ft_odd_code: string;
  uo_25_odd_code: string;
  sample_size: number;
  rating_over25: number;
  rating_btts_yes: number;
  rating_ht_over05: number;
  rating_ms1: number;
  rating_msx: number;
  rating_ms2: number;
  rating_ht1: number;
  rating_htx: number;
  rating_ht2: number;
  most_frequent_score: string | null;
};

/** key: `${ft_odd_code}|${cleanUoCode(uo_25_odd_code)}` */
export type PatternDb = Map<string, PatternStats>;

export function cleanUoCode(code: string | null | undefined): string {
  if (!code) return "NONE";
  return String(code).replace(/\s+/g, "").toUpperCase();
}

export function patternKey(ftCode: string, uoCode: string | null | undefined): string {
  return `${ftCode}|${cleanUoCode(uoCode)}`;
}

export function buildPatternDb(rows: PatternStats[]): PatternDb {
  const db: PatternDb = new Map();
  for (const r of rows) {
    db.set(patternKey(r.ft_odd_code, r.uo_25_odd_code), r);
  }
  return db;
}

// ---------------------------------------------------------------------------
// Genç/rezerv takım filtresi — python is_youth_or_reserve ile aynı regex
// ---------------------------------------------------------------------------

const YOUTH_RESERVE_RE = /\b(u17|u18|u19|u20|u21|u23|reserve|rezerv|women|w|b team)\b|\bii\b|\b2\b/i;

export function isYouthOrReserve(home: string | null, away: string | null, league: string | null): boolean {
  const t = `${home ?? ""} ${away ?? ""} ${league ?? ""}`.toLowerCase();
  return YOUTH_RESERVE_RE.test(t);
}

// ---------------------------------------------------------------------------
// Fikstür oranlarından medyan + düşüş-yüzdesi çıkarımı
// ---------------------------------------------------------------------------

function isActive(active: unknown): boolean {
  return !(active === false || active === 0 || active === "0" || active === "false");
}

function parseNum(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 1.0 ? n : null;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** round-to-step, python'daki round(x * n) / n mantığıyla birebir */
function roundStep(x: number, step: number): number {
  return Math.round(x * step) / step;
}

type BmSide = { open: number; cur: number };
// bookmakerId -> marketKey (`${TYPE}:${SCOPE}`) -> side -> {open, cur}
type BmData = Map<string, Map<string, Map<string, BmSide>>>;

function parseFixtureOdds(odds: CompactOddsRow[] | null | undefined): BmData {
  const bm: BmData = new Map();
  if (!odds?.length) return bm;

  for (const row of odds) {
    if (!Array.isArray(row) || row.length < 7) continue;
    const [bookmakerId, mtype, scope, sideTok, opening, current, active] = row;
    if (!isActive(active)) continue;

    const oVal = parseNum(opening);
    const cVal = parseNum(current);
    if (oVal == null && cVal == null) continue;

    const bmKey = String(bookmakerId);
    const marketKey = `${String(mtype).toUpperCase()}:${String(scope).toUpperCase()}`;
    const side = String(sideTok).toUpperCase();

    if (!bm.has(bmKey)) bm.set(bmKey, new Map());
    const marketMap = bm.get(bmKey)!;
    if (!marketMap.has(marketKey)) marketMap.set(marketKey, new Map());
    marketMap.get(marketKey)!.set(side, {
      open: oVal ?? cVal!,
      cur: cVal ?? oVal!,
    });
  }
  return bm;
}

export type LiveMatchMetrics = {
  ftCode: string;
  uoCode: string;
  medH: number;
  medD: number;
  medA: number;
  medU25: number;
  medO25: number;
  totalFt: number;
  totalO25: number;
  totalBtts: number;
  pctDropMs1: number;
  pctDropMsx: number;
  pctDropMs2: number;
  pctDropO25: number;
  pctDropBtts: number;
  favSide: "1" | "2" | null;
  undSide: "1" | "2" | null;
  ratingUndFt: number; // doldurulur (evaluateSignals içinde stats'tan)
  pctDropUnd: number;
} | null;

/** Tek bir maçın CompactOddsRow[]'undan ft_code/uo_code + medyan + düşüş-% çıkarır. */
export function computeLiveMatchMetrics(odds: CompactOddsRow[] | null | undefined): LiveMatchMetrics {
  const bmData = parseFixtureOdds(odds);
  if (bmData.size < 2) return null; // python: len(bm_odds) < 2 ise atla

  const allHOpen: number[] = [];
  const allDOpen: number[] = [];
  const allAOpen: number[] = [];
  const allU25Open: number[] = [];
  const allO25Open: number[] = [];

  let totalFt = 0;
  let totalO25 = 0;
  let totalBtts = 0;
  let dropMs1 = 0;
  let dropMsx = 0;
  let dropMs2 = 0;
  let dropO25 = 0;
  let dropBtts = 0;

  for (const markets of bmData.values()) {
    const ft1x2 = markets.get("HOME_DRAW_AWAY:FULL_TIME");
    const h = ft1x2?.get("H");
    const d = ft1x2?.get("D") ?? ft1x2?.get("X");
    const a = ft1x2?.get("A");
    if (h && d && a) {
      totalFt++;
      allHOpen.push(h.open);
      allDOpen.push(d.open);
      allAOpen.push(a.open);
      if ((h.cur - h.open) / h.open <= -0.015) dropMs1++;
      if ((d.cur - d.open) / d.open <= -0.015) dropMsx++;
      if ((a.cur - a.open) / a.open <= -0.015) dropMs2++;
    }

    const ouFt = markets.get("OVER_UNDER:FULL_TIME");
    const u25 = ouFt?.get("UNDER:2.5");
    const o25 = ouFt?.get("OVER:2.5");
    if (u25 && o25) {
      totalO25++;
      allU25Open.push(u25.open);
      allO25Open.push(o25.open);
      if ((o25.cur - o25.open) / o25.open <= -0.01) dropO25++;
    }

    const bttsFt = markets.get("BOTH_TEAMS_TO_SCORE:FULL_TIME");
    const bttsY = bttsFt?.get("BTTS:YES") ?? bttsFt?.get("YES");
    if (bttsY) {
      totalBtts++;
      if ((bttsY.cur - bttsY.open) / bttsY.open <= -0.01) dropBtts++;
    }
  }

  if (!allHOpen.length || !allDOpen.length || !allAOpen.length || !allU25Open.length || !allO25Open.length) {
    return null;
  }

  const medH = median(allHOpen);
  const medD = median(allDOpen);
  const medA = median(allAOpen);
  const medU25 = median(allU25Open);
  const medO25 = median(allO25Open);

  const ftCode = `${roundStep(medH, 20).toFixed(2)}_${roundStep(medD, 10).toFixed(1)}_${roundStep(medA, 10).toFixed(1)}`;
  const diff = roundStep(medU25 - medO25, 10);
  const uoCode = `UO_${diff >= 0 ? "+" : "-"}${Math.abs(diff).toFixed(1)}`;

  const pctDropMs1 = totalFt ? (dropMs1 / totalFt) * 100 : 0;
  const pctDropMsx = totalFt ? (dropMsx / totalFt) * 100 : 0;
  const pctDropMs2 = totalFt ? (dropMs2 / totalFt) * 100 : 0;
  const pctDropO25 = totalO25 ? (dropO25 / totalO25) * 100 : 0;
  const pctDropBtts = totalBtts ? (dropBtts / totalBtts) * 100 : 0;

  let favSide: "1" | "2" | null = null;
  let undSide: "1" | "2" | null = null;
  let pctDropUnd = 0;
  if (medH <= 2.15 && medA >= 2.75) {
    favSide = "1";
    undSide = "2";
    pctDropUnd = pctDropMs2;
  } else if (medA <= 2.15 && medH >= 2.75) {
    favSide = "2";
    undSide = "1";
    pctDropUnd = pctDropMs1;
  }

  return {
    ftCode,
    uoCode,
    medH,
    medD,
    medA,
    medU25,
    medO25,
    totalFt,
    totalO25,
    totalBtts,
    pctDropMs1,
    pctDropMsx,
    pctDropMs2,
    pctDropO25,
    pctDropBtts,
    favSide,
    undSide,
    ratingUndFt: 0, // evaluateSignals stats geldiğinde dolduracak
    pctDropUnd,
  };
}

// ---------------------------------------------------------------------------
// Sinyal değerlendirme — python'daki 9 kalibre edilmiş modül, BİREBİR eşikler
// ---------------------------------------------------------------------------

export type PatternSignal = {
  code: string;
  label: string;
  hitRatePct: number;
  edgePct: number;
};

export function evaluateSignals(stats: PatternStats, m: NonNullable<LiveMatchMetrics>): PatternSignal[] {
  const signals: PatternSignal[] = [];

  const rO25 = Number(stats.rating_over25 || 0);
  const rBtts = Number(stats.rating_btts_yes || 0);
  const rHt05 = Number(stats.rating_ht_over05 || 0);
  const rMs1 = Number(stats.rating_ms1 || 0);
  const rMsx = Number(stats.rating_msx || 0);
  const rHt1 = Number(stats.rating_ht1 || 0);
  const rHtx = Number(stats.rating_htx || 0);
  const rHt2 = Number(stats.rating_ht2 || 0);

  // 1. 2.5 ÜST
  if (rO25 >= 70.0 && m.pctDropO25 >= 15.0) {
    signals.push({ code: "ELITE_OVER25", label: "💣 ELİT KİLİT 2.5Ü", hitRatePct: 83.0, edgePct: 36.2 });
  } else if (rO25 >= 65.0 && m.pctDropO25 >= 20.0) {
    signals.push({ code: "SNIPER_OVER25", label: "🔥 SNIPER 2.5Ü", hitRatePct: 73.9, edgePct: 27.1 });
  } else if (rO25 >= 58.0 && m.pctDropO25 >= 15.0) {
    signals.push({ code: "STANDARD_OVER25", label: "⚡ STANDART 2.5Ü", hitRatePct: 67.0, edgePct: 20.2 });
  }

  // 2. KG VAR (BTTS YES)
  if (rBtts >= 70.0 && m.pctDropBtts >= 20.0) {
    signals.push({ code: "ELITE_BTTS", label: "🎯 ELİT KİLİT KG VAR", hitRatePct: 82.1, edgePct: 28.9 });
  } else if (rBtts >= 65.0 && m.pctDropBtts >= 15.0) {
    signals.push({ code: "SNIPER_BTTS", label: "🎯 SNIPER KG VAR", hitRatePct: 78.2, edgePct: 24.9 });
  } else if (rBtts >= 58.0 && m.pctDropBtts >= 15.0) {
    signals.push({ code: "STANDARD_BTTS", label: "🎯 STANDART KG VAR", hitRatePct: 70.3, edgePct: 17.0 });
  }

  // 3. İY 0.5 ÜST (2.5Ü düşüşünü proxy olarak kullanır — python ile aynı)
  if (rHt05 >= 80.0 && m.pctDropO25 >= 15.0) {
    signals.push({ code: "ELITE_HT_OVER05", label: "🔒 ELİT KİLİT İY 0.5Ü", hitRatePct: 87.1, edgePct: 18.6 });
  } else if (rHt05 >= 70.0 && m.pctDropO25 >= 15.0) {
    signals.push({ code: "STANDARD_HT_OVER05", label: "🔒 STANDART İY 0.5Ü", hitRatePct: 81.2, edgePct: 12.7 });
  }

  // 4. MS 1 FAVORİ
  if (rMs1 >= 70.0 && m.pctDropMs1 >= 20.0) {
    signals.push({ code: "ELITE_MS1", label: `👑 ELİT FAVORİ MS 1 (${m.medH.toFixed(2)})`, hitRatePct: 83.9, edgePct: 41.7 });
  } else if (rMs1 >= 65.0 && m.pctDropMs1 >= 20.0) {
    signals.push({ code: "SNIPER_MS1", label: `👑 SNIPER FAVORİ MS 1 (${m.medH.toFixed(2)})`, hitRatePct: 80.3, edgePct: 38.1 });
  } else if (rMs1 >= 58.0 && m.pctDropMs1 >= 15.0) {
    signals.push({ code: "STANDARD_MS1", label: `👑 STANDART FAVORİ MS 1 (${m.medH.toFixed(2)})`, hitRatePct: 70.8, edgePct: 28.6 });
  }

  // 5. İY 2 VALUE
  if (rHt2 >= 40.0 && m.pctDropMs2 >= 25.0) {
    signals.push({ code: "HT2_VALUE", label: `💎 İY 2 VALUE (${m.medA.toFixed(2)})`, hitRatePct: 42.6, edgePct: 17.7 });
  }

  // 6. İY 1 FAVORİ
  if (rHt1 >= 50.0 && m.pctDropMs1 >= 20.0) {
    signals.push({ code: "HT1_FAV", label: `⚡ İY 1 FAVORİ (${m.medH.toFixed(2)})`, hitRatePct: 47.9, edgePct: 14.0 });
  }

  // 7. MS X BERABERLİK
  if (rMsx >= 40.0 && m.pctDropMsx >= 30.0) {
    signals.push({ code: "MSX_SNIPER", label: `🎯 MS X BERABERLİK (${m.medD.toFixed(2)})`, hitRatePct: 37.3, edgePct: 4.1 });
  }

  // 8. SÜRPRİZ UNDERDOG — rating_ms1/ms2'den hangisi geçerliyse stats'tan al
  if (m.undSide) {
    const rUnd = m.undSide === "1" ? Number(stats.rating_ms1 || 0) : Number(stats.rating_ms2 || 0);
    if (rUnd >= 40.0 && m.pctDropUnd >= 15.0) {
      const undOdd = m.undSide === "2" ? m.medA : m.medH;
      signals.push({
        code: "UNDERDOG_SURPRISE",
        label: `💣 SÜRPRİZ MS ${m.undSide} (${undOdd.toFixed(2)})`,
        hitRatePct: 31.0,
        edgePct: 11.4,
      });
    }
  }

  // 9. İY X KİLİT
  if (rHtx >= 55.0 && m.pctDropMsx >= 30.0) {
    signals.push({ code: "HTX_LOCK", label: "🔒 İY X KİLİT", hitRatePct: 50.0, edgePct: 8.8 });
  }

  return signals;
}
