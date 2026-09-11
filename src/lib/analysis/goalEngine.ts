import type { CompactOddsRow } from "@/lib/archiveCache";

export type ScoreProfile =
  | "EXTREME_BLOWOUT"
  | "DOMINANT_WIN"
  | "CONTESTED_FAVORITE"
  | "OPEN_EXCHANGE"
  | "BALANCED"
  | "HARD_UNDER"
  | "LOCKED_CORRIDOR"
  | "LOW_BASELINE_TRAP"
  | "BASELINE_FAV_BREAK"
  | "PHANTOM_BLOWOUT"
  | "SOLO_HOME_BLOWOUT"
  | "REVERSE_TAKEOVER"
  | "HIDDEN_FIRE_LEAK"
  | "SUPER_FAV_TRAP"
  | "AWAY_CONTROL_LOCK"
  | "AWAY_SURGE_TRAP"
  | "COLLECTIVE_SURGE";

export type GoalEngineMetrics = {
  // 1. Dominance & Power Distribution
  dominanceSide: "HOME" | "AWAY" | "NONE";
  isHeavyFavorite: boolean;
  isExtremeDominance: boolean;
  favoriteOdds: number | null;

  // 2. First Half Velocity (HT Velocity)
  htVelocity: "HARD_LOCK" | "BALANCED" | "HIGH_VELOCITY";
  htVelocityLabel: string;
  htZeroZeroOdd: number | null;
  htZeroZeroDrift: number;

  // 3. Line Probabilities
  pOver15: number | null;
  pOver25: number;
  pOver35: number | null;
  pOver45: number | null;

  // 4. Market Anomalies & Liquidity Signals
  isUnderLeaking: boolean;
  isFalseOpen: boolean;
  handicapSmashCount: number;
  anomalies: string[];

  // 4b. Money-flow / liquidity direction (new)
  moneyFlow1X2: string;
  ouFlow: string;
  hasFavHandicapSmash: boolean;
  hasDogHandicapSupport: boolean;

  // 5. Decision Parameters & Clear Verdicts
  fairGoalLine: number;
  bttsExpectancy: boolean;
  scoreProfile: ScoreProfile;

  htVerdict: string;
  ftVerdict: string;
  /** Whether a single-team goal-line bet is safe to back on top of the total-goals read. */
  teamGoalVerdict: string;

  // 6. Score Engine Multiplier Function
  getScoreMultiplier: (homeGoals: number, awayGoals: number) => number;
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

function impliedTwo(o: number, u: number): [number, number] {
  const io = 1 / o;
  const iu = 1 / u;
  return [io / (io + iu), iu / (io + iu)];
}

/** Parses "score:1:0" / "1:0" / "1-0" style correct-score selection tokens into a canonical "H:A" key. */
function parseScoreToken(sideTok: string): { key: string; h: number; a: number } | null {
  const stripped = sideTok.toLowerCase().startsWith("score:") ? sideTok.slice(6) : sideTok;
  const parts = stripped.replace("-", ":").split(":");
  if (parts.length !== 2) return null;
  const h = Number(parts[0]);
  const a = Number(parts[1]);
  if (!Number.isInteger(h) || !Number.isInteger(a) || h < 0 || a < 0) return null;
  return { key: `${h}:${a}`, h, a };
}

const STATIC_DRIFT_MAX = 0.025; // movement under 2.5% is considered a static market

function driftRatio(current: number[], opening: number[]): number | null {
  if (!current.length || !opening.length) return null;
  const c = median(current);
  const o = median(opening);
  if (o <= 0) return null;
  return Math.abs(c - o) / o;
}

function isLineStatic(over: number[], overOp: number[], under: number[], underOp: number[]): boolean {
  const dOver = driftRatio(over, overOp);
  const dUnder = driftRatio(under, underOp);
  if (dOver == null || dUnder == null) return false;
  return dOver <= STATIC_DRIFT_MAX && dUnder <= STATIC_DRIFT_MAX;
}

/** open/cur price pool for a single market selection. */
type PricePool = { open: number[]; cur: number[] };
function newPool(): PricePool {
  return { open: [], cur: [] };
}
function pushPool(p: PricePool, op: number | null, cur: number | null) {
  if (op != null) p.open.push(op);
  if (cur != null) p.cur.push(cur);
}
/** Effective (display) price: current if we have it, else opening. */
function effOf(p: PricePool): number | null {
  if (p.cur.length) return median(p.cur);
  if (p.open.length) return median(p.open);
  return null;
}
/** current/opening ratio; 1.0 (neutral) when we can't compute one. */
function driftOf(p: PricePool): number {
  if (p.open.length && p.cur.length) {
    const mo = median(p.open);
    const mc = median(p.cur);
    if (mo > 0) return mc / mo;
  }
  return 1.0;
}

const OU_LINES = ["1.5", "2.5", "3.5", "4.5"] as const;
type OuLine = (typeof OU_LINES)[number];

const LOW_SCORES = new Set(["0:0", "1:0", "0:1", "1:1", "0:2", "2:0"]);

export function computeGoalEngine(odds: CompactOddsRow[] | null | undefined): GoalEngineMetrics | null {
  if (!odds?.length) return null;

  const ms: Record<"H" | "D" | "A", PricePool> = { H: newPool(), D: newPool(), A: newPool() };
  const dnb: Record<"H" | "A", PricePool> = { H: newPool(), A: newPool() };

  const htCorrectScore = new Map<string, PricePool>(); // CORRECT_SCORE [FIRST_HALF]
  const ftCorrectScore = new Map<string, PricePool>(); // CORRECT_SCORE [FULL_TIME]
  const htOu05 = newPool(); // OVER_UNDER [FIRST_HALF] OVER:0.5

  const ou: Record<OuLine, { over: PricePool; under: PricePool }> = {
    "1.5": { over: newPool(), under: newPool() },
    "2.5": { over: newPool(), under: newPool() },
    "3.5": { over: newPool(), under: newPool() },
    "4.5": { over: newPool(), under: newPool() },
  };

  const btts: Record<"YES" | "NO", PricePool> = { YES: newPool(), NO: newPool() };

  // Asian Handicap FULL_TIME, keyed by raw side token e.g. "H:-1.0" / "A:0.75"
  const ah = new Map<string, PricePool>();

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

    const isFullTime = scp === "FULL_TIME" || !scp.includes("HALF");
    const isFirstHalf = scp === "FIRST_HALF" || scp.includes("1ST") || scp.includes("HT1");

    // Market types are a fixed, exact set (see fixtureMarkets.ts / labels.ts), so we match
    // on equality rather than substring — CORRECT_SCORE vs BOTH_TEAMS_TO_SCORE both contain
    // "SCORE" and would otherwise collide now that each branch `continue`s.
    switch (type) {
      case "HOME_DRAW_AWAY": {
        if (!isFullTime) continue;
        if (side === "H") pushPool(ms.H, op, cur);
        else if (side === "D" || side === "X") pushPool(ms.D, op, cur);
        else if (side === "A") pushPool(ms.A, op, cur);
        continue;
      }
      case "DRAW_NO_BET": {
        if (!isFullTime) continue;
        if (side === "H") pushPool(dnb.H, op, cur);
        else if (side === "A") pushPool(dnb.A, op, cur);
        continue;
      }
      case "CORRECT_SCORE": {
        const parsed = parseScoreToken(String(sideTok));
        if (!parsed) continue;
        if (isFirstHalf) {
          if (!htCorrectScore.has(parsed.key)) htCorrectScore.set(parsed.key, newPool());
          pushPool(htCorrectScore.get(parsed.key)!, op, cur);
        } else if (isFullTime) {
          if (!ftCorrectScore.has(parsed.key)) ftCorrectScore.set(parsed.key, newPool());
          pushPool(ftCorrectScore.get(parsed.key)!, op, cur);
        }
        continue;
      }
      case "OVER_UNDER": {
        const isOver = side.startsWith("OVER") || side === "O";
        const isUnder = side.startsWith("UNDER") || side === "U";
        const lineStr = side.includes(":") ? side.split(":")[1] : null;

        if (isFirstHalf && isOver && lineStr === "0.5") {
          pushPool(htOu05, op, cur);
        } else if (isFullTime && lineStr) {
          const line = lineStr as OuLine;
          if ((OU_LINES as readonly string[]).includes(line)) {
            if (isOver) pushPool(ou[line].over, op, cur);
            else if (isUnder) pushPool(ou[line].under, op, cur);
          }
        }
        continue;
      }
      case "BOTH_TEAMS_TO_SCORE": {
        if (!isFullTime) continue;
        if (side.includes("YES")) pushPool(btts.YES, op, cur);
        else if (side.includes("NO")) pushPool(btts.NO, op, cur);
        continue;
      }
      case "ASIAN_HANDICAP": {
        if (!isFullTime) continue;
        if (!ah.has(side)) ah.set(side, newPool());
        pushPool(ah.get(side)!, op, cur);
        continue;
      }
      default:
        continue;
    }
  }

  // ---------------------------------------------------------------------
  // 1. Dominance / Asymmetry Analysis
  // ---------------------------------------------------------------------
  const medH = effOf(ms.H);
  const medA = effOf(ms.A);
  const medDnbH = effOf(dnb.H);
  const medDnbA = effOf(dnb.A);

  let dominanceSide: GoalEngineMetrics["dominanceSide"] = "NONE";
  let favoriteOdds: number | null = null;
  let isHeavyFavorite = false;
  let isExtremeDominance = false;

  const minDnb = Math.min(medDnbH ?? 99, medDnbA ?? 99);
  const minMs = Math.min(medH ?? 99, medA ?? 99);

  if (medH && (!medA || medH < medA)) {
    dominanceSide = "HOME";
    favoriteOdds = medH;
  } else if (medA && (!medH || medA < medH)) {
    dominanceSide = "AWAY";
    favoriteOdds = medA;
  }

  if (minDnb <= 1.30 || minMs <= 1.65) isHeavyFavorite = true;
  if (minMs <= 1.20 || minDnb <= 1.08) isExtremeDominance = true;
  if (!isHeavyFavorite) dominanceSide = "NONE";

  // Raw favourite (independent of the heavy-favourite gate above) — this is what the
  // new pattern hierarchy keys off, matching the reference model.
  const rawFavSide: "H" | "A" | null = medH != null && (medA == null || medH < medA) ? "H" : medA != null ? "A" : null;
  const rawDogSide: "H" | "A" | null = rawFavSide === "H" ? "A" : rawFavSide === "A" ? "H" : null;
  const rawFavOdds = rawFavSide === "H" ? medH : rawFavSide === "A" ? medA : null;

  // ---------------------------------------------------------------------
  // 2. First Half Velocity (HT Velocity)
  // ---------------------------------------------------------------------
  const medHt00 = effOf(htCorrectScore.get("0:0") ?? newPool());
  const ht00Drift = driftOf(htCorrectScore.get("0:0") ?? newPool());
  const medHtOu05 = effOf(htOu05);

  let htVelocity: GoalEngineMetrics["htVelocity"] = "BALANCED";
  let htVelocityLabel = "Balanced First Half";

  if (medHt00 != null) {
    if (medHt00 <= 2.35 && !isHeavyFavorite) {
      htVelocity = "HARD_LOCK";
      htVelocityLabel = "Hard Lock (0:0 Expected)";
    } else if (medHt00 >= 3.00 || (medHt00 >= 2.70 && isHeavyFavorite)) {
      htVelocity = "HIGH_VELOCITY";
      htVelocityLabel = "High Velocity (Early Goal Rush)";
    }
  }

  // ---------------------------------------------------------------------
  // 3. Line Probabilities
  // ---------------------------------------------------------------------
  const calcP = (line: OuLine): number | null => {
    const o = ou[line].over;
    const u = ou[line].under;
    if (o.cur.length || o.open.length) {
      const oEff = effOf(o);
      const uEff = effOf(u);
      if (oEff != null && uEff != null) return impliedTwo(oEff, uEff)[0];
    }
    return null;
  };

  const pOver15 = calcP("1.5");
  const pOver25 = calcP("2.5") ?? 0.5;
  const pOver35 = calcP("3.5");
  const pOver45 = calcP("4.5");

  // ---------------------------------------------------------------------
  // 4. Anomalies & Liquidity Signals
  // ---------------------------------------------------------------------
  const anomalies: string[] = [];

  // 4a. Under Leakage (2.5 line)
  const ou25UnderDrift = driftOf(ou["2.5"].under);
  const ou25OverDrift = driftOf(ou["2.5"].over);
  let isUnderLeaking = false;
  if (ou["2.5"].under.open.length && ou["2.5"].under.cur.length && ou25UnderDrift >= 1.04) {
    isUnderLeaking = true;
    const uOp = median(ou["2.5"].under.open);
    const uCur = median(ou["2.5"].under.cur);
    anomalies.push(
      `UNDER LEAKAGE: 2.5 Under odds rose from @${uOp.toFixed(2)} to @${uCur.toFixed(2)}. Money is flowing to the Over line!`
    );
  }

  // 4b. 1X2 money-flow direction
  const msHDrift = driftOf(ms.H);
  const msDDrift = driftOf(ms.D);
  const msADrift = driftOf(ms.A);
  let moneyFlow1X2 = "BALANCED";
  if (msHDrift <= 0.94) moneyFlow1X2 = `HOME MONEY FLOW (x${msHDrift.toFixed(2)}) ⬇️`;
  else if (msADrift <= 0.94) moneyFlow1X2 = `AWAY MONEY FLOW (x${msADrift.toFixed(2)}) ⬇️`;
  else if (msDDrift <= 0.94) moneyFlow1X2 = `DRAW MONEY FLOW (x${msDDrift.toFixed(2)}) ⬇️`;

  // 4c. Over/Under 2.5 liquidity direction
  let ouFlow = "STABLE";
  if (ou25UnderDrift >= 1.05 && ou25OverDrift <= 0.96) {
    ouFlow = "AGGRESSIVE OVER FLOW (Under being abandoned) ⬆️";
  } else if (ou25UnderDrift <= 0.95 && ou25OverDrift >= 1.05) {
    ouFlow = "AGGRESSIVE UNDER FLOW (market locking) ⬇️";
  }

  // 4d. Asian Handicap smash (favourite side) / support (underdog side)
  let handicapSmashCount = 0;
  let hasFavHandicapSmash = false;
  let hasDogHandicapSupport = false;
  const FAV_MINUS_LINES = ["-0.75", "-1.0", "-1.25", "-1.5"];
  const DOG_PLUS_LINES = ["0.5", "0.75", "1.0", "1.25"];

  for (const [key, pool] of ah.entries()) {
    if (!pool.open.length || !pool.cur.length) continue;
    const op = median(pool.open);
    const cur = median(pool.cur);
    const drift = cur / op;

    // Global smash counter (either side, kept for backward compatibility with prior behaviour)
    if (FAV_MINUS_LINES.some((l) => key.includes(l)) && drift <= 0.86) {
      handicapSmashCount++;
    }

    if (rawFavSide && key.startsWith(`${rawFavSide}:`) && FAV_MINUS_LINES.some((l) => key.endsWith(l)) && drift <= 0.86) {
      hasFavHandicapSmash = true;
      anomalies.push(`🚀 HANDICAP SMASH: ${key} collapsed (@${op.toFixed(2)} -> @${cur.toFixed(2)})!`);
    }
    if (rawDogSide && key.startsWith(`${rawDogSide}:`) && DOG_PLUS_LINES.some((l) => key.endsWith(l)) && drift <= 0.94) {
      hasDogHandicapSupport = true;
      anomalies.push(`🛡️ DOG HANDICAP SUPPORT: ${key} is being backed (@${op.toFixed(2)} -> @${cur.toFixed(2)})!`);
    }
  }

  const static15 = isLineStatic(ou["1.5"].over.cur, ou["1.5"].over.open, ou["1.5"].under.cur, ou["1.5"].under.open);
  const static25 = isLineStatic(ou["2.5"].over.cur, ou["2.5"].over.open, ou["2.5"].under.cur, ou["2.5"].under.open);

  const medBttsYes = effOf(btts.YES) ?? 2.0;
  const bttsExpectancy = medBttsYes <= 1.68;

  const wouldBeOpenExchange = pOver25 >= 0.525 && medBttsYes <= 1.65;
  const isFalseOpen = static15 && static25 && !isUnderLeaking && handicapSmashCount === 0 && wouldBeOpenExchange;
  if (isFalseOpen) {
    anomalies.push("DEAD/STATIC MARKET: Zero movement despite Open-Exchange-level Over/BTTS pricing. Locked corridor risk is at its peak!");
  }

  // 4e. Correct-score collapses (for Phantom Blowout / Hidden Fire / Collective Surge thresholds)
  let sc01: number | null = null; // "0:1" (away wins 1-0)
  let sc10: number | null = null; // "1:0" (home wins 1-0)
  const highScoreDrops = new Set<string>(); // collapsed scores outside the low-score set, e.g. "3:3", "4:2"
  for (const [key, pool] of ftCorrectScore.entries()) {
    if (key === "0:1") sc01 = effOf(pool);
    if (key === "1:0") sc10 = effOf(pool);
    if (!pool.open.length || !pool.cur.length) continue;
    const op = median(pool.open);
    const cur = median(pool.cur);
    if (op > 0 && cur / op <= 0.88 && !LOW_SCORES.has(key)) {
      highScoreDrops.add(key);
    }
  }
  const highScoreDropCount = highScoreDrops.size;
  const EXTREME_SCORES = ["3:3", "4:3", "4:2", "5:2"];
  const hasExtremeScoreDrop = EXTREME_SCORES.some((s) => highScoreDrops.has(s));

  // ---------------------------------------------------------------------
  // 5. New Pattern Hierarchy (ported from the latest anomaly-detection model)
  //    Checked in priority order; the first match wins.
  // ---------------------------------------------------------------------
  const p25 = pOver25;
  const AGGRESSIVE_OVER_FLOW = "AGGRESSIVE OVER FLOW (Under being abandoned) ⬆️";

  // A. Reverse Market Takeover — HIGHEST PRIORITY. Widened range (1.55–2.45).
  const isReverseTakeover =
    rawFavSide === "H" &&
    rawFavOdds != null &&
    rawFavOdds >= 1.55 &&
    rawFavOdds <= 2.45 &&
    hasDogHandicapSupport &&
    (msADrift <= 0.90 || moneyFlow1X2.startsWith("AWAY")) &&
    ouFlow !== AGGRESSIVE_OVER_FLOW;

  // B. Hidden Fire Infiltration — only considered when Reverse Takeover hasn't fired.
  const isHiddenFireLeak =
    !isReverseTakeover && hasExtremeScoreDrop && !hasDogHandicapSupport && moneyFlow1X2 === "BALANCED";

  // C. Low Baseline Trap / Baseline Fav Break
  let isLowBaselineTrap = false;
  let isBaselineFavBreak = false;
  if (p25 < 0.48 && medHtOu05 != null && medHtOu05 >= 1.38 && !isHiddenFireLeak && !isReverseTakeover) {
    if (
      (rawFavSide === "H" && msHDrift <= 0.85 && hasFavHandicapSmash) ||
      (rawFavSide === "A" && msADrift <= 0.85 && hasFavHandicapSmash)
    ) {
      isBaselineFavBreak = true;
    } else {
      isLowBaselineTrap = true;
    }
  }

  // D. Phantom Blowout Trap
  const isPhantomBlowout =
    rawFavSide === "A" &&
    rawFavOdds != null &&
    rawFavOdds >= 1.35 &&
    rawFavOdds <= 1.65 &&
    hasFavHandicapSmash &&
    ouFlow === "STABLE" &&
    !isUnderLeaking &&
    highScoreDropCount >= 4;

  // E. Solo Home Blowout
  const isSoloHomeBlowout =
    rawFavSide === "H" &&
    rawFavOdds != null &&
    rawFavOdds <= 1.35 &&
    !hasDogHandicapSupport &&
    isUnderLeaking &&
    ouFlow === AGGRESSIVE_OVER_FLOW;

  // F. Super Favourite Resistance
  const isSuperFavTrap = rawFavOdds != null && rawFavOdds <= 1.30 && hasDogHandicapSupport;

  // G. Away Control Lock
  const isAwayControlLock =
    rawFavSide === "A" &&
    rawFavOdds != null &&
    rawFavOdds >= 1.55 &&
    rawFavOdds <= 1.95 &&
    !isLowBaselineTrap &&
    !isPhantomBlowout &&
    hasFavHandicapSmash &&
    sc01 != null &&
    sc01 <= 8.0 &&
    sc10 != null &&
    sc10 >= 12.0 &&
    ouFlow !== AGGRESSIVE_OVER_FLOW;

  // H. Collective Surge / Away Surge Trap
  let isCollectiveSurge = false;
  let isAwaySurgeTrap = false;
  if (
    !isAwayControlLock &&
    !isPhantomBlowout &&
    !isReverseTakeover &&
    isUnderLeaking &&
    medHt00 != null &&
    medHt00 >= 3.1 &&
    medBttsYes <= 1.65 &&
    p25 >= 0.5 &&
    (ouFlow === AGGRESSIVE_OVER_FLOW || highScoreDropCount >= 3)
  ) {
    if (rawFavSide === "A" && medHtOu05 != null && medHtOu05 >= 1.30) {
      isAwaySurgeTrap = true;
    } else {
      isCollectiveSurge = true;
    }
  }

  if (isReverseTakeover) {
    anomalies.push(
      "🎯 PATTERN: REVERSE MARKET TAKEOVER: The paper favourite is being dumped — sharp money has piled onto the underdog's points and handicap (0-1 / 1-1 / 0-2 corridor)."
    );
  }
  if (isHiddenFireLeak) {
    anomalies.push(
      "💣 PATTERN: HIDDEN FIRE INFILTRATION: 1X2 looks balanced, but money has quietly backed extreme scorelines like 3-3 / 4-3! The barren-lock read is void — surge/upset risk."
    );
  }
  if (isBaselineFavBreak) {
    anomalies.push(
      "🎯 PATTERN: BASELINE FAV BREAK: The goal baseline opened thin, but heavy institutional money has hit the favourite (drift below x0.85). First half locked, 2-0 / 2-1 favourite corridor expected."
    );
  }
  if (isLowBaselineTrap) {
    anomalies.push("⚠️ LOW BASELINE TRAP: Goal baseline is thin (Over 2.5 under 48%) and HT tempo is slow. High risk of a barren lock.");
  }
  if (isPhantomBlowout) {
    anomalies.push(
      "⚠️ PATTERN: PHANTOM BLOWOUT TRAP: Extreme-margin scorelines are being backed but the Over/Under line hasn't moved at all! Templated favourite balloon — 1-1 / 1-2 upset-corridor risk."
    );
  }
  if (isSoloHomeBlowout) {
    anomalies.push(
      "🎯 PATTERN: SOLO HOME BLOWOUT: The home favourite is breaking the line alone! Under-leakage and high-scoring correct scores confirm a one-sided goal rush (3+ goals / Home Over 2.5)."
    );
  }
  if (isSuperFavTrap) {
    anomalies.push(
      "🎯 PATTERN: SUPER FAVOURITE RESISTANCE: Favourite looks artificially short, the underdog's handicap line is well supported (1-1 / 2-0 / 2-1 upset risk)."
    );
  }
  if (isAwayControlLock) {
    anomalies.push(
      "🎯 PATTERN: AWAY CONTROL LOCK: Away favourite is priced to win by a single goal only. The Over/Under line is misleading — 0-1 / 0-2 corridor!"
    );
  }
  if (isAwaySurgeTrap) {
    anomalies.push(
      "⚠️ PATTERN: AWAY SURGE TRAP: The line is flowing Over, but the favourite is away and HT tempo is controlled. A 4+ explosion is unlikely — expect a controlled 1-1 / 1-2 contest."
    );
  }
  if (isCollectiveSurge) {
    anomalies.push(
      "🎯 PATTERN: COLLECTIVE SURGE: 1X2 + HT tempo + Under-leakage + BTTS are all pointing the same direction (3.5 Over threat)."
    );
  }

  // ---------------------------------------------------------------------
  // 6. Profile Hierarchy (Synthesis of All Edge Cases)
  //    New patterns take priority; falls back to the original hierarchy.
  // ---------------------------------------------------------------------
  let fairGoalLine = 2.5;
  let scoreProfile: ScoreProfile = "BALANCED";
  let teamGoalVerdict = "⛔ Single-team goal line is risky — prefer the overall total-goals line.";
  const favLabel = rawFavSide === "H" ? "Home" : "Away";

  if (isReverseTakeover) {
    fairGoalLine = 2.0;
    scoreProfile = "REVERSE_TAKEOVER";
    teamGoalVerdict = "✅ Double Chance X2 / Away Over 0.5 (stay away from the home side).";
  } else if (isHiddenFireLeak) {
    fairGoalLine = 3.0;
    scoreProfile = "HIDDEN_FIRE_LEAK";
    teamGoalVerdict = "✅ BTTS / Over 2.5 as a surprise play — the balanced-looking board is masking mutual goals.";
  } else if (isBaselineFavBreak) {
    fairGoalLine = 2.25;
    scoreProfile = "BASELINE_FAV_BREAK";
    teamGoalVerdict = `✅ ${favLabel} to Win / ${favLabel} Over 1.5 (a 3+ margin alone is unlikely).`;
  } else if (isPhantomBlowout) {
    fairGoalLine = 1.75;
    scoreProfile = "PHANTOM_BLOWOUT";
    teamGoalVerdict = "❌ Favourite's team-goal line should NOT be backed (no baseline support, crowd-inflated favourite).";
  } else if (isLowBaselineTrap) {
    fairGoalLine = 1.25;
    scoreProfile = "LOW_BASELINE_TRAP";
    teamGoalVerdict = "❌ Team-goal line should NOT be backed (thin baseline / false-smash trap).";
  } else if (isSoloHomeBlowout) {
    fairGoalLine = 3.25;
    scoreProfile = "SOLO_HOME_BLOWOUT";
    teamGoalVerdict = "✅ Home Over 2.0 / 2.5 and Home Handicap -1 are supported.";
  } else if (isSuperFavTrap) {
    fairGoalLine = 2.5;
    scoreProfile = "SUPER_FAV_TRAP";
    teamGoalVerdict = `❌ ${favLabel} Over 2.5 (team goals) should NOT be backed — the underdog's handicap is well supported.`;
  } else if (isAwayControlLock) {
    fairGoalLine = 1.75;
    scoreProfile = "AWAY_CONTROL_LOCK";
    teamGoalVerdict = "✅ Away to Win / Away Over 1.5 unlikely alone (single-goal win expected, not a 3+ margin).";
  } else if (isAwaySurgeTrap) {
    fairGoalLine = 2.75;
    scoreProfile = "AWAY_SURGE_TRAP";
    teamGoalVerdict = "✅ BTTS / 2-3 goal corridor (the away side tends to protect the scoreline rather than blow it out).";
  } else if (isCollectiveSurge) {
    fairGoalLine = 3.5;
    scoreProfile = "COLLECTIVE_SURGE";
    teamGoalVerdict = "✅ Total-goals / BTTS-focused (both sides contribute to the scoreline).";
  }
  // --- Original hierarchy (unchanged, used when no new pattern fires) ---
  else if (isExtremeDominance && (pOver35 ?? 0) >= 0.50) {
    fairGoalLine = 4.5;
    scoreProfile = "EXTREME_BLOWOUT";
    teamGoalVerdict = "✅ Favourite's team-goal line is supported — the dominant side can cover it alone.";
  } else if (isHeavyFavorite && bttsExpectancy) {
    fairGoalLine = 2.75;
    scoreProfile = "CONTESTED_FAVORITE";
    teamGoalVerdict = "⚠️ Favourite's team-goal line is risky alone — the underdog is also expected to score.";
  } else if (isHeavyFavorite && !bttsExpectancy) {
    fairGoalLine = pOver25 >= 0.55 ? 3.0 : 2.5;
    scoreProfile = "DOMINANT_WIN";
    teamGoalVerdict = "✅ Favourite's team-goal line is supported — one-sided dominance, low BTTS.";
  } else if (isUnderLeaking && handicapSmashCount >= 1) {
    fairGoalLine = 2.75;
    scoreProfile = "OPEN_EXCHANGE";
  } else if (!isHeavyFavorite && isFalseOpen) {
    fairGoalLine = 1.75;
    scoreProfile = "LOCKED_CORRIDOR";
  } else if (
    !isHeavyFavorite &&
    ((bttsExpectancy && pOver25 >= 0.51) ||
      (htVelocity === "HIGH_VELOCITY" && bttsExpectancy) ||
      (isUnderLeaking && pOver25 >= 0.48))
  ) {
    fairGoalLine = 2.75;
    scoreProfile = "OPEN_EXCHANGE";
  } else if (
    !isHeavyFavorite &&
    (pOver15 ?? 1) < 0.70 &&
    pOver25 < 0.46 &&
    !isUnderLeaking &&
    medBttsYes >= 1.95 &&
    (medHt00 ?? 99) <= 2.40
  ) {
    fairGoalLine = 1.5;
    scoreProfile = "HARD_UNDER";
  }

  // ---------------------------------------------------------------------
  // 7. Clear HT / FT Verdict Texts
  // ---------------------------------------------------------------------
  let htVerdict = "BALANCED FIRST HALF (0-1 Goal Expectation)";
  if (htVelocity === "HIGH_VELOCITY" || (medHtOu05 != null && medHtOu05 <= 1.30)) {
    htVerdict = "🔥 FIRST HALF TEMPO / EARLY GOAL (High HT 0.5 & 1.5 Over Potential)";
  } else if (htVelocity === "HARD_LOCK" || (isFalseOpen && (medHtOu05 == null || medHtOu05 >= 1.35))) {
    htVerdict = "🔒 FIRST HALF HARD LOCK (0:0 Risk at Peak)";
  }

  let ftVerdict = "BALANCED CORRIDOR (2-3 Goal Expectation)";
  if (scoreProfile === "REVERSE_TAKEOVER") {
    ftVerdict = "🛡️ REVERSE LIQUIDITY RESISTANCE (0-1 / 1-1 / 0-2 — Away Points, Home Has Collapsed)";
  } else if (scoreProfile === "HIDDEN_FIRE_LEAK") {
    ftVerdict = "💣 HIDDEN FIRE INFILTRATION (3-3 / 4-3 Signal — Off-Baseline Mutual Goals)";
  } else if (scoreProfile === "BASELINE_FAV_BREAK") {
    ftVerdict = "⚖️ CONTROLLED FAVOURITE DOMINANCE (First Half Locked / FT 2-0, 2-1 Corridor)";
  } else if (scoreProfile === "PHANTOM_BLOWOUT") {
    ftVerdict = "🧊 TEMPLATED AWAY UPSET (1-1 / 1-2 Corridor — Inflated Over Balloon)";
  } else if (scoreProfile === "LOW_BASELINE_TRAP") {
    ftVerdict = "🛡️ HARD BARREN BASELINE LOCK (Max 0-1 Goals / 0-0, 0-1, 1-0)";
  } else if (scoreProfile === "SOLO_HOME_BLOWOUT") {
    ftVerdict = "💣 HOME SOLO GOAL RUSH (Home Over 2.5 / 3+ Goal Show)";
  } else if (scoreProfile === "SUPER_FAV_TRAP") {
    ftVerdict = "🧊 ARTIFICIAL BASELINE TRAP (1-1 / 2-0 / 2-1 Upset Risk)";
  } else if (scoreProfile === "AWAY_CONTROL_LOCK") {
    ftVerdict = "🛡️ CONTROLLED AWAY WIN (0-1 / 0-2 Corridor — Line Is Misleading)";
  } else if (scoreProfile === "AWAY_SURGE_TRAP") {
    ftVerdict = "⚖️ CONTROLLED MUTUAL CONTEST (1-1 / 1-2 Corridor — 3.5 Over Is Misleading)";
  } else if (scoreProfile === "COLLECTIVE_SURGE") {
    ftVerdict = "💣 ANOMALOUS OPEN FIRE (Mutual Goals & 3.5 Over / 4+ Goal Threat)";
  } else if (scoreProfile === "LOCKED_CORRIDOR") {
    ftVerdict = "🧊 FAKE OVER TRAP (Dead Market / 0-0 or 1-1 Lock Score Risk)";
  } else if (isUnderLeaking && handicapSmashCount >= 1) {
    ftVerdict = "💣 ANOMALOUS OVER EXPLOSION (Even If Lines Look Low, The Match Will Explode to 3+ / 4+ Goals!)";
  } else if (scoreProfile === "OPEN_EXCHANGE") {
    ftVerdict = "💣 FULL-TIME GOAL RUSH (Mutual Exchange & 3+ / 4+ Goals)";
  } else if (scoreProfile === "EXTREME_BLOWOUT" || scoreProfile === "DOMINANT_WIN") {
    ftVerdict = "🚀 ONE-SIDED BLOWOUT (Favorite Team Can Cover the Line Alone)";
  } else if (scoreProfile === "HARD_UNDER") {
    ftVerdict = "🛡️ REAL HARD LOW-SCORING WALL (Maximum 1 Goal / 0-0, 1-0)";
  } else if (pOver25 < 0.45 && !isUnderLeaking) {
    ftVerdict = "⚖️ CONTROLLED LOW TEMPO (Maximum 2 Goals / 1-0, 0-1, 1-1)";
  }

  // ---------------------------------------------------------------------
  // 8. Dynamic Score Weighting
  // ---------------------------------------------------------------------
  const getScoreMultiplier = (hG: number, aG: number): number => {
    const totG = hG + aG;
    const isCleanSheet = (dominanceSide === "HOME" && aG === 0) || (dominanceSide === "AWAY" && hG === 0);
    const favGoals = dominanceSide === "HOME" ? hG : aG;
    const dogGoals = dominanceSide === "HOME" ? aG : hG;
    const rawFavGoals = rawFavSide === "H" ? hG : aG;
    const rawDogGoals = rawFavSide === "H" ? aG : hG;

    // New patterns
    if (scoreProfile === "PHANTOM_BLOWOUT") {
      // Templated blowout balloon: real result skews to a narrow dog corridor.
      if (rawDogGoals >= 1 && totG <= 3) return 1.55; // 1-1, 1-2, 2-1
      if (rawFavGoals >= 3) return 0.30;
      return 0.75;
    }
    if (scoreProfile === "REVERSE_TAKEOVER") {
      // Away side (the "dog" on paper) is favoured by sharp money.
      if (rawDogGoals >= 1 && rawFavGoals === 0) return 1.6; // 0-1, 0-2
      if (hG === aG) return 1.3; // 1-1
      if (rawFavGoals >= 1) return 0.35;
      return 0.9;
    }
    if (scoreProfile === "LOW_BASELINE_TRAP") {
      if (totG === 0) return 1.7;
      if (totG === 1) return 1.45;
      if (totG === 2) return 0.6;
      return 0.15;
    }
    if (scoreProfile === "SUPER_FAV_TRAP") {
      if (hG === aG) return 1.5; // 1-1
      if (rawDogGoals >= 1 && totG <= 3) return 1.35; // 2-1
      if (rawDogGoals === 0 && rawFavGoals >= 2) return 0.55; // clean blowout penalised
      return 0.9;
    }
    if (scoreProfile === "AWAY_CONTROL_LOCK") {
      if (rawFavGoals >= 1 && rawDogGoals === 0 && rawFavGoals <= 2) return 1.6; // 0-1, 0-2
      if (rawFavGoals >= 3) return 0.4;
      if (hG === aG) return 0.7;
      return 0.6;
    }
    if (scoreProfile === "COLLECTIVE_SURGE") {
      if (hG > 0 && aG > 0 && totG >= 4) return 1.65;
      if (hG > 0 && aG > 0) return 1.2;
      return 0.3;
    }
    if (scoreProfile === "HIDDEN_FIRE_LEAK") {
      // Balanced-looking board masking an extreme mutual-scoring outcome.
      if (hG > 0 && aG > 0 && totG >= 5) return 1.75; // 3-3, 4-3-style outcomes
      if (hG > 0 && aG > 0 && totG >= 3) return 1.35;
      if (totG <= 1) return 0.4;
      return 0.9;
    }
    if (scoreProfile === "BASELINE_FAV_BREAK") {
      // Favourite controls the match behind a locked first half.
      if (rawFavGoals === 2 && rawDogGoals <= 1) return 1.6; // 2-0, 2-1
      if (rawFavGoals >= 3) return 0.7;
      if (rawDogGoals === 0 && rawFavGoals <= 1) return 1.1; // 1-0
      if (rawFavGoals === 0) return 0.3;
      return 0.75;
    }
    if (scoreProfile === "SOLO_HOME_BLOWOUT") {
      if (rawFavGoals >= 2 && rawDogGoals === 0) return 1.6; // 2-0, 3-0
      if (rawFavGoals >= 3) return 1.35;
      if (rawFavGoals === 0) return 0.15;
      return 0.7;
    }
    if (scoreProfile === "AWAY_SURGE_TRAP") {
      if (hG === aG || (rawDogGoals >= 1 && rawFavGoals >= 1 && totG <= 3)) return 1.5; // 1-1, 1-2
      if (totG >= 4) return 0.4;
      return 0.85;
    }

    // A. EXTREME_BLOWOUT
    if (scoreProfile === "EXTREME_BLOWOUT") {
      if (totG <= 2) return 0.20;
      if (totG === 3 && isCleanSheet) return 1.20;
      if (totG >= 4 && isCleanSheet) return 1.65;
      return 0.80;
    }

    // B. CONTESTED_FAVORITE
    if (scoreProfile === "CONTESTED_FAVORITE") {
      if (hG === 1 && aG === 1) return 1.60;
      if (favGoals >= 2 && dogGoals >= 1 && totG <= 4) return 1.50;
      if (isCleanSheet) return 0.50;
      return 0.85;
    }

    // C. DOMINANT_WIN (includes Panathinaikos / Palermo 3-1 safety net)
    if (scoreProfile === "DOMINANT_WIN") {
      if (isCleanSheet && (totG === 2 || totG === 3)) return 1.45; // 2:0, 3:0
      if (isCleanSheet && totG >= 4) return 1.25;                  // 4:0
      if (favGoals >= 2 && dogGoals === 1 && totG <= 4) return 1.35; // 2:1, 3:1
      if (!isCleanSheet && totG <= 2) return 0.50;
      return 0.90;
    }

    // D. OPEN_EXCHANGE
    if (scoreProfile === "OPEN_EXCHANGE") {
      if (hG > 0 && aG > 0) {
        if (totG >= 3) return 1.55; // 2:1, 1:2, 2:2, 2:3, 3:2
        return 1.15; // 1:1
      }
      return 0.35; // Block low-scoring one-sided scorelines
    }

    // E. HARD_UNDER
    if (scoreProfile === "HARD_UNDER") {
      if (totG === 0) return 1.70;
      if (totG === 1) return 1.50;
      if (totG === 2) return 0.85;
      return 0.20;
    }

    // E2. LOCKED_CORRIDOR (Estoril Protection)
    if (scoreProfile === "LOCKED_CORRIDOR") {
      if (totG === 0) return 1.65; // 0:0
      if (hG === aG) return 1.50;  // 1:1
      if (totG === 1) return 1.15; // 1:0, 0:1
      if (totG === 2) return 0.70;
      return 0.20;
    }

    // F. BALANCED (Cagliari / Vila Nova Correction)
    // If BTTS Yes is dead (@1.95+) and the line is low, boost 1:0 and 2:0 favorite scorelines:
    if (medBttsYes >= 1.95 && pOver25 < 0.45) {
      if ((hG === 1 && aG === 0) || (hG === 2 && aG === 0)) return 1.35;
      if ((aG === 1 && hG === 0) || (aG === 2 && hG === 0)) return 1.35;
      if (totG <= 2) return 1.10;
      return 0.70;
    }

    if (totG === 2 || totG === 3 || totG === 4) return 1.25;
    return 0.85;
  };

  return {
    dominanceSide,
    isHeavyFavorite,
    isExtremeDominance,
    favoriteOdds,
    htVelocity,
    htVelocityLabel,
    htZeroZeroOdd: medHt00 ? Math.round(medHt00 * 100) / 100 : null,
    htZeroZeroDrift: Math.round(ht00Drift * 100) / 100,
    pOver15: pOver15 ? Math.round(pOver15 * 1000) / 10 : null,
    pOver25: Math.round(pOver25 * 1000) / 10,
    pOver35: pOver35 ? Math.round(pOver35 * 1000) / 10 : null,
    pOver45: pOver45 ? Math.round(pOver45 * 1000) / 10 : null,
    isUnderLeaking,
    isFalseOpen,
    handicapSmashCount,
    anomalies,
    moneyFlow1X2,
    ouFlow,
    hasFavHandicapSmash,
    hasDogHandicapSupport,
    fairGoalLine,
    bttsExpectancy,
    scoreProfile,
    htVerdict,
    ftVerdict,
    teamGoalVerdict,
    getScoreMultiplier,
  };
}
