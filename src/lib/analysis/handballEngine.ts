/**
 * Handball Goal & Market engine.
 *
 * Reads a single handball fixture's own odds (all bookmakers, median close/open)
 * and maps them onto the rules mined from the handball archive study
 * (219 season files, 34,932 matches, 24,740 clean matches).
 *
 * Pure + client-safe: no env / DB / R2 access. Only a type import from handball.ts.
 * This is a regime classification built on historical archive statistics,
 * NOT a guaranteed prediction.
 */
import type { CompactOddsRow } from "@/lib/handball";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type HandballTier =
  | "HEAVY_HOME"
  | "STRONG_HOME"
  | "MILD_HOME"
  | "BALANCED"
  | "MILD_AWAY"
  | "STRONG_AWAY"
  | "HEAVY_AWAY";

export type HandballRuleId = "X3" | "1B" | "3B" | "TERS_3A" | "5B" | "U2" | "OVER_STEAM";

export type HandballSignal = {
  id: HandballRuleId;
  name: string;
  /** e.g. "MS X (Draw)" */
  pick: string;
  /** Current median closing odd of the pick (null if the market is missing) */
  pickOdd: number | null;
  /** Archive performance of the rule */
  sample: number;
  avgOdds: number;
  hitRate: number;
  roi: number;
  positiveSeasons: string;
  maxDrawdown?: string;
  /** Why the rule fired for this match */
  reason: string;
  note?: string;
};

export type HandballEngineMetrics = {
  leagueSlug: string;
  bookmakerCount: number;

  // 1X2 (median closing odds)
  c1: number | null;
  cx: number | null;
  c2: number | null;
  /** Margin-free probabilities in % */
  pHome: number | null;
  pDraw: number | null;
  pAway: number | null;

  tier: HandballTier;
  tierLabel: string;
  favoriteSide: "HOME" | "AWAY" | "NONE";
  favoriteOdds: number | null;
  drawProneBand: boolean;

  // Totals
  ouLine: number | null;
  overOdds: number | null;
  underOdds: number | null;
  pOver: number | null;
  pUnder: number | null;
  tempo: "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
  /** Archive-average goals for this match type (anchor, not a forecast) */
  archiveGoalAnchor: number;

  // Handicap
  ahLine: number | null;
  ahHomeOdds: number | null;
  ahAwayOdds: number | null;

  // Open -> close drift (median across bookmakers, %)
  moveHome: number | null;
  moveDraw: number | null;
  moveAway: number | null;
  moveOver: number | null;
  moveUnder: number | null;
  moneyFlow1X2: string;
  ouFlow: string;

  profile: string;
  ftVerdict: string;
  totalVerdict: string;
  marketVerdict: string;

  signals: HandballSignal[];
  anomalies: string[];
};

/* ------------------------------------------------------------------ */
/* Archive constants (from the study)                                  */
/* ------------------------------------------------------------------ */

const X3_LEAGUES = [
  "germany/bundesliga",
  "portugal/andebol-1",
  "hungary/nb-i",
  "spain/liga-asobal",
  "europe/champions-league",
  "croatia/premijer-liga",
];

const R1B_LEAGUES = [
  "turkey/superlig",
  "hungary/nb-i",
  "romania/liga-nationala",
  "austria/hla",
  "serbia/arkus-liga",
  "france/starligue",
  "iceland/olis-deildin",
];

const U2_LEAGUES = [
  "sweden/handbollsligan",
  "japan/league-h",
  "finland/aktialiiga",
  "spain/liga-asobal",
  "europe/champions-league",
  "norway/elkjop-ligaen",
  "czech-republic/extraliga",
  "poland/superliga",
];

const KOREA = "south-korea/h-league";

const ARCHIVE_AVG_GOALS = 58.04;

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 1 ? n : null;
}

function slug(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const compact = (s: string) => s.replace(/-/g, "");

const COUNTRY_ALIAS: Record<string, string> = {
  turkiye: "turkey",
  czechia: "czech-republic",
  "korea-republic": "south-korea",
  "republic-of-korea": "south-korea",
};

export function handballLeagueSlug(country: string | null | undefined, league: string | null | undefined): string {
  const c = slug(country);
  return `${COUNTRY_ALIAS[c] ?? c}/${slug(league)}`;
}

/** Fuzzy league match: same country + league name equal / contained (dash-insensitive). */
function inLeagues(leagueSlug: string, rules: string[]): boolean {
  const [cs, ls] = leagueSlug.split("/");
  if (!cs || !ls) return false;
  return rules.some((r) => {
    const [rc, rl] = r.split("/");
    const countryOk = cs === rc || cs.includes(rc) || rc.includes(cs);
    const a = compact(ls);
    const b = compact(rl);
    const leagueOk = a === b || a.includes(b) || b.includes(a);
    return countryOk && leagueOk;
  });
}

const pct = (v: number | null, d = 1): string => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`);
const r1 = (v: number) => Math.round(v * 10) / 10;

/* ------------------------------------------------------------------ */
/* Odds extraction (all bookmakers)                                    */
/* ------------------------------------------------------------------ */

type Pair = { o: number | null; c: number | null };
type LineMap = Map<number, { a: Pair; b: Pair }>; // a = home/over, b = away/under

type BmBook = {
  h: Pair;
  d: Pair;
  a: Pair;
  ah: LineMap;
  ou: LineMap;
};

function newPair(): Pair {
  return { o: null, c: null };
}

function setPair(p: Pair, row: CompactOddsRow) {
  const op = num(row[4]);
  const cl = num(row[5]);
  if (p.o == null) p.o = op ?? cl;
  if (p.c == null) p.c = cl ?? op;
}

function lineEntry(m: LineMap, line: number) {
  let e = m.get(line);
  if (!e) {
    e = { a: newPair(), b: newPair() };
    m.set(line, e);
  }
  return e;
}

function readBooks(odds: CompactOddsRow[]): Map<number, BmBook> {
  const books = new Map<number, BmBook>();
  for (const row of odds) {
    const bid = Number(row[0]);
    if (!Number.isFinite(bid)) continue;
    const t = String(row[1] ?? "").toLowerCase();
    const sc = String(row[2] ?? "").toLowerCase();
    if (sc !== "full_time" && sc !== "ft") continue;
    const side = String(row[3] ?? "").toLowerCase();

    let bk = books.get(bid);
    if (!bk) {
      bk = { h: newPair(), d: newPair(), a: newPair(), ah: new Map(), ou: new Map() };
      books.set(bid, bk);
    }

    if (t === "home_draw_away" || t === "1x2" || t === "match_odds") {
      if (side === "h" || side === "home" || side === "1") setPair(bk.h, row);
      else if (side === "d" || side === "draw" || side === "x") setPair(bk.d, row);
      else if (side === "a" || side === "away" || side === "2") setPair(bk.a, row);
      continue;
    }

    if (t === "asian_handicap" || t === "ah" || t === "handicap") {
      const [k, v] = side.split(":");
      const line = Number(v);
      if (!Number.isFinite(line)) continue;
      if (k === "h" || k === "home") setPair(lineEntry(bk.ah, line).a, row);
      // away side is stored on the mirrored line: a:+6.5 pairs with h:-6.5
      else if (k === "a" || k === "away") setPair(lineEntry(bk.ah, -line).b, row);
      continue;
    }

    if (t === "over_under" || t === "totals" || t === "total" || t === "ou") {
      const [k, v] = side.split(":");
      const line = Number(v);
      if (!Number.isFinite(line)) continue;
      if (k === "over" || k === "o") setPair(lineEntry(bk.ou, line).a, row);
      else if (k === "under" || k === "u") setPair(lineEntry(bk.ou, line).b, row);
    }
  }
  return books;
}

/** Main line of one bookmaker = the line whose "a" side (home / over) is closest to 1.90. */
function mainLine(m: LineMap): number | null {
  let best: number | null = null;
  let bestDiff = Infinity;
  for (const [line, e] of m) {
    const odd = e.a.c ?? e.a.o;
    if (odd == null) continue;
    const diff = Math.abs(odd - 1.9);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = line;
    }
  }
  return best;
}

/** Consensus line across bookmakers: mode of main lines (ties -> closest to median). */
function consensusLine(lines: number[]): number | null {
  if (!lines.length) return null;
  const counts = new Map<number, number>();
  for (const l of lines) counts.set(l, (counts.get(l) ?? 0) + 1);
  const med = median(lines) as number;
  let best: number | null = null;
  let bestCount = -1;
  for (const [l, c] of counts) {
    if (c > bestCount || (c === bestCount && best != null && Math.abs(l - med) < Math.abs(best - med))) {
      best = l;
      bestCount = c;
    }
  }
  return best;
}

function marginFree(odds: (number | null)[]): (number | null)[] {
  if (odds.some((o) => o == null)) return odds.map(() => null);
  const inv = (odds as number[]).map((o) => 1 / o);
  const sum = inv.reduce((a, b) => a + b, 0);
  return inv.map((x) => r1((x / sum) * 100));
}

const moveOf = (p: Pair): number | null =>
  p.o != null && p.c != null && p.o > 0 ? (p.c / p.o - 1) * 100 : null;

/* ------------------------------------------------------------------ */
/* Tiering                                                             */
/* ------------------------------------------------------------------ */

function tierOf(c1: number | null): { tier: HandballTier; label: string } {
  if (c1 == null) return { tier: "BALANCED", label: "Unknown Side" };
  if (c1 < 1.25) return { tier: "HEAVY_HOME", label: "Heavy Home Favourite" };
  if (c1 < 1.5) return { tier: "STRONG_HOME", label: "Strong Home Favourite" };
  if (c1 < 1.85) return { tier: "MILD_HOME", label: "Mild Home Favourite" };
  if (c1 < 2.9) return { tier: "BALANCED", label: "Balanced" };
  if (c1 < 4.0) return { tier: "MILD_AWAY", label: "Mild Away Favourite" };
  if (c1 < 6.5) return { tier: "STRONG_AWAY", label: "Strong Away Favourite" };
  return { tier: "HEAVY_AWAY", label: "Heavy Away Favourite" };
}

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

export function computeHandballEngine(
  odds: CompactOddsRow[] | null | undefined,
  leagueCountry?: string | null,
  leagueName?: string | null,
): HandballEngineMetrics | null {
  if (!odds?.length) return null;

  const books = readBooks(odds);
  const bms = [...books.values()];
  const with1x2 = bms.filter((b) => b.h.c != null && b.d.c != null && b.a.c != null);
  if (!with1x2.length) return null;

  const leagueSlug = handballLeagueSlug(leagueCountry, leagueName);

  /* --- 1X2 medians --- */
  const c1 = median(with1x2.map((b) => b.h.c as number));
  const cx = median(with1x2.map((b) => b.d.c as number));
  const c2 = median(with1x2.map((b) => b.a.c as number));
  const [pHome, pDraw, pAway] = marginFree([c1, cx, c2]);

  const moveHome = median(with1x2.map((b) => moveOf(b.h)).filter((x): x is number => x != null));
  const moveDraw = median(with1x2.map((b) => moveOf(b.d)).filter((x): x is number => x != null));
  const moveAway = median(with1x2.map((b) => moveOf(b.a)).filter((x): x is number => x != null));

  /* --- Asian handicap --- */
  const ahLine = consensusLine(
    bms.map((b) => mainLine(b.ah)).filter((x): x is number => x != null),
  );
  let ahHomeOdds: number | null = null;
  let ahAwayOdds: number | null = null;
  if (ahLine != null) {
    ahHomeOdds = median(
      bms.map((b) => b.ah.get(ahLine)?.a.c ?? null).filter((x): x is number => x != null),
    );
    ahAwayOdds = median(
      bms.map((b) => b.ah.get(ahLine)?.b.c ?? null).filter((x): x is number => x != null),
    );
  }

  /* --- Totals --- */
  const ouLine = consensusLine(
    bms.map((b) => mainLine(b.ou)).filter((x): x is number => x != null),
  );
  let overOdds: number | null = null;
  let underOdds: number | null = null;
  let moveOver: number | null = null;
  let moveUnder: number | null = null;
  if (ouLine != null) {
    overOdds = median(bms.map((b) => b.ou.get(ouLine)?.a.c ?? null).filter((x): x is number => x != null));
    underOdds = median(bms.map((b) => b.ou.get(ouLine)?.b.c ?? null).filter((x): x is number => x != null));
    moveOver = median(
      bms
        .map((b) => (b.ou.get(ouLine) ? moveOf(b.ou.get(ouLine)!.a) : null))
        .filter((x): x is number => x != null),
    );
    moveUnder = median(
      bms
        .map((b) => (b.ou.get(ouLine) ? moveOf(b.ou.get(ouLine)!.b) : null))
        .filter((x): x is number => x != null),
    );
  }
  const [pOver, pUnder] = marginFree([overOdds, underOdds]);

  /* --- Tier / tempo --- */
  const { tier, label: tierLabel } = tierOf(c1);
  const favoriteSide: "HOME" | "AWAY" | "NONE" =
    tier === "BALANCED" ? "NONE" : tier.endsWith("HOME") ? "HOME" : "AWAY";
  const favoriteOdds = c1 != null && c2 != null ? Math.min(c1, c2) : null;
  const drawProneBand = c1 != null && ((c1 >= 1.5 && c1 <= 1.85) || (c1 >= 2.9 && c1 <= 4.0));
  const oneSided = tier === "HEAVY_HOME" || tier === "HEAVY_AWAY";
  const archiveGoalAnchor = oneSided ? 59.4 : tier === "BALANCED" ? 57.4 : ARCHIVE_AVG_GOALS;

  const tempo: HandballEngineMetrics["tempo"] =
    ouLine == null ? "UNKNOWN" : ouLine >= 60.5 ? "HIGH" : ouLine <= 56.5 ? "LOW" : "MEDIUM";

  /* ---------------------------------------------------------------- */
  /* Rule signals                                                      */
  /* ---------------------------------------------------------------- */
  const signals: HandballSignal[] = [];
  const anomalies: string[] = [];

  const inX3 = inLeagues(leagueSlug, X3_LEAGUES);
  const in1B = inLeagues(leagueSlug, R1B_LEAGUES);
  const inU2 = inLeagues(leagueSlug, U2_LEAGUES);
  const inKorea = inLeagues(leagueSlug, [KOREA]);

  // Rule X3 — draw in draw-prone leagues
  if (inX3 && favoriteOdds != null && favoriteOdds >= 1.45 && favoriteOdds <= 2.4 && ouLine != null && ouLine <= 58.5) {
    const ahOk = ahLine != null && ahLine >= -1.5 && ahLine <= 1.5;
    signals.push({
      id: "X3",
      name: "Rule X3 — High-Odds Draw",
      pick: "FT Draw (X)",
      pickOdd: cx,
      sample: 1705,
      avgOdds: 7.97,
      hitRate: 13.9,
      roi: 9.85,
      positiveSeasons: "6/7",
      reason: `Draw-prone league, favourite @${favoriteOdds.toFixed(2)} (1.45–2.40), total line ${ouLine} (≤ 58.5)${
        ahOk ? `, AH ${ahLine} inside ±1.5 (booster)` : ""
      }.`,
      note: ahOk ? "Asian handicap booster is present." : "Asian handicap booster not present — weaker version of the rule.",
    });
  }

  // Rule 1B — heavy home favourite in high-scoring leagues -> Over
  if (in1B && c1 != null && c1 < 1.25) {
    signals.push({
      id: "1B",
      name: "Rule 1B — Heavy Home Fav in High-Scoring League",
      pick: `FT Over${ouLine != null ? ` ${ouLine}` : ""}`,
      pickOdd: overOdds,
      sample: 1711,
      avgOdds: 1.82,
      hitRate: 58.9,
      roi: 6.77,
      positiveSeasons: "7/9",
      maxDrawdown: "-17.6u",
      reason: `Home @${c1.toFixed(2)} (< 1.25) in a goal-heavy league.`,
      note: "Single Over beats the 1 & Over combo (about 2.5x more profitable, lower risk).",
    });
  }

  // Rule 3B — big handicap + high line -> Over
  if (ahLine != null && ahLine <= -6.5 && ouLine != null && ouLine >= 60.5) {
    signals.push({
      id: "3B",
      name: "Rule 3B — Big Margin + High Tempo",
      pick: `FT Over ${ouLine}`,
      pickOdd: overOdds,
      sample: 1229,
      avgOdds: 1.82,
      hitRate: 57.4,
      roi: 4.5,
      positiveSeasons: "6/8",
      maxDrawdown: "-14.4u",
      reason: `Home AH ${ahLine} (≤ -6.5) with total line ${ouLine} (≥ 60.5). All leagues.`,
    });
  }

  // Rule Reverse-3A — big handicap + low line -> Over
  if (ahLine != null && ahLine <= -6.5 && ouLine != null && ouLine <= 56.5) {
    signals.push({
      id: "TERS_3A",
      name: "Rule Reverse-3A — Big Margin + Suppressed Line",
      pick: `FT Over ${ouLine}`,
      pickOdd: overOdds,
      sample: 747,
      avgOdds: 1.81,
      hitRate: 57.4,
      roi: 3.72,
      positiveSeasons: "6/9",
      maxDrawdown: "-17.4u",
      reason: `Home AH ${ahLine} (≤ -6.5) but the line is pulled down to ${ouLine} (≤ 56.5): books assume the weak side gets locked down.`,
    });
  }

  // Rule 5B — South Korea neutral-venue anomaly -> Away
  if (inKorea && c1 != null && c1 >= 1.25 && c1 <= 1.85) {
    signals.push({
      id: "5B",
      name: "Rule 5B — Korea Neutral-Venue Anomaly",
      pick: "FT Away (2)",
      pickOdd: c2,
      sample: 151,
      avgOdds: 3.4,
      hitRate: 35.8,
      roi: 15.97,
      positiveSeasons: "6/7",
      maxDrawdown: "-9.2u",
      reason: `H-League home priced as favourite @${c1.toFixed(2)} although games are played tournament / neutral-venue style.`,
      note: "Small sample (151). Treat as an anomaly, not a base rate.",
    });
  }

  // Rule U2 — home underdog with handicap pressure -> Home win
  if (inU2 && c1 != null && c1 >= 2.6 && c1 <= 7.5 && ahLine != null && ahLine > 0 && ahHomeOdds != null && ahHomeOdds <= 1.83) {
    const sweet = c1 >= 3.55 && c1 <= 3.75;
    signals.push({
      id: "U2",
      name: "Rule U2 — Handicap-Pressured Home Underdog",
      pick: "FT Home (1)",
      pickOdd: c1,
      sample: 798,
      avgOdds: 3.91,
      hitRate: 28.1,
      roi: 1.6,
      positiveSeasons: "n/a",
      reason: `Home underdog @${c1.toFixed(2)}, AH +${ahLine} home price pressed to @${ahHomeOdds.toFixed(2)} (≤ 1.83).${
        sweet ? " Inside the 3.55–3.75 sweet band." : ""
      }`,
      note: "Marginal edge (+1.6% ROI). Weakest of the six rules.",
    });
  }

  /* ---------------------------------------------------------------- */
  /* Traps & drift warnings                                            */
  /* ---------------------------------------------------------------- */
  if (ahLine != null && Math.abs(ahLine) <= 1.5 && ouLine != null && ouLine >= 60.5) {
    anomalies.push(
      "Even match + high line trap: AH within ±1.5 and total line ≥ 60.5 — FT Over hits only 46.8% (-14.34% ROI). Late-game defence tightens in even games.",
    );
  }
  if (ahLine != null && ahLine <= -6.5 && ouLine != null && ouLine <= 56.5) {
    anomalies.push(
      "Big margin + low line: avoid FT Under — it hits only 42.6% (-21.14% ROI). The only profitable side of this shape is Over (Reverse-3A).",
    );
  }
  if (inX3 && ouLine != null && ouLine > 58.5) {
    anomalies.push(
      `Draw-league high line trap: total line ${ouLine} (> 58.5) — draw rate falls from 13.9% to 11.3% and FT Draw returns -8.39% ROI. Rule X3 is off.`,
    );
  }
  if (c2 != null && c2 >= 2.5 && !signals.some((s) => s.id === "5B")) {
    anomalies.push(
      `Away-underdog chase warning: Away @${c2.toFixed(2)} (≥ 2.50). Without a league filter, away upsets lose -9.9% to -68.3% ROI across every odds band.`,
    );
  }
  if (moveHome != null && moveHome <= -10) {
    anomalies.push(
      `Home price crashed ${pct(moveHome)} open→close. Buying a sharply shortened 1X2 side at the close lost -13.75% ROI in the archive — the market over-reacts to line-up / injury news.`,
    );
  }
  if (moveAway != null && moveAway <= -10) {
    anomalies.push(
      `Away price crashed ${pct(moveAway)} open→close. Buying a sharply shortened 1X2 side at the close lost -22.59% ROI in the archive — the market over-reacts to line-up / injury news.`,
    );
  }

  /* ---------------------------------------------------------------- */
  /* Flow labels                                                       */
  /* ---------------------------------------------------------------- */
  let moneyFlow1X2 = "STABLE";
  const sides: [string, number | null][] = [
    ["HOME", moveHome],
    ["AWAY", moveAway],
  ];
  const sharpest = sides
    .filter(([, v]) => v != null)
    .sort((a, b) => (a[1] as number) - (b[1] as number))[0];
  if (sharpest && (sharpest[1] as number) <= -10) moneyFlow1X2 = `${sharpest[0]} SHARP ▼ ${pct(sharpest[1])}`;
  else if (sharpest && (sharpest[1] as number) <= -4) moneyFlow1X2 = `${sharpest[0]} STEAM ▼ ${pct(sharpest[1])}`;

  let ouFlow = "STABLE";
  if (moveOver != null && moveOver <= -5) {
    ouFlow = `OVER STEAM ▼ ${pct(moveOver)}`;
    if (ouLine != null) {
      // Archive: Over price down >= 5% on a fixed line -> 57.9% hit, +0.39% ROI even at the close
      signals.push({
        id: "OVER_STEAM",
        name: "Over Steam (line unchanged)",
        pick: `FT Over ${ouLine}`,
        pickOdd: overOdds,
        sample: 1738,
        avgOdds: 0,
        hitRate: 57.9,
        roi: 0.39,
        positiveSeasons: "n/a",
        reason: `Over price shortened ${pct(moveOver)} with the line held at ${ouLine}.`,
        note: "Thin edge: only +0.39% ROI even at the closing price. Context signal, not a standalone bet.",
      });
    }
  } else if (moveUnder != null && moveUnder <= -5) {
    ouFlow = `UNDER STEAM ▼ ${pct(moveUnder)}`;
  }

  /* ---------------------------------------------------------------- */
  /* Verdicts                                                          */
  /* ---------------------------------------------------------------- */
  let ftVerdict: string;
  switch (tier) {
    case "HEAVY_HOME":
      ftVerdict = "HEAVY HOME FAVOURITE — archive win rate 89.5% vs 83.1% priced (+6.4 pts)";
      break;
    case "HEAVY_AWAY":
      ftVerdict = "HEAVY AWAY FAVOURITE — away wins 91.9%; home upset priced 8.8% but lands only 5.1%";
      break;
    case "MILD_HOME":
    case "MILD_AWAY":
      ftVerdict = "DRAW-PRONE BAND — draws land 10.2–10.4% of the time vs 6.43% archive average";
      break;
    case "BALANCED":
      ftVerdict = "BALANCED MATCH — tight, defence-first game (archive average ≈ 57.4 goals)";
      break;
    default:
      ftVerdict = "CONTROLLED FAVOURITE CORRIDOR — clear side, normal tempo";
  }

  let totalVerdict: string;
  if (ouLine == null) {
    totalVerdict = "No usable Over/Under line.";
  } else {
    const diff = ouLine - archiveGoalAnchor;
    const vs =
      Math.abs(diff) < 1
        ? "in line with"
        : diff > 0
          ? `${diff.toFixed(1)} above`
          : `${Math.abs(diff).toFixed(1)} below`;
    totalVerdict = `${tempo} TEMPO LINE ${ouLine} — ${vs} the ≈ ${archiveGoalAnchor.toFixed(1)}-goal archive anchor for this match type`;
  }

  const signalCount = signals.filter((s) => s.id !== "OVER_STEAM").length;
  const marketVerdict =
    signalCount > 0 && anomalies.length === 0
      ? `${signalCount} archive rule${signalCount > 1 ? "s" : ""} matched, no trap flags`
      : signalCount > 0
        ? `${signalCount} rule${signalCount > 1 ? "s" : ""} matched, but ${anomalies.length} warning${anomalies.length > 1 ? "s" : ""} — check below`
        : anomalies.length > 0
          ? `No rule edge — ${anomalies.length} warning${anomalies.length > 1 ? "s" : ""} (avoid forcing a bet)`
          : "No rule edge — pass";

  const profile = `${tierLabel} · ${tempo === "UNKNOWN" ? "No Line" : `${tempo[0]}${tempo.slice(1).toLowerCase()} Tempo`}`;

  return {
    leagueSlug,
    bookmakerCount: with1x2.length,
    c1,
    cx,
    c2,
    pHome,
    pDraw,
    pAway,
    tier,
    tierLabel,
    favoriteSide,
    favoriteOdds,
    drawProneBand,
    ouLine,
    overOdds,
    underOdds,
    pOver,
    pUnder,
    tempo,
    archiveGoalAnchor,
    ahLine,
    ahHomeOdds,
    ahAwayOdds,
    moveHome,
    moveDraw,
    moveAway,
    moveOver,
    moveUnder,
    moneyFlow1X2,
    ouFlow,
    profile,
    ftVerdict,
    totalVerdict,
    marketVerdict,
    signals,
    anomalies,
  };
}
