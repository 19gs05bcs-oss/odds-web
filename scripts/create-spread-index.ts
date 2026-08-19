// scripts/create-spread-index.ts
// spreadQuery için covering index — event_id, market, selection üzerinden
// TÜM bookmaker'ları grupluyor (bkz. similarityEngine.ts buildSpreadQuery),
// bu yüzden index'in leading kolonu bookmaker DEĞİL, event_id.
//
// Kullanım:
//   export DIRECT_DATABASE_URL="postgresql://...:5432/postgres"   (5432! pooler 6543 değil)
//   npx tsx scripts/create-spread-index.ts

import postgres from "postgres";

async function main() {
  const connectionString = process.env.DIRECT_DATABASE_URL;
  if (!connectionString) {
    console.error("HATA: DIRECT_DATABASE_URL env değişkeni yok.");
    process.exit(1);
  }
  if (connectionString.includes(":6543")) {
    console.error("HATA: 6543 (transaction pooler) ile CONCURRENTLY güvenilir çalışmaz. 5432 (direct/session) connection string ver.");
    process.exit(1);
  }

  const sql = postgres(connectionString, { prepare: false, ssl: "require", max: 1 });

  try {
    console.log("Session statement_timeout kaldırılıyor...");
    await sql.unsafe(`SET statement_timeout = 0`);

    console.log("Index build başlıyor (CONCURRENTLY) — dakikalar sürebilir, script'i açık bırak...");
    const t0 = Date.now();

    await sql.unsafe(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_match_odds_spread_covering
      ON match_odds (event_id, market, selection)
      INCLUDE (odds)
    `);

    console.log(`\n=== BAŞARILI (${Date.now() - t0}ms) ===`);
  } catch (err) {
    console.error("\n=== HATA ===");
    console.error(err);
    console.log(
      "\nNot: yarım kalırsa kontrol et: SELECT indisvalid FROM pg_index WHERE indexrelid = 'idx_match_odds_spread_covering'::regclass; " +
      "false ise: DROP INDEX CONCURRENTLY idx_match_odds_spread_covering; sonra tekrar dene."
    );
  } finally {
    await sql.end();
  }
}

main();
