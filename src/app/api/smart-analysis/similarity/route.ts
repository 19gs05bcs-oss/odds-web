import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { findSimilarForBookmaker, type FixtureOddsRow } from "@/lib/analysis/similarityEngine";
import { fetchQuoteRowsByEventIds } from "@/lib/analysis/marketQuotes";
import { eventsMetaAndQuotesToTableRows, PREFERRED_BM_NAME } from "@/lib/analysis/tableRows";
import type { CompactOddsRow } from "@/lib/archiveCache";

// ÖNEMLİ: bu route bilerek match/route.ts'ten AYRI. Gerçek çalışma süresi
// ~159sn (bkz. test-similarity-real-engine.ts çıktısı, index sonrası).
// match/route.ts'in 150sn'lik bütçesine bunu sığdırmaya çalışmak, ana
// analiz sonucunu da timeout'a sürüklüyordu (bkz. önceki "Unexpected end
// of JSON input" hatası). Bu yüzden:
//   - Kendi (daha uzun) maxDuration'ı var, ana rapor akışını etkilemiyor
//   - Sonuç similarity_cache tablosuna yazılıyor — aynı event_id+bookmaker
//     tekrar istendiğinde ~159sn değil, anında döner
//   - Sayfada OTOMATİK tetiklenmiyor, kullanıcı "Hesapla" butonuna basınca
//     çağrılıyor (her sayfa görüntülemede bu maliyeti göze almamak için)
//
// GEREKSİNİM: similarity_cache tablosu yoksa önce çalıştırın:
//   npx tsx scripts/create-similarity-cache-table.ts
//
// Vercel plan'ınızda bu route için yeterli function timeout'u (>160sn)
// olduğundan emin olun — Hobby planda maxDuration'ı aşan her şey (plan ne
// derse desin) 10sn'de kesilir.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 280;

type Body = {
  eventId?: string;
  bookmaker?: string;
  force?: boolean;
  odds?: CompactOddsRow[]; // seçili maçın KENDİ oranları (client'ın bulletin'den zaten yüklediği
  // fixture.odds) — match_odds tablosu ARŞİV (geçmiş/bitmiş maçlar), henüz
  // oynanmamış/canlı maçın kendi oranları orada olmayabilir. Bu yüzden
  // match_odds'tan event_id ile sorgulamak yerine client'tan alıyoruz —
  // aynen eski match/route.ts'in yaptığı gibi.
};

type CachedRow = {
  matched_count: number;
  used_codes: string[];
  samples: { event_id: string; score: number }[];
  duration_ms: number | null;
  computed_at: string;
};

export async function POST(req: Request) {
  let body: Body = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const eventId = body.eventId;
  const bookmaker = body.bookmaker || PREFERRED_BM_NAME;
  if (!eventId) {
    return NextResponse.json({ ok: false, error: "eventId is required." }, { status: 400 });
  }

  if (!body.force) {
    try {
      const cached = (await sql.unsafe(
        `SELECT matched_count, used_codes, samples, duration_ms, computed_at
         FROM similarity_cache WHERE event_id = $1 AND bookmaker = $2`,
        [eventId, bookmaker] as never[],
      )) as CachedRow[];
      if (cached.length) {
        const c = cached[0];
        const tableRows = await buildTableRows(c.samples, bookmaker);
        return NextResponse.json({
          ok: true,
          cached: true,
          computedAt: c.computed_at,
          matchedCount: c.matched_count,
          usedCodes: c.used_codes,
          durationMs: c.duration_ms,
          tableRows,
        });
      }
    } catch (e) {
      // similarity_cache tablosu henüz yoksa (migration çalıştırılmadıysa)
      // sessizce hesaplamaya devam et — cache'e yazarken tekrar hata verirse
      // orada raporlanır.
      console.error("similarity_cache okunamadı (tablo yok olabilir):", e);
    }
  }

  if (!Array.isArray(body.odds) || !body.odds.length) {
    return NextResponse.json(
      { ok: false, error: "odds is required (selected fixture's own odds, from the bulletin)." },
      { status: 400 },
    );
  }

  const fixtureOdds: FixtureOddsRow[] = body.odds
    .filter((row) => row[5] != null)
    .map((row) => ({
      market: `${row[1]}:${row[2]}`,
      selection: row[3],
      odds: row[5] as number,
      opening: row[4],
    }));

  const t0 = Date.now();
  let result: Awaited<ReturnType<typeof findSimilarForBookmaker>>;
  try {
    result = await findSimilarForBookmaker({ eventId, bookmaker, fixtureOdds });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
  const durationMs = Date.now() - t0;

  try {
    await sql.unsafe(
      `INSERT INTO similarity_cache (event_id, bookmaker, matched_count, used_codes, samples, duration_ms, computed_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (event_id, bookmaker) DO UPDATE
         SET matched_count = EXCLUDED.matched_count,
             used_codes = EXCLUDED.used_codes,
             samples = EXCLUDED.samples,
             duration_ms = EXCLUDED.duration_ms,
             computed_at = now()`,
      [
        eventId,
        bookmaker,
        result.matchedCount,
        JSON.stringify(result.usedCodes),
        JSON.stringify(result.samples),
        durationMs,
      ] as never[],
    );
  } catch (e) {
    // Cache yazımı başarısız olsa bile (ör. tablo yok) sonucu kullanıcıya
    // dön — sadece bir sonraki istekte tekrar hesaplanacak.
    console.error("similarity_cache yazılamadı:", e);
  }

  const tableRows = await buildTableRows(result.samples, bookmaker);

  return NextResponse.json({
    ok: true,
    cached: false,
    computedAt: new Date().toISOString(),
    matchedCount: result.matchedCount,
    usedCodes: result.usedCodes,
    durationMs,
    tableRows,
  });
}

async function buildTableRows(samples: { event_id: string; score: number }[], bookmaker: string) {
  const ids = samples.slice(0, 60).map((s) => s.event_id);
  if (!ids.length) return [];
  const quoteRows = await fetchQuoteRowsByEventIds(ids);
  const rowsById = eventsMetaAndQuotesToTableRows(quoteRows, bookmaker);
  const scoreById = new Map(samples.map((s) => [s.event_id, s.score]));
  return ids
    .map((id) => rowsById.get(id))
    .filter((r): r is NonNullable<typeof r> => Boolean(r))
    .map((r) => ({ ...r, similarityScore: scoreById.get(r.id) }));
}

export type { CachedRow as SimilarityCachedRow };
