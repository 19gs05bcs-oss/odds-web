import postgres from "postgres";

const connectionString = process.env.DATABASE_URL_DIRECT;
if (!connectionString) {
  console.error("HATA: DATABASE_URL_DIRECT env değişkeni gerekli (port 5432, pooler DEĞİL).");
  process.exit(1);
}

const sql = postgres(connectionString, {
  prepare: false,
  ssl: "require",
  max: 1,
  idle_timeout: 0,
  connect_timeout: 30,
});

const statements = [
  {
    name: "idx_match_odds_bookmaker",
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_match_odds_bookmaker
          ON match_odds (bookmaker) WHERE bookmaker IS NOT NULL`,
  },
  {
    name: "idx_match_odds_season_bookmaker",
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_match_odds_season_bookmaker
          ON match_odds (season_slug, bookmaker) WHERE bookmaker IS NOT NULL`,
  },
];

for (const stmt of statements) {
  const started = Date.now();
  console.log(`[create-indexes] ${stmt.name} başlıyor...`);
  try {
    await sql.unsafe("SET statement_timeout = 0");
    await sql.unsafe(stmt.sql);
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`[create-indexes] ${stmt.name} OK (${secs}s)`);
  } catch (err) {
    console.error(`[create-indexes] ${stmt.name} HATA:`, err.message || err);
  }
}

await sql.end();
console.log("[create-indexes] bitti.");
