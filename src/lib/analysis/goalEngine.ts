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
  | "COLLECTIVE_SURGE"
  // --- Case-memory library (ported from the latest goal_anomaly_cli.py) ---
  | "POLONIA_FAKE_DOG_TAKEOVER"
  | "DROGHEDA_FAKEOUT_SURGE"
  | "SHELBOURNE_HOLLOW_SURGE_TRAP"
  | "PISA_SYSTEMIC_FLIP"
  | "BENEVENTO_HOME_DOG_REVERSE"
  | "GALWAY_SOLO_AWAY_BLOWOUT"
  | "CORK_CITY_UNDERDOG_TAKEOVER"
  | "WEXFORD_SUPER_FAV_BLINDSPOT"
  | "QADSIAH_FIRE_CLASH"
  | "AL_AHLI_SOLO_HOME_BLOWOUT"
  | "RAKOW_HIGH_CEILING_TAKEOVER"
  | "WISLA_FAKE_COLLECTIVE_SURGE"
  | "JAZZ_PORI_SUPER_FAKEOUT_BLOWOUT"
  | "NEPTUNAS_CLEAN_SHEET_SUFFOCATION"
  | "PUSZCZA_LOW_BASELINE_ANCHOR"
  | "KERRY_AWAY_LOW_TEMPO_LOCK"
  | "CIENCIANO_HANDICAP_STEAMROLLER"
  | "JAGUARES_LOW_BASELINE_DUEL"
  | "ATHLETICO_FAKE_UNDER_STORM"
  | "HIDDEN_FIRE_LEAK";

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
  // Line sets & thresholds synced with the latest goal_anomaly_cli.py reference model.
  let handicapSmashCount = 0;
  let hasFavHandicapSmash = false;
  let hasDogHandicapSupport = false;
  const FAV_MINUS_LINES = ["-0.75", "-1.0", "-1.25", "-1.5", "-1.75", "-2.0", "-2.5", "-2.75"];
  const DOG_PLUS_LINES = ["0.5", "0.75", "1.0", "1.25", "-0.5", "-0.75", "-1.0"];

  for (const [key, pool] of ah.entries()) {
    if (!pool.open.length || !pool.cur.length) continue;
    const op = median(pool.open);
    const cur = median(pool.cur);
    if (op <= 0) continue;
    const drift = cur / op;

    if (rawFavSide && key.startsWith(`${rawFavSide}:`) && FAV_MINUS_LINES.some((l) => key.includes(l)) && drift <= 0.88) {
      handicapSmashCount++;
      hasFavHandicapSmash = true;
      anomalies.push(`🚀 HANDICAP SMASH: ${key} collapsed (@${op.toFixed(2)} -> @${cur.toFixed(2)})!`);
    }
    if (rawDogSide && key.startsWith(`${rawDogSide}:`) && DOG_PLUS_LINES.some((l) => key.includes(l)) && drift <= 0.94) {
      hasDogHandicapSupport = true;
      anomalies.push(`🛡️ DOG HANDICAP SUPPORT: ${key} is being backed (@${op.toFixed(2)} -> @${cur.toFixed(2)})!`);
    }
  }

  const static15 = isLineStatic(ou["1.5"].over.cur, ou["1.5"].over.open, ou["1.5"].under.cur, ou["1.5"].under.open);
  const static25 = isLineStatic(ou["2.5"].over.cur, ou["2.5"].over.open, ou["2.5"].under.cur, ou["2.5"].under.open);

  const medBttsYes = effOf(btts.YES) ?? 2.0;
  const bttsDrift = driftOf(btts.YES);
  const bttsExpectancy = medBttsYes <= 1.68;

  const wouldBeOpenExchange = pOver25 >= 0.525 && medBttsYes <= 1.65;
  const isFalseOpen = static15 && static25 && !isUnderLeaking && handicapSmashCount === 0 && wouldBeOpenExchange;
  if (isFalseOpen) {
    anomalies.push("DEAD/STATIC MARKET: Zero movement despite Open-Exchange-level Over/BTTS pricing. Locked corridor risk is at its peak!");
  }

  // 4e. Correct-score collapses (feeds the case-memory library & standard patterns below)
  let sc01: number | null = null; // "0:1" (away wins 1-0)
  let sc02: number | null = null; // "0:2"
  let sc10: number | null = null; // "1:0" (home wins 1-0)
  let sc11: number | null = null; // "1:1"
  let sc12: number | null = null; // "1:2"
  let sc21: number | null = null; // "2:1"
  const highScoreDrops = new Set<string>(); // collapsed scores outside the low-score set, e.g. "3:3", "4:2"
  const lowScoreDrops = new Set<string>(); // collapsed scores within the low-score set, e.g. "1:0", "2:0"
  for (const [key, pool] of ftCorrectScore.entries()) {
    if (key === "0:1") sc01 = effOf(pool);
    if (key === "0:2") sc02 = effOf(pool);
    if (key === "1:0") sc10 = effOf(pool);
    if (key === "1:1") sc11 = effOf(pool);
    if (key === "1:2") sc12 = effOf(pool);
    if (key === "2:1") sc21 = effOf(pool);
    if (!pool.open.length || !pool.cur.length) continue;
    const op = median(pool.open);
    const cur = median(pool.cur);
    if (op > 0 && cur / op <= 0.88) {
      if (LOW_SCORES.has(key)) lowScoreDrops.add(key);
      else highScoreDrops.add(key);
    }
  }
  const highScoreDropCount = highScoreDrops.size;

  // ---------------------------------------------------------------------
  // 5. Case-Memory Library (ported 1:1 from the latest goal_anomaly_cli.py)
  //    Each signature is independent — rules don't chain off each other and
  //    don't break older ones. Checked in the exact order of the reference
  //    model; later unguarded checks may still override an earlier match,
  //    exactly like the Python "if" (not "elif") chain they came from.
  // ---------------------------------------------------------------------
  const p25 = pOver25;
  const AGGRESSIVE_OVER_FLOW = "AGGRESSIVE OVER FLOW (Under being abandoned) ⬆️";
  const AGGRESSIVE_UNDER_FLOW = "AGGRESSIVE UNDER FLOW (market locking) ⬇️";

  type MatchedCase = {
    name: string;
    desc: string;
    ht: string;
    ft: string;
    team: string;
    profile: ScoreProfile;
  };
  let matchedCase: MatchedCase | null = null;

  // ALARM / PRIORITY FILTER: Polonia Model (Fake Under-Dog Takeover)
  if (
    rawFavSide === "H" &&
    rawFavOdds != null &&
    rawFavOdds >= 1.95 &&
    msHDrift >= 1.10 &&
    hasDogHandicapSupport &&
    (moneyFlow1X2.startsWith("AWAY") || msADrift <= 0.88)
  ) {
    matchedCase = {
      name: "POLONIA MODEL (Fake Under-Dog Takeover Alarm)",
      desc: "The under-line has been swept to create a barren-lock illusion, but the home favourite has collapsed from short odds to drift, and the away handicaps (-0.75 / +0.5) have seen a massive institutional entry! The barren display is fake — expect away points and goals at both ends.",
      ht: "🔥 FIRST HALF TEMPO / EARLY GOAL (High HT 0.5 Over)",
      ft: "💣 HOME COLLAPSE & AWAY RESISTANCE (1-2 / 2-2 / 1-3 Corridor — BTTS)",
      team: "✅ Double Chance X2 & BTTS Yes (watch the 1-0 / 2-0 home trap)",
      profile: "POLONIA_FAKE_DOG_TAKEOVER",
    };
  }

  // VAKA 1-4: Drogheda / Shelbourne / Pisa / Benevento chain — only one of these fires.
  if (
    rawFavSide === "H" &&
    rawFavOdds != null &&
    rawFavOdds >= 1.70 &&
    rawFavOdds <= 2.05 &&
    hasDogHandicapSupport
  ) {
    // VAKA 1: Drogheda Model (Fakeout Dog Surge)
    if ((ou25OverDrift >= 1.03 || ouFlow === AGGRESSIVE_UNDER_FLOW) && msHDrift >= 1.05) {
      matchedCase = {
        name: "DROGHEDA MODEL (Fakeout Dog Surge)",
        desc: "Away handicaps have been swept but the line is closing upward (under flow)! The home favourite has taken an opening correction but won't let go of the match.",
        ht: "BALANCED FIRST HALF (0-1 Goal Range)",
        ft: "🎯 CONTROLLED HOME DOMINANCE (1-0 / 2-0 Corridor — Away Trap)",
        team: "✅ Home Over 1.5 / Home Double Chance (the away surprise is fake)",
        profile: "DROGHEDA_FAKEOUT_SURGE",
      };
    }
  } else if (
    (ouFlow === AGGRESSIVE_OVER_FLOW || isUnderLeaking) &&
    moneyFlow1X2 === "BALANCED"
  ) {
    // VAKA 2: Shelbourne Model (Hollow Surge Trap)
    if (!hasFavHandicapSmash && !hasDogHandicapSupport && medHtOu05 != null && medHtOu05 >= 1.33) {
      matchedCase = {
        name: "SHELBOURNE MODEL (Hollow Surge Trap)",
        desc: "Lines have been pumped toward Over but the Asian Handicap and 1X2 are completely inert! Side support is zero — the match is tactically locked.",
        ht: "BALANCED FIRST HALF (0-1 Goal Range)",
        ft: "🧊 HOLLOW OVER BALLOON (Max 1-2 Goals / 0-1, 1-0 Lock Risk)",
        team: "❌ Over 2.5 should NOT be backed (zero handicap support)",
        profile: "SHELBOURNE_HOLLOW_SURGE_TRAP",
      };
    }
  } else if (ouFlow === AGGRESSIVE_OVER_FLOW && isUnderLeaking && hasDogHandicapSupport) {
    // VAKA 3: Pisa Model (Systemic Market Flip)
    if (highScoreDropCount >= 4 && (ht00Drift >= 1.03 || (medHtOu05 != null && medHtOu05 <= 0.98))) {
      matchedCase = {
        name: "PISA MODEL (Systemic Market Flip)",
        desc: "The opening line was barren, but the market has flipped top-to-bottom toward Over! The away side is coming with both a handicap edge and goals.",
        ht: "🔥 FIRST HALF ANOMALOUS PRESSURE (HT 0:0 Abandoned / Early Goals)",
        ft: "💣 INSTITUTIONAL LINE TAKEOVER & SURPRISE OVER (1-2 / 1-3 / 1-4 Corridor)",
        team: "✅ Double Chance X2 & Over 2.5 / Away Over 1.5",
        profile: "PISA_SYSTEMIC_FLIP",
      };
    }
  } else if (
    rawFavSide === "A" &&
    rawFavOdds != null &&
    rawFavOdds >= 1.55 &&
    rawFavOdds <= 2.55 &&
    hasDogHandicapSupport &&
    (msHDrift <= 0.90 || moneyFlow1X2.startsWith("HOME"))
  ) {
    // VAKA 4: Benevento Model (Home Dog Reverse Takeover)
    matchedCase = {
      name: "BENEVENTO MODEL (Home Dog Reverse Takeover)",
      desc: "The away side is shown as favourite on paper, but institutional money has piled onto the home win and home handicap.",
      ht: "BALANCED FIRST HALF (0-1 Goal Range)",
      ft: "🎯 HOME DOMINANCE & REVERSE LIQUIDITY (2-1 / 3-1 Win Corridor)",
      team: "✅ Home Double Chance 1X / Home Over 1.5 (the away favourite tag is misleading)",
      profile: "BENEVENTO_HOME_DOG_REVERSE",
    };
  }

  // VAKA 4.5: Galway Model (Solo Away Blowout)
  const hasAwayBlowoutScores =
    ["0:3", "0:4", "1:4", "0:5", "1:5", "0:6", "1:6", "2:3", "2:4"].filter((s) => highScoreDrops.has(s)).length >= 2;
  if (
    !matchedCase &&
    rawFavSide === "A" &&
    rawFavOdds != null &&
    rawFavOdds <= 1.85 &&
    (hasFavHandicapSmash || msADrift <= 0.92) &&
    hasAwayBlowoutScores
  ) {
    matchedCase = {
      name: "GALWAY MODEL (Solo Away Blowout)",
      desc: "The overall line looks calm, but the away handicaps (-1.0 / -1.5) and a batch of blowout scorelines have been swept! The away side breaks the line on its own.",
      ht: "🔥 FIRST HALF TEMPO / EARLY GOAL (High HT 0.5 Over)",
      ft: "💣 AWAY OFFENSIVE EXPLOSION & OVER (1-3 / 2-3 / 0-4 Corridor — 3.5 Over Threat)",
      team: "✅ Away Over 1.5 / 2.0 and Away Win",
      profile: "GALWAY_SOLO_AWAY_BLOWOUT",
    };
  }

  // VAKA 4.8: Cork City Model (Heavy Fav Underdog Takeover)
  const hasCorkDogScores = ["1:3", "2:3", "2:4", "0:3"].some((s) => highScoreDrops.has(s));
  if (
    !matchedCase &&
    rawFavSide === "H" &&
    rawFavOdds != null &&
    rawFavOdds >= 1.30 &&
    rawFavOdds <= 1.50 &&
    hasDogHandicapSupport &&
    (moneyFlow1X2.startsWith("AWAY") || msADrift <= 0.94 || hasCorkDogScores)
  ) {
    matchedCase = {
      name: "CORK CITY MODEL (Heavy Fav Underdog Takeover)",
      desc: "The home side is priced as a heavy @1.30-@1.50 favourite, but institutional money has piled onto the away +1.0 / +1.25 handicap and surprise win scorelines (1:3, 2:3)!",
      ht: "🔥 FIRST HALF TEMPO / EARLY GOAL (High HT 0.5 Over)",
      ft: "💣 HEAVY FAVOURITE COLLAPSE & SURPRISE OVER (1-2 / 1-3 / 2-3 Away Shock)",
      team: "✅ Away Handicap (+1.5 A) / Double Chance X2 / BTTS Yes",
      profile: "CORK_CITY_UNDERDOG_TAKEOVER",
    };
  }

  // VAKA 4.9: Wexford Model (Super Fav Blindspot)
  if (
    !matchedCase &&
    rawFavSide === "H" &&
    rawFavOdds != null &&
    rawFavOdds <= 1.38 &&
    p25 >= 0.58 &&
    !hasFavHandicapSmash &&
    ht00Drift >= 1.04
  ) {
    matchedCase = {
      name: "WEXFORD MODEL (Super Fav Blindspot)",
      desc: "The home side is a heavy @1.35-band favourite but handicap support is zero and HT 0:0 is rising! Public complacency in the favourite, with surprise away goals and upset risk.",
      ht: "🔥 FIRST HALF TEMPO / EARLY GOAL (High HT 0.5 Over)",
      ft: "💣 HEAVY FAVOURITE UPSET & SURPRISE DUEL (1-2 / 1-3 / 2-2 Corridor)",
      team: "✅ Away +1.5 / +2.0 Handicap / BTTS Yes",
      profile: "WEXFORD_SUPER_FAV_BLINDSPOT",
    };
  }

  // VAKA 4.95: Qadsiah Model (Super Fav Fire Clash)
  const hasFireClashScores = ["3:3", "4:4", "4:3", "3:4", "2:4", "5:3"].some((s) => highScoreDrops.has(s));
  if (
    !matchedCase &&
    rawFavSide === "H" &&
    rawFavOdds != null &&
    rawFavOdds <= 1.30 &&
    hasDogHandicapSupport &&
    p25 >= 0.65 &&
    (isUnderLeaking || ouFlow === AGGRESSIVE_OVER_FLOW || hasFireClashScores)
  ) {
    matchedCase = {
      name: "QADSIAH MODEL (Super Fav Fire Clash)",
      desc: "The home side is inflated to @1.25 and the opponent's handicap is strong; but the top of the line (65%+ Over) is on fire! This won't be a barren upset — expect a huge mutual-goal duel like 3:3 / 2:3.",
      ht: "🔥 FIRST HALF TEMPO / EARLY GOAL (High HT 0.5 Over)",
      ft: "💣 SUPER FAVOURITE UPSET & BIG DUEL (2-2 / 3-3 / 3.5 Over Explosion)",
      team: "✅ Away +1.5 / +2.0 Handicap & BTTS Yes & Over 3.5",
      profile: "QADSIAH_FIRE_CLASH",
    };
  }

  // VAKA 4.96: Al-Ahli Model (Solo Home Blowout)
  const hasAhliHomeScores = ["2:0", "3:0", "4:0", "5:0", "5:1", "6:1", "4:1", "3:1"].some((s) => highScoreDrops.has(s));
  if (
    !matchedCase &&
    rawFavSide === "H" &&
    rawFavOdds != null &&
    rawFavOdds <= 1.30 &&
    !hasDogHandicapSupport &&
    (hasAhliHomeScores || hasFavHandicapSmash || p25 >= 0.60)
  ) {
    matchedCase = {
      name: "AL-AHLI MODEL (Solo Home Blowout)",
      desc: "General lines don't look Over and Under is pressed, but the home side's -1.0 / -2.5 handicaps and blowout scorelines (3:0, 4:0, 6:1) have been swept! The home side breaks the match alone.",
      ht: "🔥 FIRST HALF TEMPO / EARLY GOAL (High HT 0.5 Over)",
      ft: "💣 ONE-SIDED HOME BLOWOUT & OVER (3-0 / 3-1 / 4-0 Corridor — 3.5 Over Threat)",
      team: "✅ Home Over 2.0 / 2.5 and Home Handicap Win (-1.5 H)",
      profile: "AL_AHLI_SOLO_HOME_BLOWOUT",
    };
  }

  // VAKA 4.97: Rakow Model (High Ceiling Fakeout Takeover) — unguarded, may override the above.
  if (
    rawFavSide === "H" &&
    rawFavOdds != null &&
    rawFavOdds >= 1.70 &&
    rawFavOdds <= 1.95 &&
    hasDogHandicapSupport &&
    p25 >= 0.58 &&
    (isUnderLeaking || (medBttsYes != null && medBttsYes <= 1.55))
  ) {
    matchedCase = {
      name: "RAKOW MODEL (High Ceiling Fakeout Takeover)",
      desc: "Away handicaps have been swept, but the top of the line (58%+ Over & BTTS Yes) is on fire and the home side is holding firm below @1.90! The away surprise is fake — the match is locked toward a 2-1 / 3-1 home win.",
      ht: "🔥 FIRST HALF TEMPO / EARLY GOAL (High HT 0.5 Over)",
      ft: "🎯 HOME RESISTANCE & GOAL-FILLED WIN (2-1 / 3-1 Corridor — BTTS & Over 2.5)",
      team: "✅ BTTS Yes & Over 2.5 / Home Win (Double Chance X2 is a trap)",
      profile: "RAKOW_HIGH_CEILING_TAKEOVER",
    };
  }

  // VAKA 4.98: Wisla Model (Fake Collective Surge) — unguarded, may override the above.
  if (
    (ouFlow === AGGRESSIVE_OVER_FLOW || isUnderLeaking) &&
    moneyFlow1X2 === "BALANCED" &&
    !hasFavHandicapSmash &&
    rawFavOdds != null &&
    rawFavOdds >= 1.85
  ) {
    matchedCase = {
      name: "WISLA MODEL (Fake Collective Surge)",
      desc: "Lines and BTTS Yes have been pumped wildly toward Over, but 1X2 is balanced and neither side has minus-handicap support! There's zero institutional conviction on who scores — the match locks into a controlled 2-0 / 1-1 corridor.",
      ht: "BALANCED FIRST HALF (0-1 Goal Range)",
      ft: "🧊 HOLLOW FIRE BALLOON (Max 2 Goals / 2-0, 1-1 Lock — 3.5 Over Trap)",
      team: "❌ Over 3.5 / BTTS Yes are a trap (max 2-3 goal corridor)",
      profile: "WISLA_FAKE_COLLECTIVE_SURGE",
    };
  }

  // VAKA 4.99: Jazz Pori Model (Super Fakeout Blowout) — unguarded, may override the above.
  if (
    rawFavSide === "H" &&
    rawFavOdds != null &&
    rawFavOdds <= 1.65 &&
    hasDogHandicapSupport &&
    (p25 >= 0.68 || (pOver35 != null && pOver35 >= 0.50))
  ) {
    matchedCase = {
      name: "JAZZ PORI MODEL (Super Fakeout Blowout)",
      desc: "Huge flow has been shown onto the away handicap and win, but the top of the line (68%+ Over) is on fire and the home side is standing firm below @1.65! The away surprise is entirely fake — the home side blows the match out alone.",
      ht: "🔥 FIRST HALF TEMPO / EARLY GOAL (High HT 0.5 Over)",
      ft: "💣 HOME OFFENSIVE EXPLOSION (3-0 / 3-1 / 4-1 Corridor — Home Over 2.5 & 3.5 Threat)",
      team: "✅ Home Over 2.0 / 2.5 and Home Win (avoid the Double-Chance-X2 trap)",
      profile: "JAZZ_PORI_SUPER_FAKEOUT_BLOWOUT",
    };
  }

  // VAKA 4.995: Neptunas Model (Clean Sheet Home Suffocation) — unguarded, may override the above.
  const hasCleanSheetScores =
    (lowScoreDrops.has("1:0") || lowScoreDrops.has("2:0")) && (highScoreDrops.has("3:0") || highScoreDrops.has("4:0"));
  if (
    rawFavSide === "H" &&
    rawFavOdds != null &&
    rawFavOdds >= 1.50 &&
    rawFavOdds <= 1.85 &&
    msHDrift <= 0.95 &&
    hasCleanSheetScores &&
    (bttsDrift >= 1.05 || ou25OverDrift >= 1.04)
  ) {
    matchedCase = {
      name: "NEPTUNAS MODEL (Clean Sheet Home Suffocation)",
      desc: "There's clear flow toward the home side, but the line is locked toward Over (BTTS No has been backed). The 1:0, 2:0, 3:0 scorelines have been swept one-sidedly! The home side smothers the match without conceding.",
      ht: "BALANCED FIRST HALF (1-0 / 0-0 Corridor)",
      ft: "🎯 CONTROLLED HOME WIN (2-0 / 3-0 Corridor — Clean Sheet Win)",
      team: "✅ Home Win & Home Over 1.5 (BTTS No focus)",
      profile: "NEPTUNAS_CLEAN_SHEET_SUFFOCATION",
    };
  }

  // VAKA 4.997: Puszcza Model (Low Baseline Anchor Progression) — unguarded, may override the above.
  const isAnchor12 =
    sc11 != null && sc11 <= 6.50 && ((sc12 != null && sc12 <= 8.50) || (sc21 != null && sc21 <= 8.50));
  if (p25 < 0.48 && isAnchor12) {
    const isCleanSheetBias = (medBttsYes != null && medBttsYes >= 1.85) || bttsDrift >= 1.03;
    let targetScoreCorridor: string;
    let targetTeam: string;
    let descDetail: string;
    if (isCleanSheetBias) {
      targetScoreCorridor =
        rawFavSide === "A" ? "0-2 / 0-1 Away (Clean Sheet)" : "2-0 / 1-0 Home (Clean Sheet)";
      targetTeam =
        rawFavSide === "A"
          ? "✅ Away Over 1.5 & Away Win (BTTS No focus)"
          : "✅ Home Over 1.5 & Home Win (BTTS No focus)";
      descDetail = "The baseline is barren, but the 2-0 / 1-0 anchors sit at the bottom and BTTS No is priced in. The favourite closes it out by two without conceding.";
    } else {
      targetScoreCorridor =
        rawFavSide === "A" ? "1-2 / 1-1 Away (Mutual Goals)" : "2-1 / 1-1 Home (Mutual Goals)";
      targetTeam =
        rawFavSide === "A"
          ? "✅ Double Chance X2 / Away Over 1.5 & BTTS Yes"
          : "✅ Double Chance 1X / Home Over 1.5 & BTTS Yes";
      descDetail = "The baseline looks barren, but the 1:1 and 1:2 anchor scores sit at the bottom and BTTS Yes stays alive. Expect a 1-2 / 2-1 duel.";
    }
    matchedCase = {
      name: "PUSZCZA MODEL (Low Baseline Anchor Progression)",
      desc: `Barren-baseline trap (below 48%)! ${descDetail}`,
      ht: "BALANCED FIRST HALF (0-1 / 1-0 Corridor)",
      ft: `⚖️ CONTROLLED FAVOURITE CORRIDOR (${targetScoreCorridor})`,
      team: `${targetTeam} (avoid the 0-0 / 0-1 barren trap)`,
      profile: "PUSZCZA_LOW_BASELINE_ANCHOR",
    };
  }

  // VAKA 4.998: Kerry Model (Away Low-Tempo Lock) — unguarded, may override the above.
  const isAwayLockScores = sc01 != null && sc01 <= 10.50 && sc02 != null && sc02 <= 12.50;
  const isHomeScoreSuppressed = sc10 == null || sc10 >= 10.00;
  if (
    rawFavSide === "A" &&
    rawFavOdds != null &&
    rawFavOdds >= 1.90 &&
    rawFavOdds <= 2.35 &&
    moneyFlow1X2 === "BALANCED" &&
    ouFlow === "STABLE" &&
    isAwayLockScores &&
    isHomeScoreSuppressed &&
    !hasDogHandicapSupport
  ) {
    matchedCase = {
      name: "KERRY MODEL (Away Low-Tempo Lock)",
      desc: "The away side sits in the balanced favourite band (@2.10-@2.30) and market flow looks stable, but 0:1 and 0:2 sit at the bottom of the correct-score board! The away side tends to grab an early goal and lock the match at a single-goal margin.",
      ht: "BALANCED FIRST HALF (0-1 Away / 0-0 Lock)",
      ft: "🛡️ CONTROLLED AWAY LOCK (0-1 / 0-2 Corridor — The Line Is Misleading)",
      team: "✅ Away Double Chance X2 & Away Over 0.5/1.5 (single-goal away win)",
      profile: "KERRY_AWAY_LOW_TEMPO_LOCK",
    };
  }

  // VAKA 4.999: Cienciano Model (Heavy Fav Handicap Steamroller) — unguarded, may override the above.
  const hasHeavyCleanSheet =
    lowScoreDrops.has("1:0") || lowScoreDrops.has("2:0") || highScoreDrops.has("3:0") || highScoreDrops.has("4:0");
  if (
    rawFavSide === "H" &&
    rawFavOdds != null &&
    rawFavOdds <= 1.55 &&
    hasFavHandicapSmash &&
    (hasHeavyCleanSheet || moneyFlow1X2.startsWith("HOME"))
  ) {
    matchedCase = {
      name: "CIENCIANO MODEL (Heavy Fav Handicap Steamroller)",
      desc: "The home side is a heavy favourite below @1.55 and institutional money has smashed its minus handicaps (-1.0, -1.25, -2.0)! Clean-sheet blowout scores (1:0, 2:0, 3:0) have piled up. The home side wins alone by at least two goals.",
      ht: "🔥 FIRST HALF HOME PRESSURE (HT 1X / HT Home)",
      ft: "🚀 HOME HANDICAP STEAMROLLER (2-0 / 3-0 Corridor — Clean Sheet Win)",
      team: "✅ Home -1.0 / -1.5 Asian Handicap & Home Over 1.5 (BTTS No focus)",
      profile: "CIENCIANO_HANDICAP_STEAMROLLER",
    };
  }

  // VAKA 4.9975: Jaguares Model (Low Baseline Duel) — unguarded, may override the above.
  // NOTE: ported verbatim from the reference model, including its own quirk — it checks the
  // *low*-score drop set for scores like "2:3"/"3:3"/"1:4" that can only ever land in the
  // high-score set, so (as in the reference CLI) this branch is effectively dormant today.
  const hasDuelScoreDrops = ["2:3", "3:3", "1:4"].some((s) => lowScoreDrops.has(s));
  if (p25 <= 0.42 && hasDuelScoreDrops) {
    matchedCase = {
      name: "JAGUARES MODEL (Low Baseline Duel)",
      desc: "The baseline is shown as extremely barren (~40%), setting an Under trap, but the correct-score market has backed high-duel scores like 2:3, 3:3, 1:4! The barren display is fake — expect mutual goals in a 2-2 / 1-2 corridor.",
      ht: "🔥 FIRST HALF GOAL DUEL (HT 0.5 Over & Away Goal)",
      ft: "💣 BARREN-MASKED GOAL DUEL (1-2 / 2-2 Corridor — BTTS Yes)",
      team: "✅ BTTS Yes & Double Chance X2 (avoid the 0-0 / 0-1 barren trap)",
      profile: "JAGUARES_LOW_BASELINE_DUEL",
    };
  }

  // VAKA 5: Farul Model (Hidden Fire Infiltration) — falls back into place only if nothing else matched.
  const EXTREME_SCORES = ["3:3", "4:3", "4:2", "5:2"];
  const hasExtremeScoreDrop = EXTREME_SCORES.some((s) => highScoreDrops.has(s));
  if (!matchedCase && hasExtremeScoreDrop && !hasDogHandicapSupport && moneyFlow1X2 === "BALANCED" && p25 < 0.50) {
    matchedCase = {
      name: "FARUL MODEL (Hidden Fire Infiltration)",
      desc: "1X2 is balanced and the line is shown as barren, but money has been staked on extreme scores like 3:3 / 4:3! Off-baseline fire risk.",
      ht: "🔒 FIRST HALF LOCK (0:0 Risk at Peak)",
      ft: "💣 HIDDEN FIRE INFILTRATION (3:3 / 4:3 Signal — Off-Baseline Mutual Goals)",
      team: "✅ BTTS Yes / Over 2.5 as a surprise (the barren display is misleading)",
      profile: "HIDDEN_FIRE_LEAK",
    };
  }

  if (matchedCase) {
    anomalies.unshift(`🧠 MEMORY MATCH: ${matchedCase.name} -> ${matchedCase.desc}`);
  }

  // ---------------------------------------------------------------------
  // 6. Standard Patterns (only kick in when no case-memory match fired)
  // ---------------------------------------------------------------------
  const isReverseTakeover =
    !matchedCase &&
    rawFavSide === "H" &&
    rawFavOdds != null &&
    rawFavOdds >= 1.55 &&
    rawFavOdds <= 2.55 &&
    hasDogHandicapSupport &&
    (msADrift <= 0.90 || moneyFlow1X2.startsWith("AWAY")) &&
    ouFlow !== AGGRESSIVE_OVER_FLOW;

  let isLowBaselineTrap = false;
  let isBaselineFavBreak = false;
  if (!matchedCase && !isReverseTakeover && p25 < 0.48 && medHtOu05 != null && medHtOu05 >= 1.38) {
    // NOTE: ported verbatim from the reference model, including its own quirk — like Jaguares,
    // it checks the *low*-score drop set for scores ("1:3", "2:4", etc.) that can only ever land
    // in the high-score set, so hasStormDrops (and this Athletico branch) is effectively dormant
    // today, exactly as in the Python reference.
    const hasStormDrops = ["1:3", "2:3", "3:3", "2:4", "1:4", "0:3"].some((s) => lowScoreDrops.has(s));
    const isFakeUnderStorm =
      (ouFlow === AGGRESSIVE_OVER_FLOW || isUnderLeaking) &&
      (hasFavHandicapSmash || (rawFavSide === "A" && msADrift <= 0.93)) &&
      hasStormDrops;

    if (isFakeUnderStorm) {
      matchedCase = {
        name: "ATHLETICO MODEL (Fake Under Goal Storm)",
        desc: "The baseline is shown below 48% to set an Under trap, but the 2.5 Under line is being abandoned, the away side's minus handicap has seen a massive institutional entry, and duel scorelines have been swept! The barren display is fake — the match explodes straight into an open goal duel.",
        ht: "🔥 FIRST HALF TEMPO / GOAL DUEL (High HT 0.5 & 1.5 Over)",
        ft: "💣 BARREN-MASKED GOAL STORM (2-2 / 2-3 / 3-3 Corridor — Over 3.5 / BTTS Yes)",
        team: "✅ BTTS Yes & Over 2.5 / Away Over 1.5 (avoid the 0-0 / 0-1 barren trap)",
        profile: "ATHLETICO_FAKE_UNDER_STORM",
      };
      // The Section-5 case-memory banner insertion already ran before this Section-6 block, so
      // (like the Python reference's later insert) we add this one's banner ourselves.
      anomalies.unshift(`🧠 MEMORY MATCH: ${matchedCase.name} -> ${matchedCase.desc}`);
    } else if (
      (rawFavSide === "H" && msHDrift <= 0.85 && hasFavHandicapSmash) ||
      (rawFavSide === "A" && msADrift <= 0.85 && hasFavHandicapSmash)
    ) {
      isBaselineFavBreak = true;
      anomalies.push(
        "🎯 PATTERN: BASELINE FAV BREAK: The goal baseline opened thin, but heavy institutional money has hit the favourite (drift below x0.85). First half locked, 2-0 / 2-1 favourite corridor expected."
      );
    } else {
      isLowBaselineTrap = true;
      anomalies.push("⚠️ LOW BASELINE TRAP: Goal baseline is thin (Over 2.5 under 48%) and HT tempo is slow. High risk of a barren lock.");
    }
  }

  const isPhantomBlowout =
    !matchedCase &&
    rawFavSide === "A" &&
    rawFavOdds != null &&
    rawFavOdds >= 1.35 &&
    rawFavOdds <= 1.65 &&
    hasFavHandicapSmash &&
    ouFlow === "STABLE" &&
    !isUnderLeaking &&
    highScoreDropCount >= 4;
  if (isPhantomBlowout) {
    anomalies.push(
      "⚠️ PATTERN: PHANTOM BLOWOUT TRAP: Extreme-margin scorelines are being backed but the Over/Under line hasn't moved at all! Templated favourite balloon — 1-1 / 1-2 upset-corridor risk."
    );
  }

  const isSoloHomeBlowout =
    !matchedCase &&
    rawFavSide === "H" &&
    rawFavOdds != null &&
    rawFavOdds <= 1.35 &&
    !hasDogHandicapSupport &&
    isUnderLeaking &&
    ouFlow === AGGRESSIVE_OVER_FLOW;
  if (isSoloHomeBlowout) {
    anomalies.push(
      "🎯 PATTERN: SOLO HOME BLOWOUT: The home favourite is breaking the line alone! Under-leakage and high-scoring correct scores confirm a one-sided goal rush (3+ goals / Home Over 2.5)."
    );
  }

  const isSuperFavTrap = !matchedCase && rawFavOdds != null && rawFavOdds <= 1.30 && hasDogHandicapSupport;
  if (isSuperFavTrap) {
    anomalies.push(
      "🎯 PATTERN: SUPER FAVOURITE RESISTANCE: Favourite looks artificially short, the underdog's handicap line is well supported (1-1 / 2-0 / 2-1 upset risk)."
    );
  }

  const isAwayControlLock =
    !matchedCase &&
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
  if (isAwayControlLock) {
    anomalies.push(
      "🎯 PATTERN: AWAY CONTROL LOCK: Away favourite is priced to win by a single goal only. The Over/Under line is misleading — 0-1 / 0-2 corridor!"
    );
  }

  let isCollectiveSurge = false;
  let isAwaySurgeTrap = false;
  if (
    !matchedCase &&
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
      anomalies.push(
        "⚠️ PATTERN: AWAY SURGE TRAP: The line is flowing Over, but the favourite is away and HT tempo is controlled. A 4+ explosion is unlikely — expect a controlled 1-1 / 1-2 contest."
      );
    } else {
      isCollectiveSurge = true;
      anomalies.push(
        "🎯 PATTERN: COLLECTIVE SURGE: 1X2 + HT tempo + Under-leakage + BTTS are all pointing the same direction (3.5 Over threat)."
      );
    }
  }

  if (isReverseTakeover) {
    anomalies.push(
      "🎯 PATTERN: REVERSE MARKET TAKEOVER: The paper favourite is being dumped — sharp money has piled onto the underdog's points and handicap (0-1 / 1-1 / 0-2 corridor)."
    );
  }

  // ---------------------------------------------------------------------
  // 7. Profile Hierarchy (Synthesis of All Edge Cases)
  //    Case-memory matches take priority; falls back to the standard hierarchy.
  // ---------------------------------------------------------------------
  let fairGoalLine = 2.5;
  let scoreProfile: ScoreProfile = "BALANCED";
  let teamGoalVerdict = "⛔ Single-team goal line is risky — prefer the overall total-goals line.";
  const favLabel = rawFavSide === "H" ? "Home" : "Away";

  if (matchedCase) {
    scoreProfile = matchedCase.profile;
    teamGoalVerdict = matchedCase.team;
    const CASE_FAIR_LINES: Partial<Record<ScoreProfile, number>> = {
      POLONIA_FAKE_DOG_TAKEOVER: 3.25,
      DROGHEDA_FAKEOUT_SURGE: 2.25,
      SHELBOURNE_HOLLOW_SURGE_TRAP: 1.75,
      PISA_SYSTEMIC_FLIP: 3.25,
      BENEVENTO_HOME_DOG_REVERSE: 2.75,
      GALWAY_SOLO_AWAY_BLOWOUT: 3.5,
      CORK_CITY_UNDERDOG_TAKEOVER: 3.0,
      WEXFORD_SUPER_FAV_BLINDSPOT: 2.75,
      QADSIAH_FIRE_CLASH: 3.75,
      AL_AHLI_SOLO_HOME_BLOWOUT: 3.5,
      RAKOW_HIGH_CEILING_TAKEOVER: 3.0,
      WISLA_FAKE_COLLECTIVE_SURGE: 1.75,
      JAZZ_PORI_SUPER_FAKEOUT_BLOWOUT: 3.5,
      NEPTUNAS_CLEAN_SHEET_SUFFOCATION: 2.25,
      PUSZCZA_LOW_BASELINE_ANCHOR: 2.25,
      KERRY_AWAY_LOW_TEMPO_LOCK: 1.75,
      CIENCIANO_HANDICAP_STEAMROLLER: 2.75,
      JAGUARES_LOW_BASELINE_DUEL: 3.0,
      ATHLETICO_FAKE_UNDER_STORM: 3.25,
      HIDDEN_FIRE_LEAK: 3.25,
    };
    fairGoalLine = CASE_FAIR_LINES[matchedCase.profile] ?? 2.5;
  } else if (isReverseTakeover) {
    fairGoalLine = 2.0;
    scoreProfile = "REVERSE_TAKEOVER";
    teamGoalVerdict = "✅ Double Chance X2 / Away Over 0.5 (stay away from the home side).";
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
  // --- Original fallback hierarchy (unchanged, used when nothing above fires) ---
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
  // 8. Clear HT / FT Verdict Texts
  // ---------------------------------------------------------------------
  let htVerdict = "BALANCED FIRST HALF (0-1 Goal Expectation)";
  if (htVelocity === "HIGH_VELOCITY" || (medHtOu05 != null && medHtOu05 <= 1.30)) {
    htVerdict = "🔥 FIRST HALF TEMPO / EARLY GOAL (High HT 0.5 & 1.5 Over Potential)";
  } else if (htVelocity === "HARD_LOCK" || (isFalseOpen && (medHtOu05 == null || medHtOu05 >= 1.35))) {
    htVerdict = "🔒 FIRST HALF HARD LOCK (0:0 Risk at Peak)";
  }

  let ftVerdict = "BALANCED CORRIDOR (2-3 Goal Expectation)";
  if (matchedCase) {
    htVerdict = matchedCase.ht;
    ftVerdict = matchedCase.ft;
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
  } else if (scoreProfile === "REVERSE_TAKEOVER") {
    ftVerdict = "🛡️ REVERSE LIQUIDITY RESISTANCE (0-1 / 1-1 / 0-2 — Away Points, Home Has Collapsed)";
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
  // 9. Dynamic Score Weighting
  // ---------------------------------------------------------------------
  const getScoreMultiplier = (hG: number, aG: number): number => {
    const totG = hG + aG;
    const isCleanSheet = (dominanceSide === "HOME" && aG === 0) || (dominanceSide === "AWAY" && hG === 0);
    const favGoals = dominanceSide === "HOME" ? hG : aG;
    const dogGoals = dominanceSide === "HOME" ? aG : hG;
    const rawFavGoals = rawFavSide === "H" ? hG : aG;
    const rawDogGoals = rawFavSide === "H" ? aG : hG;

    // --- Case-memory profiles ---
    if (scoreProfile === "POLONIA_FAKE_DOG_TAKEOVER" || scoreProfile === "CORK_CITY_UNDERDOG_TAKEOVER" || scoreProfile === "WEXFORD_SUPER_FAV_BLINDSPOT") {
      if (rawDogGoals >= 1 && rawFavGoals >= 1 && totG <= 4) return 1.6; // 1-2, 2-2, 1-3
      if (rawDogGoals === 0) return 0.35;
      return 0.85;
    }
    if (scoreProfile === "DROGHEDA_FAKEOUT_SURGE" || scoreProfile === "BENEVENTO_HOME_DOG_REVERSE" || scoreProfile === "RAKOW_HIGH_CEILING_TAKEOVER") {
      if (rawFavGoals >= 2 && rawDogGoals <= 1 && totG <= 4) return 1.55; // 2-0, 2-1, 3-1
      if (rawFavGoals === 0) return 0.3;
      return 0.85;
    }
    if (scoreProfile === "SHELBOURNE_HOLLOW_SURGE_TRAP" || scoreProfile === "WISLA_FAKE_COLLECTIVE_SURGE") {
      if (totG <= 1) return 1.5;
      if (totG === 2) return 1.15;
      if (totG === 3) return 0.4;
      return 0.15;
    }
    if (scoreProfile === "PISA_SYSTEMIC_FLIP" || scoreProfile === "QADSIAH_FIRE_CLASH" || scoreProfile === "JAGUARES_LOW_BASELINE_DUEL" || scoreProfile === "ATHLETICO_FAKE_UNDER_STORM") {
      if (hG > 0 && aG > 0 && totG >= 4) return 1.7;
      if (hG > 0 && aG > 0) return 1.25;
      return 0.3;
    }
    if (scoreProfile === "GALWAY_SOLO_AWAY_BLOWOUT" || scoreProfile === "JAZZ_PORI_SUPER_FAKEOUT_BLOWOUT" || scoreProfile === "AL_AHLI_SOLO_HOME_BLOWOUT" || scoreProfile === "CIENCIANO_HANDICAP_STEAMROLLER") {
      if (rawFavGoals >= 2 && rawDogGoals === 0) return 1.6;
      if (rawFavGoals >= 3) return 1.35;
      if (rawFavGoals === 0) return 0.15;
      return 0.6;
    }
    if (scoreProfile === "NEPTUNAS_CLEAN_SHEET_SUFFOCATION") {
      if (rawFavGoals >= 2 && rawDogGoals === 0) return 1.55;
      if (rawDogGoals >= 1) return 0.35;
      return 0.9;
    }
    if (scoreProfile === "PUSZCZA_LOW_BASELINE_ANCHOR") {
      if (hG === 1 && aG === 1) return 1.5;
      if ((rawFavGoals === 2 && rawDogGoals <= 1) || (rawFavGoals === 1 && rawDogGoals === 2)) return 1.3;
      if (totG === 0) return 0.6;
      if (totG >= 5) return 0.2;
      return 0.85;
    }
    if (scoreProfile === "KERRY_AWAY_LOW_TEMPO_LOCK") {
      if (rawFavGoals >= 1 && rawDogGoals === 0 && rawFavGoals <= 2) return 1.6; // 0-1, 0-2
      if (rawFavGoals >= 3) return 0.4;
      if (hG === aG) return 0.6;
      return 0.55;
    }
    if (scoreProfile === "HIDDEN_FIRE_LEAK") {
      if (hG > 0 && aG > 0 && totG >= 5) return 1.75; // 3-3, 4-3-style outcomes
      if (hG > 0 && aG > 0 && totG >= 3) return 1.35;
      if (totG <= 1) return 0.4;
      return 0.9;
    }

    // --- Standard patterns ---
    if (scoreProfile === "PHANTOM_BLOWOUT") {
      if (rawDogGoals >= 1 && totG <= 3) return 1.55; // 1-1, 1-2, 2-1
      if (rawFavGoals >= 3) return 0.30;
      return 0.75;
    }
    if (scoreProfile === "REVERSE_TAKEOVER") {
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
    if (scoreProfile === "BASELINE_FAV_BREAK") {
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
