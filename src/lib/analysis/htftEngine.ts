import type { CompactOddsRow } from "@/lib/archiveCache";

/**
 * HT/FT Matris Motoru — sync_engine_with_cli.py'deki evaluate_match_matrix ile
 * AYNI model: seçilen maçın kendi İlk Yarı / İkinci Yarı / Maç Sonu 1X2, O/U ve
 * BTTS oranlarından 9 HT/FT kombinasyonu (1/1 … 2/2) için ağırlıklı bir olasılık
 * dağılımı üretir. marketSignals.ts (dispersion/arbitraj) gibi ek bir API isteği
 * gerektirmez — saf client-side, bu maçın odds satırlarından hesaplanır.
 *
 * NOT — YORUM SINIRI: bu bir olasılık dağılımı, kesin bir tahmin değil. "Dönüş
 * alarmı" (2/1, 1/2) yalnızca dar bir favori/İY/BTTS/2.Y baskı koşulu kümesi
 * karşılandığında tetiklenir ve nadir olayları işaretler — garanti değildir.
 */

export type HtftCombo = "1/1" | "1/X" | "1/2" | "X/1" | "X/X" | "X/2" | "2/1" | "2/X" | "2/2";

export type HtftPick = { combo: HtftCombo; prob: number };

export type HtftEngineResult = {
  picks: HtftPick[]; // en yüksekten en düşüğe, 9 kombinasyonun tamamı
  favSide: "HOME" | "AWAY";
  favOdd: number;
  turnaroundAlert: string | null;
};

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
// Python get_med: eff = mc or mo (kapanış önce, yoksa açılışa düşülür); drift = mc/mo.
function effOf(p: PricePool): number | null {
  if (p.cur.length) return median(p.cur);
  if (p.open.length) return median(p.open);
  return null;
}
function driftOf(p: PricePool): number {
  if (p.open.length && p.cur.length) {
    const mo = median(p.open);
    const mc = median(p.cur);
    if (mo > 0) return mc / mo;
  }
  return 1.0;
}

export function computeHtftEngine(odds: CompactOddsRow[] | null | undefined): HtftEngineResult | null {
  if (!odds?.length) return null;

  const fh: Record<"H" | "D" | "A", PricePool> = { H: newPool(), D: newPool(), A: newPool() };
  const ft: Record<"H" | "D" | "A", PricePool> = { H: newPool(), D: newPool(), A: newPool() };
  const sh: Record<"H" | "A", PricePool> = { H: newPool(), A: newPool() };
  const shOver15 = newPool();
  const bttsYes = newPool();
  const over25 = newPool();
  const htft21 = newPool();
  const htft12 = newPool();

  for (const row of odds) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const [, mtype, scope, sideTok, opening, current, active] = row;
    if (!isActive(active)) continue;

    const cur = parseNum(current);
    const op = parseNum(opening);
    if (cur == null && op == null) continue;

    const type = String(mtype).toUpperCase();
    const scp = String(scope).toUpperCase();
    const side = String(sideTok).toUpperCase();

    if (type === "HOME_DRAW_AWAY") {
      if (scp === "FIRST_HALF") {
        if (side === "H") pushPool(fh.H, op, cur);
        else if (side === "D" || side === "X") pushPool(fh.D, op, cur);
        else if (side === "A") pushPool(fh.A, op, cur);
      } else if (scp === "FULL_TIME") {
        if (side === "H") pushPool(ft.H, op, cur);
        else if (side === "D" || side === "X") pushPool(ft.D, op, cur);
        else if (side === "A") pushPool(ft.A, op, cur);
      } else if (scp === "SECOND_HALF") {
        if (side === "H") pushPool(sh.H, op, cur);
        else if (side === "A") pushPool(sh.A, op, cur);
      }
      continue;
    }
    if (type === "OVER_UNDER") {
      const isOver = side.startsWith("OVER") || side === "O";
      const lineStr = side.includes(":") ? side.split(":")[1] : null;
      if (isOver && lineStr === "1.5" && scp === "SECOND_HALF") pushPool(shOver15, op, cur);
      else if (isOver && lineStr === "2.5" && scp === "FULL_TIME") pushPool(over25, op, cur);
      continue;
    }
    if (type === "BOTH_TEAMS_TO_SCORE") {
      if (scp === "FULL_TIME" && side.includes("YES")) pushPool(bttsYes, op, cur);
      continue;
    }
    if (type === "HALF_FULL_TIME") {
      if (scp !== "FULL_TIME") continue;
      if (side === "HTFT:2/1" || side === "2/1") pushPool(htft21, op, cur);
      else if (side === "HTFT:1/2" || side === "1/2") pushPool(htft12, op, cur);
      continue;
    }
  }

  const ht1 = effOf(fh.H);
  const htx = effOf(fh.D);
  const ht2 = effOf(fh.A);
  if (ht1 == null || htx == null || ht2 == null) return null;

  const ms1 = effOf(ft.H);
  const msx = effOf(ft.D);
  const ms2 = effOf(ft.A);
  if (ms1 == null || msx == null || ms2 == null) return null;

  const totHt = 1 / ht1 + 1 / htx + 1 / ht2;
  const pHt1 = 1 / ht1 / totHt;
  const pHtx = 1 / htx / totHt;
  const pHt2 = 1 / ht2 / totHt;

  const totMs = 1 / ms1 + 1 / msx + 1 / ms2;
  const pMs1 = 1 / ms1 / totMs;
  const pMsx = 1 / msx / totMs;
  const pMs2 = 1 / ms2 / totMs;

  const bttsY = effOf(bttsYes);
  const ov25 = effOf(over25);

  const favOdd = Math.min(ms1, ms2);
  const favSide: "HOME" | "AWAY" = ms1 <= ms2 ? "HOME" : "AWAY";

  const drf2hFav = driftOf(favSide === "HOME" ? sh.H : sh.A);
  const drf2hO15 = driftOf(shOver15);

  const odd21 = effOf(htft21);
  const odd12 = effOf(htft12);

  const matrix: Record<HtftCombo, number> = {
    "1/1": 0,
    "1/X": 0,
    "1/2": 0,
    "X/1": 0,
    "X/X": 0,
    "X/2": 0,
    "2/1": 0,
    "2/X": 0,
    "2/2": 0,
  };

  // HOLD (1/1, 2/2)
  const holdBoost = favOdd <= 1.55 ? 1.65 : 1.25;
  matrix["1/1"] = pHt1 * pMs1 * holdBoost;
  matrix["2/2"] = pHt2 * pMs2 * holdBoost;

  // BREAKTHROUGH (X/1, X/2)
  matrix["X/1"] = pHtx * pMs1 * 1.15;
  matrix["X/2"] = pHtx * pMs2 * 1.15;

  // DEADLOCK (X/X)
  const deadlockMult = (bttsY != null && bttsY <= 1.55) || (ov25 != null && ov25 >= 2.05) ? 1.45 : 0.95;
  matrix["X/X"] = pHtx * pMsx * deadlockMult;

  // LOSING LEAD (1/X, 2/X)
  const leadLossMult = bttsY != null && bttsY <= 1.6 ? 1.1 : 0.7;
  matrix["1/X"] = pHt1 * pMsx * leadLossMult;
  matrix["2/X"] = pHt2 * pMsx * leadLossMult;

  // TURNAROUND ANOMALİSİ KONTROLÜ
  let turnaroundAlert: string | null = null;

  let turn1 = pHt2 * pMs1 * 0.25;
  if (favSide === "HOME" && favOdd >= 1.65 && favOdd <= 2.35 && ht1 >= 2.45) {
    if (bttsY != null && bttsY <= 1.72 && (drf2hFav <= 0.98 || drf2hO15 <= 0.96)) {
      if (odd21 != null && odd21 <= 26.0) {
        turn1 *= 5.0;
        turnaroundAlert = `⚡ HIGH VALUE ALERT: conditions look clean for a 2/1 turnaround (@${odd21.toFixed(1)}) — 2nd-half pressure + BTTS lined up`;
      }
    }
  }
  matrix["2/1"] = turn1;

  let turn2 = pHt1 * pMs2 * 0.25;
  if (favSide === "AWAY" && favOdd >= 1.65 && favOdd <= 2.35 && ht2 >= 2.45) {
    if (bttsY != null && bttsY <= 1.72 && (drf2hFav <= 0.98 || drf2hO15 <= 0.96)) {
      if (odd12 != null && odd12 <= 26.0) {
        turn2 *= 5.0;
        turnaroundAlert = `⚡ HIGH VALUE ALERT: conditions look clean for a 1/2 turnaround (@${odd12.toFixed(1)}) — 2nd-half pressure + BTTS lined up`;
      }
    }
  }
  matrix["1/2"] = turn2;

  const totM = Object.values(matrix).reduce((a, b) => a + b, 0);
  if (!(totM > 0)) return null;

  const picks: HtftPick[] = (Object.keys(matrix) as HtftCombo[])
    .map((combo) => ({ combo, prob: Math.round((matrix[combo] / totM) * 1000) / 10 }))
    .sort((a, b) => b.prob - a.prob);

  return { picks, favSide, favOdd: Math.round(favOdd * 100) / 100, turnaroundAlert };
}

export const HTFT_COMBO_LABEL: Record<HtftCombo, string> = {
  "1/1": "Home / Home",
  "1/X": "Home / Draw",
  "1/2": "Home / Away",
  "X/1": "Draw / Home",
  "X/X": "Draw / Draw",
  "X/2": "Draw / Away",
  "2/1": "Away / Home",
  "2/X": "Away / Draw",
  "2/2": "Away / Away",
};
