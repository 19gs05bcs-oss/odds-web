// scripts/test-similarity-real-engine.ts
//
// ÖNEMLİ: test-similarity-single-bm.ts elle iterasyonlarla similarityEngine.ts'in
// zaten reddettiği "kod başına 1 subquery" anti-pattern'ine geri sürüklenmiş
// (bkz. EXPLAIN çıktısındaki 92 ayrı correlated GroupAggregate subquery).
// similarityEngine.ts'in kendisi bu sorunu ZATEN çözmüş durumda — kod sayısından
// bağımsız sadece 2 set-based sorgu kullanıyor. Bu script, paralel/drifted bir
// SQL reimplementasyonu tutmak yerine GERÇEK üretim fonksiyonunu çağırıyor.
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
    if (!eventId) {
      const rows = (await sql.unsafe(
        `SELECT event_id FROM match_odds WHERE opening IS NOT NULL AND opening != 0 GROUP BY event_id ORDER BY COUNT(*) DESC LIMIT 1`
      )) as { event_id: string }[];
      eventId = rows[0].event_id;
    }
    if (!bookmaker) bookmaker = "bet365";

    console.log(`\n=== GERÇEK ÜRETİM ENGINE'İ TEST EDİLİYOR (similarityEngine.ts) ===`);
    console.log(`eventId=${eventId}  bookmaker=${bookmaker}`);

    const fixtureRows = (await sql.unsafe(
      `SELECT market, selection, odds, opening FROM match_odds WHERE event_id = $1 AND bookmaker = $2 AND opening IS NOT NULL AND opening != 0`,
      [eventId, bookmaker] as never[]
    )) as { market: string; selection: string; odds: number; opening: number | null }[];

    console.log(`fixtureOdds satır sayısı: ${fixtureRows.length}`);
    if (!fixtureRows.length) {
      console.log("HATA: bu event_id + bookmaker için satır yok.");
      return;
    }

    const t0 = Date.now();
    const result = await findSimilarForBookmaker({
      eventId,
      bookmaker,
      fixtureOdds: fixtureRows,
    });
    const ms = Date.now() - t0;

    console.log(`\n=== BAŞARILI (${ms}ms) ===`);
    console.log("Kullanılan kod sayısı:", result.usedCodes.length);
    console.log("Eşleşen maç sayısı:", result.matchedCount);
    console.log("İlk 10 örnek:", result.samples.slice(0, 10));
  } catch (err) {
    console.error("\n=== SİSTEM HATASI ===");
    console.error(err);
  } finally {
    const { sql } = await import("@/lib/db");
    await sql.end();
  }
}

main();
