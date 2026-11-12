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
  featureKeys: string[];
  useProbCols: boolean;
};

const fold = (s: string) =>
  s
    .toLocaleLowerCase("tr")
    .replace(/ı/g, "i")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

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

let cache: Promise<Store> | null = null;
const load = () =>
  (cache ??= (async () => {
    const [m, b] = await Promise.all([get("meta.json"), get("features.bin")]);
    const meta = JSON.parse(m.toString());
    const matches = meta.matches as HandballMeta[];
    const vec = new Float32Array(new Uint8Array(b).buffer);
    const index = new Map<string, number>(matches.map((x, i) => [x.id, i]));
    const haystack = matches.map((x) => fold(`${x.home} ${x.away} ${x.season}`));
    const dim = meta.dim as number;

    const fromMeta =
      (Array.isArray(meta.features) && meta.features) ||
      (Array.isArray(meta.feature_keys) && meta.feature_keys) ||
      (Array.isArray(meta.cols) && meta.cols) ||
      null;

    const featureKeys: string[] = fromMeta
      ? (fromMeta as string[]).map(String)
      : DEFAULT_FEATURES.slice(0, dim);

    while (featureKeys.length < dim) featureKeys.push(`pad|${featureKeys.length}`);
    if (featureKeys.length > dim) featureKeys.length = dim;

    // meta.json içinde cols (open_H, close_H, ah_line vb.) varsa probability + line modu aktif olur
    const useProbCols = Array.isArray(meta.cols) && !meta.features && !meta.feature_keys;

    return { matches, dim, vec, index, haystack, featureKeys, useProbCols };
  })().catch((e) => {
    cache = null;
    throw e;
  }));

const hasScore = (m: HandballMeta) =>
  m.hs != null && m.hs !== "" && m.as != null && m.as !== "";

/** Canlı fixtureh oran anahtarlarını standart formata çevirir */
function normalizeOddsKey(type: string, scope: string, side: string): string | null {
  const t = String(type).toLowerCase();
  const s = String(scope).toLowerCase();
  const sideL = String(side).toLowerCase();

  // 1X2
  if (t === "home_draw_away" || t === "1x2") {
    const sc = s === "full_time" ? "full_time" : s === "first_half" || s === "1st_half" ? "1st_half" : null;
    if (!sc) return null;
    if (sideL === "h" || sideL === "home") return `1x2|${sc}|home`;
    if (sideL === "d" || sideL === "draw") return `1x2|${sc}|draw`;
    if (sideL === "a" || sideL === "away") return `1x2|${sc}|away`;
  }

  // Over/Under
  if (t === "over_under" || t === "ou") {
    const sc = s === "full_time" ? "full_time" : s === "first_half" || s === "1st_half" ? "1st_half" : null;
    if (!sc) return null;
    if (sideL === "over" || sideL.startsWith("over:")) return `ou|${sc}|over`;
    if (sideL === "under" || sideL.startsWith("under:")) return `ou|${sc}|under`;
  }

  // Asian Handicap
  if (t === "asian_handicap" || t === "ah") {
    const sc = s === "full_time" ? "full_time" : s === "first_half" || s === "1st_half" ? "1st_half" : null;
    if (!sc) return null;
    if (sideL === "home" || sideL.startsWith("h:") || sideL.startsWith("home:")) return `ah|${sc}|home`;
    if (sideL === "away" || sideL.startsWith("a:") || sideL.startsWith("away:")) return `ah|${sc}|away`;
  }

  return null;
}

/**
 * Canlı / arşiv dışı maç için oranlardan sorgu vektörü üret.
 * - useProbCols = true ise: meta.cols (open_H, open_D, open_A, close_H, close_D, close_A, ah_line) formatında implied probability + line üretir.
 * - useProbCols = false ise: log(current odds) formatında vektör üretir.
 */
export function buildFeatureVector(
  odds: CompactOddsRow[],
  featureKeys: string[],
  dim: number,
  useProbCols = false,
  bookmakerId?: number | null,
): Float32Array {
  const out = new Float32Array(dim);
  if (!odds?.length) return out;

  // Seçili bookmaker varsa onu kullan; yoksa en fazla satırı olanı seç
  let bestBm = bookmakerId != null && Number.isFinite(bookmakerId) ? Number(bookmakerId) : -1;
  if (bestBm < 0 || !odds.some((r) => r[0] === bestBm)) {
    const counts = new Map<number, number>();
    for (const row of odds) {
      const bid = row[0];
      counts.set(bid, (counts.get(bid) ?? 0) + 1);
    }
    bestBm = -1;
    let bestN = -1;
    for (const [bid, n] of counts) {
      if (n > bestN) {
        bestN = n;
        bestBm = bid;
      }
    }
  }

  const bmRows = odds.filter((r) => r[0] === bestBm);

  // Mod 1: meta.json'daki cols (open_H, close_H, ah_line vb.) ile implied probability + line
  if (useProbCols) {
    const vals = new Map<string, number>();

    // 1X2 opening & closing implied probabilities (1 / odds)
    for (const row of bmRows) {
      const k = normalizeOddsKey(row[1], row[2], row[3]);
      if (!k) continue;
      const openOdd = row[4];
      const closeOdd = row[5];

      if (k === "1x2|full_time|home") {
        if (openOdd && openOdd > 1 && !vals.has("open_H")) vals.set("open_H", 1 / openOdd);
        if (closeOdd && closeOdd > 1 && !vals.has("close_H")) vals.set("close_H", 1 / closeOdd);
      } else if (k === "1x2|full_time|draw") {
        if (openOdd && openOdd > 1 && !vals.has("open_D")) vals.set("open_D", 1 / openOdd);
        if (closeOdd && closeOdd > 1 && !vals.has("close_D")) vals.set("close_D", 1 / closeOdd);
      } else if (k === "1x2|full_time|away") {
        if (openOdd && openOdd > 1 && !vals.has("open_A")) vals.set("open_A", 1 / openOdd);
        if (closeOdd && closeOdd > 1 && !vals.has("close_A")) vals.set("close_A", 1 / closeOdd);
      }
    }

    // Ana AH çizgisini (oranları 2.00'ye en yakın olan ev sahibi handikapını) bul
    let bestAhLine: number | null = null;
    let bestDiff = Infinity;
    for (const row of bmRows) {
      const t = String(row[1]).toLowerCase();
      const s = String(row[2]).toLowerCase();
      const sideL = String(row[3]).toLowerCase();
      if ((t === "asian_handicap" || t === "ah") && s === "full_time" && sideL.startsWith("h:")) {
        const lineVal = Number(sideL.split(":")[1]);
        const curOdd = row[5] ?? row[4];
        if (Number.isFinite(lineVal) && curOdd && curOdd > 1) {
          const diff = Math.abs(curOdd - 1.9);
          if (diff < bestDiff) {
            bestDiff = diff;
            bestAhLine = lineVal;
          }
        }
      }
    }
    if (bestAhLine != null) vals.set("ah_line", bestAhLine);

    for (let c = 0; c < dim; c++) {
      const v = vals.get(featureKeys[c]);
      out[c] = v != null && Number.isFinite(v) ? v : 0;
    }
    return out;
  }

  // Mod 2: Standart log(current odds) vektörü
  const byKey = new Map<string, number>();
  for (const row of bmRows) {
    const cur = row[5];
    if (cur == null || !(cur > 1)) continue;
    const k = normalizeOddsKey(row[1], row[2], row[3]);
    if (!k) continue;
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

export async function similar(
  eventId: string,
  k = 10,
  oddsOverride?: CompactOddsRow[] | null,
  bookmakerId?: number | null,
): Promise<SimilarRow[] | { error: string; message: string }> {
  const { matches, dim: D, vec, index, featureKeys, useProbCols } = await load();
  const i = index.get(eventId);

  let nearest: (HandballMeta & { distance: number })[];

  // Arşivde varsa ve özel BM / oddsOverride yoksa precomputed vektörü kullan
  if (i !== undefined && !oddsOverride?.length && bookmakerId == null) {
    const q = new Float32Array(D);
    for (let c = 0; c < D; c++) q[c] = vec[i * D + c];
    nearest = nearestFromVector(q, matches, D, vec, k, eventId);
  } else {
    let odds = oddsOverride ?? null;
    if (!odds?.length) odds = await fetchFixtureHOdds(eventId);
    if (!odds?.length) {
      return {
        error: "not_in_archive_no_odds",
        message:
          "Bu maç R2 arşivinde yok ve Supabase fixtureh içinde kullanılabilir oran bulunamadı. Benzer maç için oranlar gerekli.",
      } as const;
    }

    const q = buildFeatureVector(odds, featureKeys, D, useProbCols, bookmakerId);
    let nonzero = 0;
    for (let c = 0; c < D; c++) if (q[c] !== 0) nonzero++;
    if (nonzero === 0) {
      return {
        error: "odds_features_empty",
        message:
          "Oranlar var ama feature anahtarlarıyla eşleşmedi (type/scope/side isimleri farklı olabilir). meta.json features/cols listesini kontrol edin.",
      } as const;
    }

    nearest = nearestFromVector(q, matches, D, vec, k, i !== undefined ? eventId : undefined);
  }

  // Always enrich with 1X2 odds for the reference BM so the UI can show football-style table
  return enrichSimilarWithOdds(nearest, bookmakerId ?? null);
}

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

const rawCache = new Map<string, any>();
/** Load raw file for a match (cached). Returns null if not in archive. */
async function loadRawForMatch(eventId: string): Promise<{ meta: HandballMeta; raw: any; match: any } | null> {
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
  return { meta: matches[i], raw: d, match: m };
}

export async function matchDetail(eventId: string) {
  const loaded = await loadRawForMatch(eventId);
  if (!loaded) return null;
  const { meta, raw: d, match: m } = loaded;
  const odds = m.odds.map(([bid, type, scope, side, opening, current, active]: any[]) => ({
    bookmaker: d.bookmakers[String(bid)] ?? String(bid),
    type,
    scope,
    side,
    opening: opening === "" || opening == null ? null : Number(opening),
    current: Number(current),
    active: !!active,
  }));
  return { ...meta, odds };
}

/** Extract 1X2 FT open/close for a numeric bookmaker id from a raw match. */
function extract1x2ForBm(
  matchOdds: any[],
  bookmakers: Record<string, string>,
  bookmakerId: number | null,
): { home: { o: number | null; c: number | null }; draw: { o: number | null; c: number | null }; away: { o: number | null; c: number | null } } {
  const empty = { o: null as number | null, c: null as number | null };
  const out = { home: { ...empty }, draw: { ...empty }, away: { ...empty } };
  if (!Array.isArray(matchOdds)) return out;

  for (const row of matchOdds) {
    const [bid, type, scope, side, opening, current] = row;
    if (bookmakerId != null && Number(bid) !== bookmakerId) continue;
    const t = String(type || "").toLowerCase();
    const sc = String(scope || "").toLowerCase();
    if (!(t === "home_draw_away" || t === "1x2" || t === "match_odds")) continue;
    if (!(sc === "full_time" || sc === "ft" || sc === "")) continue;
    const sideL = String(side || "").toLowerCase();
    const o = opening === "" || opening == null ? null : Number(opening);
    const c = current == null || current === "" ? null : Number(current);
    const oo = o != null && Number.isFinite(o) && o >= 1.01 ? o : null;
    const cc = c != null && Number.isFinite(c) && c >= 1.01 ? c : null;
    if (sideL === "h" || sideL === "home" || sideL === "1") {
      out.home.o = oo;
      out.home.c = cc;
    } else if (sideL === "d" || sideL === "draw" || sideL === "x") {
      out.draw.o = oo;
      out.draw.c = cc;
    } else if (sideL === "a" || sideL === "away" || sideL === "2") {
      out.away.o = oo;
      out.away.c = cc;
    }
  }
  return out;
}

export type SimilarRow = HandballMeta & {
  distance: number;
  /** 1X2 FT odds for the reference BM (if available) */
  odds1x2?: {
    home: { o: number | null; c: number | null };
    draw: { o: number | null; c: number | null };
    away: { o: number | null; c: number | null };
  };
};

/** Enrich nearest matches with 1X2 odds for the given BM (loads raw files, cached). */
export async function enrichSimilarWithOdds(
  rows: (HandballMeta & { distance: number })[],
  bookmakerId: number | null,
): Promise<SimilarRow[]> {
  const out: SimilarRow[] = [];
  for (const r of rows) {
    try {
      const loaded = await loadRawForMatch(r.id);
      if (!loaded) {
        out.push({ ...r });
        continue;
      }
      const odds1x2 = extract1x2ForBm(loaded.match.odds, loaded.raw.bookmakers || {}, bookmakerId);
      out.push({ ...r, odds1x2 });
    } catch {
      out.push({ ...r });
    }
  }
  return out;
}
