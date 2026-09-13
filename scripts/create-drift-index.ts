// scripts/create-drift-index.ts
import postgres from "postgres";

async function main() {
  const connectionString = process.env.DIRECT_DATABASE_URL;
  if (!connectionString) {
    console.error("HATA: DIRECT_DATABASE_URL env değişkeni yok.");
    process.exit(1);
  }
  if (connectionString.includes(":6543")) {
    console.error("HATA: 6543 (transaction pooler) ile CONCURRENTLY güvenilir çalışmaz.");
    process.exit(1);
  }

  const sql = postgres(connectionString, { prepare: false, ssl: "require", max: 1 });

  try {
    console.log("Session statement_timeout kaldırılıyor...");
    await sql.unsafe(`SET statement_timeout = 0`);

    console.log("Index build başlıyor (CONCURRENTLY) — bu dakikalar sürebilir, script'i açık bırak...");
    const t0 = Date.now();

    await sql.unsafe(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_match_odds_drift_covering
      ON match_odds (bookmaker, market, selection)
      INCLUDE (event_id, odds, opening)
      WHERE opening IS NOT NULL AND opening <> 0
    `);

    console.log(`\n=== BAŞARILI (${Date.now() - t0}ms) ===`);
  } catch (err) {
    console.error("\n=== HATA ===");
    console.error(err);
  } finally {
    await sql.end();
  }
}

main();
