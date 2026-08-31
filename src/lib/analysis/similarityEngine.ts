import { sqlDirect as sql } from "@/lib/dbDirect";
import { MATCH_ODDS_TABLE } from "./marketQuotes";
import { SIMILARITY_CODES, type SimilarityCode } from "./similarityCodes";
import weightsCfg from "./similarityWeights.json";
import statsCfg from "./similarityStats.json";

type CodeStats = { mean_drift_pct: [number, number]; spread_close: [number, number] };
const STATS = statsCfg as unknown as Record<string, CodeStats>;
const WEIGHTS = (weightsCfg as { weights: Record<string, number> }).weights;
const K_DEFAULT = (weightsCfg as { k_default: number }).k_default;
const K_MIN = (weightsCfg as { k_min: number }).k_min;

const STAGE1_MARKET = "HOME_DRAW_AWAY:FULL_TIME";
const STAGE1_POOL = 250;
const STAGE2_POOL = 12;
const BAND = 0.045;
const LIQ_BAND = 0.06;

const LIQUID_1X2_DC_BTTS_MARKETS = new Set([
  "HOME_DRAW_AWAY:FULL_TIME",
  "HOME_DRAW_AWAY:FIRST_HALF",
  "HOME_DRAW_AWAY:SECOND_HALF",
  "DOUBLE_CHANCE:FULL_TIME",
  "BOTH_TEAMS_TO_SCORE:FULL_TIME",
]);
const LIQUID_OU_LINES = new Set([1.5, 2.5, 3.5]);
const LIQUID_AH_LINES = new Set([-1, -0.5, 0, 0.5, 1]);

function parseLine(side: string): number | null {
  const idx = side.indexOf(":");
  if (idx === -1) return null;
  const n = Number(side.slice(idx + 1));
  return Number.isFinite(n) ? n : null;
}

function isLiquidCode(c: SimilarityCode): boolean {
  if (LIQUID_1X2_DC_BTTS_MARKETS.has(c.market)) return true;
  if (c.market === "OVER_UNDER:FULL_TIME" || c.market.startsWith("OVER_UNDER:FULL_TIME:")) {
    const line = parseLine(c.side) ?? parseLine(c.market);
    return line != null && LIQUID_OU_LINES.has(line);
  }
  if (c.market === "ASIAN_HANDICAP:FULL_TIME" || c.market.startsWith("ASIAN_HANDICAP:FULL_TIME:")) {
    const line = parseLine(c.side);
    return line != null && LIQUID_AH_LINES.has(line);
  }
  return false;
}

export type FixtureOddsRow = { market: string; selection: string; odds: number; opening: number | null };

type SqlParamPusher = (v: unknown) => string;
function makePush(params: unknown[]): SqlParamPusher {
  return (v) => {
    params.push(v);
    return `$${params.length}`;
  };
}

function findFixtureRowForCode(code: SimilarityCode, rows: FixtureOddsRow[]): FixtureOddsRow | null {
  const direct = rows.find((r) => r.market === code.market && r.selection === code.side);
  if (direct) return direct;

  if (code.group === "BTTS") {
    const alt = code.side === "btts:YES" ? ["YES", "True", "btts:True"] : ["NO", "False", "btts:False"];
    for (const s of alt) {
      const r = rows.find((r) => r.market === code.market && r.selection === s);
      if (r) return r;
    }
  }
  if (code.group === "HTFT") {
    const bareCombo = code.side.replace("htft:", "");
    const r = rows.find((r) => r.market === code.market && r.selection === bareCombo);
    if (r) return r;
  }
  return null;
}

export type SimilarityFamily =
  | "CLEAN_AWAY"
  | "AWAY_SHUTOUT"
  | "HOME_BURST"
  | "OPEN_GAME"
  | "OPEN_DRAW"
  | "BASE";

export type ScoreBucket = { scoreline: string; n: number };
export type RegimeBuckets = {
  open: ScoreBucket[];
  shut: ScoreBucket[];
  openN: number;
  shutN: number;
};

export type SimilarityResult = {
  matchedCount: number;
  samples: { event_id: string; score: number }[];
  usedCodes: string[];
  family?: SimilarityFamily;
  buckets?: ScoreBucket[];
  regimes?: RegimeBuckets;
  prediction?: { primary: string; backup: string; reason: string };
  durationMs?: number;
};

export type SimilarityBulkQueries = {
  driftQuery: { text: string; params: unknown[] };
  buildSpreadQuery: (eventIds: string[]) => { text: string; params: unknown[] };
  activeCodes: SimilarityCode[];
};

function codeKey(market: string, side: string): string {
  return `${market}\u0000${side}`;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function band(v: number, pct = BAND): [number, number] {
  return [v * (1 - pct), v * (1 + pct)];
}

function pickRow(rows: FixtureOddsRow[], market: string, selection: string): FixtureOddsRow | null {
  const exact = rows.find((r) => r.market === market && r.selection === selection);
  if (exact) return exact;
  if (market === "OVER_UNDER:FULL_TIME:2.5") {
    return (
      rows.find((r) => r.market === "OVER_UNDER:FULL_TIME" && r.selection === "OVER:2.5") ||
      rows.find((r) => r.market.startsWith("OVER_UNDER") && r.selection === "OVER:2.5") ||
      null
    );
  }
  if (market === "OVER_UNDER:FULL_TIME:3.5") {
    return (
      rows.find((r) => r.market === "OVER_UNDER:FULL_TIME" && r.selection === "OVER:3.5") ||
      rows.find((r) => r.market.startsWith("OVER_UNDER") && r.selection === "OVER:3.5") ||
      null
    );
  }
  if (market === "BOTH_TEAMS_TO_SCORE:FULL_TIME" && selection === "btts:YES") {
    return (
      rows.find((r) => r.market.includes("BOTH_TEAMS") && (r.selection === "btts:YES" || r.selection === "YES")) ||
      null
    );
  }
  if (market === "BOTH_TEAMS_TO_SCORE:FULL_TIME" && selection === "btts:NO") {
    return (
      rows.find((r) => r.market.includes("BOTH_TEAMS") && (r.selection === "btts:NO" || r.selection === "NO")) ||
      null
    );
  }
  if (market === "HALF_FULL_TIME:FULL_TIME" || market === "CORRECT_SCORE:FULL_TIME") {
    return rows.find((r) => r.market === market && r.selection === selection) || null;
  }
  if (market === "DRAW_NO_BET:FULL_TIME") {
    return (
      rows.find((r) => r.market === market && r.selection === selection) ||
      rows.find((r) => r.market.includes("DRAW_NO_BET") && r.selection === selection) ||
      null
    );
  }
  if (market === "HOME_DRAW_AWAY:SECOND_HALF" || market === "ASIAN_HANDICAP:FULL_TIME") {
    return (
      rows.find((r) => r.market === market && r.selection === selection) ||
      rows.find((r) => r.market.startsWith(market.split(":")[0]) && r.selection === selection) ||
      null
    );
  }
  return null;
}

export function classifyFamily(fixtureOdds: FixtureOddsRow[]): {
  family: SimilarityFamily;
  h: FixtureOddsRow | null;
  d: FixtureOddsRow | null;
  a: FixtureOddsRow | null;
  ou25: FixtureOddsRow | null;
  ou35: FixtureOddsRow | null;
  bttsYes: FixtureOddsRow | null;
  bttsNo: FixtureOddsRow | null;
} {
  const h = pickRow(fixtureOdds, STAGE1_MARKET, "H");
  const d = pickRow(fixtureOdds, STAGE1_MARKET, "D");
  const a = pickRow(fixtureOdds, STAGE1_MARKET, "A");
  const ou25 = pickRow(fixtureOdds, "OVER_UNDER:FULL_TIME:2.5", "OVER:2.5");
  const ou35 = pickRow(fixtureOdds, "OVER_UNDER:FULL_TIME:3.5", "OVER:3.5");
  const bttsYes = pickRow(fixtureOdds, "BOTH_TEAMS_TO_SCORE:FULL_TIME", "btts:YES");
  const bttsNo = pickRow(fixtureOdds, "BOTH_TEAMS_TO_SCORE:FULL_TIME", "btts:NO");

  const Hc = h?.odds ?? null;
  const Ac = a?.odds ?? null;
  const side: "HOME" | "AWAY" = Hc != null && Ac != null && Hc <= Ac ? "HOME" : "AWAY";
  const fav = Math.min(Hc ?? 99, Ac ?? 99);

  const goalsOpen =
    ou25?.opening != null &&
    ou25.odds < ou25.opening &&
    (ou35?.opening == null || ou35.odds <= ou35.opening);
  const goalsShut =
    ou25?.opening != null &&
    ou25.odds > ou25.opening &&
    bttsNo?.opening != null &&
    bttsNo.odds < bttsNo.opening;
  const bttsOn = bttsYes?.opening != null && bttsYes.odds < bttsYes.opening;

  const bttsNoFav =
    bttsNo != null && bttsYes != null && bttsNo.odds < bttsYes.odds && bttsYes.odds >= 1.9;
  const pickem =
    Hc != null && Ac != null && Math.abs(Hc - Ac) / Math.min(Hc, Ac) <= 0.12 && (d?.odds ?? 99) <= 3.55;

  let family: SimilarityFamily = "BASE";
  if (side === "AWAY" && bttsNoFav) family = "AWAY_SHUTOUT";
  else if (side === "AWAY" && goalsShut) family = "CLEAN_AWAY";
  else if (side === "HOME" && fav <= 1.5 && (goalsOpen || (ou25 != null && ou25.odds <= 1.58))) family = "HOME_BURST";
  else if (pickem && (bttsYes?.odds ?? 99) <= 1.8 && (ou35?.odds ?? 99) <= 3.3) family = "OPEN_DRAW";
  else if ((goalsOpen || bttsOn) && (bttsYes?.odds ?? 99) <= 1.75) family = "OPEN_GAME";

  return { family, h, d, a, ou25, ou35, bttsYes, bttsNo };
}

function csOdds(rows: FixtureOddsRow[], line: string): number | null {
  const r =
    pickRow(rows, "CORRECT_SCORE:FULL_TIME", `score:${line}`) ||
    rows.find((x) => x.market.includes("CORRECT_SCORE") && (x.selection === `score:${line}` || x.selection === line));
  return r?.odds ?? null;
}

/** K1–K6 nokta atışı. fixtureOdds içinde CS / HTFT varsa K6 da çalışır. */
export function predictScoreline(fixtureOdds: FixtureOddsRow[]): {
  family: SimilarityFamily;
  primary: string;
  backup: string;
  reason: string;
} {
  const p = classifyFamily(fixtureOdds);
  const cs20 = csOdds(fixtureOdds, "2:0");
  const cs21 = csOdds(fixtureOdds, "2:1");
  const cs11 = csOdds(fixtureOdds, "1:1");
  const cs22 = csOdds(fixtureOdds, "2:2");
  const cs32 = csOdds(fixtureOdds, "3:2");
  const ratio21 =
    cs21 != null && cs20 != null && cs20 > 0 ? cs21 / cs20 : null;
  const awayGoalPriced = ratio21 != null && ratio21 <= 1.2;

  const htft11 = pickRow(fixtureOdds, "HALF_FULL_TIME:FULL_TIME", "htft:1/1");
  const ahM15 = pickRow(fixtureOdds, "ASIAN_HANDICAP:FULL_TIME", "H:-1.5");

  if (p.family === "AWAY_SHUTOUT") {
    const ahA = pickRow(fixtureOdds, "ASIAN_HANDICAP:FULL_TIME", "A:-1.5");
    if (ahA && ahA.odds >= 2.1) return { family: p.family, primary: "0-1", backup: "0-2", reason: "AWAY_SHUTOUT + AH-1.5 uzun" };
    return { family: p.family, primary: "0-2", backup: "0-1", reason: "AWAY_SHUTOUT" };
  }
  if (p.family === "CLEAN_AWAY") {
    return { family: p.family, primary: "0-2", backup: "0-1", reason: "CLEAN_AWAY OU kapanır" };
  }
  if (p.family === "HOME_BURST") {
    if (awayGoalPriced || (p.bttsYes && p.bttsYes.odds <= 1.75)) {
      const tightAh = ahM15 != null && ahM15.odds <= 2.05;
      if (p.ou35 && p.ou35.odds <= 1.9) return { family: p.family, primary: "4-2", backup: "5-1", reason: "HOME_BURST OU35 çok kısa" };
      if (tightAh) return { family: p.family, primary: "4-2", backup: "5-2", reason: "HOME_BURST BTTS + -1.5" };
      return { family: p.family, primary: "3-1", backup: "2-1", reason: "HOME_BURST BTTS, -1.5 sınır" };
    }
    if (p.ou25 && p.ou25.odds <= 1.55) return { family: p.family, primary: "3-0", backup: "2-0", reason: "HOME_BURST clean-sheet eğilim" };
    return { family: p.family, primary: "2-0", backup: "3-0", reason: "HOME_BURST" };
  }
  if (p.family === "OPEN_DRAW") {
    if (p.ou35 && p.ou35.odds <= 3.25 && (p.bttsYes?.odds ?? 99) <= 1.75) {
      return { family: p.family, primary: "3-3", backup: "2-2", reason: "OPEN_DRAW + OU35 + BTTS" };
    }
    return { family: p.family, primary: "1-1", backup: "2-2", reason: "OPEN_DRAW" };
  }
  if (p.family === "OPEN_GAME") {
    if (p.ou25 && p.ou25.odds <= 1.55 && (p.bttsYes?.odds ?? 99) <= 1.5) {
      return { family: p.family, primary: "2-2", backup: "3-2", reason: "OPEN_GAME OU25/BTTS çok kısa; 1-1 totals ile çelişir" };
    }
    if (awayGoalPriced && p.ou35 && p.ou35.odds <= 2.55) {
      return { family: p.family, primary: "2-1", backup: "3-2", reason: "OPEN_GAME CS(2-1)≈CS(2-0) + OU35" };
    }
    if (htft11 && (p.h?.odds ?? 99) <= 2.1) {
      return { family: p.family, primary: "2-1", backup: "3-1", reason: "OPEN_GAME HT/FT 1/1" };
    }
    return { family: p.family, primary: "2-1", backup: "2-2", reason: "OPEN_GAME" };
  }

  if (cs11 != null && cs21 != null && cs11 <= cs21 && (p.ou25?.odds ?? 0) > 1.7) {
    return { family: p.family, primary: "1-1", backup: "2-1", reason: "CS 1-1 en kısa" };
  }
  return { family: p.family, primary: "2-1", backup: "1-1", reason: "BASE" };
}

/** Eski UNION/tüm-kod tarama — sadece geriye dönük uyumluluk. Production path findSimilarForBookmaker. */
export function buildSimilarityQueries(opts: {
  bookmaker: string;
  fixtureOdds: FixtureOddsRow[];
}): SimilarityBulkQueries | null {
  const { bookmaker, fixtureOdds } = opts;

  const activeCodes = SIMILARITY_CODES.filter((c) => {
    if (!STATS[c.code]) return false;
    const row = findFixtureRowForCode(c, fixtureOdds);
    return row != null && row.opening != null && row.opening !== 0;
  });
  if (!activeCodes.length) return null;

  const driftParams: unknown[] = [bookmaker];
  const driftValues = activeCodes
    .map((c) => {
      driftParams.push(c.market, c.side);
      return `($${driftParams.length - 1}, $${driftParams.length})`;
    })
    .join(", ");
  const driftQuery = {
    text: `
      SELECT mo.event_id, mo.market, mo.selection, mo.odds, mo.opening
      FROM ${MATCH_ODDS_TABLE} mo
      JOIN (VALUES ${driftValues}) AS codes(market, selection)
        ON mo.market = codes.market AND mo.selection = codes.selection
      WHERE mo.bookmaker = $1
        AND mo.opening IS NOT NULL AND mo.opening != 0
    `,
    params: driftParams,
  };

  const buildSpreadQuery = (eventIds: string[]) => {
    const params: unknown[] = [];
    const values = activeCodes
      .map((c) => {
        params.push(c.market, c.side);
        return `($${params.length - 1}, $${params.length})`;
      })
      .join(", ");
    params.push(eventIds);
    return {
      text: `
        SELECT mo.event_id, mo.market, mo.selection, STDDEV(mo.odds) AS spread_close
        FROM ${MATCH_ODDS_TABLE} mo
        JOIN (VALUES ${values}) AS codes(market, selection)
          ON mo.market = codes.market AND mo.selection = codes.selection
        WHERE mo.event_id = ANY($${params.length}::text[])
        GROUP BY mo.event_id, mo.market, mo.selection
      `,
      params,
    };
  };

  return { driftQuery, buildSpreadQuery, activeCodes };
}

function rel(a: number, b: number): number {
  if (!b) return 1;
  return Math.abs(a - b) / b;
}

export async function findSimilarForBookmaker(opts: {
  eventId: string;
  bookmaker: string;
  fixtureOdds: FixtureOddsRow[];
  limit?: number;
}): Promise<SimilarityResult> {
  const t0 = Date.now();
  const { eventId, bookmaker, fixtureOdds, limit = 60 } = opts;
  const prof = classifyFamily(fixtureOdds);

  if (!prof.h || !prof.d || !prof.a) {
    return { matchedCount: 0, samples: [], usedCodes: [], family: prof.family, durationMs: Date.now() - t0 };
  }

  const [hLo, hHi] = band(prof.h.odds);
  const [dLo, dHi] = band(prof.d.odds);
  const [aLo, aHi] = band(prof.a.odds);

  const stage1 = (await sql.unsafe(
    `
    SELECT event_id,
           MAX(CASE WHEN selection = 'H' THEN odds END) AS h,
           MAX(CASE WHEN selection = 'D' THEN odds END) AS d,
           MAX(CASE WHEN selection = 'A' THEN odds END) AS a,
           MAX(CASE WHEN selection = 'H' THEN opening END) AS h_open,
           MAX(CASE WHEN selection = 'D' THEN opening END) AS d_open,
           MAX(CASE WHEN selection = 'A' THEN opening END) AS a_open
    FROM ${MATCH_ODDS_TABLE}
    WHERE bookmaker = $1
      AND market = '${STAGE1_MARKET}'
      AND selection IN ('H','D','A')
      AND opening IS NOT NULL AND opening <> 0
      AND event_id <> $2
    GROUP BY event_id
    HAVING MAX(CASE WHEN selection = 'H' THEN odds END) BETWEEN $3 AND $4
       AND MAX(CASE WHEN selection = 'D' THEN odds END) BETWEEN $5 AND $6
       AND MAX(CASE WHEN selection = 'A' THEN odds END) BETWEEN $7 AND $8
    `,
    [bookmaker, eventId, hLo, hHi, dLo, dHi, aLo, aHi] as never[],
  )) as {
    event_id: string;
    h: number;
    d: number;
    a: number;
    h_open: number | null;
    d_open: number | null;
    a_open: number | null;
  }[];

  const homeLen =
    prof.h.opening != null && prof.h.odds >= prof.h.opening + 0.05;
  const homeSh =
    prof.h.opening != null && prof.h.odds <= prof.h.opening - 0.05;
  const awayLen =
    prof.a.opening != null && prof.a.odds >= prof.a.opening + 0.05;
  const awaySh =
    prof.a.opening != null && prof.a.odds <= prof.a.opening - 0.05;

  const stage1Scored = stage1
    .filter((r) => {
      if (homeLen && !(r.h_open != null && r.h >= r.h_open + 0.04)) return false;
      if (homeSh && !(r.h_open != null && r.h <= r.h_open - 0.04)) return false;
      if (awayLen && !(r.a_open != null && r.a >= r.a_open + 0.04)) return false;
      if (awaySh && !(r.a_open != null && r.a <= r.a_open - 0.04)) return false;
      return true;
    })
    .map((r) => ({
      ...r,
      d1:
        rel(r.h, prof.h!.odds) ** 2 +
        rel(r.d, prof.d!.odds) ** 2 +
        rel(r.a, prof.a!.odds) ** 2,
    }))
    .sort((x, y) => x.d1 - y.d1)
    .slice(0, STAGE1_POOL);

  if (!stage1Scored.length) {
    return {
      matchedCount: 0,
      samples: [],
      usedCodes: ["1X2_FT"],
      family: prof.family,
      durationMs: Date.now() - t0,
    };
  }

  const candidateIds = stage1Scored.map((r) => r.event_id);
  const liquid = (await sql.unsafe(
    `
    SELECT event_id, market, selection, odds, opening
    FROM ${MATCH_ODDS_TABLE}
    WHERE bookmaker = $1
      AND event_id = ANY($2::text[])
      AND (
        (market = 'OVER_UNDER:FULL_TIME:2.5' AND selection IN ('OVER:2.5','UNDER:2.5'))
        OR (market = 'OVER_UNDER:FULL_TIME:3.5' AND selection IN ('OVER:3.5','UNDER:3.5'))
        OR (market = 'OVER_UNDER:FULL_TIME:4.5' AND selection IN ('OVER:4.5','UNDER:4.5'))
        OR (market = 'BOTH_TEAMS_TO_SCORE:FULL_TIME' AND selection IN ('btts:YES','btts:NO','YES','NO'))
        OR (market = 'HALF_FULL_TIME:FULL_TIME' AND selection IN ('htft:1/1','htft:X/X','htft:2/2','1/1','X/X','2/2'))
        OR (market = 'CORRECT_SCORE:FULL_TIME' AND selection IN (
          'score:1:0','score:2:0','score:2:1','score:3:0','score:3:1','score:3:2',
          'score:1:1','score:2:2','score:0:1','score:0:2','score:1:2','score:1:3','score:3:1'
        ))
        OR (market = 'DRAW_NO_BET:FULL_TIME' AND selection IN ('H','A'))
        OR (market = 'HOME_DRAW_AWAY:SECOND_HALF' AND selection IN ('H','D','A'))
        OR (market = 'HOME_DRAW_AWAY:FIRST_HALF' AND selection IN ('H','D','A'))
        OR (market = 'ASIAN_HANDICAP:FULL_TIME' AND selection IN ('A:-1.0','H:-1.0','A:0.0','H:0.0'))
        OR (market = 'EUROPEAN_HANDICAP:FULL_TIME' AND selection IN ('A:-1.0','H:-1.0'))
      )
    `,
    [bookmaker, candidateIds] as never[],
  )) as { event_id: string; market: string; selection: string; odds: number; opening: number | null }[];

  const liqByEvent = new Map<string, Map<string, { odds: number; opening: number | null }>>();
  for (const row of liquid) {
    let m = liqByEvent.get(row.event_id);
    if (!m) {
      m = new Map();
      liqByEvent.set(row.event_id, m);
    }
    const sel = row.selection === "YES" ? "btts:YES" : row.selection === "NO" ? "btts:NO" : row.selection;
    m.set(`${row.market}|${sel}`, { odds: row.odds, opening: row.opening });
  }

  type Ranked = { event_id: string; score: number };
  const ranked: Ranked[] = [];

  for (const r of stage1Scored) {
    const L = liqByEvent.get(r.event_id);
    const ou25 = L?.get("OVER_UNDER:FULL_TIME:2.5|OVER:2.5");
    const ou35 = L?.get("OVER_UNDER:FULL_TIME:3.5|OVER:3.5");
    const bttsY = L?.get("BOTH_TEAMS_TO_SCORE:FULL_TIME|btts:YES");
    const bttsN = L?.get("BOTH_TEAMS_TO_SCORE:FULL_TIME|btts:NO");

    const dnbA = L?.get("DRAW_NO_BET:FULL_TIME|A");
    const dnbH = L?.get("DRAW_NO_BET:FULL_TIME|H");
    const shA = L?.get("HOME_DRAW_AWAY:SECOND_HALF|A");
    const shH = L?.get("HOME_DRAW_AWAY:SECOND_HALF|H");
    const ahA1 = L?.get("ASIAN_HANDICAP:FULL_TIME|A:-1.0");
    const ahH1 = L?.get("ASIAN_HANDICAP:FULL_TIME|H:-1.0");

    const fxDnbA = pickRow(fixtureOdds, "DRAW_NO_BET:FULL_TIME", "A");
    const fxDnbH = pickRow(fixtureOdds, "DRAW_NO_BET:FULL_TIME", "H");
    const fxShA = pickRow(fixtureOdds, "HOME_DRAW_AWAY:SECOND_HALF", "A");
    const fxShH = pickRow(fixtureOdds, "HOME_DRAW_AWAY:SECOND_HALF", "H");
    const fxAhA1 = pickRow(fixtureOdds, "ASIAN_HANDICAP:FULL_TIME", "A:-1.0");
    const fxAhH1 = pickRow(fixtureOdds, "ASIAN_HANDICAP:FULL_TIME", "H:-1.0");

    function steamDown(row: { odds: number; opening: number | null } | null | undefined, min = 0.12) {
      return row?.opening != null && row.odds <= row.opening - min;
    }
    function steamUp(row: { odds: number; opening: number | null } | null | undefined, min = 0.12) {
      return row?.opening != null && row.odds >= row.opening + min;
    }
    if (steamDown(fxDnbA, 0.15) && dnbA && !steamDown(dnbA, 0.12)) continue;
    if (steamDown(fxDnbH, 0.15) && dnbH && !steamDown(dnbH, 0.12)) continue;
    if (steamDown(fxShA, 0.15) && shA && !steamDown(shA, 0.1)) continue;
    if (steamDown(fxShH, 0.15) && shH && !steamDown(shH, 0.1)) continue;
    if (steamDown(fxAhA1, 0.25) && ahA1 && !steamDown(ahA1, 0.2)) continue;
    if (steamDown(fxAhH1, 0.25) && ahH1 && !steamDown(ahH1, 0.2)) continue;

    if (!ou25 || !bttsY) continue;
    if (prof.ou25 && rel(ou25.odds, prof.ou25.odds) > LIQ_BAND) continue;
    if (prof.ou35) {
      if (!ou35 || rel(ou35.odds, prof.ou35.odds) > LIQ_BAND) continue;
    }
    if (prof.bttsYes && rel(bttsY.odds, prof.bttsYes.odds) > LIQ_BAND) continue;
    if ((prof.family === "CLEAN_AWAY" || prof.family === "AWAY_SHUTOUT") && bttsN && prof.bttsNo) {
      if (rel(bttsN.odds, prof.bttsNo.odds) > LIQ_BAND) continue;
    }

    const parts: number[] = [r.d1];
    parts.push((1.3 * rel(ou25.odds, prof.ou25?.odds ?? ou25.odds)) ** 2);
    if (prof.ou35 && ou35) parts.push((1.4 * rel(ou35.odds, prof.ou35.odds)) ** 2);
    parts.push((1.4 * rel(bttsY.odds, prof.bttsYes?.odds ?? bttsY.odds)) ** 2);
    if (fxDnbA && dnbA) parts.push((1.2 * rel(dnbA.odds, fxDnbA.odds)) ** 2);
    if (fxShA && shA) parts.push((1.15 * rel(shA.odds, fxShA.odds)) ** 2);
    if (fxAhA1 && ahA1) parts.push((1.1 * rel(ahA1.odds, fxAhA1.odds)) ** 2);
    ranked.push({ event_id: r.event_id, score: Math.sqrt(parts.reduce((s, x) => s + x, 0)) });
  }

  ranked.sort((x, y) => x.score - y.score);
  const shortlist = ranked.slice(0, 40);
  const ids = shortlist.map((s) => s.event_id);

  let scored: { event_id: string; score: number; hs: number; as: number }[] = [];
  if (ids.length) {
    const evs = (await sql.unsafe(
      `SELECT id, home_score, away_score FROM events
       WHERE id = ANY($1::text[]) AND home_score IS NOT NULL AND away_score IS NOT NULL`,
      [ids] as never[],
    )) as { id: string; home_score: number; away_score: number }[];
    const evMap = new Map(evs.map((e) => [e.id, e]));
    for (const s of shortlist) {
      const e = evMap.get(s.event_id);
      if (!e) continue;
      scored.push({
        event_id: s.event_id,
        score: s.score,
        hs: Number(e.home_score),
        as: Number(e.away_score),
      });
    }
  }

  function freqOf(rows: typeof scored): ScoreBucket[] {
    const freq = new Map<string, number>();
    for (const s of rows) {
      const k = `${s.hs}-${s.as}`;
      freq.set(k, (freq.get(k) ?? 0) + 1);
    }
    return [...freq.entries()]
      .map(([scoreline, n]) => ({ scoreline, n }))
      .sort((a, b) => b.n - a.n || a.scoreline.localeCompare(b.scoreline));
  }

  const openRows = scored.filter((s) => s.hs > 0 && s.as > 0 && s.hs + s.as >= 3);
  const shutRows = scored.filter((s) => s.hs === 0 || s.as === 0 || s.hs + s.as <= 2);
  const regimes: RegimeBuckets = {
    open: freqOf(openRows).slice(0, 6),
    shut: freqOf(shutRows).slice(0, 6),
    openN: openRows.length,
    shutN: shutRows.length,
  };
  const buckets = freqOf(scored);

  const pred = predictScoreline(fixtureOdds);
  const split = regimes.openN + regimes.shutN;
  const openShare = split ? regimes.openN / split : 0.5;
  const shutShare = split ? regimes.shutN / split : 0.5;
  const mixed = Math.abs(openShare - shutShare) < 0.22;

  if (mixed) {
    pred.primary = regimes.open[0]?.scoreline ?? pred.primary;
    pred.backup = regimes.shut[0]?.scoreline ?? pred.backup;
    pred.reason = `iki kova açık ${regimes.openN} (${regimes.open
      .slice(0, 3)
      .map((b) => `${b.scoreline}×${b.n}`)
      .join(", ")}) / kilit ${regimes.shutN} (${regimes.shut
      .slice(0, 3)
      .map((b) => `${b.scoreline}×${b.n}`)
      .join(", ")})`;
  } else if (openShare >= shutShare && regimes.open[0]) {
    pred.primary = regimes.open[0].scoreline;
    pred.backup = regimes.open[1]?.scoreline ?? regimes.shut[0]?.scoreline ?? pred.backup;
    pred.reason = `açık kova ${regimes.openN}/${split} ${regimes.open
      .slice(0, 3)
      .map((b) => `${b.scoreline}×${b.n}`)
      .join(", ")}`;
  } else if (regimes.shut[0]) {
    pred.primary = regimes.shut[0].scoreline;
    pred.backup = regimes.shut[1]?.scoreline ?? regimes.open[0]?.scoreline ?? pred.backup;
    pred.reason = `kilit kova ${regimes.shutN}/${split} ${regimes.shut
      .slice(0, 3)
      .map((b) => `${b.scoreline}×${b.n}`)
      .join(", ")}`;
  }

  const top = scored.slice(0, Math.max(K_MIN, Math.min(limit, STAGE2_POOL))).map((s) => ({
    event_id: s.event_id,
    score: s.score,
  }));

  return {
    matchedCount: scored.length,
    samples: top,
    usedCodes: [
      "1X2_FT",
      "OU25",
      "OU35",
      "BTTS",
      "DNB",
      "2H_1X2",
      "AH_-1",
      "STEAM_SIGN",
      "REGIME_A_B",
      `FAMILY:${prof.family}`,
    ],
    family: pred.family,
    buckets,
    regimes,
    prediction: { primary: pred.primary, backup: pred.backup, reason: pred.reason },
    durationMs: Date.now() - t0,
  };
}
