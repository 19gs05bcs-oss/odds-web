import { NextResponse } from "next/server";
import { getWarmStatus, startArchiveWarm } from "@/lib/events";
import { pingDuckDb } from "@/lib/duckdb";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Analyze sayfası mount olunca çağrılır.
 *
 * analyzeSeason/searchProfile artık DuckDB üzerinden çalışıyor (bkz.
 * analyzeSeasonSQL.ts, searchOddsProfileSQL.ts) — sezonun tamamını Node
 * RAM'ine çekmeye ihtiyaçları yok. Eski startArchiveWarm(...) / events.ts
 * yolu SADECE DuckDB attach başarısız olursa (ör. DUCKDB_PG_DSN eksik)
 * fixtures.ts'teki fallback tarafından kullanılıyor.
 *
 * Bu yüzden burada önce DuckDB'nin sağlıklı olup olmadığına bakıyoruz:
 * sağlıklıysa legacy RAM cache'e HİÇ dokunmuyoruz ve doğrudan "ready"
 * dönüyoruz — arşiv 24 sezondan 283+ sezona çıktığında bile bellek
 * kullanımı sabit kalır. DuckDB gerçekten kullanılamıyorsa eski
 * davranışa (tüm sezonu RAM'e çekme) güvenlik ağı olarak düşüyoruz.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const max = Number(url.searchParams.get("maxSeasons") || 24);
  const maxSeasons = Number.isFinite(max) && max > 0 ? Math.min(max, 80) : 24;

  const duckdb = await pingDuckDb();
  if (duckdb.ok) {
    return NextResponse.json({
      ok: true,
      status: "ready",
      seasonsDone: 0,
      seasonsTotal: 0,
      events: 0,
      quotes: 0,
      source: "duckdb",
    });
  }

  console.warn(
    "[/api/analyze/warm] DuckDB unavailable, falling back to legacy RAM warm cache:",
    duckdb.error,
  );
  startArchiveWarm(maxSeasons);
  return NextResponse.json({ ok: true, source: "ram-fallback", ...getWarmStatus() });
}

export async function POST(req: Request) {
  return GET(req);
}
