import type { CompactOddsRow } from "@/lib/archiveCache";

/**
 * Anatomy Engine ("Market Detect") — ported from the Python odds radar
 * (run_radarv2.py: "akilli para / katı yön / skor radari"). File and export
 * names are kept as `anatomyEngine.ts` / `computeAnatomyEngine` on purpose —
 * only the underlying model changed, not the wiring.
 *
 * This replaces the old fixed 4-model pattern matcher (Blowout / Defensive
 * Lock / HT Lock / Fake Favourite Trap) with a live market-state reader:
 * it looks at how every quoted market moved between opening and current
 * price across all bookmakers offering this fixture, weights each move by
 * how many bookmakers confirm it (liquidity), and from that derives:
 *   - an X-ray side (which outcome the sharpest money is leaning on),
 *   - an expected goal-margin corridor,
 *   - a tempo/goal-count read (including a "super explosive" flag for
 *     short HT Over 1.5 + short FT Over 3.5 combinations),
 *   - a short list of "hot" Correct Score prices that shortened hardest.
 *
 * Same as htftEngine.ts / goalEngine.ts: pure client-side, computed only
 * from this match's own odds rows — no extra API request. The historical
 * "twin match" search from the Python script (looking up similar finished
 * matches in Postgres) is NOT ported here — that is a separate concern and
 * lives in the existing similarity search (similarityEngine.ts).
 *
 * READING LIMIT: this is a market-state scan, not a guaranteed outcome. If
 * the match hasn't been played yet, only the read itself is shown; once it
 * has finished (home_score/away_score present), it's compared to what
 * actually happened.
 */

export type MarketDirection = "UP" | "DOWN" | "FLAT";
export type XraySide = "LOW" | "DRAW" | "OVER" | "AWAY" | "HOME" | "NONE";

export type ExpectedMargin =
  | "MARGIN_INSIDER_LEAK"
  | "MARGIN_3_PLUS"
  | "MARGIN_HOME_RESISTANCE"
  | "MARGIN_TRAP"
  | "MARGIN_LOW_SCORING"
  | "MARGIN_OPEN_DRAW"
  | "MARGIN_OVER_LADDER"
  | "MARGIN_CLOSE_OR_UPSET"
  | "MARGIN_XRAY_AWAY"
  | "MARGIN_XRAY_HOME"
  | "MARGIN_STAGNANT_DRAW"
  | "MARGIN_1_2"
  | "MARGIN_FAV_WIN"
  | "ANY";

export type TargetTempo =
  | "SUPER_EXPLOSIVE"
  | "LOW_PACE"
  | "EXPLOSIVE_GOALS"
  | "HIGH_PACE"
  | "DECEPTIVE_TEMPO"
  | "BALANCED";

export type MarketMove = {
  label: string;
  openOdd: number;
  currentOdd: number;
  pctMove: number; // liquidity-weighted % move (negative = shortened)
  bookCount: number;
};

export type AnatomyActualCheck = {
  score: string;
  htScore: string | null;
  totalGoals: number;
  scoreHit: boolean; // actual score matched one of the hot Correct Score prices
  tempoHit: boolean | null; // null when the tempo read makes no directional goal-count claim
};

export type AnatomyEngineResult = {
  favSide: "HOME" | "AWAY";
  favOdd: number;
  homeDirection: MarketDirection;
  awayDirection: MarketDirection;
  xraySide: XraySide;
  expectedMargin: ExpectedMargin;
  marginLabel: string;
  targetTempo: TargetTempo;
  tempoLabel: string;
  isSuperExplosive: boolean;
  hotScores: string[]; // e.g. ["2:2", "1:1"] — Correct Score prices that shortened hardest
  topDrops: MarketMove[]; // biggest liquidity-weighted odds drops across every quoted market
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
// drift is a PERCENTAGE (e.g. 5.2 means +5.2%), matching the rest of this file's convention.
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

/** Liquidity weight: how much a move counts, scaled by how many bookmakers confirm it. */
function liqWeight(nb: number): number {
  if (nb <= 0) return 0.0;
  if (nb < 3) return 0.1;
  if (nb < 5) return 0.35;
  if (nb < 8) return 0.75;
  if (nb < 12) return 0.9;
  return 1.0;
}

function getDirection(deltaPct: number): MarketDirection {
  if (deltaPct <= -3.5) return "DOWN";
  if (deltaPct >= 3.5) return "UP";
  return "FLAT";
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

type MoveAgg = { open: number[]; cur: number[]; books: Set<number> };

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
  const htOver15 = newPool();
  const btts = { yes: newPool(), no: newPool() };
  const cs = new Map<string, PricePool>();
  const eh = new Map<string, PricePool>();
  const allMoves = new Map<string, MoveAgg>();

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

    // Generic per-market-per-selection aggregate — used for the liquidity
    // X-ray and the "biggest movers" list, regardless of market type.
    const label = `${type} (${scp}) - ${side}`;
    let agg = allMoves.get(label);
    if (!agg) {
      agg = { open: [], cur: [], books: new Set() };
      allMoves.set(label, agg);
    }
    if (op != null) agg.open.push(op);
    if (cur != null) agg.cur.push(cur);
    agg.books.add(Number(bookmakerId));

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
        if (lineStr === "1.5" && isOver) pushPool(htOver15, op, cur);
      }
      continue;
    }

    if (type === "BOTH_TEAMS_TO_SCORE" && scp === "FULL_TIME") {
      if (side.includes("YES")) pushPool(btts.yes, op, cur);
      else if (side.includes("NO")) pushPool(btts.no, op, cur);
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

    if (type === "EUROPEAN_HANDICAP" && scp === "FULL_TIME") {
      if (!eh.has(side)) eh.set(side, newPool());
      pushPool(eh.get(side)!, op, cur);
      continue;
    }
  }

  const msH = statsOf(ft.H);
  const msD = statsOf(ft.D);
  const msA = statsOf(ft.A);
  if (msH.eff == null || msD.eff == null || msA.eff == null) return null;

  let under25 = statsOf(ou25.under);
  if (under25.eff == null) under25 = statsOf(ouBare.under);
  let over25 = statsOf(ou25.over);
  if (over25.eff == null) over25 = statsOf(ouBare.over);
  const over35 = statsOf(ou35Over);
  const htOver15Stats = statsOf(htOver15);
  const bttsYes = statsOf(btts.yes);

  const o25Odd = over25.mo ?? 1.95;
  const u25Odd = under25.mo ?? 1.8;
  const o35Odd = over35.mo ?? 2.5;
  const htOver15Odd = htOver15Stats.mo ?? 2.5;
  const bttsYesOdd = bttsYes.mo ?? 1.8;
  const bttsNoOdd = statsOf(btts.no).mo ?? 1.9;
  const tDeltaO25 = over25.drift;
  const tDeltaBtts = bttsYes.drift;

  // Favourite side/price is read off the OPENING line (matches the Python
  // radar), not the current price — this is "who opened as favourite", used
  // as the anchor the rest of the read compares drift against.
  const favHomeOdd = msH.mo ?? msH.eff;
  const favAwayOdd = msA.mo ?? msA.eff;
  const favOdd = Math.min(favHomeOdd, favAwayOdd);
  const favSide: "HOME" | "AWAY" = favHomeOdd <= favAwayOdd ? "HOME" : "AWAY";
  const favTeamTok: "H" | "A" = favSide === "HOME" ? "H" : "A";
  const favDelta = favSide === "HOME" ? msH.drift : msA.drift;

  const targetDirH = getDirection(msH.drift);
  const targetDirA = getDirection(msA.drift);

  // 🌋 "Super explosive" flag: short HT Over 1.5 combined with a short FT
  // Over 3.5 tends to precede lower-league goal avalanches.
  const isSuperExplosive = htOver15Odd <= 2.0 && o35Odd <= 1.85;

  // Correct Score drift for 1:0 / 2:0 — used only by the tempo read below.
  const dCs10 = cs.has("1:0") ? statsOf(cs.get("1:0")!).drift : 0;
  const dCs20 = cs.has("2:0") ? statsOf(cs.get("2:0")!).drift : 0;

  // European Handicap drift for the favourite at -1 and -2 goals ("-1"/"-1.0"
  // but not "-1.5" etc.).
  function matchesHandicap(sel: string, n: 1 | 2): boolean {
    const base = `-${n}`;
    const dot = `-${n}.`;
    return (sel.includes(base) && !sel.includes(dot)) || sel.includes(`${dot}0`);
  }
  function findEh(n: 1 | 2): PricePool | null {
    for (const [sel, pool] of eh) {
      if (!sel.includes(favTeamTok)) continue;
      if (matchesHandicap(sel, n)) return pool;
    }
    return null;
  }
  const eh1Pool = findEh(1);
  const eh2Pool = findEh(2);
  const tDeltaEh1 = eh1Pool ? statsOf(eh1Pool).drift : 0;
  const tDeltaEh2 = eh2Pool ? statsOf(eh2Pool).drift : 0;

  const max1x2Move = Math.max(Math.abs(msH.drift), Math.abs(msD.drift), Math.abs(msA.drift));

  // ---- Liquidity X-ray: which side the sharpest, most-confirmed money is on ----
  const xrayEntries: { pct: number; nb: number; label: string }[] = [];
  const moveSummaries: MarketMove[] = [];
  for (const [label, agg] of allMoves) {
    if (!agg.open.length || !agg.cur.length) continue;
    const mo = median(agg.open);
    const mc = median(agg.cur);
    if (mo <= 1.05) continue;
    const pct = ((mc - mo) / mo) * 100;
    const nb = agg.books.size;

    // Weighted move, used for the "biggest movers" list and the hot-score scan.
    let adjPct = pct * liqWeight(nb);
    if (label.includes("CORRECT_SCORE (FIRST_HALF)") && mo > 15.0) adjPct = 0;
    moveSummaries.push({ label, openOdd: mo, currentOdd: mc, pctMove: adjPct, bookCount: nb });

    // Unweighted move, only counted toward the X-ray once enough bookmakers confirm it.
    if (nb >= 4 && mo <= 15.0) xrayEntries.push({ pct, nb, label });
  }
  moveSummaries.sort((a, b) => a.pctMove - b.pctMove);
  const topDrops = moveSummaries.filter((m) => m.pctMove < -2.0).slice(0, 8);
  const topRises = moveSummaries
    .filter((m) => m.pctMove > 2.0)
    .sort((a, b) => b.pctMove - a.pctMove)
    .slice(0, 5);

  let liqAway = 0;
  let liqHome = 0;
  let liqDraw = 0;
  let liqOver = 0;
  let liqLow = 0;
  let liqEhHome = 0;
  let liqEhAway = 0;
  for (const { pct, nb, label: L } of xrayEntries) {
    if (pct > -4.0) continue;
    const w = liqWeight(nb);
    const isFt = L.includes("(FULL_TIME)");

    if (L.includes("DRAW_NO_BET") && isFt) {
      const dnbSel = L.split("-").pop()?.trim() ?? "";
      if (dnbSel === "A") liqAway += w;
      else if (dnbSel === "H") liqHome += w;
      continue;
    }
    if (isFt && (L.includes("SCORE:0:0") || L.includes("UNDER:0.5") || L.includes("UNDER:1.5") || L.includes("UNDER:2.0"))) {
      liqLow += w;
      continue;
    }
    if (isFt && (L.includes("SCORE:1:1") || L.includes("SCORE:2:2") || L.includes("HTFT:1/X") || L.includes("HTFT:X/X"))) {
      liqDraw += w;
      continue;
    }
    if (isFt && L.includes("OVER:") && ["2.5", "3.5", "4.5", "5.5"].some((x) => L.includes(x))) {
      liqOver += w;
      continue;
    }
    if (L.includes("BOTH_TEAMS_TO_SCORE") && L.includes("YES")) {
      liqOver += w;
      continue;
    }
    if (L.includes("CORRECT_SCORE") && ["2:2", "3:2", "2:3", "3:3", "4:2", "2:4", "4:3", "3:4"].some((s) => L.includes(s))) {
      liqOver += w;
    }
    if (L.includes("FIRST_HALF") && L.includes("ASIAN_HANDICAP")) continue;

    if (isFt && (L.includes("HTFT:X/2") || L.includes("HTFT:2/2") || L.includes("SCORE:0:1") || L.includes("SCORE:0:2") || L.includes("SCORE:1:2"))) {
      liqAway += w;
    }
    if (isFt && L.includes("ASIAN_HANDICAP") && (L.includes("A:-1") || L.includes("A:-1.5") || L.includes("A:-2"))) {
      liqAway += w;
      liqEhAway += w;
    }
    if (isFt && L.includes("EUROPEAN_HANDICAP") && (L.includes("A:-1") || L.includes("A:-2"))) {
      liqEhAway += w;
      liqAway += w;
    }
    if (isFt && (L.includes("HTFT:1/1") || L.includes("SCORE:1:0") || L.includes("SCORE:2:0") || L.includes("SCORE:3:0"))) {
      liqHome += w;
    }
    if (isFt && L.includes("ASIAN_HANDICAP") && (L.includes("H:-1") || L.includes("H:-2"))) {
      liqHome += w;
      liqEhHome += w;
    }
    if (isFt && L.includes("EUROPEAN_HANDICAP") && (L.includes("H:-1") || L.includes("H:-2"))) {
      liqEhHome += w;
      liqHome += w;
    }
  }

  let xraySide: XraySide = "NONE";
  if (liqLow >= 2 && liqLow >= liqAway) xraySide = "LOW";
  else if (liqOver >= 3 && liqOver >= liqHome && liqOver >= liqAway) xraySide = "OVER";
  else if (liqDraw >= 2 && liqDraw >= liqHome && liqDraw >= liqAway) xraySide = "DRAW";
  else if (liqEhAway >= 2 || (liqAway >= 3 && liqAway > liqHome + 1)) xraySide = "AWAY";
  else if (liqEhHome >= 2 || (liqHome >= 3 && liqHome > liqAway + 1)) xraySide = "HOME";

  // A rising favourite handicap paired with the X-ray saying AWAY (while the
  // home favourite is actually drifting out) is more likely a false signal.
  if (xraySide === "AWAY" && favSide === "HOME" && tDeltaEh1 >= 5 && liqEhAway === 0) {
    xraySide = liqLow > 0 ? "LOW" : "NONE";
  }

  // ---- Hot Correct Score prices ----
  let trapScoreCount = 0;
  const hotFtLiquid: string[] = [];
  for (const m of topDrops) {
    if (m.label.includes("CORRECT_SCORE") && m.openOdd >= 80) continue;
    if (m.openOdd >= 8.0 && m.openOdd <= 45.0 && m.pctMove <= -18.0) trapScoreCount += 1;
    if (m.label.includes("CORRECT_SCORE (FULL_TIME)") && m.pctMove <= -15.0) {
      const match = m.label.match(/(\d+)\s*[:.]\s*(\d+)/);
      if (match && m.openOdd <= 12.0 && m.bookCount >= 5) {
        hotFtLiquid.push(`${match[1]}:${match[2]}`);
      }
    }
  }
  const hotScores = hotFtLiquid;
  const liquidOpenDraw = ["2:2", "3:3", "3:2", "2:3", "1:1", "4:4"].some((s) => hotScores.includes(s));

  const handicapConfirmedBlowout = tDeltaEh1 <= -8.0 && tDeltaEh2 <= -8.0 && tDeltaBtts >= -3.0 && !liquidOpenDraw;
  const isTrap =
    trapScoreCount >= 2 &&
    favOdd <= 1.85 &&
    favDelta < 2.0 &&
    !handicapConfirmedBlowout &&
    (tDeltaEh1 >= -2.0 || tDeltaEh2 >= 0.0);
  const isInsiderLeak =
    trapScoreCount >= 2 && favOdd > 1.85 && (max1x2Move >= 4.0 || tDeltaO25 <= -6.0 || tDeltaBtts <= -6.0);

  const isStagnant = max1x2Move <= 4.5 && Math.abs(tDeltaEh1) <= 4.0 && tDeltaBtts > -4.5 && tDeltaO25 > -4.5;

  // ---- Expected goal-margin corridor ----
  let expectedMargin: ExpectedMargin = "ANY";
  let marginLabel = "Open / unclear";

  if (isInsiderLeak) {
    expectedMargin = "MARGIN_INSIDER_LEAK";
    marginLabel = "Inside-info / chaos read (close match, money on long-shot scores)";
  } else if (handicapConfirmedBlowout) {
    expectedMargin = "MARGIN_3_PLUS";
    marginLabel = "3+ goal blowout (EH -1 and -2 both confirmed, BTTS fading)";
  } else if (msH.drift >= 7.0 && msA.drift <= -7.0 && favHomeOdd <= 2.6) {
    expectedMargin = "MARGIN_HOME_RESISTANCE";
    marginLabel = "Home resistance (away drifting out; expect 1-1 / 2-0 / 2-1)";
  } else if (isTrap) {
    expectedMargin = "MARGIN_TRAP";
    marginLabel = "Trap corridor (heavy favourite drifting out, max 1-goal margin)";
  } else if (xraySide === "LOW") {
    expectedMargin = "MARGIN_LOW_SCORING";
    marginLabel = "Liquid X-ray: 0-0 / Under 1.5 shortening (tight, locked match)";
  } else if (xraySide === "DRAW") {
    expectedMargin = "MARGIN_OPEN_DRAW";
    marginLabel = "Liquid X-ray: 1-1 / HTFT 1/X shortening (draw)";
  } else if (xraySide === "OVER") {
    expectedMargin = "MARGIN_OVER_LADDER";
    marginLabel = "Liquid X-ray: Over 2.5/3.5 and high-scoring lines shortening (chaos/explosion)";
  } else if (xraySide === "AWAY" && favSide === "HOME" && msH.drift >= 8.0) {
    expectedMargin = "MARGIN_CLOSE_OR_UPSET";
    marginLabel = "Fleeing the favourite (X-ray says away, but the favourite itself is drifting out → upset/draw risk)";
  } else if (xraySide === "AWAY") {
    expectedMargin = "MARGIN_XRAY_AWAY";
    marginLabel = "Liquid X-ray: away AH/EH -1/-2 or CS 0-1 / 0-2 shortening";
  } else if (xraySide === "HOME") {
    expectedMargin = "MARGIN_XRAY_HOME";
    marginLabel = "Liquid X-ray: home AH/EH -1/-2 or CS 1-0 / 2-0 shortening";
  } else if (isStagnant) {
    expectedMargin = "MARGIN_STAGNANT_DRAW";
    marginLabel = "Stagnant market (draw / tactical lock)";
  } else if (tDeltaEh1 >= 4.0 && favOdd <= 2.4 && max1x2Move <= 8.0) {
    if (o25Odd <= 1.6 && bttsYesOdd <= 1.6) {
      expectedMargin = "MARGIN_OPEN_DRAW";
      marginLabel = "Favourite's EH-1 drifting out + Over/BTTS still open (2-2 / 1-1, not 0-0)";
    } else {
      expectedMargin = "MARGIN_CLOSE_OR_UPSET";
      marginLabel = "Favourite's EH-1 drifting out (1-1 / 0-0 / 1-0 corridor)";
    }
  } else if (favDelta <= -2.0 && tDeltaEh1 <= -4.0) {
    const eh2LabelRising = topRises.some((m) => m.label.includes("EUROPEAN_HANDICAP") && (m.label.includes("-2") || m.label.includes("-3")) && m.pctMove > 15.0);
    if (tDeltaEh2 >= 5.0 || eh2LabelRising) {
      expectedMargin = "MARGIN_1_2";
      marginLabel = "1-2 goal margin corridor (EH-1 confirmed, EH-2 capped out)";
    } else {
      expectedMargin = "MARGIN_FAV_WIN";
      marginLabel = "Favourite win";
    }
  } else if (favDelta >= 3.0) {
    expectedMargin = "MARGIN_CLOSE_OR_UPSET";
    marginLabel = "0-1 goal margin / upset risk (fleeing the favourite)";
  }

  // ---- Tempo / goal-count read ----
  let targetTempo: TargetTempo = "BALANCED";
  let tempoLabel = "Balanced tempo";

  if (isSuperExplosive) {
    targetTempo = "SUPER_EXPLOSIVE";
    tempoLabel = "🌋 Super explosion risk: HT Over 1.5 < 2.00 & FT Over 3.5 < 1.85 (lower-league chaos pattern)";
  } else if (xraySide === "LOW") {
    targetTempo = "LOW_PACE";
    tempoLabel = "🔒 Low tempo (X-ray confirmed, tight match)";
  } else if (xraySide === "OVER") {
    targetTempo = "EXPLOSIVE_GOALS";
    tempoLabel = "💣 Heavy goal flow (X-ray confirmed)";
  } else if (tDeltaO25 <= -5.0 || tDeltaBtts <= -5.0 || (tDeltaO25 <= -2.5 && tDeltaBtts <= -2.5)) {
    targetTempo = "EXPLOSIVE_GOALS";
    tempoLabel = "Heavy goal flow (Over/BTTS odds collapsing)";
  } else if (favOdd <= 1.5 && o25Odd <= 1.42 && favDelta <= 2.0 && dCs10 < 4.0 && dCs20 < 4.0) {
    targetTempo = "HIGH_PACE";
    tempoLabel = "Heavy favourite + short Over price";
  } else if (favOdd <= 1.25 && (dCs10 >= 4.0 || dCs20 >= 4.0)) {
    targetTempo = "DECEPTIVE_TEMPO";
    tempoLabel = "Short favourite, but 1-0 / 2-0 drifting out (messy-score risk)";
  } else if (favOdd <= 1.7 && favDelta >= 6.0) {
    targetTempo = "DECEPTIVE_TEMPO";
    tempoLabel = "Favourite drifting out — directional shock (reverse-score risk)";
  } else if ((o25Odd <= 1.55 && tDeltaO25 >= 1.5) || (favDelta >= 3.0 && o25Odd <= 1.55)) {
    targetTempo = "DECEPTIVE_TEMPO";
    tempoLabel = "Suspicious favourite & resistance on goals / lock risk";
  } else if (o25Odd <= 1.7 && bttsYesOdd <= 1.7) {
    targetTempo = "HIGH_PACE";
    tempoLabel = "High tempo / goal duel";
  } else if (u25Odd <= 1.75 || bttsNoOdd <= 1.75) {
    targetTempo = "LOW_PACE";
    tempoLabel = "Low tempo / tactical lock";
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
    const actualScore = `${hSc}:${aSc}`;

    let tempoHit: boolean | null = null;
    if (targetTempo === "SUPER_EXPLOSIVE" || targetTempo === "EXPLOSIVE_GOALS" || targetTempo === "HIGH_PACE") {
      tempoHit = totalGoals >= 3;
    } else if (targetTempo === "LOW_PACE") {
      tempoHit = totalGoals <= 2;
    }

    actual = {
      score: actualScore,
      htScore: hHt != null && aHt != null ? `${hHt}:${aHt}` : null,
      totalGoals,
      scoreHit: hotScores.includes(actualScore),
      tempoHit,
    };
  }

  return {
    favSide,
    favOdd: Math.round(favOdd * 100) / 100,
    homeDirection: targetDirH,
    awayDirection: targetDirA,
    xraySide,
    expectedMargin,
    marginLabel,
    targetTempo,
    tempoLabel,
    isSuperExplosive,
    hotScores,
    topDrops,
    isMajorLeague,
    actual,
  };
}
