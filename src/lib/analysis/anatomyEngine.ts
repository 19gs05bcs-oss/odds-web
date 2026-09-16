import type { CompactOddsRow } from "@/lib/archiveCache";

/**
 * Anatomy Engine — test_12_september_real_schema.py'deki 4 model (ULTIMATE
 * BLOWOUT / DEFENSIVE LOCK / İY KİLİT ➔ 2Y ÇÖZÜM / FAKE FAVORITE TRAP) ile
 * AYNI eşikler. htftEngine.ts / goalEngine.ts gibi saf client-side: ek bir
 * API isteği gerektirmez, seçilen maçın kendi FT 1X2, FT/İY Over-Under ve
 * Correct Score oranlarından hesaplanır.
 *
 * NOT — YORUM SINIRI: bu bir olasılık/anatomi taraması, kesin bir tahmin
 * değildir. Maç henüz oynanmadıysa sadece model + hedefler gösterilir; maç
 * bittiyse (home_score/away_score doluysa) gerçekleşenle karşılaştırılır.
 */

export type AnatomyModelKey =
  | "ULTIMATE_BLOWOUT"
  | "DEFENSIVE_LOCK"
  | "IY_KILIT_2Y_COZUM"
  | "FAKE_FAVORITE_TRAP";

export type AnatomyActualCheck = {
  score: string;
  htScore: string | null;
  msHit: boolean;
  iyHit: boolean;
  auHit: boolean;
  bandHit: boolean;
  scoreHit: boolean;
};

export type AnatomyEngineResult = {
  model: AnatomyModelKey;
  title: string;
  favSide: "HOME" | "AWAY";
  favOdd: number;
  iyKarar: string;
  msTaraf: string;
  iyMs: string;
  auKarar: string;
  golBandi: string;
  iySkor: string;
  hedefSkorlar: string[];
  isMajorLeague: boolean;
  actual: AnatomyActualCheck | null;
};

const TARGET_COUNTRIES = ["england", "spain", "germany", "italy", "france", "belgium", "scotland"];
const EXCLUDED_COUNTRIES = ["netherlands", "turkey", "türkiye", "portugal"];

function isTargetMajor(country: string | null | undefined, league: string | null | undefined): boolean {
  const c = String(country || "").toLowerCase().trim();
  if (!c) return false;
  if (EXCLUDED_COUNTRIES.some((ex) => c.includes(ex))) return false;
  return TARGET_COUNTRIES.some((tc) => c.includes(tc));
}

function isYouthOrReserve(home: string | null | undefined, away: string | null | undefined, league: string | null | undefined): boolean {
  const t = `${home || ""} ${away || ""} ${league || ""}`.toLowerCase();
  return /\b(u17|u18|u19|u20|u21|u23|reserve|rezerv|women|b team)\b|\bii\b/.test(t);
}

function parseNum(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1.01 ? n : null;
}

function isActive(active: unknown): boolean {
  return !(active === false || active === 0 || active === "0" || active === "false");
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

type PricePool = { open: number[]; cur: number[] };
function newPool(): PricePool {
  return { open: [], cur: [] };
}
function pushPool(p: PricePool, op: number | null, cur: number | null) {
  if (op != null) p.open.push(op);
  if (cur != null) p.cur.push(cur);
}
type Stats = { eff: number | null; mo: number | null; mc: number | null; drift: number };
// Python get_med ile birebir: eff = mc yoksa mo; drift = (mc-mo)/mo*100.
function statsOf(p: PricePool): Stats {
  const mo = p.open.length ? median(p.open) : null;
  const mc = p.cur.length ? median(p.cur) : null;
  const eff = mc ?? mo;
  const drift = mo && mc ? ((mc - mo) / mo) * 100 : 0;
  return { eff, mo, mc, drift };
}

function parseScoreToken(sideTok: string): { score: string; h: number; a: number } | null {
  const stripped = sideTok.startsWith("SCORE:") ? sideTok.slice(6) : sideTok;
  const parts = stripped.replace("-", ":").split(":");
  if (parts.length !== 2) return null;
  const h = Number(parts[0]);
  const a = Number(parts[1]);
  if (!Number.isInteger(h) || !Number.isInteger(a) || h < 0 || a < 0) return null;
  return { score: `${h}:${a}`, h, a };
}

function toInt(v: string | number | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export type AnatomyFixtureMeta = {
  league?: string | null;
  leagueCountry?: string | null;
  homeName?: string | null;
  awayName?: string | null;
  homeScore?: string | number | null;
  awayScore?: string | number | null;
  homeHtScore?: string | number | null;
  awayHtScore?: string | number | null;
};

export function computeAnatomyEngine(
  odds: CompactOddsRow[] | null | undefined,
  meta: AnatomyFixtureMeta | null | undefined,
): AnatomyEngineResult | null {
  if (!odds?.length) return null;
  if (isYouthOrReserve(meta?.homeName, meta?.awayName, meta?.league)) return null;

  const ft = { H: newPool(), D: newPool(), A: newPool() };
  const ou25 = { over: newPool(), under: newPool() };
  const ouBare = { over: newPool(), under: newPool() };
  const ou35Over = newPool();
  const fhOver05 = newPool();
  const fhOver15 = newPool();
  const cs = new Map<string, PricePool>();

  for (const row of odds) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const [, mtypeRaw, scopeRaw, sideRaw, opening, current, active] = row;
    if (!isActive(active)) continue;

    const cur = parseNum(current);
    const op = parseNum(opening);
    if (cur == null && op == null) continue;

    const type = String(mtypeRaw).toUpperCase();
    const scp = String(scopeRaw).toUpperCase();
    const side = String(sideRaw).toUpperCase();

    if (type === "HOME_DRAW_AWAY" && scp === "FULL_TIME") {
      if (side === "H") pushPool(ft.H, op, cur);
      else if (side === "D" || side === "X") pushPool(ft.D, op, cur);
      else if (side === "A") pushPool(ft.A, op, cur);
      continue;
    }

    if (type === "OVER_UNDER") {
      const isOver = side.startsWith("OVER");
      const isUnder = side.startsWith("UNDER");
      const lineStr = side.includes(":") ? side.split(":")[1] : null;
      if (scp === "FULL_TIME") {
        if (lineStr === "2.5") {
          if (isOver) pushPool(ou25.over, op, cur);
          else if (isUnder) pushPool(ou25.under, op, cur);
        } else if (lineStr === "3.5") {
          if (isOver) pushPool(ou35Over, op, cur);
        } else if (!lineStr) {
          if (isOver) pushPool(ouBare.over, op, cur);
          else if (isUnder) pushPool(ouBare.under, op, cur);
        }
      } else if (scp === "FIRST_HALF") {
        if (lineStr === "0.5" && isOver) pushPool(fhOver05, op, cur);
        else if (lineStr === "1.5" && isOver) pushPool(fhOver15, op, cur);
      }
      continue;
    }

    if (type === "CORRECT_SCORE" && scp === "FULL_TIME") {
      const parsed = parseScoreToken(side);
      if (parsed) {
        if (!cs.has(parsed.score)) cs.set(parsed.score, newPool());
        pushPool(cs.get(parsed.score)!, op, cur);
      }
      continue;
    }
  }

  const msH = statsOf(ft.H);
  const msX = statsOf(ft.D);
  const msA = statsOf(ft.A);
  if (msH.eff == null || msX.eff == null || msA.eff == null) return null;

  let under25 = statsOf(ou25.under);
  if (under25.eff == null) under25 = statsOf(ouBare.under);
  let over25 = statsOf(ou25.over);
  if (over25.eff == null) over25 = statsOf(ouBare.over);
  const over35 = statsOf(ou35Over);
  const gap = over35.eff != null && over25.eff != null ? over35.eff - over25.eff : 99.0;

  const hto05 = statsOf(fhOver05);
  const hto15 = statsOf(fhOver15);

  const favOdd = Math.min(msH.eff, msA.eff);
  const favSide: "HOME" | "AWAY" = msH.eff <= msA.eff ? "HOME" : "AWAY";
  const favDrift = favSide === "HOME" ? msH.drift : msA.drift;

  // Correct Score tablosundaki en çok düşen (en likit) skor — toplam gol <= 4
  let bestLiquidScore: string | null = null;
  let minScoreDrift = -2.0;
  for (const [score, pool] of cs) {
    const parts = score.split(":");
    const h = Number(parts[0]);
    const a = Number(parts[1]);
    if (h + a > 4) continue;
    const s = statsOf(pool);
    if (s.mo != null && s.mc != null && s.mo > 1.0) {
      const d = ((s.mc - s.mo) / s.mo) * 100.0;
      if (d < minScoreDrift) {
        minScoreDrift = d;
        bestLiquidScore = score;
      }
    }
  }
  function withLiquid(hedef: string[]): string[] {
    if (bestLiquidScore && !hedef.includes(bestLiquidScore)) return [...hedef, bestLiquidScore];
    return hedef;
  }

  let result: Omit<AnatomyEngineResult, "favSide" | "favOdd" | "isMajorLeague" | "actual"> | null = null;

  // MODEL 1: ULTIMATE BLOWOUT
  if (favOdd <= 1.45 && gap <= 0.46 && under25.drift >= 6.0 && hto05.eff != null && hto05.eff <= 1.35) {
    const hedef =
      favSide === "HOME"
        ? withLiquid(["3:1", "4:0", "4:1", "3:0", "3:2", "2:1"])
        : withLiquid(["1:3", "0:4", "1:4", "0:3", "2:3", "1:2"]);
    result = {
      model: "ULTIMATE_BLOWOUT",
      title: "🔥 ULTIMATE BLOWOUT (HT+FT PATLAMA)",
      iyKarar: "İY 0.5 ÜST (İY 1.5Ü Riski)",
      msTaraf: `MS ${favSide === "HOME" ? 1 : 2}`,
      iyMs: favSide === "HOME" ? "1/1" : "2/2",
      auKarar: "FT BLOWOUT (3.5 ÜST / 2.5 ÜST)",
      golBandi: "4+ GOL (En az 3)",
      iySkor: favSide === "HOME" ? "2:0 veya 1:1" : "0:2",
      hedefSkorlar: hedef,
    };
  }
  // MODEL 2: DEFENSIVE LOCK
  else if (
    under25.drift <= -5.0 &&
    gap >= 1.05 &&
    hto15.eff != null &&
    hto15.eff >= 2.45 &&
    under25.mo != null &&
    under25.mo <= 1.68
  ) {
    const hedef = withLiquid(["0:0", "1:0", "0:1", "1:1"]);
    result = {
      model: "DEFENSIVE_LOCK",
      title: "🧱 DEFENSIVE LOCK (HT 0-0 & FT KISIR)",
      iyKarar: "HT 0.5 UNDER (İY 0-0 KİLİT)",
      msTaraf: "MS X veya TEK FARK",
      iyMs: "X/X veya X/1",
      auKarar: "FT 2.5 UNDER",
      golBandi: "0-1 GOL (Maks 2)",
      iySkor: "0:0",
      hedefSkorlar: hedef,
    };
  }
  // MODEL 3: İY KİLİT ➔ 2Y ÇÖZÜM (KONTROLLÜ FAV)
  else if (favOdd <= 1.7 && favDrift <= 0.5 && hto15.eff != null && hto15.eff >= 2.25 && gap <= 1.15) {
    const tight = favOdd <= 1.45 && hto05.eff != null && hto05.eff <= 1.28;
    const hedef = tight
      ? favSide === "HOME"
        ? withLiquid(["2:0", "3:0", "4:0", "3:1", "4:1"])
        : withLiquid(["0:2", "0:3", "0:4", "1:3", "1:4"])
      : favSide === "HOME"
        ? withLiquid(["2:0", "2:1", "3:0", "3:1", "1:0"])
        : withLiquid(["0:2", "1:2", "0:3", "1:3", "0:1"]);
    result = {
      model: "IY_KILIT_2Y_COZUM",
      title: "⚡ İY KİLİT ➔ 2Y ÇÖZÜM (KONTROLLÜ FAV)",
      iyKarar: "İY 1.5 ALT (Tek Gol veya 0-0)",
      msTaraf: `MS ${favSide === "HOME" ? 1 : 2}`,
      iyMs: favSide === "HOME" ? "1/1 veya X/1" : "2/2 veya X/2",
      auKarar: "2.5 ÜST / 2-3 GOL",
      golBandi: "2-3 GOL ARALIĞI (Maks 4)",
      iySkor: favSide === "HOME" ? "1:0 veya 0:0" : "0:1",
      hedefSkorlar: hedef,
    };
  }
  // MODEL 4: FAKE FAVORITE TRAP
  else if (msH.eff >= 1.85 && msH.eff <= 2.3 && msH.drift >= 2.5 && msA.drift <= -1.8 && gap >= 0.8) {
    const hedef = withLiquid(["1:1", "1:2", "0:1", "2:2"]);
    result = {
      model: "FAKE_FAVORITE_TRAP",
      title: "⚠️ FAKE FAVORITE TRAP (SÜRPRİZ X2 & KG VAR)",
      iyKarar: "İY 0.5 ÜST",
      msTaraf: "ÇİFTE ŞANS X2",
      iyMs: "X/2 veya 1/X",
      auKarar: "KG VAR & 1.5 ÜST",
      golBandi: "2-3 GOL ARALIĞI",
      iySkor: "0:1 veya 1:1",
      hedefSkorlar: hedef,
    };
  }

  if (!result) return null;

  const isMajorLeague = isTargetMajor(meta?.leagueCountry, meta?.league);

  // Maç bittiyse gerçekleşenle karşılaştır (bulletin fixture tablosu ile aynı home_score/away_score/home_ht_score/away_ht_score alanları)
  let actual: AnatomyActualCheck | null = null;
  const hSc = toInt(meta?.homeScore);
  const aSc = toInt(meta?.awayScore);
  if (hSc != null && aSc != null) {
    const hHt = toInt(meta?.homeHtScore);
    const aHt = toInt(meta?.awayHtScore);
    const totHt = hHt != null && aHt != null ? hHt + aHt : null;
    const totGoals = hSc + aSc;
    const ftRes: "MS1" | "MSX" | "MS2" = hSc > aSc ? "MS1" : aSc > hSc ? "MS2" : "MSX";
    const actualScore = `${hSc}:${aSc}`;

    let msHit = false;
    let iyHit = totHt != null ? false : true;
    let auHit = false;
    let bandHit = false;

    if (result.model === "ULTIMATE_BLOWOUT") {
      msHit = favSide === "HOME" ? ftRes === "MS1" : ftRes === "MS2";
      if (totHt != null) iyHit = totHt >= 1;
      auHit = totGoals >= 3;
      bandHit = totGoals >= 3;
    } else if (result.model === "DEFENSIVE_LOCK") {
      msHit = ftRes === "MSX" || Math.abs(hSc - aSc) <= 1;
      if (totHt != null) iyHit = totHt === 0;
      auHit = totGoals < 3;
      bandHit = totGoals <= 2;
    } else if (result.model === "IY_KILIT_2Y_COZUM") {
      msHit = favSide === "HOME" ? ftRes === "MS1" : ftRes === "MS2";
      if (totHt != null) iyHit = totHt <= 1;
      auHit = totGoals >= 2;
      bandHit = totGoals >= 2 && totGoals <= 4;
    } else if (result.model === "FAKE_FAVORITE_TRAP") {
      msHit = ftRes === "MSX" || ftRes === "MS2";
      if (totHt != null) iyHit = totHt >= 1;
      auHit = totGoals >= 2;
      bandHit = totGoals >= 2 && totGoals <= 4;
    }

    actual = {
      score: actualScore,
      htScore: hHt != null && aHt != null ? `${hHt}:${aHt}` : null,
      msHit,
      iyHit,
      auHit,
      bandHit,
      scoreHit: result.hedefSkorlar.includes(actualScore),
    };
  }

  return {
    ...result,
    favSide,
    favOdd: Math.round(favOdd * 100) / 100,
    isMajorLeague,
    actual,
  };
}
