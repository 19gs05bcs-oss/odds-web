import type { CompactOddsRow } from "@/lib/archiveCache";
import type { H2hForm, TwinFeatures, TwinResult } from "@/lib/analysis/m6Twins";

/**
 * Anatomy Engine ("Market Detect") — ported from the Python odds radar
 * v6 (toplu_radart.py: "Toplu Radar / Saf OU Büro Gol Beklentisi").
 * File and export names are kept as `anatomyEngine.ts` / `computeAnatomyEngine`
 * on purpose — only the underlying model changed, not the wiring.
 *
 * This is a full replacement of the previous X-ray / margin-corridor model
 * (which leaned on FT 1X2 + European Handicap drift). The v6 model drops
 * that 1X2/Skellam dependency entirely and instead:
 *   - devigs the FT Over/Under 2.5, FT Over/Under 3.5 and HT Over/Under 1.5
 *     markets with Shin's (1992) method (corrects for favourite-longshot
 *     bias, unlike flat normalisation),
 *   - solves for the bookmakers' implied full-time goal expectation (E_FT)
 *     and first-half goal expectation (E_HT) against a Poisson model,
 *   - derives second-half expectation E_2H = E_FT - E_HT and flags an
 *     internal mispricing when that comes out negative,
 *   - flags "fake steam" (public/steam moves with no DNA support behind
 *     them) separately from genuine confirmed drift,
 *   - runs five named sub-ratings (Steel Lock / MMS tempo / HT goal / wall /
 *     2:1-1:2 duel) whose ANDed thresholds pick one of the tempo buckets.
 *
 * Same as htftEngine.ts / goalEngine.ts: pure client-side, computed only
 * from this match's own odds rows — no extra API request. The historical
 * "day-end calibration" report from the Python script (aggregating many
 * matches into hit-rate tables) is NOT ported here — that's a batch/reporting
 * concern, not a single-match read.
 *
 * On top of the single-winner engine chain, `goldSignals` carries the radar's
 * "Gold Signals" (V8 Home Rout, Elite Duel, Entropy Shock, MER Split, Combined
 * Fire) — evaluated independently on opening/current medians, so more than one
 * can fire on the same match.
 *
 * READING LIMIT: this is a market-state scan, not a guaranteed outcome. If
 * the match hasn't been played yet, only the read itself is shown; once it
 * has finished (home_score/away_score present), it's compared to what
 * actually happened, including E_FT vs actual-goals calibration.
 */

export type TargetTempo =
  | "EXPLOSIVE_GOALS_STRONG"
  | "EXPLOSIVE_GOALS_WEAK"
  | "HT_EXPLOSION"
  | "ASYMMETRIC_WALL"
  | "HIGH_PACE"
  | "DECEPTIVE_TEMPO"
  | "LOW_PACE"
  | "BALANCED";

/** Hangi motorun kazandığı. Öncelik sırası: V23 -> M6 -> SAF_V23 üçlüsü -> nihai (v14) zinciri. */
export type EngineId =
  | "V23_NUCLEAR" // super_radar_v23: 💥 Nükleer Patlama (3.5Ü) — form + 888 ikiz teyidi
  | "M6_DOUBLE_HALF" // nihai: 💥 M6 çift yarı (4.5Ü/5.5Ü)
  | "SAF_V23_DUELLO" // toplu_radar saf v23: 💎 Elit Düello
  | "SAF_V23_KILIT" // toplu_radar saf v23: 🔒 Gerçek Kilit
  | "SAF_V23_WALL" // toplu_radar saf v23: 🛡️ Rölanti Duvarı
  | "STEAM_TRAP"
  | "V8_HOME_ROUT"
  | "NIHAI_DUELLO"
  | "V9_AWAY_IDLE"
  | "V3B_DOUBLE_LOCK"
  | "V3_DEAD_HT"
  | "HT_NUCLEAR"
  | "STD_DUELLO"
  | "NATURAL_STERILE"
  | "BALANCED";

export type EngineSource = "super_radar_v23" | "toplu_radar saf v23" | "toplu_radar nihai (v14)";

/** /api/smart-analysis/market-detect cevabı: fixture.h2h formu + 888 M6 KNN ikizleri. */
export type AnatomyEnrichment = { form: H2hForm | null; twins: TwinResult | null };

/** Gold Signals — ported from the Python live radar (radar_supabase_gold.py, v24). Independent of the single-winner engine chain above: several can fire on the same match. */
export type GoldSignalId = "V8_HOME_ROUT" | "ELITE_DUEL" | "ENTROPY_SHOCK" | "MER_SPLIT" | "COMBINED_FIRE";

export type GoldSignal = {
  id: GoldSignalId;
  label: string; // "🚀 V8: HOME ROUT"
  market: "Over 3.5" | "Over 2.5";
  odds: number | null; // opening median of the target market
  goalsRequired: number; // total goals needed for the target to win (4 for Over 3.5 signals, 3 for Over 2.5)
  backtest: string | null; // historical figure quoted in the radar script header (not re-verified here)
  hit: boolean | null; // null until the match has finished
};

export type GoldMetrics = {
  mmsRadar: number; // radar-mode MMS (only 0:0 / 1:1 CS penalties, no HT 0:0 penalty — differs from mmsV23)
  klTotal: number; // KL divergence of opening vs current devigged 1X2 + OU 2.5
  d45: number; // Over 4.5 opening -> current (fraction)
  dCs10: number; // CS 1:0 opening -> current (fraction)
};

export type AnatomyActualCheck = {
  score: string;
  htScore: string | null;
  totalGoals: number;
  htTotalGoals: number | null;
  tempoHit: boolean | null; // motorun ana bahsi tuttu mu (yönsüz okumada null)
  expDiff: number | null; // actual total goals - E_FT (calibration; null if E_FT unavailable)
};

export type AnatomyLambda = {
  market: number | null; // λ_Pzr — piyasa (Shin + Poisson) E_FT
  form: number | null; // λ_F — fixture.h2h zaman ağırlıklı form
  blend: number | null; // λ_Snt = (1-γ)·λ_Pzr + γ·λ_F
  gamma: number | null;
  formN: number | null;
  formWSum: number | null;
};

export type AnatomyDrifts = {
  d25: number; // Over 2.5 açılış -> güncel (oran değişimi, kesir)
  d35: number;
  dBtts: number;
  dCs00: number;
};

export type AnatomyEngineResult = {
  favSide: "HOME" | "AWAY";
  favOdd: number;
  targetTempo: TargetTempo;
  tempoLabel: string;
  idealBet: string;
  comboLabel: string;
  engineId: EngineId;
  engineSource: EngineSource;
  dnaU25: number; // opening Under 2.5 odd - opening Over 2.5 odd
  mmsRating: number; // kazanan motorun modundaki MMS (v23 motorlarında Shin'li, nihai'de düz normalize)
  mmsV23: number;
  htRating: number;
  kilitRating: number; // "Steel Lock" rating (kazanan motor moduna göre)
  kilitV23: number;
  wallRating: number;
  driftTag: string; // "+3%/-5%" = ΔOver2.5 / ΔOver3.5 since opening
  drifts: AnatomyDrifts;
  expGoalsFt: number | null; // E_FT
  expGoalsHt: number | null; // E_HT
  expGoals2h: number | null; // E_2H = E_FT - E_HT
  tempoShift: number | null; // E_2H - E_HT
  expLowConfidence: boolean; // fewer than 3 books quoting FT OU, or E_FT unsolved
  expCol: string; // "2.45 / 1.10*" display string, matching the Python report column
  lambda: AnatomyLambda;
  similarity: TwinResult | null; // 888 M6 KNN (k=5)
  simDisplayPct: number | null; // kilit motorunda 100 - sim
  twinProof: string | null; // "3/5 3.5Ü | 1/5 5.5Ü"
  shields: string[]; // devreye giren kalkanlar / vetolar
  gateNotes: string[]; // V23 motorlarının hipotez ✓ ama teyit ✗ açıklamaları
  enrichStatus: "ok" | "pending" | "unavailable";
  twinFeatures: TwinFeatures | null; // route'a gönderilecek KNN vektörü
  goldSignals: GoldSignal[]; // radar Gold Signals that fired on this match (empty = none / excluded league)
  goldMetrics: GoldMetrics;
  mispricingAnomaly: boolean; // E_2H < 0 (bilgi amaçlı; sınıflamayı değiştirmez)
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
  return /\b(u17|u18|u19|u20|u21|u23|reserve|rezerv|b team)\b|\bii\b/.test(t);
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

type PricePool = { open: number[]; cur: number[]; books: Set<number> };
function newPool(): PricePool {
  return { open: [], cur: [], books: new Set() };
}
function pushPool(p: PricePool, op: number | null, cur: number | null, bookId: number) {
  if (op != null) p.open.push(op);
  if (cur != null) p.cur.push(cur);
  p.books.add(bookId);
}
function openMedian(p: PricePool): number | null {
  return p.open.length ? median(p.open) : null;
}
function curMedian(p: PricePool): number | null {
  return p.cur.length ? median(p.cur) : null;
}

function toInt(v: string | number | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
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

// ---------------------------------------------------------------------------
// Shin (1992) devig + Poisson expected-goals solver — direct port of the
// `shin_devig` / `solve_ft_expected_goals` / `solve_ht_expected_goals`
// functions in toplu_radart.py.
// ---------------------------------------------------------------------------

/** Bisection root-finder. Assumes a sign change between lo and hi. */
function bisect(f: (x: number) => number, lo: number, hi: number, iters = 200): number | null {
  let a = lo;
  let b = hi;
  let fa = f(a);
  const fb0 = f(b);
  if (Number.isNaN(fa) || Number.isNaN(fb0)) return null;
  if (fa === 0) return a;
  if (fb0 === 0) return b;
  if (fa * fb0 > 0) return null; // no sign change
  for (let i = 0; i < iters; i++) {
    const mid = (a + b) / 2;
    const fm = f(mid);
    if (fm === 0 || (b - a) / 2 < 1e-12) return mid;
    if (fa * fm < 0) {
      b = mid;
    } else {
      a = mid;
      fa = fm;
    }
  }
  return (a + b) / 2;
}

/** Golden-section search for the minimiser of a (roughly unimodal) function on [lo, hi]. */
function goldenSectionMin(f: (x: number) => number, lo: number, hi: number, iters = 200): number {
  const gr = (Math.sqrt(5) - 1) / 2;
  let a = lo;
  let b = hi;
  let c = b - gr * (b - a);
  let d = a + gr * (b - a);
  let fc = f(c);
  let fd = f(d);
  for (let i = 0; i < iters && b - a > 1e-9; i++) {
    if (fc < fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - gr * (b - a);
      fc = f(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + gr * (b - a);
      fd = f(d);
    }
  }
  return (a + b) / 2;
}

function poissonCdf(k: number, lam: number): number {
  // sum_{i=0}^{k} lam^i e^-lam / i!
  let term = Math.exp(-lam);
  let s = term;
  for (let i = 1; i <= k; i++) {
    term *= lam / i;
    s += term;
  }
  return s;
}

/** Shin (1992) devig: corrects for favourite-longshot bias. Falls back to flat normalisation. */
function shinDevig(oddsList: number[]): number[] {
  const pis = oddsList.map((o) => 1 / o);
  const sumPi = pis.reduce((a, b) => a + b, 0);
  const flat = pis.map((pi) => pi / sumPi);

  const probsForZ = (z: number): number[] =>
    pis.map((pi) => (Math.sqrt(Math.max(0, z * z + (4 * (1 - z) * pi * pi) / sumPi)) - z) / (2 * (1 - z)));
  const f = (z: number): number => probsForZ(z).reduce((a, b) => a + b, 0) - 1;

  try {
    let zHi = 0.5;
    let guard = 0;
    while (f(zHi) > 0 && zHi < 0.999 && guard < 20) {
      zHi = Math.min(0.999, zHi + 0.1);
      guard += 1;
    }
    const z = bisect(f, 1e-10, zHi, 200);
    if (z == null) return flat;
    const probs = probsForZ(z);
    if (probs.some((p) => !(p > 0) || Number.isNaN(p))) return flat;
    return probs;
  } catch {
    return flat;
  }
}

/** Solves the bookmakers' implied FT goal expectation from OU 2.5 and OU 3.5. */
function solveFtExpectedGoals(u25o: number | null, o25o: number | null, u35o: number | null, o35o: number | null): number | null {
  const constraints: Array<[number, number]> = [];
  if (u25o && o25o) {
    const [pU25] = shinDevig([u25o, o25o]);
    constraints.push([2, pU25]);
  }
  if (u35o && o35o) {
    const [pU35] = shinDevig([u35o, o35o]);
    constraints.push([3, pU35]);
  }
  if (!constraints.length) return null;

  const residualsSq = (lam: number): number =>
    constraints.reduce((acc, [k, p]) => acc + (poissonCdf(k, lam) - p) ** 2, 0);

  const lam = goldenSectionMin(residualsSq, 0.01, 15.0);
  return Number.isFinite(lam) ? Math.round(lam * 100) / 100 : null;
}

/** Solves the bookmakers' implied first-half goal expectation from HT OU 1.5. */
function solveHtExpectedGoals(u15htO: number | null, o15htO: number | null): number | null {
  if (!u15htO || !o15htO || u15htO <= 1.0 || o15htO <= 1.0) return null;
  const [pU15] = shinDevig([u15htO, o15htO]);
  const f = (lam: number): number => Math.exp(-lam) * (1 + lam) - pU15;

  const root = bisect(f, 1e-4, 8.0, 200);
  if (root != null) return Math.round(root * 100) / 100;

  const lam = goldenSectionMin((l) => (poissonCdf(1, l) - pU15) ** 2, 0.01, 8.0);
  return Number.isFinite(lam) ? Math.round(lam * 100) / 100 : null;
}

/** KL-style divergence used by the radar: sum(q * ln(q / p)) with p = opening dist, q = current dist. */
function klDivergence(pDist: number[], qDist: number[]): number {
  let kl = 0;
  for (let i = 0; i < pDist.length; i++) {
    const p = Math.max(1e-6, Math.min(0.999999, pDist[i]));
    const q = Math.max(1e-6, Math.min(0.999999, qDist[i]));
    kl += q * Math.log(q / p);
  }
  return Math.max(0, kl);
}

/** Same exclusion list as the radar's WILD tuple (substring match on the league name). */
const GOLD_WILD_LEAGUE = ["u19", "u20", "u21", "u23", "women", "bayan", "youth", "friendly", "junioren", "cup", "kupa", "copa"];

// ---------------------------------------------------------------------------

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

const MIN_BOOKS_FOR_EXP = 3;

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Python `" W" in name` alt-string hatasını (West Ham, Wolves...) düzeltir: sadece kelime olarak W / (W) / Women. */
function isWomenMatch(home: string | null | undefined, away: string | null | undefined): boolean {
  const t = `${home || ""} - ${away || ""}`;
  return /\sW(?=\s|-|$)/.test(t) || /\(W\)/.test(t) || /women/i.test(t);
}

function csPool(map: Map<string, PricePool>, key: string): PricePool {
  return map.get(key) ?? newPool();
}

/**
 * @param enrich  undefined = zenginleştirme yükleniyor, null = alınamadı,
 *                nesne = /api/smart-analysis/market-detect sonucu (form + ikizler).
 */
export function computeAnatomyEngine(
  odds: CompactOddsRow[] | null | undefined,
  meta: AnatomyFixtureMeta | null | undefined,
  enrich?: AnatomyEnrichment | null,
): AnatomyEngineResult | null {
  if (!odds?.length) return null;
  if (isYouthOrReserve(meta?.homeName, meta?.awayName, meta?.league)) return null;

  const ft = { H: newPool(), D: newPool(), A: newPool() };
  const ou25 = { over: newPool(), under: newPool() };
  const ou35 = { over: newPool(), under: newPool() };
  const ou45 = { over: newPool(), under: newPool() };
  const ou55 = { over: newPool(), under: newPool() };
  const ouHt05 = { over: newPool(), under: newPool() };
  const ouHt15 = { over: newPool(), under: newPool() };
  const ouHt25 = { over: newPool(), under: newPool() };
  const btts = { yes: newPool(), no: newPool() };
  const csFt = new Map<string, PricePool>();
  const csHt = new Map<string, PricePool>();

  for (const row of odds) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const [bookmakerId, mtypeRaw, scopeRaw, sideRaw, opening, current, active] = row;
    if (!isActive(active)) continue;

    const cur = parseNum(current);
    const op = parseNum(opening);
    if (cur == null && op == null) continue;

    const type = String(mtypeRaw).toUpperCase();
    const scp = String(scopeRaw).toUpperCase();
    const side = String(sideRaw).toUpperCase();
    const bookId = Number(bookmakerId);
    const isFullTime = scp === "FULL_TIME";
    const isFirstHalf = scp === "FIRST_HALF";

    if (type === "HOME_DRAW_AWAY" && isFullTime) {
      if (side === "H") pushPool(ft.H, op, cur, bookId);
      else if (side === "D" || side === "X") pushPool(ft.D, op, cur, bookId);
      else if (side === "A") pushPool(ft.A, op, cur, bookId);
      continue;
    }

    if (type === "OVER_UNDER") {
      const isOver = side.startsWith("OVER");
      const isUnder = side.startsWith("UNDER");
      const lineStr = side.includes(":") ? side.split(":")[1] : null;
      const put = (pool: { over: PricePool; under: PricePool }) => {
        if (isOver) pushPool(pool.over, op, cur, bookId);
        else if (isUnder) pushPool(pool.under, op, cur, bookId);
      };
      if (isFullTime) {
        if (lineStr === "2.5") put(ou25);
        else if (lineStr === "3.5") put(ou35);
        else if (lineStr === "4.5") put(ou45);
        else if (lineStr === "5.5") put(ou55);
      } else if (isFirstHalf) {
        if (lineStr === "0.5") put(ouHt05);
        else if (lineStr === "1.5") put(ouHt15);
        else if (lineStr === "2.5") put(ouHt25);
      }
      continue;
    }

    if (type === "BOTH_TEAMS_TO_SCORE" && isFullTime) {
      if (side.includes("YES")) pushPool(btts.yes, op, cur, bookId);
      else if (side.includes("NO")) pushPool(btts.no, op, cur, bookId);
      continue;
    }

    if (type === "CORRECT_SCORE") {
      const parsed = parseScoreToken(side);
      if (parsed) {
        if (isFullTime) {
          if (!csFt.has(parsed.score)) csFt.set(parsed.score, newPool());
          pushPool(csFt.get(parsed.score)!, op, cur, bookId);
        } else if (isFirstHalf) {
          // Python only tracks the opening price for HT correct score.
          if (!csHt.has(parsed.score)) csHt.set(parsed.score, newPool());
          pushPool(csHt.get(parsed.score)!, op, null, bookId);
        }
      }
      continue;
    }
  }

  // ---- Ham (fallback'siz) açılış medyanları — v23 motorları bunları kullanır ----
  const rawU25o = openMedian(ou25.under);
  const rawO25o = openMedian(ou25.over);
  const rawU35o = openMedian(ou35.under);
  const rawO35o = openMedian(ou35.over);
  const rawO45o = openMedian(ou45.over);
  const rawO55o = openMedian(ou55.over);
  const rawU15htO = openMedian(ouHt15.under);
  const rawO15htO = openMedian(ouHt15.over);
  const rawHtO05 = openMedian(ouHt05.over);
  const rawHtO25 = openMedian(ouHt25.over);
  const rawHo = openMedian(ft.H);
  const rawDo = openMedian(ft.D);
  const rawAo = openMedian(ft.A);
  const rawBttsY = openMedian(btts.yes);
  const rawBttsN = openMedian(btts.no);
  const rawCs00 = openMedian(csPool(csFt, "0:0"));
  const rawCs11 = openMedian(csPool(csFt, "1:1"));
  const rawCsHt00 = openMedian(csPool(csHt, "0:0"));
  const rawCs21 = openMedian(csPool(csFt, "2:1"));
  const rawCs12 = openMedian(csPool(csFt, "1:2"));

  // Need at least one FT OU market to read anything meaningful.
  if (rawU25o == null && rawO25o == null && rawU35o == null && rawO35o == null) return null;

  const expGoalsFt = solveFtExpectedGoals(rawU25o, rawO25o, rawU35o, rawO35o);
  const expGoalsHt = solveHtExpectedGoals(rawU15htO, rawO15htO);

  const booksOu = new Set<number>([
    ...ou25.under.books,
    ...ou25.over.books,
    ...ou35.under.books,
    ...ou35.over.books,
  ]);
  const expLowConfidence = booksOu.size < MIN_BOOKS_FOR_EXP || expGoalsFt == null;

  let expGoals2h: number | null = null;
  let tempoShift: number | null = null;
  let mispricingAnomaly = false;
  if (expGoalsFt != null && expGoalsHt != null) {
    const calc2h = r2(expGoalsFt - expGoalsHt);
    if (calc2h < 0 && !expLowConfidence) mispricingAnomaly = true;
    expGoals2h = Math.max(0, calc2h);
    tempoShift = r2(expGoals2h - expGoalsHt);
  }

  const confMark = expLowConfidence ? "*" : "";
  const ftStr = expGoalsFt != null ? expGoalsFt.toFixed(2) : "-";
  const h2Str = expGoals2h != null ? expGoals2h.toFixed(2) : "-";
  const expCol = `${ftStr} / ${h2Str}${confMark}`;

  // ---- Nihai (v14) çalışma değerleri: eksik piyasada Python varsayılanları ----
  const tU25o = rawU25o ?? 1.8;
  const tO25o = rawO25o ?? 1.95;
  const tO25c = curMedian(ou25.over) ?? tO25o;
  const tDeltaO25 = tO25o ? (tO25c - tO25o) / tO25o : 0;

  const tO35o = rawO35o ?? 3.0;
  const tO35c = curMedian(ou35.over) ?? tO35o;
  const tDeltaO35 = tO35o ? (tO35c - tO35o) / tO35o : 0;

  const tU15htO = rawU15htO ?? 1.4;
  const tO15htO = rawO15htO ?? 2.8;

  const tBttsYo = rawBttsY ?? 1.8;
  const tBttsNo = rawBttsN ?? 1.9;
  const tBttsYc = curMedian(btts.yes) ?? tBttsYo;
  const tDeltaBtts = tBttsYo ? (tBttsYc - tBttsYo) / tBttsYo : 0;

  const tHo = rawHo ?? 2.5;
  const tDo = rawDo ?? 3.2;
  const tAo = rawAo ?? 2.6;

  const favSide: "HOME" | "AWAY" = tHo <= tAo ? "HOME" : "AWAY";
  const favOdd = Math.min(tHo, tAo);
  const dogOdd = Math.max(tHo, tAo);
  const dnaU25 = r2(tU25o - tO25o);

  const cs00o = rawCs00 ?? 12.0;
  const cs11o = rawCs11 ?? 6.5;
  const csHt00o = rawCsHt00 ?? 2.7;

  // 1. STEEL LOCK RATING (nihai, düz normalize)
  const probU25 = 1 / tU25o / (1 / tU25o + 1 / tO25o);
  const probHtu15 = 1 / tU15htO / (1 / tU15htO + 1 / tO15htO);
  const dBonus = tDo <= 3.1 ? 20.0 : tDo <= 3.3 ? 10.0 : 0.0;
  const htLockBonus = csHt00o <= 2.35 ? 15.0 : 0.0;
  const kilitNihai = r1(probU25 * 45.0 + probHtu15 * 25.0 + dBonus + htLockBonus);

  // 2. MMS (TEMPO) RATING (nihai)
  const probO25 = 1 / tO25o / (1 / tO25o + 1 / tU25o);
  const probBtts = 1 / tBttsYo / (1 / tBttsYo + 1 / tBttsNo);
  const rTempo = probO25 * 60.0 + probBtts * 40.0;
  const rDrift = -tDeltaO25 * 50.0 + -tDeltaBtts * 40.0;
  let rCeza = 0.0;
  if (cs00o <= 8.5) rCeza += 10.0;
  if (cs11o <= 5.8) rCeza += 8.0;
  if (csHt00o <= 2.35) rCeza += 15.0;
  if (dnaU25 <= -0.35 && (tDeltaO25 <= -0.04 || tDeltaBtts <= -0.04) && kilitNihai >= 65.0) rCeza += 25.0;
  const mmsNihai = r1(rTempo + rDrift - rCeza);

  // 3. HT GOAL RATING
  const probHt15 = 1 / tO15htO / (1 / tO15htO + 1 / tU15htO);
  const htRating = r1(probHt15 * 60.0 + probO25 * 40.0);

  // 4. ONE-SIDED WALL RATING
  const probBttsNo = 1 / tBttsNo / (1 / tBttsNo + 1 / tBttsYo);
  const favBonus = favOdd <= 1.25 ? 40.0 : favOdd <= 1.45 ? 30.0 : favOdd <= 1.65 ? 20.0 : 10.0;
  const wallRating = r1(probBttsNo * 60.0 + favBonus);

  // 5. CS 2:1 / 1:2 koridoru (nihai: açılış <= 9.50 VEYA -%4 düşüş)
  const cs21c = curMedian(csPool(csFt, "2:1")) ?? rawCs21;
  const dCs21 = rawCs21 && rawCs21 > 1.0 && cs21c != null ? (cs21c - rawCs21) / rawCs21 : 0;
  const cs12c = curMedian(csPool(csFt, "1:2")) ?? rawCs12;
  const dCs12 = rawCs12 && rawCs12 > 1.0 && cs12c != null ? (cs12c - rawCs12) / rawCs12 : 0;
  const csDuelloNihai =
    (rawCs21 != null && rawCs21 <= 9.5) || (rawCs12 != null && rawCs12 <= 9.5) || dCs21 <= -0.04 || dCs12 <= -0.04;

  const isPublicSteamTrap = (tDeltaO25 <= -0.05 || tDeltaBtts <= -0.05) && dnaU25 < 0.2 && mmsNihai < 65.0;

  // =========================================================================
  // v23 ÖZELLİK EVRENİ (super_radar_v23.parse_full_market_universe)
  // =========================================================================
  const hasFt1x2 = rawHo != null && rawAo != null;
  const v23Fav = hasFt1x2 ? Math.min(rawHo!, rawAo!) : null;
  const v23Dog = hasFt1x2 ? Math.max(rawHo!, rawAo!) : null;
  const v23U25 = rawU25o ?? 1.85;
  const v23O25 = rawO25o ?? 1.95;
  const v23O35 = rawO35o ?? (rawO25o != null ? rawO25o * 1.55 : 3.1);
  const v23O45 = rawO45o ?? (rawO25o != null ? rawO25o * 2.4 : 5.5);
  const v23HtO15 = rawO15htO ?? 2.6;
  const v23Dna = rawU25o != null && rawO25o != null ? r2(rawU25o - rawO25o) : 0;
  const v23D = rawDo ?? 3.4;

  const pO25 = rawO25o != null && rawU25o != null ? shinDevig([rawO25o, rawU25o])[0] : null; // P(over 2.5)
  const pHtO15 = rawO15htO != null && rawU15htO != null ? shinDevig([rawO15htO, rawU15htO])[0] : null;
  const pBtts = rawBttsY != null && rawBttsN != null ? shinDevig([rawBttsY, rawBttsN])[0] : null;

  const dCs00 = (() => {
    const c = curMedian(csPool(csFt, "0:0")) ?? rawCs00;
    return rawCs00 && c != null && rawCs00 > 1.0 ? (c - rawCs00) / rawCs00 : 0;
  })();

  const kilitV23 = r1(
    (pO25 != null ? 1 - pO25 : 0.5) * 45.0 +
      (pHtO15 != null ? 1 - pHtO15 : 0.5) * 25.0 +
      (rawDo != null && rawDo <= 3.1 ? 20.0 : rawDo != null && rawDo <= 3.3 ? 10.0 : 0.0) +
      (rawCsHt00 != null && rawCsHt00 <= 2.35 ? 15.0 : 0.0),
  );
  let cezaV23 = 0.0;
  if (rawCs00 != null && rawCs00 <= 8.5) cezaV23 += 10.0;
  if (rawCs11 != null && rawCs11 <= 5.8) cezaV23 += 8.0;
  if (rawCsHt00 != null && rawCsHt00 <= 2.35) cezaV23 += 15.0;
  const mmsV23 = r1(
    (pO25 ?? 0.5) * 60.0 + (pBtts ?? 0.5) * 40.0 + -tDeltaO25 * 50.0 + -tDeltaBtts * 40.0 - cezaV23,
  );
  const csDuelloV23 = (rawCs21 != null && rawCs21 <= 9.5) || (rawCs12 != null && rawCs12 <= 9.5);

  const twinFeatures: TwinFeatures | null =
    v23Fav != null && v23Dog != null
      ? { fav: v23Fav, dog: v23Dog, dna: v23Dna, o25: v23O25, o35: v23O35, o45: v23O45, htO15: v23HtO15 }
      : null;

  // ---- Zenginleştirme: fixture.h2h formu + 888 M6 ikizleri ----
  const enrichStatus: "ok" | "pending" | "unavailable" =
    enrich === undefined ? "pending" : enrich === null ? "unavailable" : "ok";
  const form = enrich?.form ?? null;
  const twins = enrich?.twins ?? null;

  let finalLambda: number | null = expGoalsFt;
  if (form && expGoalsFt) finalLambda = r2((1 - form.gamma) * expGoalsFt + form.gamma * form.lambdaForm);

  const lambda: AnatomyLambda = {
    market: expGoalsFt,
    form: form ? form.lambdaForm : null,
    blend: finalLambda,
    gamma: form ? form.gamma : null,
    formN: form ? form.n : null,
    formWSum: form ? form.wSum : null,
  };

  const shields: string[] = [];
  const gateNotes: string[] = [];
  const women = isWomenMatch(meta?.homeName, meta?.awayName);
  const heavyFavBlind = v23Fav != null && v23Fav <= 1.18 && form == null;
  const womenUnverified = women && (form == null || form.lambdaForm < 3.5);
  if (heavyFavBlind && enrichStatus !== "pending") shields.push("Heavy favourite (≤1.18) with no H2H form — nuclear blocked (bureau template trap)");
  if (womenUnverified && enrichStatus !== "pending") shields.push("Women's match without H2H form ≥ 3.50 — nuclear blocked");

  const twinNote = (need: string): string =>
    enrichStatus === "pending"
      ? "twin check pending"
      : twins == null
        ? "twin check unavailable"
        : `twin gate failed (${need})`;

  // ---- 1) 💥 NÜKLEER PATLAMA (super_radar_v23 ile birebir) ----
  let explosion =
    !heavyFavBlind &&
    !womenUnverified &&
    v23Fav != null &&
    v23Fav <= 1.65 &&
    finalLambda != null &&
    finalLambda >= 3.75 &&
    mmsV23 >= 65.0 &&
    (v23O45 <= 2.3 || (v23O35 <= 1.95 && v23HtO15 <= 2.35)) &&
    v23Dna >= 0.7 &&
    (rawCs00 == null || rawCs00 >= 18.0) &&
    tDeltaO25 <= 0.02 &&
    tDeltaO35 <= 0.02;
  if (explosion && form && form.lambdaForm < 2.4) {
    explosion = false;
    shields.push(`Form contradiction: market says explosion, last matches avg ${form.lambdaForm.toFixed(2)} goals (< 2.40) — nuclear cancelled`);
  }
  const nuclearOk = explosion && twins != null && twins.simPct >= 80.0 && twins.twinO35 >= 3;
  if (explosion && !nuclearOk) {
    gateNotes.push(
      `💥 Nuclear hypothesis ✓ but ${twinNote(
        twins ? `sim ${twins.simPct.toFixed(0)}% (need ≥80) · ${twins.twinO35}/5 O3.5 (need ≥3)` : "",
      )}`,
    );
  }

  // ---- saf v23: 💎 ELİT DÜELLO ----
  const duelloHyp =
    v23Fav != null &&
    v23Dog != null &&
    v23Fav >= 1.65 &&
    v23Dog <= 4.2 &&
    mmsV23 >= 68.0 &&
    pO25 != null &&
    pO25 >= 0.58 &&
    pBtts != null &&
    pBtts >= 0.58 &&
    (csDuelloV23 || v23Dna >= 0.35) &&
    tDeltaO25 <= 0.03 &&
    tDeltaBtts <= 0.03 &&
    (form == null || form.lambdaForm >= 2.2);
  const duelloOk = duelloHyp && twins != null && twins.twinU25 <= 1;
  if (duelloHyp && !duelloOk) {
    gateNotes.push(
      `💎 Elite duel hypothesis ✓ but ${twinNote(twins ? `${5 - twins.twinU25}/5 O2.5 (need ≥4)` : "")}`,
    );
  }

  // ---- saf v23: 🔒 GERÇEK KİLİT ----
  const lockHyp =
    v23U25 <= 1.55 &&
    v23Dna <= -0.6 &&
    rawCs00 != null &&
    rawCs00 <= 8.5 &&
    kilitV23 >= 68.0 &&
    finalLambda != null &&
    finalLambda <= 2.2 &&
    v23D <= 3.15 &&
    tDeltaO25 >= -0.02 &&
    dCs00 <= 0.08 &&
    (form == null || form.lambdaForm <= 2.5);
  const lockOk = lockHyp && twins != null && twins.simPct < 70.0 && twins.twinU25 >= 3;
  if (lockHyp && !lockOk) {
    gateNotes.push(
      `🔒 True lock hypothesis ✓ but ${twinNote(
        twins ? `sim ${twins.simPct.toFixed(0)}% (need <70) · ${twins.twinU25}/5 low (need ≥3)` : "",
      )}`,
    );
  }

  // ---- saf v23: 🛡️ RÖLANTİ DUVARI (ikiz teyidi yok) ----
  const wallOk =
    rawAo != null && rawHo != null && rawAo <= 1.2 && rawHo >= 7.0 && v23O45 >= 2.6 && pBtts != null && pBtts <= 0.4;

  // =========================================================================
  // NİHAİ (v14) MOTOR ÇEKİRDEĞİ — v23 üçlüsü tutmazsa devreye girer
  // =========================================================================
  const isM6 =
    rawHtO25 != null && rawHtO25 <= 4.2 && rawCs00 != null && rawCs00 >= 24.0 && rawO55o != null && rawO55o <= 3.8 && dogOdd <= 5.2;
  const isHomeMassacre = tHo <= 1.25 && tAo >= 7.0 && expGoalsFt != null && expGoalsFt >= 3.4 && mmsNihai >= 70.0;
  const isEliteDuelloNihai =
    mmsNihai >= 70.0 && favOdd >= 1.75 && dogOdd <= 4.5 && expGoalsFt != null && expGoalsFt >= 3.1 && (csDuelloNihai || dnaU25 >= 0.8);
  const isAwayIdleWall = tAo <= 1.2 && tHo >= 7.0;
  const isDoubleLock15 = expGoalsHt != null && expGoalsHt <= 1.05 && expGoalsFt != null && expGoalsFt <= 2.15 && favOdd >= 1.7;
  const isDeadHtLock25 = expGoalsHt != null && expGoalsHt <= 1.15 && expGoalsFt != null && expGoalsFt <= 2.35 && favOdd >= 1.65;

  const fmtPct = (x: number): string => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(0)}%`;
  const driftTag = `${fmtPct(tDeltaO25)}/${fmtPct(tDeltaO35)}`;

  let engineId: EngineId;
  let targetTempo: TargetTempo;
  let tempoLabel: string;
  let idealBet: string;
  let comboLabel: string;

  if (nuclearOk) {
    engineId = "V23_NUCLEAR";
    targetTempo = "EXPLOSIVE_GOALS_STRONG";
    tempoLabel = `💥 Nuclear explosion (MMS: ${mmsV23.toFixed(0)})`;
    idealBet = "Over 3.5";
    comboLabel = "💥 NUCLEAR EXPLOSION (form + 888 twin confirmed)";
  } else if (isM6) {
    engineId = "M6_DOUBLE_HALF";
    targetTempo = "EXPLOSIVE_GOALS_STRONG";
    tempoLabel = `💥 M6 double-half (O5.5 @${rawO55o!.toFixed(2)})`;
    idealBet = "Over 4.5 / Over 5.5 (nuclear)";
    comboLabel = "💥 M6: NUCLEAR DOUBLE HALF (4.5O/5.5O)";
  } else if (duelloOk) {
    engineId = "SAF_V23_DUELLO";
    targetTempo = "EXPLOSIVE_GOALS_STRONG";
    tempoLabel = `💎 Elite duel (MMS: ${mmsV23.toFixed(0)})`;
    idealBet = "Over 2.5 / BTTS Yes";
    comboLabel = "💎 ELITE DUEL (twin confirmed)";
  } else if (lockOk) {
    engineId = "SAF_V23_KILIT";
    targetTempo = "LOW_PACE";
    tempoLabel = `🔒 True lock (Lock: ${kilitV23.toFixed(0)})`;
    idealBet = "Under 2.5";
    comboLabel = "🔒 TRUE LOCK (twin confirmed)";
  } else if (wallOk) {
    engineId = "SAF_V23_WALL";
    targetTempo = "ASYMMETRIC_WALL";
    tempoLabel = `🛡️ Idle wall (Away fav @${rawAo!.toFixed(2)})`;
    idealBet = "Under 3.5 / BTTS No";
    comboLabel = "🛡️ IDLE WALL (away fav ≤1.20)";
  } else if (isPublicSteamTrap) {
    engineId = "STEAM_TRAP";
    targetTempo = "DECEPTIVE_TEMPO";
    tempoLabel = `⚠️ Fake drop (MMS: ${mmsNihai.toFixed(0)})`;
    idealBet = "Under 2.5 / BTTS No";
    comboLabel = "⚠️ Public trap (fake steam)";
  } else if (isHomeMassacre) {
    engineId = "V8_HOME_ROUT";
    targetTempo = "EXPLOSIVE_GOALS_STRONG";
    tempoLabel = `🚀 Home heavyweight (MMS: ${mmsNihai.toFixed(0)})`;
    idealBet = "Over 3.5 / Home -2.5 handicap";
    comboLabel = "🚀 V8: HOME ROUT (3.5O)";
  } else if (isEliteDuelloNihai) {
    engineId = "NIHAI_DUELLO";
    targetTempo = "EXPLOSIVE_GOALS_STRONG";
    tempoLabel = `💎 Elite duel (MMS: ${mmsNihai.toFixed(0)})`;
    idealBet = "Over 2.5 / BTTS Yes";
    comboLabel = "💎 2-1 / 1-2 CORRIDOR (MMS 70+, no twin check)";
  } else if (isAwayIdleWall) {
    engineId = "V9_AWAY_IDLE";
    targetTempo = "ASYMMETRIC_WALL";
    tempoLabel = "🛡️ Away idle (Fav ≤ 1.20)";
    idealBet = "BTTS No / Under 3.5";
    comboLabel = "🛡️ V9: ASYMMETRIC IDLE (loose wall)";
  } else if (isDoubleLock15) {
    engineId = "V3B_DOUBLE_LOCK";
    targetTempo = "LOW_PACE";
    tempoLabel = `🎯 Double lock (E_HT: ${expGoalsHt!.toFixed(2)})`;
    idealBet = "Under 1.5 (surprise) / Under 2.5";
    comboLabel = "🎯 V3b: DOUBLE LOCK (1.5U)";
  } else if (isDeadHtLock25) {
    engineId = "V3_DEAD_HT";
    targetTempo = "LOW_PACE";
    tempoLabel = `🔒 Dead-HT lock (E_HT: ${expGoalsHt!.toFixed(2)})`;
    idealBet = "Under 2.5 / HT Under 0.5";
    comboLabel = "🔒 V3: DEAD FIRST HALF (2.5U)";
  } else if (htRating >= 52.0 && dnaU25 >= 0.8 && rawHtO05 != null && rawHtO05 <= 1.22) {
    engineId = "HT_NUCLEAR";
    targetTempo = "HT_EXPLOSION";
    tempoLabel = `⚡ HT nuclear (HT: ${htRating.toFixed(0)})`;
    idealBet = "HT Over 0.5 / HT Over 1.5";
    comboLabel = "⚡ First-half goal (~80% HT O0.5)";
  } else if (tO25o <= 1.72 && tBttsYo <= 1.72 && dnaU25 > -0.2) {
    engineId = "STD_DUELLO";
    targetTempo = "HIGH_PACE";
    tempoLabel = `Duel band (MMS: ${mmsNihai.toFixed(0)})`;
    idealBet = "BTTS Yes / Over 2.5";
    comboLabel = "⭐ Standard duel band";
  } else if (dnaU25 <= -0.4 && expGoalsFt != null && expGoalsFt <= 2.45) {
    engineId = "NATURAL_STERILE";
    targetTempo = "DECEPTIVE_TEMPO";
    tempoLabel = `❌ Natural sterile (DNA: ${dnaU25 >= 0 ? "+" : ""}${dnaU25.toFixed(2)})`;
    idealBet = "Under 2.5";
    comboLabel = "❌ V2: NATURAL OPEN STERILE";
  } else {
    engineId = "BALANCED";
    targetTempo = "BALANCED";
    tempoLabel = `Balanced (MMS: ${mmsNihai.toFixed(0)})`;
    idealBet = "Wait for live / no direction";
    comboLabel = "-";
  }

  const engineSource: EngineSource =
    engineId === "V23_NUCLEAR"
      ? "super_radar_v23"
      : engineId === "SAF_V23_DUELLO" || engineId === "SAF_V23_KILIT" || engineId === "SAF_V23_WALL"
        ? "toplu_radar saf v23"
        : "toplu_radar nihai (v14)";
  const v23Mode = engineSource !== "toplu_radar nihai (v14)";

  // Kilit motorunda benzerlik ters okunur (düşük sim = kısır maçlara yakın değil → kilit teyidi)
  const simDisplayPct = twins ? (engineId === "SAF_V23_KILIT" ? 100 - twins.simPct : twins.simPct) : null;
  const twinProof = twins
    ? engineId === "SAF_V23_KILIT"
      ? `${twins.twinU25}/5 low`
      : engineId === "SAF_V23_DUELLO"
        ? `${5 - twins.twinU25}/5 O2.5`
        : `${twins.twinO35}/5 O3.5 | ${twins.twinO55}/5 O5.5`
    : null;

  const isMajorLeague = isTargetMajor(meta?.leagueCountry, meta?.league);

  // =========================================================================
  // 🏆 GOLD SIGNALS (radar_supabase_gold.py v24) — non-exclusive, opening-odds based.
  //   🚀 V8 Home Rout (Over 3.5) · 💎 Elite Duel (Over 2.5) · ⚡ Entropy Shock (Over 2.5)
  //   🎯 MER Split (Over 2.5) · 🔥 Combined Fire (MER + V8 / MER + Duel → Over 3.5)
  // =========================================================================
  const dOf = (open: number | null, cur: number | null): number => (open && cur != null && open > 1.0 ? (cur - open) / open : 0);
  const d45 = dOf(rawO45o, curMedian(ou45.over));
  const dCs10 = dOf(openMedian(csPool(csFt, "1:0")), curMedian(csPool(csFt, "1:0")));

  // Radar MMS: only the 0:0 / 1:1 CS penalties (the HT 0:0 penalty in mmsV23 is not part of the radar).
  const mmsRadar = r1(
    (pO25 ?? 0.5) * 60.0 +
      (pBtts ?? 0.5) * 40.0 +
      -tDeltaO25 * 50.0 +
      -tDeltaBtts * 40.0 -
      ((rawCs00 != null && rawCs00 <= 8.5 ? 10.0 : 0.0) + (rawCs11 != null && rawCs11 <= 5.8 ? 8.0 : 0.0)),
  );

  let klTotal = 0;
  const hC = curMedian(ft.H);
  const dC = curMedian(ft.D);
  const aC = curMedian(ft.A);
  if (rawHo && rawDo && rawAo && hC && dC && aC) {
    klTotal += klDivergence(shinDevig([rawHo, rawDo, rawAo]), shinDevig([hC, dC, aC]));
  }
  const o25C = curMedian(ou25.over);
  const u25C = curMedian(ou25.under);
  if (rawO25o && rawU25o && o25C && u25C) {
    klTotal += klDivergence(shinDevig([rawO25o, rawU25o]), shinDevig([o25C, u25C]));
  }
  klTotal = Math.round(klTotal * 10000) / 10000;

  const goldV8 =
    v23Fav != null && v23Fav <= 1.25 && v23Dog != null && v23Dog >= 7.0 && expGoalsFt != null && expGoalsFt >= 3.4 && mmsRadar >= 70.0;
  const goldDuel =
    mmsRadar >= 70.0 &&
    ((rawCs21 != null && rawCs21 <= 9.2) || (rawCs12 != null && rawCs12 <= 9.2)) &&
    v23Fav != null &&
    v23Fav >= 1.65 &&
    tDeltaO25 <= 0.01;
  const goldEntropy = klTotal >= 0.04 && tDeltaO25 <= 0 && rawO25o != null && rawO25o >= 1.45 && mmsRadar >= 55.0;
  const goldMer = rawO25o != null && rawO25o <= 1.4 && d45 <= -0.02 && dCs10 >= 0.03 && tDeltaO25 < 0.04;

  type GoldDef = Omit<GoldSignal, "hit">;
  const goldDefs: GoldDef[] = [];
  const wildLeague = GOLD_WILD_LEAGUE.some((w) => String(meta?.league || "").toLowerCase().includes(w));
  if (!wildLeague) {
    if (goldMer && goldV8) {
      goldDefs.push({ id: "COMBINED_FIRE", label: "🔥 COMBINED FIRE (MER + V8)", market: "Over 3.5", odds: rawO35o, goalsRequired: 4, backtest: null });
    } else if (goldMer && goldDuel) {
      goldDefs.push({ id: "COMBINED_FIRE", label: "🔥 COMBINED FIRE (MER + DUEL)", market: "Over 3.5", odds: rawO35o, goalsRequired: 4, backtest: null });
    } else {
      if (goldV8) goldDefs.push({ id: "V8_HOME_ROUT", label: "🚀 V8: HOME ROUT", market: "Over 3.5", odds: rawO35o, goalsRequired: 4, backtest: "Historical ROI +22.1%" });
      if (goldDuel) goldDefs.push({ id: "ELITE_DUEL", label: "💎 ELITE DUEL (2-1 / 1-2)", market: "Over 2.5", odds: rawO25o, goalsRequired: 3, backtest: "Historical ROI +14.9%" });
      if (goldEntropy) goldDefs.push({ id: "ENTROPY_SHOCK", label: "⚡ INFORMATION ENTROPY SHOCK (Smart Money)", market: "Over 2.5", odds: rawO25o, goalsRequired: 3, backtest: "Historical ROI +15%+" });
      if (goldMer) goldDefs.push({ id: "MER_SPLIT", label: "🎯 MER SPLIT (Banker Flow)", market: "Over 2.5", odds: rawO25o, goalsRequired: 3, backtest: "Historical hit rate 79%-100%" });
    }
  }
  const goldTotalGoals = (() => {
    const h = toInt(meta?.homeScore);
    const a = toInt(meta?.awayScore);
    return h != null && a != null ? h + a : null;
  })();
  const goldSignals: GoldSignal[] = goldDefs.map((g) => ({ ...g, hit: goldTotalGoals == null ? null : goldTotalGoals >= g.goalsRequired }));
  const goldMetrics: GoldMetrics = { mmsRadar, klTotal, d45, dCs10 };

  // If the match has finished, compare the read against what actually happened.
  let actual: AnatomyActualCheck | null = null;
  const hSc = toInt(meta?.homeScore);
  const aSc = toInt(meta?.awayScore);
  if (hSc != null && aSc != null) {
    const hHt = toInt(meta?.homeHtScore);
    const aHt = toInt(meta?.awayHtScore);
    const totalGoals = hSc + aSc;
    const htTotalGoals = hHt != null && aHt != null ? hHt + aHt : null;

    let tempoHit: boolean | null = null;
    switch (engineId) {
      case "V23_NUCLEAR":
      case "V8_HOME_ROUT":
        tempoHit = totalGoals >= 4;
        break;
      case "M6_DOUBLE_HALF":
        tempoHit = totalGoals >= 5;
        break;
      case "SAF_V23_DUELLO":
      case "NIHAI_DUELLO":
      case "STD_DUELLO":
        tempoHit = totalGoals >= 3;
        break;
      case "SAF_V23_KILIT":
      case "V3B_DOUBLE_LOCK":
      case "V3_DEAD_HT":
      case "STEAM_TRAP":
      case "NATURAL_STERILE":
        tempoHit = totalGoals < 3;
        break;
      case "SAF_V23_WALL":
      case "V9_AWAY_IDLE":
        tempoHit = totalGoals < 4;
        break;
      case "HT_NUCLEAR":
        tempoHit = htTotalGoals != null ? htTotalGoals >= 1 : null;
        break;
      default:
        tempoHit = null;
    }

    actual = {
      score: `${hSc}:${aSc}`,
      htScore: hHt != null && aHt != null ? `${hHt}:${aHt}` : null,
      totalGoals,
      htTotalGoals,
      tempoHit,
      expDiff: expGoalsFt != null ? r2(totalGoals - expGoalsFt) : null,
    };
  }

  return {
    favSide,
    favOdd: r2(favOdd),
    targetTempo,
    tempoLabel,
    idealBet,
    comboLabel,
    engineId,
    engineSource,
    dnaU25,
    mmsRating: v23Mode ? mmsV23 : mmsNihai,
    mmsV23,
    htRating,
    kilitRating: v23Mode ? kilitV23 : kilitNihai,
    kilitV23,
    wallRating,
    driftTag,
    drifts: { d25: tDeltaO25, d35: tDeltaO35, dBtts: tDeltaBtts, dCs00 },
    expGoalsFt,
    expGoalsHt,
    expGoals2h,
    tempoShift,
    expLowConfidence,
    expCol,
    lambda,
    similarity: twins,
    simDisplayPct,
    twinProof,
    shields,
    gateNotes,
    enrichStatus,
    twinFeatures,
    goldSignals,
    goldMetrics,
    mispricingAnomaly,
    isMajorLeague,
    actual,
  };
}
