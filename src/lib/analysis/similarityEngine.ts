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
 *
 * NOT — DB BAĞLANTISI: db.ts'deki paylaşılan `sql` (Supavisor transaction
 * pooler, 6543) yerine bilerek dbDirect.ts'deki `sqlDirect` (5432, direct/
 * session) kullanılıyor. driftQuery/spreadQuery büyük VALUES-join sorguları
 * olduğu için pooler'da 502 ile kesiliyordu; direct connection'da sorun
 * yok. Railway'de DIRECT_DATABASE_URL env değişkeni set edilmiş olmalı.
 */

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

/**
 * KADEMELİ (CASCADE) FİLTRELEME — neden gerekli:
 *
 * SIMILARITY_CODES ~357 kod üretiyor (28 O/U çizgisi × 2 yön × 3 scope, 25
 * AH çizgisi × 2 × 3 scope, vs.). Eski tasarım TEK geçişte tüm aktif
 * kodların ağırlıklı z-distance'ını alıp bir eşiğe (SIMILARITY_THRESHOLD)
 * ve %60 coverage şartına (minRequiredCodes) tabi tutuyordu. Sorun: gerçek
 * bookmaker verisinde uç O/U ve AH çizgileri (ör. AH -3.0, OU 6.75) çok
 * nadiren quote edilir, dolayısıyla geçmiş adayların büyük çoğunluğu bu
 * uç kodlarda drift/spread verisine sahip DEĞİL. Sonuç: hiçbir aday %60
 * coverage'ı geçemiyor, havuz boş kalıyor, similarity DAİMA sıfır dönüyor.
 * Ayrıca "tüm marketin AYNI ANDA benzer olması" istatistiksel olarak da
 * neredeyse imkansız bir şart.
 *
 * ÇÖZÜM — üç aşamalı huni (tüm veri zaten driftQuery/spreadQuery ile tek
 * seferde çekildiği için ek DB sorgusu GEREKMİYOR, sadece JS'te aday
 * havuzunu art arda daraltıyoruz):
 *   Aşama 1 (STAGE1_MARKET)  : sadece MS 1X2 (H/D/A) — 3 kod, hemen her
 *                               maçta var → havuzu STAGE1_POOL adaya indir.
 *   Aşama 2 (isLiquidCode)   : 1X2 (tüm scope) + Çifte Şans MS + KG Var/Yok
 *                               MS + ana O/U çizgileri (1.5/2.5/3.5) + ana
 *                               AH çizgileri (-1/-0.5/0/0.5/1) → STAGE2_POOL.
 *   Aşama 3 (activeCodes)    : TÜM aktif kodlarla (357'ye kadar) ince
 *                               skorlama, ama artık sadece STAGE2_POOL kadar
 *                               (~60) adayın üzerinde → en iyi k tanesi.
 * Her aşamada sabit bir "geç/kal" eşiği yerine sadece "en yakın N tanesini
 * al" mantığı var; bu yüzden sonuç asla sert bir eşik yüzünden sıfıra
 * düşmüyor — havuzda ne kadar aday varsa oradan en iyisi seçilir.
 */
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

/** code.side'dan sayısal çizgiyi çıkarır: "OVER:2.5" -> 2.5, "H:-1.0" -> -1. */
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
 * Skorlama artık TEK geçiş değil, kademeli (bkz. yukarıdaki "KADEMELİ
 * FİLTRELEME" bloğu): önce sadece 1X2 ile, sonra likit pazarlarla, en
 * sonda TÜM aktif kodlarla daralan bir havuz üzerinden çalışır. Bir
 * maçın bir aşamada elenmemesi için o aşamadaki kodlardan EN AZ BİRİNDE
 * hem drift hem spread verisi olması yeterli — tüm kodlarda veri şartı
 * artık yok (bu şart sıfır sonuç sorununun asıl nedeniydi).
 */
export async function findSimilarForBookmaker(opts: {
  eventId: string;
  bookmaker: string;
  fixtureOdds: FixtureOddsRow[]; // seçili maçın TÜM market/selection satırları
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

  /**
   * Verilen kod alt kümesiyle, verilen aday event_id listesini skorlar ve
   * artan skora (küçük = daha benzer) göre sıralı döner. En az 1 kod
   * eşleşen her aday havuzda kalır — sert bir coverage/threshold şartı
   * YOK, huninin bir sonraki (daha geniş kod setli) aşaması zaten daha
   * sıkı bir eleme yapacak.
   */
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
      if (!drifts || !spreads) continue;

      let sum = 0;
      let matchedWeight = 0;
      let matched = 0;

      for (const c of codes) {
        const key = codeKey(c.market, c.side);
        const drift = drifts.get(key);
        const spread = spreads.get(key);
        if (drift == null || spread == null) continue;

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

  // --- Aşama 1: sadece MS 1X2 (tam maç) — geniş havuzu hızlıca daralt ---
  const stage1Codes = activeCodes.filter((c) => c.market === STAGE1_MARKET);
  const stage1Ranked = scoreCandidates(
    stage1Codes.length ? stage1Codes : activeCodes,
    candidateEventIds,
  );
  const stage1Pool = stage1Ranked.slice(0, STAGE1_POOL).map((r) => r.event_id);

  // --- Aşama 2: likit pazarlar (1X2 tüm scope + ÇŞ + KG + ana O/U + ana AH) ---
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
