import type { CompactOddsRow } from "@/lib/archiveCache";

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

export type AnatomyActualCheck = {
  score: string;
  htScore: string | null;
  totalGoals: number;
  htTotalGoals: number | null;
  tempoHit: boolean | null; // null when the tempo read makes no directional goal-count claim
  expDiff: number | null; // actual total goals - E_FT (calibration; null if E_FT unavailable)
};

export type AnatomyEngineResult = {
  favSide: "HOME" | "AWAY";
  favOdd: number;
  targetTempo: TargetTempo;
  tempoLabel: string;
  idealBet: string;
  comboLabel: string;
  dnaU25: number; // opening Under 2.5 odd - opening Over 2.5 odd
  mmsRating: number;
  htRating: number;
  kilitRating: number; // "Steel Lock" rating
  wallRating: number;
  driftTag: string; // "+3%/-5%" = ΔOver2.5 / ΔOver3.5 since opening
  expGoalsFt: number | null; // E_FT
  expGoalsHt: number | null; // E_HT
  expGoals2h: number | null; // E_2H = E_FT - E_HT
  tempoShift: number | null; // E_2H - E_HT
  expLowConfidence: boolean; // fewer than 3 books quoting FT OU, or E_FT unsolved
  expCol: string; // "2.45 / 1.10*" display string, matching the Python report column
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

export function computeAnatomyEngine(
  odds: CompactOddsRow[] | null | undefined,
  meta: AnatomyFixtureMeta | null | undefined,
): AnatomyEngineResult | null {
  if (!odds?.length) return null;
  if (isYouthOrReserve(meta?.homeName, meta?.awayName, meta?.league)) return null;

  const ft = { H: newPool(), D: newPool(), A: newPool() };
  const ou25 = { over: newPool(), under: newPool() };
  const ou35 = { over: newPool(), under: newPool() };
  const ouHt15 = { over: newPool(), under: newPool() };
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
      if (isFullTime && lineStr === "2.5") {
        if (isOver) pushPool(ou25.over, op, cur, bookId);
        else if (isUnder) pushPool(ou25.under, op, cur, bookId);
      } else if (isFullTime && lineStr === "3.5") {
        if (isOver) pushPool(ou35.over, op, cur, bookId);
        else if (isUnder) pushPool(ou35.under, op, cur, bookId);
      } else if (isFirstHalf && lineStr === "1.5") {
        if (isOver) pushPool(ouHt15.over, op, cur, bookId);
        else if (isUnder) pushPool(ouHt15.under, op, cur, bookId);
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

  const rawU25o = openMedian(ou25.under);
  const rawO25o = openMedian(ou25.over);
  const rawU35o = openMedian(ou35.under);
  const rawO35o = openMedian(ou35.over);
  const rawU15htO = openMedian(ouHt15.under);
  const rawO15htO = openMedian(ouHt15.over);

  // Need at least one FT OU market to read anything meaningful (mirrors the
  // Python script's `if not open_data: return None`, narrowed to what this
  // engine actually needs).
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
  let isMispricingAnomaly = false;
  if (expGoalsFt != null && expGoalsHt != null) {
    const calc2h = Math.round((expGoalsFt - expGoalsHt) * 100) / 100;
    if (calc2h < 0 && !expLowConfidence) {
      isMispricingAnomaly = true;
      expGoals2h = 0;
    } else {
      expGoals2h = Math.max(0, calc2h);
    }
    tempoShift = Math.round((expGoals2h - expGoalsHt) * 100) / 100;
  }

  const confMark = expLowConfidence ? "*" : "";
  const ftStr = expGoalsFt != null ? expGoalsFt.toFixed(2) : "-";
  const h2Str = expGoals2h != null ? expGoals2h.toFixed(2) : "-";
  const expCol = `${ftStr} / ${h2Str}${confMark}`;

  // ---- Fallback-filled working values (Python defaults when a market is missing) ----
  const tU25o = rawU25o ?? 1.8;
  const tO25o = rawO25o ?? 1.95;
  const tO25c = curMedian(ou25.over) ?? tO25o;
  const tDeltaO25 = tO25o ? (tO25c - tO25o) / tO25o : 0;

  const tU35o = rawU35o ?? 1.3;
  const tO35o = rawO35o ?? 3.0;
  const tO35c = curMedian(ou35.over) ?? tO35o;
  const tDeltaO35 = tO35o ? (tO35c - tO35o) / tO35o : 0;

  const tU15htO = rawU15htO ?? 1.4;
  const tO15htO = rawO15htO ?? 2.8;

  const tBttsYo = openMedian(btts.yes) ?? 1.8;
  const tBttsNo = openMedian(btts.no) ?? 1.9;
  const tBttsYc = curMedian(btts.yes) ?? tBttsYo;
  const tDeltaBtts = tBttsYo ? (tBttsYc - tBttsYo) / tBttsYo : 0;

  const tHo = openMedian(ft.H) ?? 2.5;
  const tDo = openMedian(ft.D) ?? 3.2;
  const tAo = openMedian(ft.A) ?? 2.6;

  const favSide: "HOME" | "AWAY" = tHo <= tAo ? "HOME" : "AWAY";
  const favOdd = Math.min(tHo, tAo);
  const dnaU25 = Math.round((tU25o - tO25o) * 100) / 100;
  const dnaHt15 = Math.round((tU15htO - tO15htO) * 100) / 100;
  const bttsSpread = Math.round((tBttsYo - tBttsNo) * 100) / 100;

  const cs00o = openMedian(csFt.get("0:0") ?? newPool()) ?? 12.0;
  const cs11o = openMedian(csFt.get("1:1") ?? newPool()) ?? 6.5;
  const csHt00o = openMedian(csHt.get("0:0") ?? newPool()) ?? 2.7;

  // 1. STEEL LOCK RATING
  const probU25 = 1 / tU25o / (1 / tU25o + 1 / tO25o);
  const probHtu15 = 1 / tU15htO / (1 / tU15htO + 1 / tO15htO);
  const dBonus = tDo <= 3.1 ? 20.0 : tDo <= 3.3 ? 10.0 : 0.0;
  const htLockBonus = csHt00o <= 2.35 ? 15.0 : 0.0;
  const kilitRating = Math.round((probU25 * 45.0 + probHtu15 * 25.0 + dBonus + htLockBonus) * 10) / 10;

  // 2. MMS (TEMPO) RATING
  const probO25 = 1 / tO25o / (1 / tO25o + 1 / tU25o);
  const probBtts = 1 / tBttsYo / (1 / tBttsYo + 1 / tBttsNo);
  const rTempo = probO25 * 60.0 + probBtts * 40.0;
  const rDrift = -tDeltaO25 * 50.0 + -tDeltaBtts * 40.0;
  let rCeza = 0.0;
  if (cs00o <= 8.5) rCeza += 10.0;
  if (cs11o <= 5.8) rCeza += 8.0;
  if (csHt00o <= 2.35) rCeza += 15.0;
  if (dnaU25 <= -0.35 && (tDeltaO25 <= -0.04 || tDeltaBtts <= -0.04) && kilitRating >= 65.0) rCeza += 25.0;
  const mmsRating = Math.round((rTempo + rDrift - rCeza) * 10) / 10;

  // 3. HT GOAL RATING
  const probHt15 = 1 / tO15htO / (1 / tO15htO + 1 / tU15htO);
  const htRating = Math.round((probHt15 * 60.0 + probO25 * 40.0) * 10) / 10;

  // 4. ONE-SIDED WALL RATING
  const probBttsNo = 1 / tBttsNo / (1 / tBttsNo + 1 / tBttsYo);
  const favBonus = favOdd <= 1.25 ? 40.0 : favOdd <= 1.45 ? 30.0 : favOdd <= 1.65 ? 20.0 : 10.0;
  const wallRating = Math.round((probBttsNo * 60.0 + favBonus) * 10) / 10;

  // 5. CS 2:1 / 1:2 duel-trap detection
  const cs21o = openMedian(csFt.get("2:1") ?? newPool());
  const cs21c = curMedian(csFt.get("2:1") ?? newPool()) ?? cs21o;
  const dCs21 = cs21o && cs21o > 1.0 && cs21c != null ? (cs21c - cs21o) / cs21o : 0;

  const cs12o = openMedian(csFt.get("1:2") ?? newPool());
  const cs12c = curMedian(csFt.get("1:2") ?? newPool()) ?? cs12o;
  const dCs12 = cs12o && cs12o > 1.0 && cs12c != null ? (cs12c - cs12o) / cs12o : 0;

  const csTrap21 = dCs21 <= -0.04 || dCs12 <= -0.04 || (cs21o != null && cs21o <= 10.0);
  const isHtLockRisk = csHt00o <= 2.45;

  // ---- Traps ----
  const isFlipTrap = dnaU25 <= -0.35 && (tDeltaO25 <= -0.04 || tDeltaBtts <= -0.04) && kilitRating >= 65.0;
  // "Fake drop" / public steam: no DNA support, yet Over/BTTS shortened late.
  const isPublicSteamTrap = (tDeltaO25 <= -0.05 || tDeltaBtts <= -0.05) && dnaU25 < 0.2 && mmsRating < 65.0;

  const isSikletKatliami = dnaU25 >= 3.3;
  const isValidHighVolume = mmsRating >= 70.0 && dnaU25 > -0.3;

  const isTrueMonster =
    isValidHighVolume && htRating >= 58.0 && (tO35o <= 2.65 || dnaU25 >= 1.5) && !csTrap21 && !isHtLockRisk;

  const isDuello21 = isValidHighVolume && (csTrap21 || isHtLockRisk || tO35o > 2.65 || htRating < 58.0);

  const isExtremePotential = dnaU25 >= 1.5 || tO35o <= 1.85 || dnaHt15 >= 0.0;
  const isSafeNuclear = isExtremePotential && bttsSpread < 0.4 && dnaU25 > -0.3 && mmsRating >= 70.0;

  const fmtPct = (x: number): string => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(0)}%`;
  const driftTag = `${fmtPct(tDeltaO25)}/${fmtPct(tDeltaO35)}`;

  // ---- Tempo hierarchy (mirrors the Python if/elif chain exactly) ----
  let targetTempo: TargetTempo;
  let tempoLabel: string;
  let idealBet: string;
  let comboLabel: string;

  if (isMispricingAnomaly) {
    targetTempo = "DECEPTIVE_TEMPO";
    tempoLabel = "⚠️ Internal inconsistency (E_2H < 0)";
    idealBet = "Under 2.5 / stay away";
    comboLabel = "⚠️ OU mispricing (negative 2nd-half expectation)";
  } else if (isPublicSteamTrap) {
    targetTempo = "DECEPTIVE_TEMPO";
    tempoLabel = `⚠️ Fake drop (MMS: ${mmsRating.toFixed(0)})`;
    idealBet = "Under 2.5 / BTTS No";
    comboLabel = "⚠️ Public trap (fake steam)";
  } else if (isFlipTrap || (mmsRating < 40.0 && kilitRating >= 65.0)) {
    targetTempo = "DECEPTIVE_TEMPO";
    tempoLabel = `⚠️ Fake flow (MMS: ${mmsRating.toFixed(0)})`;
    idealBet = "Under 2.5 / stay away";
    comboLabel = "❌ Fake-over trap (dry open)";
  } else if (isSikletKatliami) {
    targetTempo = "EXPLOSIVE_GOALS_STRONG";
    tempoLabel = `🚀 Weight-class rout (MMS: ${mmsRating.toFixed(0)})`;
    if (favOdd <= 1.2 && wallRating >= 60.0) {
      idealBet = "Over 2.5 / Fav -1.5 handicap";
      comboLabel = "🚀 Weight pressure (3-0 / cruise mode)";
    } else {
      idealBet = "Over 4.5 / Fav -2.5 handicap";
      comboLabel = "🚀 Weight-class rout (target: Over 4.5 / handicap)";
    }
  } else if (isTrueMonster) {
    targetTempo = "EXPLOSIVE_GOALS_STRONG";
    tempoLabel = `💎 Elite monster (MMS: ${mmsRating.toFixed(0)})`;
    if (!expLowConfidence && tempoShift != null && tempoShift > 0.45) {
      idealBet = "Over 3.5 / HT Over 1.5 (late surge)";
      comboLabel = "💎 Elite monster (rising 2nd-half tempo)";
    } else {
      idealBet = "Over 3.5 / HT Over 1.5";
      comboLabel = "💎 Elite monster (4+ goals / clean flow)";
    }
  } else if (isSafeNuclear) {
    targetTempo = "EXPLOSIVE_GOALS_STRONG";
    tempoLabel = `🔥 Pure nuclear (MMS: ${mmsRating.toFixed(0)})`;
    idealBet = "Over 3.5 / Over 4.5";
    comboLabel = "🔥 Pure nuclear (5+ goal potential)";
  } else if (isDuello21) {
    targetTempo = "EXPLOSIVE_GOALS_STRONG";
    tempoLabel = `💎 Elite duel (MMS: ${mmsRating.toFixed(0)})`;
    idealBet = "Over 2.5 / BTTS Yes";
    comboLabel = "💎 Elite duel (2-1 / 1-2 corridor)";
  } else if (wallRating >= 72.0 && dnaU25 < 1.8 && dnaU25 > -0.3) {
    targetTempo = "ASYMMETRIC_WALL";
    tempoLabel = `🛡️ Wall & handicap (Wall: ${wallRating.toFixed(0)})`;
    idealBet = "BTTS No / Fav -1.5 handicap";
    comboLabel = "🛡️ One-sided wall (~62% handicap / ~64% BTTS No)";
  } else if (htRating >= 50.0 && dnaU25 > -0.3) {
    targetTempo = "HT_EXPLOSION";
    tempoLabel = `⚡ HT nuclear (HT: ${htRating.toFixed(0)})`;
    idealBet = "HT Over 0.5 / HT Over 1.5";
    comboLabel = "⚡ First-half goal (~79% HT O0.5 / ~45% HT O1.5)";
  } else if ((kilitRating >= 65.0 || dnaU25 <= -0.8) && favOdd > 1.5 && expGoalsFt != null && expGoalsFt <= 2.25) {
    targetTempo = "LOW_PACE";
    tempoLabel = `🔒 Steel lock (Lock: ${kilitRating.toFixed(0)})`;
    idealBet = "Under 2.5 / HT Under 0.5";
    comboLabel = "🔒 Steel lock (E_FT <= 2.25)";
  } else if ((dnaU25 >= 0.7 || (tO35o <= 2.2 && mmsRating >= 55.0)) && dnaU25 > -0.3) {
    targetTempo = "EXPLOSIVE_GOALS_WEAK";
    tempoLabel = `🧨 Natural over-explosion (MMS: ${mmsRating.toFixed(0)})`;
    idealBet = "Over 2.5 / Over 3.5";
    comboLabel = "⭐⭐ Above-threshold goals (66%+ over)";
  } else if (tO25o <= 1.7 && tBttsYo <= 1.7 && dnaU25 > -0.3) {
    targetTempo = "HIGH_PACE";
    tempoLabel = `High tempo (MMS: ${mmsRating.toFixed(0)})`;
    idealBet = "BTTS Yes / Over 2.5";
    comboLabel = "⭐ Duel band";
  } else {
    targetTempo = "BALANCED";
    tempoLabel = `Balanced (MMS: ${mmsRating.toFixed(0)})`;
    idealBet = "Wait for live / no direction";
    comboLabel = "-";
  }

  const isMajorLeague = isTargetMajor(meta?.leagueCountry, meta?.league);

  // If the match has finished, compare the read against what actually happened.
  let actual: AnatomyActualCheck | null = null;
  const hSc = toInt(meta?.homeScore);
  const aSc = toInt(meta?.awayScore);
  if (hSc != null && aSc != null) {
    const hHt = toInt(meta?.homeHtScore);
    const aHt = toInt(meta?.awayHtScore);
    const totalGoals = hSc + aSc;
    const htTotalGoals = hHt != null && aHt != null ? hHt + aHt : null;
    const btts_ = hSc > 0 && aSc > 0;

    let tempoHit: boolean | null = null;
    if (
      targetTempo === "EXPLOSIVE_GOALS_STRONG" ||
      targetTempo === "EXPLOSIVE_GOALS_WEAK" ||
      targetTempo === "HT_EXPLOSION" ||
      targetTempo === "HIGH_PACE"
    ) {
      tempoHit = totalGoals >= 3;
    } else if (targetTempo === "LOW_PACE" || targetTempo === "DECEPTIVE_TEMPO") {
      tempoHit = totalGoals < 3;
    } else if (targetTempo === "ASYMMETRIC_WALL") {
      tempoHit = !btts_;
    }

    actual = {
      score: `${hSc}:${aSc}`,
      htScore: hHt != null && aHt != null ? `${hHt}:${aHt}` : null,
      totalGoals,
      htTotalGoals,
      tempoHit,
      expDiff: expGoalsFt != null ? Math.round((totalGoals - expGoalsFt) * 100) / 100 : null,
    };
  }

  return {
    favSide,
    favOdd: Math.round(favOdd * 100) / 100,
    targetTempo,
    tempoLabel,
    idealBet,
    comboLabel,
    dnaU25,
    mmsRating,
    htRating,
    kilitRating,
    wallRating,
    driftTag,
    expGoalsFt,
    expGoalsHt,
    expGoals2h,
    tempoShift,
    expLowConfidence,
    expCol,
    isMajorLeague,
    actual,
  };
}
