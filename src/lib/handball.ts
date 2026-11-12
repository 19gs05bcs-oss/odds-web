import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { gunzipSync } from "zlib";
import { sql } from "@/lib/db";

const BUCKET = "handball-odds";
const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_KEY!,
    secretAccessKey: process.env.R2_SECRET!,
  },
});

const get = async (key: string) =>
  Buffer.from(
    await (await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))).Body!.transformToByteArray(),
  );

export type HandballMeta = {
  id: string;
  season: string;
  file: string;
  ts: number;
  home: string;
  away: string;
  hs: string | null;
  as: string | null;
};

/** Compact odds row: [bookmakerId, type, scope, side, opening, current, active] — fixtureh / R2 raw ile aynı. */
export type CompactOddsRow = [
  bookmakerId: number,
  bettingType: string,
  bettingScope: string,
  side: string,
  opening: number | null,
  current: number | null,
  active: boolean,
];

type Store = {
  matches: HandballMeta[];
  dim: number;
  vec: Float32Array;
  index: Map<string, number>;
  haystack: string[];
  /** Özellik anahtarları: "type|scope|side" — features.bin ile aynı sıra. meta.json'da yoksa DEFAULT_FEATURES. */
  featureKeys: string[];
};

const fold = (s: string) =>
  s
    .toLocaleLowerCase("tr")
    .replace(/ı/g, "i")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

/**
 * R2 features.bin üretiminde kullanılan varsayılan pazar sırası.
 * meta.json içinde `features` / `feature_keys` varsa o kullanılır (yeniden build gerekmez).
 * Yoksa bu liste dim kadar kesilir/pad edilir — indeksi aynı script ile ürettiyseniz eşleşir.
 */
const DEFAULT_FEATURES = [
  "1x2|full_time|home",
  "1x2|full_time|draw",
  "1x2|full_time|away",
  "ou|full_time|over",
  "ou|full_time|under",
  "ah|full_time|home",
  "ah|full_time|away",
  "1x2|1st_half|home",
  "1x2|1st_half|draw",
  "1x2|1st_half|away",
  "ou|1st_half|over",
  "ou|1st_half|under",
];

// Benzerlik verisi: bir kez indirilir, bellekte tutulur
let cache: Promise<Store> | null = null;
const load = () =>
  (cache ??= (async () => {
    const [m, b] = await Promise.all([get("meta.json"), get("features.bin")]);
    const meta = JSON.parse(m.toString());
    const matches = meta.matches as HandballMeta[];
    const vec = new Float32Array(new Uint8Array(b).buffer); // kopya: hizalama güvenli
    const index = new Map<string, number>(matches.map((x, i) => [x.id, i]));
    const haystack = matches.map((x) => fold(`${x.home} ${x.away} ${x.season}`));
    const dim = meta.dim as number;
    const fromMeta =
      (Array.isArray(meta.features) && meta.features) ||
      (Array.isArray(meta.feature_keys) && meta.feature_keys) ||
      null;
    const featureKeys: string[] = fromMeta
      ? (fromMeta as string[]).map(String)
      : DEFAULT_FEATURES.slice(0, dim);
    // dim ile anahtar sayısı uyuşmuyorsa pad / kes
    while (featureKeys.length < dim) featureKeys.push(`pad|${featureKeys.length}`);
    if (featureKeys.length > dim) featureKeys.length = dim;
    return { matches, dim, vec, index, haystack, featureKeys };
  })().catch((e) => {
    cache = null;
    throw e;
  }));

const hasScore = (m: HandballMeta) =>
  m.hs != null && m.hs !== "" && m.as != null && m.as !== "";

/** odds satırını feature key'e çevir (küçük harf, ayırıcı |). */
function oddsKey(type: string, scope: string, side: string): string {
  return `${String(type).toLowerCase()}|${String(scope).toLowerCase()}|${String(side).toLowerCase()}`;
}

/**
 * Canlı / arşiv dışı maç için oranlardan sorgu vektörü üret.
 * - Tercihen tek bookmaker (en çok satırlı) kullanılır.
 * - Değer: log(current odds); eksik özellik 0.
 * features.bin ile aynı ölçekte olmalı (indeks script'i log-odds kullanıyorsa).
 */
export function buildFeatureVector(
  odds: CompactOddsRow[],
  featureKeys: string[],
  dim: number,
): Float32Array {
  const out = new Float32Array(dim);
  if (!odds?.length) return out;

  // Bookmaker seç: en fazla satırı olan
  const counts = new Map<number, number>();
  for (const row of odds) {
    const bid = row[0];
    counts.set(bid, (counts.get(bid) ?? 0) + 1);
  }
  let bestBm = -1;
  let bestN = -1;
  for (const [bid, n] of counts) {
    if (n > bestN) {
      bestN = n;
      bestBm = bid;
    }
  }

  const byKey = new Map<string, number>();
  for (const row of odds) {
    if (row[0] !== bestBm) continue;
    const cur = row[5];
    if (cur == null || !(cur > 1)) continue;
    const k = oddsKey(row[1], row[2], row[3]);
    // Aynı key birden fazla satırda varsa (farklı handicap/line) ilk geçerli değeri tut
    if (!byKey.has(k)) byKey.set(k, Math.log(cur));
  }

  for (let c = 0; c < dim; c++) {
    const key = featureKeys[c];
    const v = byKey.get(key);
    out[c] = v != null && Number.isFinite(v) ? v : 0;
  }
  return out;
}

/** Supabase fixtureh tablosundan maçın oranlarını oku. */
export async function fetchFixtureHOdds(matchId: string): Promise<CompactOddsRow[] | null> {
  try {
    const rows = await sql.unsafe<{ odds: CompactOddsRow[] | null }[]>(
      `SELECT odds FROM fixtureh WHERE match_id = $1 LIMIT 1`,
      [matchId],
    );
    const odds = rows[0]?.odds;
    if (!Array.isArray(odds) || !odds.length) return null;
    return odds;
  } catch (e) {
    console.error("fixtureh odds okunamadı:", e);
    return null;
  }
}

function nearestFromVector(
  q: Float32Array,
  matches: HandballMeta[],
  dim: number,
  vec: Float32Array,
  k: number,
  skipId?: string,
) {
  const sc: [number, number][] = [];
  for (let j = 0; j < matches.length; j++) {
    if (skipId && matches[j].id === skipId) continue;
    if (!hasScore(matches[j])) continue;
    let d = 0;
    const base = j * dim;
    for (let c = 0; c < dim; c++) {
      const t = q[c] - vec[base + c];
      d += t * t;
    }
    sc.push([d, j]);
  }
  sc.sort((a, b) => a[0] - b[0]);
  return sc.slice(0, k).map(([d, j]) => ({ ...matches[j], distance: Math.sqrt(d) }));
}

/**
 * Benzer maçlar.
 * - match_id R2 indeksindeyse: hazır vektör ile arama (eski davranış).
 * - değilse (Supabase fikstür): fixtureh.odds ile vektör kurup R2 arşivine karşı oran benzerliği.
 * Futboldaki gibi: aynı id gerekmez, oran profili yeter.
 */
export async function similar(eventId: string, k = 10, oddsOverride?: CompactOddsRow[] | null) {
  const { matches, dim: D, vec, index, featureKeys } = await load();
  const i = index.get(eventId);

  if (i !== undefined) {
    const q = new Float32Array(D);
    for (let c = 0; c < D; c++) q[c] = vec[i * D + c];
    return nearestFromVector(q, matches, D, vec, k, eventId);
  }

  // Arşivde yok → canlı fikstür: oranlardan sorgu vektörü
  let odds = oddsOverride ?? null;
  if (!odds?.length) odds = await fetchFixtureHOdds(eventId);
  if (!odds?.length) {
    return {
      error: "not_in_archive_no_odds",
      message:
        "Bu maç R2 arşivinde yok ve Supabase fixtureh içinde kullanılabilir oran bulunamadı. Benzer maç için oranlar gerekli.",
    } as const;
  }

  const q = buildFeatureVector(odds, featureKeys, D);
  // Hepsi 0 ise oran eşleşmesi kurulamadı (pazar isimleri farklı)
  let nonzero = 0;
  for (let c = 0; c < D; c++) if (q[c] !== 0) nonzero++;
  if (nonzero === 0) {
    return {
      error: "odds_features_empty",
      message:
        "Oranlar var ama feature anahtarlarıyla eşleşmedi (type/scope/side isimleri farklı olabilir). meta.json features listesini kontrol edin.",
    } as const;
  }

  return nearestFromVector(q, matches, D, vec, k);
}

// Takım adı / lig yazarak maç arama (en yeni maçlar önce)
export async function searchMatches(q: string, limit = 20) {
  const { matches, haystack } = await load();
  const terms = fold(q).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const out: HandballMeta[] = [];
  for (let i = 0; i < matches.length; i++) {
    if (terms.every((t) => haystack[i].includes(t))) out.push(matches[i]);
  }
  return out.sort((a, b) => b.ts - a.ts).slice(0, limit);
}

// Maç detayı: ilgili sezon dosyasını R2'den indirir, içinden maçı okur
const rawCache = new Map<string, any>();
export async function matchDetail(eventId: string) {
  const { matches, index } = await load();
  const i = index.get(eventId);
  if (i === undefined) return null;
  const file = matches[i].file;
  let d = rawCache.get(file);
  if (!d) {
    d = JSON.parse(gunzipSync(await get(`raw/${file}`)).toString());
    if (rawCache.size >= 20) rawCache.delete(rawCache.keys().next().value!);
    rawCache.set(file, d);
  }
  const m = d.matches.find((x: any) => x.match_id === eventId);
  if (!m) return null;
  const odds = m.odds.map(([bid, type, scope, side, opening, current, active]: any[]) => ({
    bookmaker: d.bookmakers[String(bid)] ?? String(bid),
    type,
    scope,
    side,
    opening: opening === "" || opening == null ? null : Number(opening),
    current: Number(current),
    active: !!active,
  }));
  return { ...matches[i], odds };
}
