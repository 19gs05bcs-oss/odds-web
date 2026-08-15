/**
 * "quotes_flat" — DuckDB'nin kendi yerel (in-memory) tablosunda materialize
 * edilmiş, events.markets_json'ın açılmış (market × selection × bookmaker)
 * hâli.
 *
 * NEDEN: searchOddsProfileSQL.ts eskiden her arama isteğinde `pg.events`
 * tablosuna canlı bağlanıp JSON-unnest cross-join yapıyordu. Arşiv 24
 * sezondan 283+ sezona çıkınca, sadece taranan sezon sayısını (60'a)
 * sınırlamak yetmedi — asıl maliyet "kaç sezon" değil, HER istekte bu ağır
 * unnest işleminin SIFIRDAN tekrar edilmesiydi (tek kriterli arama bile
 * 30+ saniye sürüp Railway gateway timeout'una (502) çarpıyordu).
 *
 * Bu dosya, unnest işini periyodik olarak (TTL ile) BİR KEZ yapıp sonucu
 * DuckDB'nin kendi yerel tablosuna yazıyor. Arama istekleri artık bu hazır
 * tabloya basit indexli WHERE sorgusu atıyor — milisaniyeler sürer.
 *
 * Trade-off: bu hâlâ "son N sezon" ile sınırlı (ANALYZE_DEFAULT_SEASON_SCAN_LIMIT) —
 * tüm 283 sezonu materialize etmek DuckDB'nin :memory: instance'ında çok
 * daha fazla RAM ister. Gerçek uzun vadeli çözüm, bunu diske persist eden
 * bir DuckDB dosyasına veya Postgres'te normalize edilmiş bir tabloya
 * taşımak — ayrı bir proje.
 */
import { getDuckDbMaterializeConnection } from "@/lib/duckdb";
import { sql } from "@/lib/db";

const TABLE = "quotes_flat";

// quotes_flat, tek bir kriterle filtrelenmiş dar bir sonuç DEĞİL — o sezon
// aralığındaki HER market/seçenek/bahisçi kombinasyonunu içeriyor. 60 sezonda
// bu, süreci OOM'a (Killed) götürecek kadar büyüktü. Disk-backed DuckDB'ye
// geçiş (bkz. duckdb.ts) bunu out-of-core yapılabilir kılıyor, ama yine de
// daha güvenli/küçük bir varsayılanla başlayıp gerekirse yükseltiyoruz.
const DEFAULT_SEASON_SCAN_LIMIT = Number(process.env.ANALYZE_DEFAULT_SEASON_SCAN_LIMIT) || 20;
const REFRESH_TTL_MS = Number(process.env.ANALYZE_QUOTES_REFRESH_TTL_MS) || 15 * 60_000;

export type MaterializeStatus = {
  status: "idle" | "loading" | "ready" | "error";
  rows: number;
  seasons: number;
  startedAt?: number;
  readyAt?: number;
  error?: string;
};

type Bag = { status: MaterializeStatus; promise: Promise<void> | null };

function bag(): Bag {
  const g = globalThis as unknown as { __quotesFlatBag?: Bag };
  if (!g.__quotesFlatBag) {
    g.__quotesFlatBag = { status: { status: "idle", rows: 0, seasons: 0 }, promise: null };
  }
  return g.__quotesFlatBag;
}

async function recentSeasonIds(limit: number): Promise<string[]> {
  const rows = await sql.unsafe<{ id: string }[]>(
    "SELECT id FROM seasons WHERE source = 'flashscore' ORDER BY season_label DESC LIMIT $1",
    [limit],
  );
  return rows.map((r) => r.id);
}

function sqlQuoteLiteral(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

async function buildTable(): Promise<void> {
  const b = bag();
  b.status = { status: "loading", rows: 0, seasons: 0, startedAt: Date.now() };
  try {
    const seasons = await recentSeasonIds(DEFAULT_SEASON_SCAN_LIMIT);
    const conn = await getDuckDbMaterializeConnection();
    const seasonCond = seasons.length
      ? `AND e.season_slug IN (${seasons.map(sqlQuoteLiteral).join(", ")})`
      : "";

    // Not: DDL/materialize adımı — kullanıcı girdisi burada YOK (season id'ler
    // Postgres'ten geldi, prepared statement değil ama ATTACH gibi kendi
    // içimizde üretilmiş literal'lar), analyzeSeasonSQL.ts'deki ATTACH ile
    // aynı güvenlik modeli.
    const createSql = `
      CREATE OR REPLACE TABLE ${TABLE} AS
      SELECT
        e.id AS event_id, e.source_event_id, e.competition, e.season_slug, e.round,
        e.home_team, e.away_team, e.kickoff_at, e.home_score, e.away_score,
        e.home_ht_score, e.away_ht_score,
        json_extract_string(m, '$.type') AS market_type,
        COALESCE(json_extract_string(m, '$.scope'), 'FULL_TIME') AS market_scope,
        json_extract_string(m, '$.key') AS market_key,
        json_extract_string(m, '$.name') AS market_name,
        json_extract_string(m, '$.line') AS market_line,
        json_extract_string(s, '$.key') AS side,
        json_extract_string(s, '$.name') AS side_name_raw,
        TRY_CAST(json_extract_string(s, '$.bookmakers.' || bm_id || '.opening') AS DOUBLE) AS opening,
        TRY_CAST(json_extract_string(s, '$.bookmakers.' || bm_id || '.current') AS DOUBLE) AS closing,
        bm_id AS bookmaker_id,
        json_extract_string(e.markets_json, '$.bookmakers.' || bm_id) AS bookmaker_name,
        (json_extract_string(s, '$.bookmakers.' || bm_id || '.active') = 'false') AS suspended
      FROM pg.events e,
           UNNEST(CAST(json_extract(e.markets_json, '$.markets') AS JSON[])) AS tm(m),
           UNNEST(CAST(json_extract(m, '$.selections') AS JSON[])) AS ts(s),
           UNNEST(json_keys(json_extract(s, '$.bookmakers'))) AS tb(bm_id)
      WHERE e.source = 'flashscore'
        ${seasonCond}

      UNION ALL

      SELECT
        e.id AS event_id, e.source_event_id, e.competition, e.season_slug, e.round,
        e.home_team, e.away_team, e.kickoff_at, e.home_score, e.away_score,
        e.home_ht_score, e.away_ht_score,
        json_extract_string(m, '$.type') AS market_type,
        COALESCE(json_extract_string(m, '$.scope'), 'FULL_TIME') AS market_scope,
        json_extract_string(m, '$.key') AS market_key,
        json_extract_string(m, '$.name') AS market_name,
        json_extract_string(m, '$.line') AS market_line,
        json_extract_string(s, '$.key') AS side,
        json_extract_string(s, '$.name') AS side_name_raw,
        TRY_CAST(json_extract_string(s, '$.opening') AS DOUBLE) AS opening,
        TRY_CAST(json_extract_string(s, '$.odds') AS DOUBLE) AS closing,
        NULL AS bookmaker_id,
        json_extract_string(s, '$.bookmaker_name') AS bookmaker_name,
        COALESCE(TRY_CAST(json_extract_string(s, '$.suspended') AS BOOLEAN), false) AS suspended
      FROM pg.events e,
           UNNEST(CAST(json_extract(e.markets_json, '$.markets') AS JSON[])) AS tm(m),
           UNNEST(CAST(json_extract(m, '$.selections') AS JSON[])) AS ts(s)
      WHERE e.source = 'flashscore'
        AND COALESCE(len(json_keys(json_extract(s, '$.bookmakers'))), 0) = 0
        ${seasonCond}
    `;

    await conn.run(createSql);
    await conn.run(
      `CREATE INDEX IF NOT EXISTS idx_qf_market ON ${TABLE}(market_type, market_scope, side);`,
    );
    await conn.run(`CREATE INDEX IF NOT EXISTS idx_qf_event ON ${TABLE}(event_id);`);

    const countReader = await conn.runAndReadAll(`SELECT COUNT(*) AS n FROM ${TABLE}`);
    const rowObjs = countReader.getRowObjectsJS() as { n: unknown }[];
    const rows = Number(rowObjs[0]?.n ?? 0);

    b.status = {
      status: "ready",
      rows,
      seasons: seasons.length,
      startedAt: b.status.startedAt,
      readyAt: Date.now(),
    };
  } catch (e) {
    b.status = {
      status: "error",
      rows: 0,
      seasons: 0,
      error: e instanceof Error ? e.message : String(e),
    };
    throw e;
  }
}

export function getMaterializeStatus(): MaterializeStatus {
  return bag().status;
}

function isStale(): boolean {
  const s = bag().status;
  if (s.status !== "ready" || !s.readyAt) return true;
  return Date.now() - s.readyAt > REFRESH_TTL_MS;
}

/** Idempotent arka plan tetikleyici — zaten yükleniyorsa/tazeyse mevcut promise'i döner. */
export function startQuotesRefresh(): Promise<void> {
  const b = bag();
  if (b.status.status === "loading" && b.promise) return b.promise;
  if (b.status.status === "ready" && !isStale()) return Promise.resolve();
  b.promise = buildTable().finally(() => {
    /* keep promise for awaiters */
  });
  return b.promise;
}

/** Arama yollarının çağırdığı: tablo hazır/taze değilse bekler (max waitMs), sonra devam eder. */
export async function ensureQuotesTable(waitMs = 45_000): Promise<MaterializeStatus> {
  const b = bag();
  if (b.status.status === "ready" && !isStale()) return b.status;
  const p = startQuotesRefresh();
  await Promise.race([p, new Promise<void>((resolve) => setTimeout(resolve, waitMs))]);
  return b.status;
}

export const QUOTES_FLAT_TABLE = TABLE;
