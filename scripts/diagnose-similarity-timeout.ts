// scripts/diagnose-similarity-timeout.ts
//
// findSimilarForBookmaker içindeki driftQuery/spreadQuery'nin NEREDE
// timeout'a girdiğini bulmak için: hiçbir sorguyu (ANALYZE ile) fiilen
// TAMAMLAMAYA çalışmadan sadece EXPLAIN planını + tahmini satır sayısını
// çeker, ayrıca match_odds üzerindeki mevcut index'leri listeler.
//
// Kullanım:
//   npx tsx -r ./scripts/stub-server-only.cjs scripts/diagnose-similarity-timeout.ts <eventId> <bookmaker>

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
  const { buildSimilarityQueries } = await import("@/lib/analysis/similarityEngine");

  let [eventId, bookmaker] = process.argv.slice(2);

  try {
    if (!eventId || !bookmaker) {
      const rows = (await sql.unsafe(`
        SELECT event_id, bookmaker, COUNT(*) AS n
        FROM match_odds
        WHERE opening IS NOT NULL AND opening != 0
        GROUP BY event_id, bookmaker
        ORDER BY n DESC
        LIMIT 1
      `)) as { event_id: string; bookmaker: string; n: number }[];
      eventId = eventId || rows[0].event_id;
      bookmaker = bookmaker || rows[0].bookmaker;
      console.log(`event_id=${eventId} bookmaker=${bookmaker}`);
    }

    // 0) match_odds üzerindeki mevcut index'ler
    console.log("\n=== match_odds INDEX'LERİ ===");
    const idx = (await sql.unsafe(`
      SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'match_odds'
    `)) as { indexname: string; indexdef: string }[];
    idx.forEach((r) => console.log(` - ${r.indexname}: ${r.indexdef}`));

    // 1) Bu bookmaker için toplam satır sayısı (LIMIT'siz driftQuery'nin
    //    büyüklük mertebesini anlamak için)
    console.log("\n=== bookmaker toplam satır sayısı ===");
    const cnt = (await sql.unsafe(
      `SELECT COUNT(*) AS n FROM match_odds WHERE bookmaker = $1 AND opening IS NOT NULL AND opening != 0`,
      [bookmaker] as never[],
    )) as { n: string }[];
    console.log(`  bookmaker=${bookmaker} -> ${cnt[0].n} satır`);

    // 2) fixtureOdds çek + activeCodes/driftQuery/spreadQuery inşa et (DB'ye dokunmadan)
    const fixtureRows = (await sql.unsafe(
      `SELECT market, selection, odds, opening FROM match_odds WHERE event_id = $1 AND bookmaker = $2 AND opening IS NOT NULL AND opening != 0`,
      [eventId, bookmaker] as never[],
    )) as { market: string; selection: string; odds: number; opening: number }[];

    const built = buildSimilarityQueries({ bookmaker, fixtureOdds: fixtureRows });
    if (!built) {
      console.log("HATA: buildSimilarityQueries null döndü (aktif kod yok).");
      return;
    }
    console.log(`\naktif kod sayısı: ${built.activeCodes.length}`);

    // 3) driftQuery'nin EXPLAIN planı (satır tahmini) — ÇALIŞTIRMIYORUZ, sadece plan
    console.log("\n=== driftQuery EXPLAIN (tahmini satır sayısı) ===");
    const driftPlan = await sql.unsafe(
      `EXPLAIN ${built.driftQuery.text}`,
      built.driftQuery.params as never[],
    );
    console.log((driftPlan as unknown as { "QUERY PLAN": string }[]).map((r) => r["QUERY PLAN"]).join("\n"));
  } catch (err) {
    console.error("\n=== HATA ===");
    console.error(err);
  } finally {
    const { sql } = await import("@/lib/db");
    await sql.end();
  }
}

main();
