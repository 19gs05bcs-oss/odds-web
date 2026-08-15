/**
 * ⚠️ DEPRECATED — ARTIK KULLANILMIYOR (bkz. src/lib/analysis/marketQuotes.ts).
 * analyzeSeasonSQL.ts ve searchOddsProfileSQL.ts artık DuckDB/Koyeb'e hiç
 * dokunmuyor, doğrudan Postgres'teki `match_odds` tablosuna sorgu atıyor.
 * Bu dosya hiçbir yerden import edilmiyor — silinmedi, referans olsun diye
 * bırakıldı. Güvenle silinebilir.
 */

/**
 * "quotes_flat" — DuckDB'nin kendi yerel tablosunda materialize edilmiş,
 * flat quote satırları (market × selection × bookmaker, event meta dahil).
 *
 * ESKİSİ (bir önceki iterasyon): DuckDB canlı `pg.events`'e ATTACH olup
 * markets_json'ı UNNEST ediyordu — tam da OOM'a yol açan işlemin kendisiydi,
 * sadece :memory: yerine disk-backed yapılarak yumuşatılmıştı.
 *
 * ŞİMDİ: Postgres'e hiç dokunmuyoruz. Koyeb worker'ın (archive_cache_server.py)
 * zaten flat olan `/quotes/season/{slug}` (quotes tablosu — markets_json YOK)
 * ve hafif `/events/season/{slug}` (event meta — markets_json YOK) HTTP
 * endpoint'lerinden sezon sezon çekip, event_id üzerinden Node'da birleştirip
 * NDJSON olarak DİSKE stream ediyoruz (tüm sezonları aynı anda RAM'de
 * tutmadan — bir sezon bitince referansı bırakılır, GC edilir). Sonunda
 * DuckDB'nin `read_json_auto`'su bu NDJSON dosyasını TEK SEFERDE tabloya
 * yüklüyor. Node process RAM'inde hiçbir zaman "tüm sezonlar" aynı anda
 * durmuyor — sadece o an işlenen tek sezonun satırları.
 */
import { getDuckDbMaterializeConnection } from "@/lib/duckdb";
import {
  fetchKoyebSeasonsMeta,
  fetchKoyebQuotesSeason,
  fetchKoyebEventsMetaSeason,
  type KoyebEventMeta,
} from "@/lib/koyebCache";

const TABLE = "quotes_flat";

const DEFAULT_SEASON_SCAN_LIMIT = Number(process.env.ANALYZE_DEFAULT_SEASON_SCAN_LIMIT) || 60;
const REFRESH_TTL_MS = Number(process.env.ANALYZE_QUOTES_REFRESH_TTL_MS) || 15 * 60_000;
const STAGE_PATH = process.env.DUCKDB_STAGE_PATH || "/tmp/oddsvig-duckdb/quotes_stage.ndjson";

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

async function seasonSlugsToMaterialize(limit: number): Promise<string[]> {
  const seasons = await fetchKoyebSeasonsMeta();
  const sorted = [...seasons].sort((a, b) =>
    String(b.season_label || "").localeCompare(String(a.season_label || "")),
  );
  return sorted.slice(0, limit).map((s) => s.id);
}

function sqlQuoteLiteral(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

type FlatRow = {
  event_id: string;
  season_slug: string | null;
  competition: string | null;
  round: string | null;
  home_team: string | null;
  away_team: string | null;
  kickoff_at: string | null;
  home_score: number | string | null;
  away_score: number | string | null;
  home_ht_score: number | string | null;
  away_ht_score: number | string | null;
  source_event_id: string | null;
  bookmaker_id: number | string | null;
  market_type: string | null;
  market_scope: string | null;
  side: string | null;
  opening: number | null;
  closing: number | null;
  active: boolean | null;
};

function toFlatRow(
  q: Record<string, unknown>,
  meta: KoyebEventMeta | undefined,
  seasonSlug: string,
): FlatRow | null {
  const eventId = q.event_id != null ? String(q.event_id) : null;
  if (!eventId) return null;
  return {
    event_id: eventId,
    season_slug: (meta?.season_slug as string) ?? seasonSlug,
    competition: meta?.competition ?? null,
    round: meta?.round ?? null,
    home_team: meta?.home_team ?? null,
    away_team: meta?.away_team ?? null,
    kickoff_at: meta?.kickoff_at ?? ((q.kickoff_at as string) ?? null),
    home_score: meta?.home_score ?? null,
    away_score: meta?.away_score ?? null,
    home_ht_score: meta?.home_ht_score ?? null,
    away_ht_score: meta?.away_ht_score ?? null,
    source_event_id: meta?.source_event_id ?? null,
    bookmaker_id: (q.bookmaker_id as number | string | null) ?? null,
    market_type: (q.betting_type as string) ?? null,
    market_scope: (q.betting_scope as string) ?? null,
    side: (q.side as string) ?? null,
    opening: q.opening == null ? null : Number(q.opening),
    closing: q.current == null ? null : Number(q.current),
    active: q.active == null ? null : Boolean(q.active),
  };
}

async function writeSeasonToStage(
  writeLine: (line: string) => Promise<void>,
  seasonSlug: string,
): Promise<number> {
  const [quotesRes, metaRes] = await Promise.all([
    fetchKoyebQuotesSeason(seasonSlug),
    fetchKoyebEventsMetaSeason(seasonSlug),
  ]);
  const metaById = new Map(metaRes.events.map((e) => [String(e.id), e]));

  let count = 0;
  for (const q of quotesRes.quotes) {
    const eventId = q.event_id != null ? String(q.event_id) : null;
    const meta = eventId ? metaById.get(eventId) : undefined;
    const row = toFlatRow(q, meta, seasonSlug);
    if (!row) continue;
    await writeLine(JSON.stringify(row));
    count++;
  }
  // quotesRes/metaRes bu fonksiyon dönünce scope dışına çıkar — bir sonraki
  // sezona geçmeden önce GC'ye uygun hale gelir, tüm sezonlar aynı anda
  // RAM'de birikmez.
  return count;
}

async function buildTable(): Promise<void> {
  const b = bag();
  b.status = { status: "loading", rows: 0, seasons: 0, startedAt: Date.now() };
  try {
    const { mkdirSync, rmSync, createWriteStream } = await import("node:fs");
    const { dirname } = await import("node:path");
    mkdirSync(dirname(STAGE_PATH), { recursive: true });
    rmSync(STAGE_PATH, { force: true });

    const stream = createWriteStream(STAGE_PATH, { flags: "w" });
    const writeLine = (line: string): Promise<void> =>
      new Promise((resolve, reject) => {
        const ok = stream.write(line + "\n", (err) => {
          if (err) reject(err);
        });
        if (ok) resolve();
        else stream.once("drain", resolve);
      });

    const seasons = await seasonSlugsToMaterialize(DEFAULT_SEASON_SCAN_LIMIT);
    let totalRows = 0;
    let seasonsOk = 0;
    for (const slug of seasons) {
      try {
        totalRows += await writeSeasonToStage(writeLine, slug);
        seasonsOk++;
      } catch (e) {
        // Tek sezonun Koyeb'den çekilmesi başarısız olsa bile diğer
        // sezonlarla devam et — tüm materialize'ı iptal etme.
        console.error(`[duckdbMaterialize] sezon ${slug} atlandı:`, e);
      }
    }

    await new Promise<void>((resolve, reject) => {
      stream.end((err: unknown) => (err ? reject(err) : resolve()));
    });

    if (totalRows === 0) {
      throw new Error(
        "Koyeb'den hiç quote satırı gelmedi (KOYEB_CACHE_URL/CACHE_API_TOKEN doğru mu, Koyeb worker ayakta mı kontrol et).",
      );
    }

    const conn = await getDuckDbMaterializeConnection();
    await conn.run(
      `CREATE OR REPLACE TABLE ${TABLE} AS SELECT * FROM read_json_auto(${sqlQuoteLiteral(
        STAGE_PATH,
      )}, format='newline_delimited', sample_size=-1)`,
    );
    await conn.run(
      `CREATE INDEX IF NOT EXISTS idx_qf_market ON ${TABLE}(market_type, market_scope, side);`,
    );
    await conn.run(`CREATE INDEX IF NOT EXISTS idx_qf_event ON ${TABLE}(event_id);`);

    rmSync(STAGE_PATH, { force: true });

    const countReader = await conn.runAndReadAll(`SELECT COUNT(*) AS n FROM ${TABLE}`);
    const rowObjs = countReader.getRowObjectsJS() as { n: unknown }[];
    const rows = Number(rowObjs[0]?.n ?? 0);

    b.status = {
      status: "ready",
      rows,
      seasons: seasonsOk,
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
