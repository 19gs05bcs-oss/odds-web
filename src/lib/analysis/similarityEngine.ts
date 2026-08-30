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
const STAGE1_POOL = 400;
const STAGE2_POOL = 60;
const BAND = 0.08;

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

export type SimilarityFamily = "CLEAN_AWAY" | "HOME_BURST" | "OPEN_GAME" | "BASE";

export type SimilarityResult = {
  matchedCount: number;
  samples: { event_id: string; score: number }[];
  usedCodes: string[];
  family?: SimilarityFamily;
  buckets?: { scoreline: string; n: number }[];
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

  let family: SimilarityFamily = "BASE";
  if (side === "AWAY" && goalsShut) family = "CLEAN_AWAY";
  else if (side === "HOME" && fav <= 1.5 && goalsOpen) family = "HOME_BURST";
  else if (goalsOpen && bttsOn) family = "OPEN_GAME";

  return { family, h, d, a, ou25, ou35, bttsYes, bttsNo };
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

  const stage1Scored = stage1
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

    if (prof.family === "CLEAN_AWAY") {
      if (!ou25 || !bttsN) continue;
      if (prof.ou25 && rel(ou25.odds, prof.ou25.odds) > 0.1) continue;
      if (ou25.opening != null && !(ou25.odds > ou25.opening * 0.98)) continue;
      if (bttsN.opening != null && !(bttsN.odds < bttsN.opening * 1.02)) continue;
    } else if (prof.family === "HOME_BURST") {
      if (!ou25) continue;
      if (prof.ou25 && rel(ou25.odds, prof.ou25.odds) > 0.1) continue;
      if (ou35 && prof.ou35 && rel(ou35.odds, prof.ou35.odds) > 0.15) continue;
    } else if (prof.family === "OPEN_GAME") {
      if (!ou25 || !bttsY) continue;
      if (prof.ou25 && rel(ou25.odds, prof.ou25.odds) > 0.1) continue;
      if (prof.bttsYes && rel(bttsY.odds, prof.bttsYes.odds) > 0.1) continue;
    }

    const parts: number[] = [r.d1];
    if (prof.ou25 && ou25) parts.push((1.2 * rel(ou25.odds, prof.ou25.odds)) ** 2);
    if (prof.ou35 && ou35) parts.push((1.3 * rel(ou35.odds, prof.ou35.odds)) ** 2);
    if (prof.bttsYes && bttsY) parts.push((1.2 * rel(bttsY.odds, prof.bttsYes.odds)) ** 2);
    ranked.push({ event_id: r.event_id, score: Math.sqrt(parts.reduce((s, x) => s + x, 0)) });
  }

  ranked.sort((x, y) => x.score - y.score);
  const top = ranked.slice(0, Math.max(K_MIN, Math.min(limit, K_DEFAULT, STAGE2_POOL)));

  return {
    matchedCount: ranked.length,
    samples: top,
    usedCodes: ["1X2_FT", "OU25", "OU35", "BTTS", `FAMILY:${prof.family}`],
    family: prof.family,
    durationMs: Date.now() - t0,
  };
}
