import postgres from "postgres";

async function main() {
  const sql = postgres(process.env.DIRECT_DATABASE_URL!, { prepare: false, ssl: "require", max: 1 });
  try {
    await sql.unsafe(`SET statement_timeout = 0`);
    console.log("ANALYZE çalışıyor...");
    await sql.unsafe(`ANALYZE match_odds`);
    console.log("ANALYZE bitti.\n");
  } finally {
    await sql.end();
  }
}
main();
