/**
 * similarityEngine.ts — seçili bir maç için, TEK bir bookmaker'ı referans
 * alarak match_odds tablosundan ağırlıklı z-score mesafesiyle geçmiş
 * "benzer" maçları bulur. 20 bookmaker için bu fonksiyon ayrı ayrı çağrılır
 * (her biri kendi cohort'unu üretir) — bkz. bulk route.
 *
 * ÖNEMLİ — CANLIYA ALMADAN ÖNCE TEK BİR event_id İLE TEST ET:
 * similarityCodes.ts'teki market/side formatı odds-agent'ın raw arşiv
 * verisinden (memory/raw/*.parquet) doğrulandı; match_odds'un GERÇEKTEN
 * aynı formatı kullandığı (marketQuoteCriteria.ts'teki kalıplardan
 * çıkarım) henüz canlı sorguyla teyit edilmedi.
 */

import { sql } from "@/lib/db";
import { MATCH_ODDS_TABLE } from "./marketQuotes";
import { SIMILARITY_CODES, type SimilarityCode } from "./similarityCodes";
import weightsCfg from "./similarityWeights.json";
import statsCfg from "./similarityStats.json";

type CodeStats = { mean_drift_pct: [number, number]; spread_close: [number, number] };
const STATS = statsCfg as unknown as Record<string, CodeStats>;
const WEIGHTS = (weightsCfg as { weights: Record<string, number> }).weights;
const SIMILARITY_THRESHOLD = (weightsCfg as { similarity_threshold: number }).similarity_threshold;
const K_DEFAULT = (weightsCfg as { k_default: number }).k_default;
const K_MIN = (weightsCfg as { k_min: number }).k_min;

export type FixtureOddsRow = { market: string; selection: string; odds: number; opening: number | null };

type SqlParamPusher = (v: unknown) => string;
function makePush(params: unknown[]): SqlParamPusher {
  return (v) => {
    params.push(v);
    return `$${params.length}`;
  };
}

/** Seçili maçın (referans bookmaker'daki) hangi kodları "aktif" (o bookmaker
 * bu market/side'ı gerçekten quote etmiş) olduğunu bulur. BTTS için
 * YES/NO dışındaki gerçek varyantları (True/false, btts: önekli) da dener. */
function findFixtureRowForCode(code: SimilarityCode, rows: FixtureOddsRow[]): FixtureOddsRow | null {
  const direct = rows.find((r) => r.market === code.market && r.selection === code.side);
  if (direct) return direct;

  if (code.group === "BTTS") {
    // 'btts:YES'/'btts:NO' zaten birincil format (doğrulandı); bazı eski
    // kayıtlarda farklı bir yazım olabilir ihtimaline karşı esnek bırakıldı.
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

/**
 * Aktif kodları belirler ve İKİ toplu sorguyu inşa eder — DB'ye dokunmaz.
 * ESKİ TASARIM: kod başına 1 CTE + 1 JOIN (357 kod varsa 357 CTE + 714 JOIN
 * tek dev sorguda) — canlıda 3dk+ sürüp Supabase'i timeout'a düşürdü.
 * YENİ TASARIM: kod sayısından bağımsız olarak SADECE 2 sorgu:
 *   1) driftQuery  — referans bookmaker'ın TÜM aktif kodlardaki satırları,
 *      tek hash-join (VALUES listesi) ile.
 *   2) spreadQuery — tüm bookmaker'ların STDDEV'i, yine tek hash-join;
 *      sadece driftQuery'de event_id'si çıkan maçlarla sınırlı (tüm arşivi
 *      taramak yerine).
 * Ağırlıklı z-distance skorlaması artık SQL'de değil JS'de (bkz.
 * findSimilarForBookmaker) — Postgres sadece ham drift/spread verisini
 * çekiyor.
 */
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

/**
 * Tek bookmaker'ı referans alarak, o bookmaker'ın SUNDUĞU kodlar üzerinden
 * ağırlıklı z-distance ile geçmiş maçları eler.
 *   drift  = (odds - opening) / opening      (bu bookmaker'ın satırından)
 *   spread = STDDEV(odds) tüm bookmaker'lar  (aynı event/market/selection)
 *   z = (x - median) / MAD                   (similarityStats.json'dan, sabit)
 *
 * Bir maçın skorlanabilmesi için TÜM aktif kodlarda hem drift hem spread
 * verisi bulunmalı (eski SQL'deki LEFT JOIN + NULL-propagation davranışıyla
 * birebir aynı — eksik kod varsa o maç elenir).
 */
export async function findSimilarForBookmaker(opts: {
  eventId: string;
  bookmaker: string;
  fixtureOdds: FixtureOddsRow[]; // seçili maçın TÜM market/selection satırları (tüm bookmaker'lar dahil, spread hesabı için)
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
  const candidateEventIds = new Set<string>();
  for (const r of driftRows) {
    if (r.event_id === eventId) continue;
    const drift = (r.odds - r.opening) / r.opening;
    let m = driftByEvent.get(r.event_id);
    if (!m) {
      m = new Map();
      driftByEvent.set(r.event_id, m);
    }
    m.set(codeKey(r.market, r.selection), drift);
    candidateEventIds.add(r.event_id);
  }
  if (!candidateEventIds.size) {
    return { matchedCount: 0, samples: [], usedCodes: activeCodes.map((c) => c.code) };
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

  const groupCounts = new Map<string, number>();
  for (const c of activeCodes) groupCounts.set(c.group, (groupCounts.get(c.group) ?? 0) + 1);
  const totalWeight = activeCodes.reduce((s, c) => {
    const gw = WEIGHTS[c.group] ?? 1;
    return s + gw / (groupCounts.get(c.group) ?? 1);
  }, 0);

  const scored: { event_id: string; score: number }[] = [];
  for (const evId of candidateEventIds) {
    const drifts = driftByEvent.get(evId);
    const spreads = spreadByEvent.get(evId);
    if (!drifts || !spreads) continue;

    let sum = 0;
    let complete = true;
    for (const c of activeCodes) {
      const key = codeKey(c.market, c.side);
      const drift = drifts.get(key);
      const spread = spreads.get(key);
      if (drift == null || spread == null) {
        complete = false; // orijinal davranış: eksik kod varsa event elenir
        break;
      }
      const stats = STATS[c.code];
      const [medDrift, madDrift] = stats.mean_drift_pct;
      const [medSpread, madSpread] = stats.spread_close;
      const groupWeight = WEIGHTS[c.group] ?? 1;
      const wPerCode = groupWeight / (groupCounts.get(c.group) ?? 1);

      const zDrift = clamp((drift - medDrift) / (madDrift || 1), -6, 6);
      const zSpread = clamp((spread - medSpread) / (madSpread || 1), -6, 6);
      sum += wPerCode * (zDrift * zDrift + zSpread * zSpread);
    }
    if (!complete) continue;

    const score = sum / totalWeight;
    if (score < SIMILARITY_THRESHOLD) scored.push({ event_id: evId, score });
  }

  scored.sort((a, b) => a.score - b.score);
  const limited = scored.slice(0, limit);
  const k = Math.max(K_MIN, Math.min(K_DEFAULT, limited.length));
  return {
    matchedCount: limited.length,
    samples: limited.slice(0, k),
    usedCodes: activeCodes.map((c) => c.code),
  };
}
