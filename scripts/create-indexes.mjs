// scripts/create-drift-index.ts
// CONCURRENTLY index build — Supavisor transaction pooler (6543) ve
// Supabase SQL Editor'ın HTTP gateway timeout'unu bypass etmek için
// DIRECT connection (5432) ile, ayrı bir tek-seferlik script olarak çalıştır.
//
// Kullanım:
//   export DIRECT_DATABASE_URL="postgresql://postgres:[PASSWORD]@db.<ref>.supabase.co:5432/postgres"
//   npx tsx scripts/create-drift-index.ts

import postgres from "postgres";

async function main() {
  const connectionString = process.env.DIRECT_DATABASE_URL;
  if (!connectionString) {
    console.error("HATA: DIRECT_DATABASE_URL env değişkeni yok. Transaction pooler (6543) DEĞİL, direct connection (5432) kullanmalısın.");
    process.exit(1);
  }
  if (connectionString.includes(":6543")) {
    console.error("HATA: 6543 (transaction pooler) ile CONCURRENTLY güvenilir çalışmaz. 5432 (direct) connection string ver.");
    process.exit(1);
  }

  // max:1 ŞART — SET statement_timeout ve CREATE INDEX'in aynı fiziksel
  // session'da çalıştığından emin olmak için (postgres.js varsayılan olarak
  // birden fazla bağlantı havuzlayabilir; SET başka bağlantıda kalırsa hiç
  // işe yaramaz). prepare:false pooler yoksa şart değil ama zararı yok.
  const sql = postgres(connectionString, { prepare: false, ssl: "require", max: 1 });

  try {
    console.log("Session statement_timeout kaldırılıyor...");
    // Supabase proje/rol seviyesinde varsayılan bir statement_timeout
    // zorluyor (küçük planlarda genelde 2dk civarı) — index build bundan
    // uzun sürdüğü için SESSION seviyesinde geçici olarak sıfırlıyoruz.
    // Bu ayar SADECE bu bağlantı için geçerli, projeyi kalıcı etkilemez.
    await sql.unsafe(`SET statement_timeout = 0`);

    console.log("Index build başlıyor (CONCURRENTLY) — bu dakikalar sürebilir, script'i açık bırak...");
    const t0 = Date.now();

    // NOT: CONCURRENTLY bir transaction bloğu içinde çalışamaz.
    // sql.unsafe tek bir simple-query olarak gider, postgres.js bunu
    // otomatik transaction'a sarmaz (sql.begin kullanmadığımız sürece).
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
    console.log(
      "\nNot: script bir sebeple kesilirse (bağlantı düşerse vs.) Postgres'te " +
      "'idx_match_odds_drift_covering' adında INVALID durumda yarım bir index kalabilir. " +
      "Kontrol et: SELECT indexrelid::regclass, indisvalid FROM pg_index WHERE indexrelid = 'idx_match_odds_drift_covering'::regclass; " +
      "Geçersizse önce DROP INDEX CONCURRENTLY idx_match_odds_drift_covering; ile temizleyip tekrar dene."
    );
  } finally {
    await sql.end();
  }
}

main();
