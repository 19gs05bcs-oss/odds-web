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
    const alt = code.side === "YES" ? ["True", "btts:YES", "btts:True"] : ["False", "btts:NO", "btts:False"];
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

/**
 * Tek bookmaker'ı referans alarak, o bookmaker'ın SUNDUĞU kodlar üzerinden
 * ağırlıklı z-distance ile geçmiş maçları eler.
 *   drift  = (odds - opening) / opening      (bu bookmaker'ın satırından)
 *   spread = STDDEV(odds) tüm bookmaker'lar  (aynı event/market/selection)
 *   z = (x - median) / MAD                   (similarityStats.json'dan, sabit)
 */
export async function findSimilarForBookmaker(opts: {
  eventId: string;
  bookmaker: string;
  fixtureOdds: FixtureOddsRow[]; // seçili maçın TÜM market/selection satırları (tüm bookmaker'lar dahil, spread hesabı için)
  limit?: number;
}): Promise<SimilarityResult> {
  const { eventId, bookmaker, fixtureOdds, limit = 500 } = opts;
  const bmRows = fixtureOdds; // spread hesabı tüm bookmaker'ları gerektirir, filtre yapmıyoruz burada

  const activeCodes = SIMILARITY_CODES.filter((c) => {
    if (!STATS[c.code]) return false;
    const row = findFixtureRowForCode(c, bmRows.filter(() => true));
    return row != null && row.opening != null && row.opening !== 0;
  });
  if (!activeCodes.length) return { matchedCount: 0, samples: [], usedCodes: [] };

  const params: unknown[] = [];
  const push = makePush(params);

  const ctes: string[] = [];
  const distTerms: string[] = [];
  const groupCounts = new Map<string, number>();
  for (const c of activeCodes) groupCounts.set(c.group, (groupCounts.get(c.group) ?? 0) + 1);

  activeCodes.forEach((c, i) => {
    const alias = `q${i}`;
    const marketPh = push(c.market);
    const sidePh = push(c.side);
    const bmPh = push(bookmaker);

    ctes.push(`
      ${alias} AS (
        SELECT event_id,
               (odds - opening) / NULLIF(opening, 0) AS drift
        FROM ${MATCH_ODDS_TABLE}
        WHERE bookmaker = ${bmPh} AND market = ${marketPh} AND selection = ${sidePh}
          AND opening IS NOT NULL AND opening != 0
      ),
      ${alias}_spread AS (
        SELECT event_id, STDDEV(odds) AS spread_close
        FROM ${MATCH_ODDS_TABLE}
        WHERE market = ${marketPh} AND selection = ${sidePh}
        GROUP BY event_id
      )`);

    const stats = STATS[c.code];
    const [medDrift, madDrift] = stats.mean_drift_pct;
    const [medSpread, madSpread] = stats.spread_close;
    const groupWeight = WEIGHTS[c.group] ?? 1;
    const wPerCode = groupWeight / (groupCounts.get(c.group) ?? 1);

    distTerms.push(`
      ${push(wPerCode)} * (
        POWER(LEAST(6, GREATEST(-6, (${alias}.drift - ${push(medDrift)}) / ${push(madDrift || 1)})), 2)
      + POWER(LEAST(6, GREATEST(-6, (${alias}_spread.spread_close - ${push(medSpread)}) / ${push(madSpread || 1)})), 2)
      )`);
  });

  const joins = activeCodes
    .map((_, i) => `LEFT JOIN q${i} ON q${i}.event_id = base.event_id
                     LEFT JOIN q${i}_spread ON q${i}_spread.event_id = base.event_id`)
    .join("\n");

  const totalWeight = activeCodes.reduce((s, c) => {
    const gw = WEIGHTS[c.group] ?? 1;
    return s + gw / (groupCounts.get(c.group) ?? 1);
  }, 0);

  const excludeEventPh = push(eventId);
  const totalWeightPh = push(totalWeight);
  const thresholdPh = push(SIMILARITY_THRESHOLD);
  const limitPh = push(limit);

  // Not: aggregate olmayan bir sütun (score) WHERE'de kullanılamadığı için
  // dış sorguda tekrar hesaplanıyor.
  const scoreExpr = `(${distTerms.join(" + ")}) / ${totalWeightPh}`;
  const text = `
    WITH ${ctes.join(",\n")},
    base AS (SELECT DISTINCT event_id FROM q0)
    SELECT event_id, score FROM (
      SELECT base.event_id, ${scoreExpr} AS score
      FROM base
      ${joins}
      WHERE base.event_id != ${excludeEventPh}
    ) scored
    WHERE score < ${thresholdPh}
    ORDER BY score ASC
    LIMIT ${limitPh}
  `;

  const rows = (await sql.unsafe(text, params as never[])) as { event_id: string; score: number }[];
  const k = Math.max(K_MIN, Math.min(K_DEFAULT, rows.length));
  return {
    matchedCount: rows.length,
    samples: rows.slice(0, k),
    usedCodes: activeCodes.map((c) => c.code),
  };
}
