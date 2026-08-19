// scripts/create-similarity-cache-table.ts
// similarity engine sonuçlarını (event_id + bookmaker başına) cache'lemek
// için tablo — bkz. src/app/api/smart-analysis/similarity/route.ts
// Hesaplama ~2-3 dk sürebiliyor (bkz. test-similarity-real-engine.ts
// çıktısı: 159035ms), bu yüzden aynı maç+bookmaker tekrar istendiğinde
// yeniden hesaplamak yerine buradan okunuyor.
//
// Kullanım:
//   export DIRECT_DATABASE_URL="postgresql://...:5432/postgres"   (5432! pooler değil)
//   npx tsx scripts/create-similarity-cache-table.ts

import postgres from "postgres";

async function main() {
  const connectionString = process.env.DIRECT_DATABASE_URL;
  if (!connectionString) {
    console.error("HATA: DIRECT_DATABASE_URL env değişkeni yok.");
    process.exit(1);
  }

  const sql = postgres(connectionString, { prepare: false, ssl: "require", max: 1 });

  try {
    console.log("similarity_cache tablosu oluşturuluyor...");
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS similarity_cache (
        event_id     text        NOT NULL,
        bookmaker    text        NOT NULL,
        matched_count integer    NOT NULL,
        used_codes   jsonb       NOT NULL,
        samples      jsonb       NOT NULL,
        duration_ms  integer,
        computed_at  timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (event_id, bookmaker)
      )
    `);
    console.log("=== BAŞARILI ===");
  } catch (err) {
    console.error("=== HATA ===");
    console.error(err);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

main();
