import { NextResponse } from "next/server";
import { getWarmStatus, startArchiveWarm } from "@/lib/events";
import { pingDuckDb } from "@/lib/duckdb";
import { startQuotesRefresh, getMaterializeStatus } from "@/lib/analysis/duckdbMaterialize";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Analyze sayfası mount olunca çağrılır (ve "ready"/"error" olana kadar
 * client tarafından pollanır).
 *
 * analyzeSeason/searchProfile artık DuckDB üzerinden çalışıyor. Ama "tüm
 * sezonlarda ara" (searchOddsProfileSQL) DE canlı UNNEST yerine yerel
 * materialize edilmiş bir tabloya (quotes_flat, bkz. duckdbMaterialize.ts)
 * bakıyor — o tablonun inşası (JSON unnest, ~son 60 sezon) tek seferlik ama
 * ağır bir iş. Bunu burada, kullanıcı arama tuşuna basmadan ÖNCE (sayfa
 * mount olunca) tetikleyip client'a "loading" olarak raporluyoruz; arama
 * isteği geldiğinde tablo genelde zaten hazır olur ve saniyeler içinde
 * cevap döner. TTL (varsayılan 15dk) dolunca bir sonraki warm çağrısı
 * tabloyu arka planda tazeler.
 *
 * Eski startArchiveWarm(...) / events.ts (tüm sezonu Node RAM'ine çekme)
 * yolu SADECE DuckDB attach tamamen başarısız olursa (ör. DUCKDB_PG_DSN
 * eksik) fixtures.ts'teki fallback tarafından kullanılıyor.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const max = Number(url.searchParams.get("maxSeasons") || 24);
  const maxSeasons = Number.isFinite(max) && max > 0 ? Math.min(max, 80) : 24;

  const duckdb = await pingDuckDb();
  if (!duckdb.ok) {
    console.warn(
      "[/api/analyze/warm] DuckDB unavailable, falling back to legacy RAM warm cache:",
      duckdb.error,
    );
    startArchiveWarm(maxSeasons);
    return NextResponse.json({
      ok: true,
      source: "ram-fallback",
      duckdbError: duckdb.error,
      ...getWarmStatus(),
    });
  }

  // Materialize'ı tetikle (idempotent — zaten yükleniyor/taze ise no-op).
  void startQuotesRefresh().catch(() => {
    /* status zaten getMaterializeStatus() üzerinden okunuyor */
  });
  const m = getMaterializeStatus();

  return NextResponse.json({
    ok: true,
    status: m.status === "idle" ? "loading" : m.status,
    seasonsDone: m.status === "ready" ? m.seasons : 0,
    seasonsTotal: m.seasons,
    events: 0,
    quotes: m.rows,
    error: m.error,
    source: "duckdb",
  });
}

export async function POST(req: Request) {
  return GET(req);
}
