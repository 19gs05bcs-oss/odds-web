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
import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";

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

async function createInstance(): Promise<DuckDBInstance> {
  const { DuckDBInstance } = await import("@duckdb/node-api");

  // quotes_flat artık TEK bir kriterin filtrelediği dar bir sonuç değil,
  // 60 sezonun TÜM market/seçenek/bahisçi kombinasyonu — bu, process RAM'ine
  // sığmayacak kadar büyük olabiliyor ve ":memory:" ile OOM'a (Killed) yol
  // açıyordu. Disk-backed bir DuckDB dosyasına geçiyoruz: DuckDB, verinin
  // RAM'e sığmayan kısmını diske yazıp out-of-core çalışabiliyor — tam bu
  // senaryo için tasarlanmış özelliği. Container restart'ında zaten TTL ile
  // yeniden inşa ediliyor, dosyanın kalıcı olması gerekmiyor (/tmp yeterli).
  const dbPath = process.env.DUCKDB_FILE_PATH || "/tmp/oddsvig-duckdb/main.db";
  const { mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  mkdirSync(dirname(dbPath), { recursive: true });

  const instance = await DuckDBInstance.create(dbPath, {
    // Konteynerin gerçek RAM tavanının altında bir hedef veriyoruz ki
    // DuckDB agresif şekilde diske spill etsin, kernel OOM killer'ından
    // önce kendi limitini uygulasın. DUCKDB_MEMORY_LIMIT ile ayarlanabilir.
    memory_limit: process.env.DUCKDB_MEMORY_LIMIT || "1GB",
  });

  // ATTACH, instance/catalog seviyesinde kalıcıdır — bir kez bootstrap
  // connection'ıyla yapılır, sonrasında aynı instance'tan açılan TÜM
  // connection'lar (interactive + materialize) "pg" şemasını görür.
  const boot = await instance.connect();
  await boot.run("INSTALL postgres;");
  await boot.run("LOAD postgres;");
  const dsn = resolveDuckDbDsn();
  await boot.run(`ATTACH ${sqlQuoteLiteral(dsn)} AS pg (TYPE POSTGRES, READ_ONLY);`);

  return instance;
}

type InstanceBag = { promise: Promise<DuckDBInstance> | null };

function instanceBag(): InstanceBag {
  const g = globalThis as unknown as { __duckdbInstanceBag?: InstanceBag };
  if (!g.__duckdbInstanceBag) {
    g.__duckdbInstanceBag = { promise: null };
  }
  return g.__duckdbInstanceBag;
}

async function getDuckDbInstance(): Promise<DuckDBInstance> {
  const bag = instanceBag();
  if (!bag.promise) {
    bag.promise = createInstance().catch((err) => {
      bag.promise = null;
      throw err;
    });
  }
  return bag.promise;
}

type ConnBag = { promise: Promise<DuckDBConnection> | null };

function connBag(key: "__duckdbInteractiveConnBag" | "__duckdbMaterializeConnBag"): ConnBag {
  const g = globalThis as unknown as Record<string, ConnBag | undefined>;
  if (!g[key]) {
    g[key] = { promise: null };
  }
  return g[key] as ConnBag;
}

/**
 * "İnteraktif" bağlantı — kullanıcı isteklerini bekleten TÜM sorgular
 * (analyzeSeasonSQL tek-sezon sorgusu, searchOddsProfileSQL'in quotes_flat
 * üzerindeki hızlı WHERE'i, archive-table, warm'ın health-check'i) bunu
 * kullanır. Ayrı bir materialize connection'ı olduğu için, arka planda
 * süren uzun quotes_flat inşası bu bağlantıyı BLOKE ETMEZ.
 */
export async function getDuckDbConnection(): Promise<DuckDBConnection> {
  const bag = connBag("__duckdbInteractiveConnBag");
  if (!bag.promise) {
    bag.promise = (async () => {
      const instance = await getDuckDbInstance();
      return instance.connect();
    })().catch((err) => {
      bag.promise = null;
      throw err;
    });
  }
  return bag.promise;
}

/**
 * Sadece duckdbMaterialize.ts'in uzun süren CREATE TABLE AS SELECT
 * işi için — kasıtlı olarak getDuckDbConnection()'dan AYRI bir
 * connection. Aynı instance'ı (dolayısıyla "pg" ATTACH'ını ve
 * yazdığı quotes_flat tablosunu) paylaşır, ama sorgu kuyruğu farklıdır;
 * bu sayede materialize çalışırken interactive sorgular (ve warm'ın
 * kendi health-check'i) saniyelerce/dakikalarca bloklanmaz.
 */
export async function getDuckDbMaterializeConnection(): Promise<DuckDBConnection> {
  const bag = connBag("__duckdbMaterializeConnBag");
  if (!bag.promise) {
    bag.promise = (async () => {
      const instance = await getDuckDbInstance();
      return instance.connect();
    })().catch((err) => {
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
