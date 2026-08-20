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

/** Aşama 2'de kullanılacak "likit" (çoğu bookmaker'ın gerçekten quote ettiği) kodlar. */
function isLiquidCode(c: SimilarityCode): boolean {
  if (LIQUID_1X2_DC_BTTS_MARKETS.has(c.market)) return true;
  if (c.market === "OVER_UNDER:FULL_TIME") {
    const line = parseLine(c.side);
    return line != null && LIQUID_OU_LINES.has(line);
  }
  if (c.market === "ASIAN_HANDICAP:FULL_TIME") {
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

export type SimilarityResult = {
  matchedCount: number;
  samples: { event_id: string; score: number }[];
  usedCodes: string[];
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


export async function findSimilarForBookmaker(opts: {
  eventId: string;
  bookmaker: string;
  fixtureOdds: FixtureOddsRow[];
  limit?: number;
}): Promise<SimilarityResult> {
  const { eventId, bookmaker, fixtureOdds, limit = 500 } = opts;

  const built = buildSimilarityQueries({ bookmaker, fixtureOdds });
  if (!built) return { matchedCount: 0, samples: [], usedCodes: [] };
  const { driftQuery, buildSpreadQuery, activeCodes } = built;

  const driftRows = (await sql.unsafe(driftQuery.text, driftQuery.params as never[])) as {
    event_id: string;
    market: string;
    selection: string;
    odds: number;
    opening: number;
  }[];

  const driftByEvent = new Map<string, Map<string, number>>();
  const oddsByEvent = new Map<string, Map<string, number>>();
  const candidateEventIds = new Set<string>();
  for (const r of driftRows) {
    if (r.event_id === eventId) continue;
    const drift = (r.odds - r.opening) / r.opening;
    const key = codeKey(r.market, r.selection);
    let dm = driftByEvent.get(r.event_id);
    if (!dm) {
      dm = new Map();
      driftByEvent.set(r.event_id, dm);
    }
    dm.set(key, drift);
    let om = oddsByEvent.get(r.event_id);
    if (!om) {
      om = new Map();
      oddsByEvent.set(r.event_id, om);
    }
    om.set(key, r.odds);
    candidateEventIds.add(r.event_id);
  }
  if (!candidateEventIds.size) {
    return { matchedCount: 0, samples: [], usedCodes: activeCodes.map((c) => c.code) };
  }

 
  const fixtureOddsByCode = new Map<string, number>();
  for (const c of activeCodes) {
    const row = findFixtureRowForCode(c, fixtureOdds);
    if (row) fixtureOddsByCode.set(codeKey(c.market, c.side), row.odds);
  }

  const spreadQuery = buildSpreadQuery([...candidateEventIds]);
  const spreadRows = (await sql.unsafe(spreadQuery.text, spreadQuery.params as never[])) as {
    event_id: string;
    market: string;
    selection: string;
    spread_close: number | null;
  }[];

  const spreadByEvent = new Map<string, Map<string, number>>();
  for (const r of spreadRows) {
    if (r.spread_close == null) continue;
    let m = spreadByEvent.get(r.event_id);
    if (!m) {
      m = new Map();
      spreadByEvent.set(r.event_id, m);
    }
    m.set(codeKey(r.market, r.selection), r.spread_close);
  }

  const ODDS_LEVEL_TOLERANCE = 0.2;

 
  function scoreCandidates(
    codes: SimilarityCode[],
    candidates: Iterable<string>,
  ): { event_id: string; score: number; matched: number }[] {
    const groupCounts = new Map<string, number>();
    for (const c of codes) groupCounts.set(c.group, (groupCounts.get(c.group) ?? 0) + 1);

    const out: { event_id: string; score: number; matched: number }[] = [];
    for (const evId of candidates) {
      const drifts = driftByEvent.get(evId);
      const spreads = spreadByEvent.get(evId);
      const oddsMap = oddsByEvent.get(evId);
      if (!drifts || !spreads) continue;

      let sum = 0;
      let matchedWeight = 0;
      let matched = 0;

      for (const c of codes) {
        const key = codeKey(c.market, c.side);
        const drift = drifts.get(key);
        const spread = spreads.get(key);
        if (drift == null || spread == null) continue;

        const fixtureOdds = fixtureOddsByCode.get(key);
        const histOdds = oddsMap?.get(key);
        if (fixtureOdds != null && histOdds != null) {
          const relDiff = Math.abs(histOdds - fixtureOdds) / fixtureOdds;
          if (relDiff > ODDS_LEVEL_TOLERANCE) continue; // bu kod bu aday için sayılmaz
        }

        const stats = STATS[c.code];
        if (!stats) continue;
        const [medDrift, madDrift] = stats.mean_drift_pct;
        const [medSpread, madSpread] = stats.spread_close;
        const groupWeight = WEIGHTS[c.group] ?? 1;
        const wPerCode = groupWeight / (groupCounts.get(c.group) ?? 1);

        const zDrift = clamp((drift - medDrift) / (madDrift || 1), -6, 6);
        const zSpread = clamp((spread - medSpread) / (madSpread || 1), -6, 6);


        sum += wPerCode * (zDrift * zDrift + zSpread * zSpread);
        matchedWeight += wPerCode;
        matched++;
      }

      if (matched === 0) continue;
      out.push({ event_id: evId, score: sum / matchedWeight, matched });
    }
    out.sort((a, b) => a.score - b.score);
    return out;
  }

 
  const stage1Codes = activeCodes.filter((c) => c.market === STAGE1_MARKET);
  const stage1RequiredMatches = stage1Codes.length || activeCodes.length;
  const stage1Ranked = scoreCandidates(
    stage1Codes.length ? stage1Codes : activeCodes,
    candidateEventIds,
  ).filter((r) => r.matched === stage1RequiredMatches);
  const stage1Pool = stage1Ranked.slice(0, STAGE1_POOL).map((r) => r.event_id);

 
  if (stage1Codes.length > 0 && stage1Pool.length === 0) {
    return { matchedCount: 0, samples: [], usedCodes: activeCodes.map((c) => c.code) };
  }

  const stage2Codes = activeCodes.filter(isLiquidCode);
  const stage2Source = stage1Pool.length ? stage1Pool : candidateEventIds;
  const stage2Ranked = scoreCandidates(
    stage2Codes.length ? stage2Codes : activeCodes,
    stage2Source,
  );
  const stage2Pool = stage2Ranked.slice(0, STAGE2_POOL).map((r) => r.event_id);

  // --- Aşama 3: TÜM aktif kodlar — sadece Aşama 2'den geçen küçük havuzda ---
  const stage3Source = stage2Pool.length ? stage2Pool : stage2Source;
  const finalRanked = scoreCandidates(activeCodes, stage3Source).slice(0, limit);

  const k = Math.max(K_MIN, Math.min(K_DEFAULT, finalRanked.length));

  return {
    matchedCount: finalRanked.length,
    samples: finalRanked.slice(0, k).map((r) => ({ event_id: r.event_id, score: r.score })),
    usedCodes: activeCodes.map((c) => c.code),
  };
}
