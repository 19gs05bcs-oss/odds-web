import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { MATCH_ODDS_TABLE } from "@/lib/analysis/marketQuotes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Analyze sayfası mount olunca çağrılır (client tarafından pollanır).
 *
 * ESKİSİ: analyzeSeason/searchProfile DuckDB'ye materialize edilmiş
 * quotes_flat tablosuna bakıyordu — bu tablonun inşası (Koyeb'den NDJSON
 * stream) tek seferlik ama ağır bir işti, bu route onu tetikleyip
 * "loading" durumunu raporluyordu.
 *
 * ŞİMDİ: analyzeSeason/searchProfile doğrudan Postgres'in `match_odds`
 * tablosuna sorgu atıyor — materialize/warm-up adımı YOK, her istek zaten
 * canlı veriyle çalışıyor. Bu route artık sadece hafif bir bağlantı
 * kontrolü yapıp "ready" döner; client'taki eski warm-progress UI'si
 * (aynı JSON şekli üzerinden) çalışmaya devam eder.
 */
export async function GET() {
  try {
    await sql.unsafe(`SELECT 1 FROM ${MATCH_ODDS_TABLE} LIMIT 1`);
    return NextResponse.json({
      ok: true,
      status: "ready",
      seasonsDone: 0,
      seasonsTotal: 0,
      events: 0,
      quotes: 0,
      source: "postgres",
    });
  } catch (e) {
    return NextResponse.json({
      ok: true,
      status: "error",
      seasonsDone: 0,
      seasonsTotal: 0,
      events: 0,
      quotes: 0,
      error: e instanceof Error ? e.message : String(e),
      source: "postgres",
    });
  }
}

export async function POST(req: Request) {
  return GET();
}
