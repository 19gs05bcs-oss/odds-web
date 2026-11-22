/**
 * Basketball Market & Tempo engine.
 *
 * Reads a single basketball fixture's own odds (all bookmakers, median close/open),
 * classifies the league ecosystem (NBA / CBA / NBL / FIBA-Europe) and maps the match
 * onto the rules mined from the basketball archive backtest
 * (Flashscore archive, 29,641 played matches, 29,628 with half-time scores).
 *
 * Pure + client-safe: no env / DB / R2 access. A regime classification built on
 * historical archive statistics, NOT a guaranteed prediction.
 */
import type { CompactOddsRow } from "@/lib/basketballOdds";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type BasketballEcosystem = "NBA" | "CBA" | "NBL" | "FIBA";

export type BasketballTier =
  | "HEAVY_HOME"
  | "STRONG_HOME"
  | "MILD_HOME"
  | "BALANCED"
  | "MILD_AWAY"
  | "STRONG_AWAY"
  | "HEAVY_AWAY";

export type BasketballSignal = {
  id: string;
  name: string;
  /** e.g. "FT Under 160.5" */
  pick: string;
  /** Current median closing odd of the pick (null if the market is missing) */
  pickOdd: number | null;
  /** One-line archive performance, e.g. "395 matches · hit 58.7% · ROI +9.78% · +seasons 5/5" */
  statsLine: string;
  /** Why the rule fired for this match */
  reason: string;
  note?: string;
  /** Live / half-time regime signal (context, not a pre-match bet) */
  context?: boolean;
};

export type BasketballEngineMetrics = {
  leagueSlug: string;
  ecosystem: BasketballEcosystem;
  ecosystemLabel: string;
  bookmakerCount: number;

  // 2-way moneyline (median closing odds, OT included when available)
  c1: number | null;
  c2: number | null;
  /** Margin-free probabilities in % */
  pHome: number | null;
  pAway: number | null;

  tier: BasketballTier;
  tierLabel: string;
  favoriteSide: "HOME" | "AWAY" | "NONE";
  favoriteOdds: number | null;

  // Totals
  ouLine: number | null;
  overOdds: number | null;
  underOdds: number | null;
  pOver: number | null;
  pUnder: number | null;
  tempo: "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
  /** Archive-average total points for this ecosystem (anchor, not a forecast) */
  archiveTotalAnchor: number;

  // Spread
  ahLine: number | null;
  ahHomeOdds: number | null;
  ahAwayOdds: number | null;

  // Open -> close drift (median across bookmakers, %)
  moveHome: number | null;
  moveAway: number | null;
  moveOver: number | null;
  moveUnder: number | null;
  moneyFlow: string;
  ouFlow: string;

  /** Half-time regime read (only when a 1st-half score exists) */
  halftime: {
    homeHt: number;
    awayHt: number;
    htTotal: number;
    halfLine: number;
    delta: number;
    state: "FAST" | "SLOW" | "NORMAL";
    label: string;
  } | null;

  profile: string;
  ftVerdict: string;
  totalVerdict: string;
  marketVerdict: string;

  signals: BasketballSignal[];
  anomalies: string[];
};

/* ------------------------------------------------------------------ */
/* Archive constants (from the backtest)                               */
/* ------------------------------------------------------------------ */

const NBA = ["usa/nba"];
const CBA = ["china/cba"];
const NBL = ["australia/nbl"];

const B01_LEAGUES = ["turkey/bsl", "turkey/super-ligi", "germany/bbl", "europe/champions-league", "europe/fiba-champions-league"];
const B02_LEAGUES = ["spain/acb"];
const B04_LEAGUES = ["germany/bbl", "europe/champions-league", "europe/fiba-champions-league", "finland/korisliiga"];
const B05_LEAGUES = ["greece/basket-league", "finland/korisliiga"];
const EUROLEAGUE = ["europe/euroleague"];
const ITALY = ["italy/lega-a"];
const SWEDEN = ["sweden/basketligan"];

const ANCHOR: Record<BasketballEcosystem, number> = { NBA: 228.5, CBA: 197.5, NBL: 183.5, FIBA: 166 };
const ECO_LABEL: Record<BasketballEcosystem, string> = {
  NBA: "USA NBA · 48 min · high tempo",
  CBA: "China CBA · 48 min",
  NBL: "Australia NBL · 40 min · high tempo",
  FIBA: "FIBA / Europe & World · 40 min · low tempo",
};

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
  usa: "usa",
  "united-states": "usa",
  "united-states-of-america": "usa",
};

export function basketballLeagueSlug(country: string | null | undefined, league: string | null | undefined): string {
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
const inRange = (v: number | null, lo: number, hi: number) => v != null && v >= lo && v <= hi;

/* ------------------------------------------------------------------ */
/* Odds extraction (all bookmakers)                                    */
/* ------------------------------------------------------------------ */

type Pair = { o: number | null; c: number | null };
type LineMap = Map<number, { a: Pair; b: Pair }>; // a = home/over, b = away/under

type ScopeBook = { h: Pair; a: Pair; ah: LineMap; ou: LineMap };
type BmBook = Map<string, ScopeBook>; // scope -> book

const newPair = (): Pair => ({ o: null, c: null });

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
    const t = String(row[1] ?? "").toUpperCase();
    const sc = String(row[2] ?? "").toUpperCase();
    if (sc !== "FULL_TIME_OVER_TIME" && sc !== "FULL_TIME") continue;
    const side = String(row[3] ?? "").toUpperCase();

    let bk = books.get(bid);
    if (!bk) {
      bk = new Map();
      books.set(bid, bk);
    }
    let sb = bk.get(sc);
    if (!sb) {
      sb = { h: newPair(), a: newPair(), ah: new Map(), ou: new Map() };
      bk.set(sc, sb);
    }

    if (t === "HOME_AWAY") {
      if (side === "H") setPair(sb.h, row);
      else if (side === "A") setPair(sb.a, row);
      continue;
    }
    if (t === "ASIAN_HANDICAP") {
      const [k, v] = side.split(":");
      const line = Number(v);
      if (!Number.isFinite(line)) continue;
      if (k === "H") setPair(lineEntry(sb.ah, line).a, row);
      // away side is stored on the mirrored line: A:+3.5 pairs with H:-3.5
      else if (k === "A") setPair(lineEntry(sb.ah, -line).b, row);
      continue;
    }
    if (t === "OVER_UNDER") {
      const [k, v] = side.split(":");
      const line = Number(v);
      if (!Number.isFinite(line)) continue;
      if (k === "OVER") setPair(lineEntry(sb.ou, line).a, row);
      else if (k === "UNDER") setPair(lineEntry(sb.ou, line).b, row);
    }
  }
  return books;
}

/** Per bookmaker and market: overtime-inclusive scope when it has data, else regular time. */
function resolve(bk: BmBook): { h: Pair; a: Pair; ah: LineMap; ou: LineMap } {
  const ot = bk.get("FULL_TIME_OVER_TIME");
  const ft = bk.get("FULL_TIME");
  const pick = <T,>(has: (s: ScopeBook) => boolean, get: (s: ScopeBook) => T, empty: T): T => {
    if (ot && has(ot)) return get(ot);
    if (ft && has(ft)) return get(ft);
    return empty;
  };
  const ml = pick(
    (s) => s.h.c != null && s.a.c != null,
    (s) => ({ h: s.h, a: s.a }),
    { h: newPair(), a: newPair() },
  );
  return {
    h: ml.h,
    a: ml.a,
    ah: pick((s) => s.ah.size > 0, (s) => s.ah, new Map() as LineMap),
    ou: pick((s) => s.ou.size > 0, (s) => s.ou, new Map() as LineMap),
  };
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

const nn = (xs: (number | null)[]) => xs.filter((x): x is number => x != null);

/* ------------------------------------------------------------------ */
/* Tiering                                                             */
/* ------------------------------------------------------------------ */

function tierOf(c1: number | null): { tier: BasketballTier; label: string } {
  if (c1 == null) return { tier: "BALANCED", label: "Unknown Side" };
  if (c1 < 1.2) return { tier: "HEAVY_HOME", label: "Heavy Home Favourite" };
  if (c1 < 1.55) return { tier: "STRONG_HOME", label: "Strong Home Favourite" };
  if (c1 < 1.8) return { tier: "MILD_HOME", label: "Mild Home Favourite" };
  if (c1 < 2.4) return { tier: "BALANCED", label: "Balanced" };
  if (c1 < 3.5) return { tier: "MILD_AWAY", label: "Mild Away Favourite" };
  if (c1 < 5.5) return { tier: "STRONG_AWAY", label: "Strong Away Favourite" };
  return { tier: "HEAVY_AWAY", label: "Heavy Away Favourite" };
}

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

export function computeBasketballEngine(
  odds: CompactOddsRow[] | null | undefined,
  leagueCountry?: string | null,
  leagueName?: string | null,
  ht?: { home: unknown; away: unknown } | null,
): BasketballEngineMetrics | null {
  if (!odds?.length) return null;

  const bms = [...readBooks(odds).values()].map(resolve);
  const withMl = bms.filter((b) => b.h.c != null && b.a.c != null);
  if (!withMl.length) return null;

  const leagueSlug = basketballLeagueSlug(leagueCountry, leagueName);
  const ecosystem: BasketballEcosystem = inLeagues(leagueSlug, NBA)
    ? "NBA"
    : inLeagues(leagueSlug, CBA)
      ? "CBA"
      : inLeagues(leagueSlug, NBL)
        ? "NBL"
        : "FIBA";
  const threeLeague = ecosystem !== "FIBA";

  /* --- Moneyline --- */
  const c1 = median(nn(withMl.map((b) => b.h.c)));
  const c2 = median(nn(withMl.map((b) => b.a.c)));
  const [pHome, pAway] = marginFree([c1, c2]);
  const moveHome = median(nn(withMl.map((b) => moveOf(b.h))));
  const moveAway = median(nn(withMl.map((b) => moveOf(b.a))));

  /* --- Spread --- */
  const ahLine = consensusLine(nn(bms.map((b) => mainLine(b.ah))));
  let ahHomeOdds: number | null = null;
  let ahAwayOdds: number | null = null;
  if (ahLine != null) {
    ahHomeOdds = median(nn(bms.map((b) => b.ah.get(ahLine)?.a.c ?? null)));
    ahAwayOdds = median(nn(bms.map((b) => b.ah.get(ahLine)?.b.c ?? null)));
  }

  /* --- Totals --- */
  const ouLine = consensusLine(nn(bms.map((b) => mainLine(b.ou))));
  let overOdds: number | null = null;
  let underOdds: number | null = null;
  let moveOver: number | null = null;
  let moveUnder: number | null = null;
  if (ouLine != null) {
    overOdds = median(nn(bms.map((b) => b.ou.get(ouLine)?.a.c ?? null)));
    underOdds = median(nn(bms.map((b) => b.ou.get(ouLine)?.b.c ?? null)));
    moveOver = median(nn(bms.map((b) => (b.ou.get(ouLine) ? moveOf(b.ou.get(ouLine)!.a) : null))));
    moveUnder = median(nn(bms.map((b) => (b.ou.get(ouLine) ? moveOf(b.ou.get(ouLine)!.b) : null))));
  }
  const [pOver, pUnder] = marginFree([overOdds, underOdds]);

  /* --- Tier / tempo --- */
  const { tier, label: tierLabel } = tierOf(c1);
  const favoriteSide: "HOME" | "AWAY" | "NONE" =
    tier === "BALANCED" ? "NONE" : tier.endsWith("HOME") ? "HOME" : "AWAY";
  const favoriteOdds = c1 != null && c2 != null ? Math.min(c1, c2) : null;
  const archiveTotalAnchor = ANCHOR[ecosystem];
  const tempo: BasketballEngineMetrics["tempo"] =
    ouLine == null
      ? "UNKNOWN"
      : ouLine >= archiveTotalAnchor + 4
        ? "HIGH"
        : ouLine <= archiveTotalAnchor - 4
          ? "LOW"
          : "MEDIUM";

  const signals: BasketballSignal[] = [];
  const anomalies: string[] = [];
  const lineTxt = ouLine != null ? ` ${ouLine}` : "";
  const fmt = (v: number | null) => (v == null ? "—" : v.toFixed(2));

  /* ---------------------------------------------------------------- */
  /* Core pre-match rules B-01 … B-05                                   */
  /* ---------------------------------------------------------------- */
  if (inLeagues(leagueSlug, B01_LEAGUES) && inRange(c1, 2.6, 3.5)) {
    signals.push({
      id: "B-01",
      name: "B-01 — Mild Away Favourite → Under",
      pick: `FT Under${lineTxt}`,
      pickOdd: underOdds,
      statsLine: "395 matches · avg odds 1.87 · hit 58.7% · ROI +9.78% · +seasons 5/5 · max DD -9.5u",
      reason: `Turkey BSL / Germany BBL / FIBA BCL with home @${fmt(c1)} (2.60–3.50): the away favourite is not strong enough to push the pace.`,
    });
  }
  if (inLeagues(leagueSlug, B02_LEAGUES) && c1 != null && c1 < 1.2) {
    signals.push({
      id: "B-02",
      name: "B-02 — Spain ACB Heavy Home Fav → Over",
      pick: `FT Over${lineTxt}`,
      pickOdd: overOdds,
      statsLine: "431 matches · avg odds 1.86 · hit 58.7% · ROI +9.32% · +seasons 4/5 · max DD -19.4u",
      reason: `Spain ACB, home @${fmt(c1)} (< 1.20).`,
      note: "Largest drawdown of the core rules (-19.4u) — size stakes accordingly.",
    });
  }
  if (ecosystem === "NBA" && c1 != null && c1 >= 5.5 && ouLine != null && ouLine >= 214) {
    signals.push({
      id: "B-03",
      name: "B-03 — NBA Heavy Away Fav + High Line → Over",
      pick: `FT Over ${ouLine}`,
      pickOdd: overOdds,
      statsLine: "221 matches · avg odds 1.83 · hit 61.5% · ROI +12.60% · +seasons 4/5 · max DD -7.8u",
      reason: `NBA home @${fmt(c1)} (≥ 5.50) with total line ${ouLine} (≥ 214). Defensive resistance drops when the away side dominates.`,
    });
  }
  if (inLeagues(leagueSlug, B04_LEAGUES) && inRange(c1, 1.8, 2.1)) {
    signals.push({
      id: "B-04",
      name: "B-04 — Even Match → Under",
      pick: `FT Under${lineTxt}`,
      pickOdd: underOdds,
      statsLine: "325 matches · avg odds 1.88 · hit 58.8% · ROI +9.88% · +seasons 4/5 · max DD -9.1u",
      reason: `Germany BBL / FIBA BCL / Finland with home @${fmt(c1)} (1.80–2.10): tight game, defence-first.`,
    });
  }
  if (inLeagues(leagueSlug, B05_LEAGUES) && c1 != null && c1 < 1.2) {
    signals.push({
      id: "B-05",
      name: "B-05 — Greece / Finland Heavy Home Fav → Over",
      pick: `FT Over${lineTxt}`,
      pickOdd: overOdds,
      statsLine: "154 matches · avg odds 1.85 · hit 65.6% · ROI +21.12% · +seasons 2/2 · max DD -6.1u",
      reason: `Greece Basket League / Finland with home @${fmt(c1)} (< 1.20).`,
      note: "Only two seasons of evidence — strong numbers, short history.",
    });
  }

  /* ---------------------------------------------------------------- */
  /* League-specific edges                                              */
  /* ---------------------------------------------------------------- */
  if (inLeagues(leagueSlug, EUROLEAGUE) && inRange(c1, 2.6, 4.2)) {
    signals.push({
      id: "EL-HOME",
      name: "EuroLeague — Home Mid-Underdog Surprise",
      pick: "FT Home (1)",
      pickOdd: c1,
      statsLine: "172 matches · 71 wins · hit 41.3% · avg odds 3.09 · +41.6u · ROI +24.17%",
      reason: `EuroLeague home underdog @${fmt(c1)} (2.60–4.20).`,
    });
  }
  if (ecosystem === "CBA" && inRange(c1, 1.45, 1.8)) {
    signals.push({
      id: "CBA-FAV",
      name: "CBA — Home Court Resistance (mild favourite)",
      pick: "FT Home (1)",
      pickOdd: c1,
      statsLine: "110 matches · hit 75.5% · ROI +18.65%",
      reason: `CBA home favourite @${fmt(c1)} (1.45–1.80): the market systematically underrates home court.`,
    });
  }
  if (ecosystem === "CBA" && inRange(c1, 2.6, 5.5)) {
    signals.push({
      id: "CBA-DOG",
      name: "CBA — Home Court Resistance (underdog)",
      pick: "FT Home (1)",
      pickOdd: c1,
      statsLine: "160 matches · ROI +11.63% to +23.44% across the band",
      reason: `CBA home underdog @${fmt(c1)} (2.60–5.50).`,
    });
  }
  if (inLeagues(leagueSlug, ITALY) && inRange(c1, 4.2, 8.5)) {
    signals.push({
      id: "ITA-DOG",
      name: "Italy Lega A — Home Underdog Surprise",
      pick: "FT Home (1)",
      pickOdd: c1,
      statsLine: "hit 44.4% · avg odds 5.22 · ROI +131.08%",
      reason: `Lega A home underdog @${fmt(c1)} (4.20–8.50).`,
      note: "Extreme ROI on a thin, high-variance band — treat as an anomaly, not a base rate.",
    });
  }
  if (inLeagues(leagueSlug, SWEDEN) && inRange(c1, 2.6, 4.2)) {
    signals.push({
      id: "SWE-DOG",
      name: "Sweden Basketligan — Home Underdog Surprise",
      pick: "FT Home (1)",
      pickOdd: c1,
      statsLine: "hit 44.7% · ROI +34.45%",
      reason: `Basketligan home underdog @${fmt(c1)} (2.60–4.20).`,
    });
  }

  /* ---------------------------------------------------------------- */
  /* Odds × line matrix & twin clusters                                 */
  /* ---------------------------------------------------------------- */
  if (!threeLeague && ouLine != null && ouLine < 156 && c1 != null && c1 >= 2.4) {
    signals.push({
      id: "M-1",
      name: "Matrix 1 — FIBA Low Line + Away Favourite → Home Upset",
      pick: "FT Home (1)",
      pickOdd: c1,
      statsLine: "604 matches · home win rate 30.5% vs 24.2% baseline · blind ROI +0.6%",
      reason: `FIBA line ${ouLine} (< 156.0) with home @${fmt(c1)} (≥ 2.40): low-scoring games erase the talent gap.`,
      note: "Edge is a probability lift, not a large ROI — context signal.",
      context: true,
    });
  }
  if (threeLeague && inRange(c1, 1.8, 2.4) && ouLine != null && ouLine >= 228) {
    signals.push({
      id: "M-2",
      name: "Matrix 2 — Even Match + High Line → Under",
      pick: `FT Under ${ouLine}`,
      pickOdd: underOdds,
      statsLine: "470 matches · Over only 47.7% · Under ROI +3.0%",
      reason: `${ecosystem} even match (home @${fmt(c1)}) with line ${ouLine} (≥ 228).`,
    });
  }
  if (threeLeague && c1 != null && c1 >= 2.4 && ouLine != null && ouLine >= 214) {
    signals.push({
      id: "M-3",
      name: "Matrix 3 — Away Favourite + Mid/High Line → Over",
      pick: `FT Over ${ouLine}`,
      pickOdd: overOdds,
      statsLine: "1,511 matches · Over 55.3% · ROI +0.7% to +1.3%",
      reason: `${ecosystem} away favourite (home @${fmt(c1)}) with line ${ouLine} (≥ 214).`,
      note: "Thin edge on a large sample — a base-rate lean, not a standalone bet.",
      context: true,
    });
  }
  if (!threeLeague && inRange(c1, 1.35, 1.45)) {
    signals.push({
      id: "M-4A",
      name: "Matrix 4 — FIBA Squeeze Zone (home ≈ 1.35–1.45)",
      pick: "FT Away (2)",
      pickOdd: c2,
      statsLine: "away wins 38.6%–51.4% in micro-cells · ROI +17.3% to +36.0%",
      reason: `FIBA home @${fmt(c1)} sits in the squeeze band where away upsets are underpriced.`,
      note: "Micro-cell result — sample per cell is small.",
      context: true,
    });
  }
  if (!threeLeague && inRange(c1, 1.15, 1.25) && ouLine != null && inRange(ouLine, 173, 175)) {
    signals.push({
      id: "M-4B",
      name: "Matrix 4 — Twin Cluster (home ≈ 1.20, line ≈ 174)",
      pick: `FT Over ${ouLine}`,
      pickOdd: overOdds,
      statsLine: "48 matches · Over 75.0% · ROI +39.17%",
      reason: `FIBA home @${fmt(c1)} with line ${ouLine}.`,
      note: "Only 48 matches — twin-cluster anomaly.",
    });
  }

  /* ---------------------------------------------------------------- */
  /* Traps (anti-rules)                                                 */
  /* ---------------------------------------------------------------- */
  if (c1 != null && c2 != null) {
    const underdogIsHome = c1 > c2;
    const dogAh = underdogIsHome ? ahHomeOdds : ahAwayOdds;
    if (ahLine != null && dogAh != null && dogAh <= 1.83) {
      anomalies.push(
        `Pressed-handicap underdog: the ${underdogIsHome ? "home" : "away"} underdog's spread price is @${dogAh.toFixed(2)} (≤ 1.83). Chasing underdogs here without a league filter lost -634.2u (-16% to -18% ROI) in the archive.`,
      );
    }
  }
  if (ecosystem === "NBA" && inRange(c1, 1.8, 2.1)) {
    anomalies.push(
      "NBA even-match Over trap: with home between 1.80 and 2.10, Over lands only 47.8% (-12.01% ROI over 757 matches). Do not force Over.",
    );
  }
  if (threeLeague && c1 != null && c1 >= 2.4 && ouLine != null && ouLine < 214) {
    anomalies.push(
      `Away favourite + low line: ${ecosystem} away favourite with line ${ouLine} (< 214) — Over drops to 49.6% (-9.3% ROI over 466 matches). Matrix 3 is off.`,
    );
  }
  if (!threeLeague && !signals.some((s) => /Over|Under/.test(s.pick) && !s.context)) {
    anomalies.push(
      "FIBA totals caution: Over/Under without a league filter lost -108u to -170u in the archive. Only play totals where a named league rule fires.",
    );
  }

  /* ---------------------------------------------------------------- */
  /* Flow labels                                                        */
  /* ---------------------------------------------------------------- */
  let moneyFlow = "STABLE";
  const sides: [string, number | null][] = [
    ["HOME", moveHome],
    ["AWAY", moveAway],
  ];
  const sharpest = sides
    .filter(([, v]) => v != null)
    .sort((a, b) => (a[1] as number) - (b[1] as number))[0];
  if (sharpest && (sharpest[1] as number) <= -10) moneyFlow = `${sharpest[0]} SHARP ▼ ${pct(sharpest[1])}`;
  else if (sharpest && (sharpest[1] as number) <= -4) moneyFlow = `${sharpest[0]} STEAM ▼ ${pct(sharpest[1])}`;

  let ouFlow = "STABLE";
  if (moveOver != null && moveOver <= -5) ouFlow = `OVER STEAM ▼ ${pct(moveOver)}`;
  else if (moveUnder != null && moveUnder <= -5) ouFlow = `UNDER STEAM ▼ ${pct(moveUnder)}`;

  /* ---------------------------------------------------------------- */
  /* Half-time regime (regression to the mean)                          */
  /* ---------------------------------------------------------------- */
  let halftime: BasketballEngineMetrics["halftime"] = null;
  const hh = ht?.home != null && ht.home !== "" ? Number(ht.home) : NaN;
  const ha = ht?.away != null && ht.away !== "" ? Number(ht.away) : NaN;
  if (Number.isFinite(hh) && Number.isFinite(ha) && ouLine != null) {
    const htTotal = hh + ha;
    const halfLine = ouLine / 2;
    const delta = r1(htTotal - halfLine);
    const thr = threeLeague ? 10 : 8;
    const state: "FAST" | "SLOW" | "NORMAL" = delta >= thr ? "FAST" : delta <= -thr ? "SLOW" : "NORMAL";
    const label =
      state === "FAST"
        ? `1H TOO FAST — ${htTotal} pts vs half-line ${halfLine.toFixed(1)} (+${delta} pts)`
        : state === "SLOW"
          ? `1H TOO SLOW — ${htTotal} pts vs half-line ${halfLine.toFixed(1)} (${delta} pts)`
          : `1H NORMAL — ${htTotal} pts vs half-line ${halfLine.toFixed(1)}`;
    halftime = { homeHt: hh, awayHt: ha, htTotal, halfLine, delta, state, label };

    if (state === "FAST") {
      signals.push({
        id: "HT-FAST",
        name: "Half-Time Law — Fast 1H → 2H Under",
        pick: "Live 2nd-Half Under",
        pickOdd: null,
        statsLine: threeLeague
          ? "1,721 matches · 1H avg 127.6 → 2H avg 110.7 (-16.9 pts)"
          : "5,271 matches · 1H avg 96.5 → 2H avg 84.5 (-12.0 pts)",
        reason: `1H total ${htTotal} is ${delta} above the half-line (≥ +${thr}). Second-half scoring regresses to the league's normal half average.`,
        context: true,
      });
    } else if (state === "SLOW") {
      signals.push({
        id: "HT-SLOW",
        name: "Half-Time Law — Slow 1H → 2H Over",
        pick: "Live 2nd-Half Over",
        pickOdd: null,
        statsLine: threeLeague
          ? "1,504 matches · 1H avg 94.9 → 2H avg 108.5 (+13.6 pts)"
          : "4,337 matches · 1H avg 68.2 → 2H avg 81.1 (+12.9 pts)",
        reason: `1H total ${htTotal} is ${Math.abs(delta)} below the half-line (≥ ${thr} under). Second-half scoring regresses upward.`,
        context: true,
      });
    }

    // Half-time comeback asymmetry (favourite 1.15–1.55 trailing at the break)
    if (c1 != null && c2 != null) {
      if (inRange(c2, 1.15, 1.55) && ha < hh) {
        signals.push({
          id: "HT-AWAYFAV",
          name: "Half-Time Law — Trailing Away Favourite",
          pick: "Live FT Away (2)",
          pickOdd: null,
          statsLine: "comeback rate 16.8% · HT/FT 1/2 avg odds 6.00 · +47.8u · ROI +1.54%",
          reason: `Away favourite @${fmt(c2)} trails ${hh}-${ha} at half-time.`,
          note: "Marginal ROI — the edge is that the market over-discounts the comeback.",
          context: true,
        });
      }
      if (inRange(c1, 1.15, 1.55) && hh < ha) {
        anomalies.push(
          `Trailing home favourite: home @${fmt(c1)} is behind ${hh}-${ha} at half-time. HT/FT 2/1 lost -546.4u (-8.77% ROI) in the archive — do not back the comeback.`,
        );
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Verdicts                                                           */
  /* ---------------------------------------------------------------- */
  const ecoNote: Record<BasketballEcosystem, string> = {
    NBA: "away-favourite games lose defensive resistance and drift Over",
    CBA: "the market systematically underrates home-court advantage",
    NBL: "40-minute game at a high tempo (≈ 181–186 pts)",
    FIBA: "40-minute low-tempo game with heavy defensive physicality",
  };
  const ftVerdict =
    favoriteSide === "NONE"
      ? `BALANCED MATCH — home @${fmt(c1)} / away @${fmt(c2)}; ${ecosystem} note: ${ecoNote[ecosystem]}`
      : `${tierLabel.toUpperCase()} @${fmt(favoriteOdds)} — ${ecosystem} note: ${ecoNote[ecosystem]}`;

  let totalVerdict: string;
  if (ouLine == null) {
    totalVerdict = "No usable Over/Under line.";
  } else {
    const diff = ouLine - archiveTotalAnchor;
    const vs =
      Math.abs(diff) < 1 ? "in line with" : diff > 0 ? `${diff.toFixed(1)} above` : `${Math.abs(diff).toFixed(1)} below`;
    totalVerdict = `${tempo} TEMPO LINE ${ouLine} — ${vs} the ≈ ${archiveTotalAnchor.toFixed(1)}-point ${ecosystem} archive anchor`;
  }

  const signalCount = signals.filter((s) => !s.context).length;
  const marketVerdict =
    signalCount > 0 && anomalies.length === 0
      ? `${signalCount} archive rule${signalCount > 1 ? "s" : ""} matched, no trap flags`
      : signalCount > 0
        ? `${signalCount} rule${signalCount > 1 ? "s" : ""} matched, but ${anomalies.length} warning${anomalies.length > 1 ? "s" : ""} — check below`
        : anomalies.length > 0
          ? `No rule edge — ${anomalies.length} warning${anomalies.length > 1 ? "s" : ""} (avoid forcing a bet)`
          : "No rule edge — pass";

  const profile = `${ecosystem} · ${tierLabel} · ${tempo === "UNKNOWN" ? "No Line" : `${tempo[0]}${tempo.slice(1).toLowerCase()} Tempo`}`;

  return {
    leagueSlug,
    ecosystem,
    ecosystemLabel: ECO_LABEL[ecosystem],
    bookmakerCount: withMl.length,
    c1,
    c2,
    pHome,
    pAway,
    tier,
    tierLabel,
    favoriteSide,
    favoriteOdds,
    ouLine,
    overOdds,
    underOdds,
    pOver,
    pUnder,
    tempo,
    archiveTotalAnchor,
    ahLine,
    ahHomeOdds,
    ahAwayOdds,
    moveHome,
    moveAway,
    moveOver,
    moveUnder,
    moneyFlow,
    ouFlow,
    halftime,
    profile,
    ftVerdict,
    totalVerdict,
    marketVerdict,
    signals,
    anomalies,
  };
}
