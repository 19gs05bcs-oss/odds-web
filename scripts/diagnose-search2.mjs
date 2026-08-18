import postgres from "postgres";

const connectionString = process.env.DATABASE_URL_DIRECT;
const sql = postgres(connectionString, {
  prepare: false,
  ssl: "require",
  max: 1,
  idle_timeout: 0,
  connect_timeout: 30,
});

async function main() {
  console.log("\n1) Gerçek kullanılan dar aralık [1.415, 1.425] kaç satır:");
  console.log(
    await sql.unsafe(
      `SELECT count(*) FROM match_odds
       WHERE bookmaker = 'Betano.uk'
         AND market = 'HOME_DRAW_AWAY:FULL_TIME'
         AND (selection = 'H' OR selection LIKE 'H:%')
         AND opening BETWEEN 1.415 AND 1.425`,
    ),
  );

  console.log("\n2) Bu aralıktaki satırların event_id + events tablosunda karşılığı var mı:");
  console.log(
    await sql.unsafe(
      `SELECT mo.event_id, mo.opening, mo.selection, e.id AS events_match
       FROM match_odds mo
       LEFT JOIN events e ON e.id = mo.event_id
       WHERE mo.bookmaker = 'Betano.uk'
         AND mo.market = 'HOME_DRAW_AWAY:FULL_TIME'
         AND (mo.selection = 'H' OR mo.selection LIKE 'H:%')
         AND mo.opening BETWEEN 1.415 AND 1.425
       LIMIT 10`,
    ),
  );

  console.log("\n3) events tablosunda toplam satır sayısı (referans):");
  console.log(await sql.unsafe(`SELECT count(*) FROM events`));

  console.log("\n4) match_odds'taki event_id'lerden kaçı events'te YOK (join kopukluğu var mı):");
  console.log(
    await sql.unsafe(
      `SELECT count(*) FROM (
         SELECT DISTINCT mo.event_id
         FROM match_odds mo
         LEFT JOIN events e ON e.id = mo.event_id
         WHERE mo.bookmaker = 'Betano.uk' AND e.id IS NULL
         LIMIT 100000
       ) x`,
    ),
  );
}

main()
  .catch((err) => console.error("HATA:", err))
  .finally(() => sql.end());
