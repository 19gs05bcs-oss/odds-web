import postgres from "postgres";

const connectionString = process.env.DATABASE_URL_DIRECT;
if (!connectionString) {
  console.error("HATA: DATABASE_URL_DIRECT env değişkeni gerekli.");
  process.exit(1);
}

const sql = postgres(connectionString, {
  prepare: false,
  ssl: "require",
  max: 1,
  idle_timeout: 0,
  connect_timeout: 30,
});

async function main() {
  console.log("\n1) 'Betano' ile başlayan tüm bookmaker değerleri:");
  const bms = await sql.unsafe(
    `SELECT DISTINCT bookmaker FROM match_odds WHERE bookmaker ILIKE 'Betano%' LIMIT 20`,
  );
  console.log(bms);

  console.log("\n2) Betano.uk + market='HOME_DRAW_AWAY:FULL_TIME' + selection H-ish satır sayısı:");
  const cnt = await sql.unsafe(
    `SELECT count(*) FROM match_odds
     WHERE bookmaker = 'Betano.uk'
       AND market = 'HOME_DRAW_AWAY:FULL_TIME'
       AND (selection = 'H' OR selection LIKE 'H:%')`,
  );
  console.log(cnt);

  console.log("\n3) Aynı filtrede opening oranların min/max/ortalama dağılımı:");
  const dist = await sql.unsafe(
    `SELECT min(opening), max(opening), avg(opening), count(*) FROM match_odds
     WHERE bookmaker = 'Betano.uk'
       AND market = 'HOME_DRAW_AWAY:FULL_TIME'
       AND (selection = 'H' OR selection LIKE 'H:%')
       AND opening IS NOT NULL`,
  );
  console.log(dist);

  console.log("\n4) 1.42 civarı (±0.05, geniş aralık) kaç satır var:");
  const near = await sql.unsafe(
    `SELECT count(*) FROM match_odds
     WHERE bookmaker = 'Betano.uk'
       AND market = 'HOME_DRAW_AWAY:FULL_TIME'
       AND (selection = 'H' OR selection LIKE 'H:%')
       AND opening BETWEEN 1.37 AND 1.47`,
  );
  console.log(near);

  console.log("\n5) match_odds tablosunda toplam satır sayısı (referans için):");
  const total = await sql.unsafe(`SELECT count(*) FROM match_odds`);
  console.log(total);
}

main()
  .catch((err) => console.error("HATA:", err))
  .finally(() => sql.end());
