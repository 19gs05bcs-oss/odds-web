// ⚠️ DEPRECATED — ARTIK KULLANILMIYOR. Sadece deprecated duckdbMaterialize.ts
// tarafından import ediliyor; o da hiçbir yerden çağrılmıyor. Güvenle silinebilir.
/**
 * DuckDB connection singleton.
 *
 * ESKİSİ: DuckDB, `ATTACH ... TYPE POSTGRES` ile canlı Supabase'e bağlanıp
 * events.markets_json'ı her istekte (veya materialize adımında) UNNEST
 * ediyordu. Bu hem Supabase pooler uyumsuzluğu (Transaction mode ile
 * postgres_scanner'ın cursor akışı çakışıyor) hem de OOM riski taşıyordu.
 *
 * ŞİMDİ: DuckDB, Postgres'i hiç görmüyor. Tüm veri Koyeb worker'ın
 * (archive_cache_server.py) zaten-flat HTTP endpoint'lerinden (bkz.
 * koyebCache.ts) NDJSON olarak diske stream edilip DuckDB'ye
 * `read_json_auto` ile toplu yükleniyor (bkz. duckdbMaterialize.ts).
 * Bu dosyada artık sadece yerel, disk-backed bir DuckDB instance'ı var —
 * ne DSN, ne ATTACH, ne postgres extension.
 */
import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";

async function createInstance(): Promise<DuckDBInstance> {
  const { DuckDBInstance } = await import("@duckdb/node-api");

  // quotes_flat, 60+ sezonun TÜM market/seçenek/bahisçi kombinasyonunu
  // içerebiliyor — process RAM'ine sığmayacak kadar büyük olabilir.
  // Disk-backed bir DuckDB dosyası kullanıyoruz: DuckDB, verinin RAM'e
  // sığmayan kısmını diske yazıp out-of-core çalışabiliyor. Container
  // restart'ında TTL ile zaten yeniden inşa ediliyor, dosyanın kalıcı
  // olması gerekmiyor (/tmp yeterli).
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
 * üzerindeki hızlı WHERE'i, health-check) bunu kullanır. Ayrı bir
 * materialize connection'ı olduğu için, arka planda süren uzun quotes_flat
 * inşası bu bağlantıyı BLOKE ETMEZ.
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
 * Sadece duckdbMaterialize.ts'in read_json_auto ile toplu yükleme işi
 * için — kasıtlı olarak getDuckDbConnection()'dan AYRI bir connection.
 * Aynı instance'ı (ve yazdığı quotes_flat tablosunu) paylaşır, ama sorgu
 * kuyruğu farklıdır; materialize çalışırken interactive sorgular bloklanmaz.
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
