// scripts/test-similarity-single-bm.ts
//
// similarityEngine.ts'i UI/route.ts'e hiç dokunmadan, TEK bir bookmaker
// için doğrudan çağırıp ham sonucu console'a basar. 20 bookmaker'ı sırayla
// dener durumdaki akışta ("20 bm'de patlıyor") neyin patladığını görmek için:
// tek bm'lik gerçek süreyi + gerçek hatayı + döndürülen veriyi izole eder.
//
// Kullanım (proje kökünden):
//   npx tsx scripts/test-similarity-single-bm.ts                     -> otomatik event + bookmaker seçer
//   npx tsx scripts/test-similarity-single-bm.ts <eventId>            -> event_id'yi sen ver, bookmaker'ı otomatik seçer
//   npx tsx scripts/test-similarity-single-bm.ts <eventId> <bookmaker> -> ikisini de sen ver (ör. "bet365")
//
// DATABASE_URL, src/lib/db.ts'in okuduğu değişkenle AYNI olmalı — .env.local'den
// otomatik yükleniyor (diagnose-search.mjs'teki desenin aynısı).

import { readFileSync, existsSync } from "fs";

function loadEnvLocal() {
  if (!existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    const v = m[2].replace(/^["']|["']$/g, "");
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}

async function main() {
  loadEnvLocal();

  const { sql } = await import("@/lib/db");
  const { findSimilarForBookmaker } = await import("@/lib/analysis/similarityEngine");

  let [eventId, bookmaker] = process.argv.slice(2);

  try {
    // 1) event_id verilmediyse: match_odds'ta en çok satırı olan (en dolu)
    //    yakın tarihli bir maçı otomatik seç — testin "veri yok" yüzünden
    //    boş dönmesini engellemek için.
    if (!eventId) {
      console.log("event_id verilmedi, otomatik seçiliyor...");
      const rows = (await sql.unsafe(`
        SELECT event_id, COUNT(*) AS n
        FROM match_odds
        WHERE opening IS NOT NULL AND opening != 0
        GROUP BY event_id
        ORDER BY n DESC
        LIMIT 1
      `)) as { event_id: string; n: number }[];
      if (!rows.length) throw new Error("match_odds içinde uygun satır bulunamadı.");
      eventId = rows[0].event_id;
      console.log(`  -> event_id = ${eventId} (${rows[0].n} satır)`);
    }

    // 2) bookmaker verilmediyse: bu event için en çok satırı olan bookmaker'ı seç.
    if (!bookmaker) {
      console.log("bookmaker verilmedi, otomatik seçiliyor...");
      const rows = (await sql.unsafe(
        `
        SELECT bookmaker, COUNT(*) AS n
        FROM match_odds
        WHERE event_id = $1 AND bookmaker IS NOT NULL
          AND opening IS NOT NULL AND opening != 0
        GROUP BY bookmaker
        ORDER BY n DESC
        LIMIT 1
      `,
        [eventId] as never[],
      )) as { bookmaker: string; n: number }[];
      if (!rows.length) throw new Error(`event_id=${eventId} için bookmaker bulunamadı.`);
      bookmaker = rows[0].bookmaker;
      console.log(`  -> bookmaker = ${bookmaker} (${rows[0].n} satır)`);
    }

    // 3) Bu event + bookmaker için fixtureOdds'u gerçek match_odds'tan çek
    //    (route.ts'te bunu client fixture.odds'tan türetiyordu — burada
    //    doğrudan DB'den okuyoruz, aynı şekil: market/selection/odds/opening).
    const fixtureRows = (await sql.unsafe(
      `
      SELECT market, selection, odds, opening
      FROM match_odds
      WHERE event_id = $1 AND bookmaker = $2
        AND opening IS NOT NULL AND opening != 0
    `,
      [eventId, bookmaker] as never[],
    )) as { market: string; selection: string; odds: number; opening: number }[];

    console.log(`\nfixtureOdds satır sayısı: ${fixtureRows.length}`);
    if (!fixtureRows.length) {
      console.log("HATA: bu event_id + bookmaker için satır yok, başka bir kombinasyon dene.");
      return;
    }

    console.log(`\n=== findSimilarForBookmaker çağrılıyor ===`);
    console.log(`eventId=${eventId}  bookmaker=${bookmaker}`);

    const t0 = Date.now();
    const result = await findSimilarForBookmaker({
      eventId,
      bookmaker,
      fixtureOdds: fixtureRows,
    });
    const ms = Date.now() - t0;

    console.log(`\n=== SONUÇ (${ms}ms) ===`);
    console.log("usedCodes (aktif kod sayısı):", result.usedCodes.length);
    console.log("matchedCount:", result.matchedCount);
    console.log("samples (ilk 10):", result.samples.slice(0, 10));
    console.log("\nusedCodes (ilk 20):", result.usedCodes.slice(0, 20));
  } catch (err) {
    console.error("\n=== HATA ===");
    console.error(err);
  } finally {
    const { sql } = await import("@/lib/db");
    await sql.end();
  }
}

main();
