/**
 * DuckDB connection singleton.
 *
 * Amaç: events.markets_json (nested JSON) üzerinde filtreleme/aggregation
 * işini Node process RAM'i yerine DuckDB'nin vectorized/out-of-core
 * execution'ına devretmek. events.ts (ensureArchiveCache) ve
 * seasonGzCache.ts'deki "24 sezonun TÜM markets_json'ını parse edip
 * globalThis'te sonsuza dek tut" yaklaşımının yerini alır.
 *
 * ÖNEMLİ — Supabase pooler notu:
 * DuckDB'nin postgres_scanner'ı (ATTACH ... TYPE POSTGRES) tarama sırasında
 * kendi server-side cursor/prepared-statement akışını kullanır. Bu,
 * Supavisor'ın TRANSACTION modundaki pooler'ıyla (6543, prepare:false
 * gerektiren) uyumsuzdur — bağlantı DDL/DML'de garip hatalar verebilir.
 * Bu yüzden DuckDB için ayrı bir DSN kullanıyoruz:
 *   DUCKDB_PG_DSN (yoksa DATABASE_URL_DIRECT, o da yoksa DATABASE_URL'e düşer)
 * Supabase'de bunu "Session pooler" (5432/6543 session mode) ya da
 * doğrudan bağlantı stringiyle doldurun — Transaction pooler DEĞİL.
 */
import type { DuckDBConnection } from "@duckdb/node-api";

function resolveDuckDbDsn(): string {
  const dsn =
    process.env.DUCKDB_PG_DSN ||
    process.env.DATABASE_URL_DIRECT ||
    process.env.DATABASE_URL;
  if (!dsn) {
    throw new Error(
      "DUCKDB_PG_DSN / DATABASE_URL tanımlı değil — DuckDB'nin Postgres'e ATTACH olabilmesi için gerekli.",
    );
  }
  return dsn;
}

/** ATTACH bir DDL komutu — parametre binding desteklemiyor, string'i kendimiz güvenli şekilde tırnaklıyoruz. */
function sqlQuoteLiteral(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

async function createConnection(): Promise<DuckDBConnection> {
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();

  await conn.run("INSTALL postgres;");
  await conn.run("LOAD postgres;");

  const dsn = resolveDuckDbDsn();
  await conn.run(
    `ATTACH ${sqlQuoteLiteral(dsn)} AS pg (TYPE POSTGRES, READ_ONLY);`,
  );

  return conn;
}

type ConnBag = { promise: Promise<DuckDBConnection> | null };

function globalBag(): ConnBag {
  const g = globalThis as unknown as { __duckdbConnBag?: ConnBag };
  if (!g.__duckdbConnBag) {
    g.__duckdbConnBag = { promise: null };
  }
  return g.__duckdbConnBag;
}

/** Lazy singleton — ilk çağrıda ATTACH eder, sonrasında aynı connection reuse edilir. */
export async function getDuckDbConnection(): Promise<DuckDBConnection> {
  const bag = globalBag();
  if (!bag.promise) {
    bag.promise = createConnection().catch((err) => {
      // Başarısız denemeyi cache'leme — bir sonraki istek yeniden dener.
      bag.promise = null;
      throw err;
    });
  }
  return bag.promise;
}

/** Sağlık kontrolü / warm-up endpoint'i için. */
export async function pingDuckDb(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const conn = await getDuckDbConnection();
    await conn.runAndReadAll("SELECT 1");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
