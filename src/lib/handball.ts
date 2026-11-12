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

export type CompactOddsRow = [
  bookmakerId: number,
  bettingType: string,
  bettingScope: string,
  side: string,
  opening: number | null,
  current: number | null,
  active: boolean,
];

export type HandballTableRow = HandballMeta & {
  src: "fixture" | "archive";
  date: string;
  time: string;
  ft: string;
  ftRes: "Home" | "Draw" | "Away" | "-";
  o1: number | null;
  c1: number | null;
  ox: number | null;
  cx: number | null;
  o2: number | null;
  c2: number | null;
  bmUsed?: string;
  distance?: number;
};

type Store = {
  matches: HandballMeta[];
  dim: number;
  cols: string[];
  vec: Float32Array;
  index: Map<string, number>;
  haystack: string[];
};

const fold = (s: string) =>
  s
    .toLocaleLowerCase("tr")
    .replace(/ı/g, "i")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

let cache: Promise<Store> | null = null;
const load = () =>
  (cache ??= (async () => {
    const [m, b] = await Promise.all([get("meta.json"), get("features.bin")]);
    const meta = JSON.parse(m.toString());
    const matches = meta.matches as HandballMeta[];
    const vec = new Float32Array(new Uint8Array(b).buffer);
    const index = new Map<string, number>(matches.map((x, i) => [x.id, i]));
    const haystack = matches.map((x) => fold(`${x.home} ${x.away} ${x.season}`));
    const dim = Number(meta.dim ?? 7);
    const cols: string[] = Array.isArray(meta.cols)
      ? meta.cols.map(String)
      : ["open_H", "open_D", "open_A", "close_H", "close_D", "close_A", "ah_line"];

    return { matches, dim, cols, vec, index, haystack };
  })().catch((e) => {
    cache = null;
    throw e;
  }));

const rawCache = new Map<string, any>();
async function loadRawSeason(file: string) {
  let d = rawCache.get(file);
  if (!d) {
    d = JSON.parse(gunzipSync(await get(`raw/${file}`)).toString());
    if (rawCache.size >= 25) rawCache.delete(rawCache.keys().next().value!);
    rawCache.set(file, d);
  }
  return d;
}

const hasScore = (m: HandballMeta) =>
  m.hs != null && m.hs !== "" && m.as != null && m.as !== "";

function formatTs(ts: number) {
  const d = new Date(ts * 1000);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  return { date: `${yyyy}-${mm}-${dd}`, time: `${hh}:${min}` };
}

function getFtRes(hs: string | null, as: string | null): "Home" | "Draw" | "Away" | "-" {
  if (hs == null || as == null || hs === "" || as === "") return "-";
  const h = Number(hs);
  const a = Number(as);
  if (!Number.isFinite(h) || !Number.isFinite(a)) return "-";
  if (h > a) return "Home";
  if (h < a) return "Away";
  return "Draw";
}

/**
 * meta.json -> cols: ["open_H", "open_D", "open_A", "close_H", "close_D", "close_A", "ah_line"]
 * ile birebir aynı implied probability + ah_line vektörü üretir.
 */
export function buildFeatureVector(
  odds: CompactOddsRow[],
  cols: string[],
  dim: number,
  preferredBookmakerId?: number | null,
): Float32Array {
  const out = new Float32Array(dim);
  if (!odds?.length) return out;

  // Bookmaker seçimi: tercih edilen varsa ve verisi varsa onu, yoksa en çok satırı olanı al
  let targetBm = preferredBookmakerId ?? null;
  if (targetBm == null || !odds.some((r) => Number(r[0]) === targetBm)) {
    const counts = new Map<number, number>();
    for (const row of odds) {
      const bid = Number(row[0]);
      counts.set(bid, (counts.get(bid) ?? 0) + 1);
    }
    let bestN = -1;
    for (const [bid, n] of counts) {
      if (n > bestN) {
        bestN = n;
        targetBm = bid;
      }
    }
  }

  const bmRows = odds.filter((r) => Number(r[0]) === targetBm);

  let openH = 0, openD = 0, openA = 0;
  let closeH = 0, closeD = 0, closeA = 0;

  for (const row of bmRows) {
    const t = String(row[1]).toLowerCase();
    const s = String(row[2]).toLowerCase();
    const side = String(row[3]).toLowerCase();
    if ((t !== "home_draw_away" && t !== "1x2") || s !== "full_time") continue;

    const op = row[4] != null && Number(row[4]) > 1 ? Number(row[4]) : null;
    const cl = row[5] != null && Number(row[5]) > 1 ? Number(row[5]) : null;

    if (side === "h" || side === "home") {
      if (!openH && (op || cl)) openH = 1 / (op ?? cl)!;
      if (!closeH && (cl || op)) closeH = 1 / (cl ?? op)!;
    } else if (side === "d" || side === "draw") {
      if (!openD && (op || cl)) openD = 1 / (op ?? cl)!;
      if (!closeD && (cl || op)) closeD = 1 / (cl ?? op)!;
    } else if (side === "a" || side === "away") {
      if (!openA && (op || cl)) openA = 1 / (op ?? cl)!;
      if (!closeA && (cl || op)) closeA = 1 / (cl ?? op)!;
    }
  }

  // Overround normalize (features.bin vig-free probability ise birebir eşleşir)
  const sumOpen = openH + openD + openA;
  if (sumOpen > 0) {
    openH /= sumOpen;
    openD /= sumOpen;
    openA /= sumOpen;
  }
  const sumClose = closeH + closeD + closeA;
  if (sumClose > 0) {
    closeH /= sumClose;
    closeD /= sumClose;
    closeA /= sumClose;
  }

  // Ana AH çizgisi (oranı 1.90'a en yakın olan ev sahibi handikapı)
  let ahLine = 0;
  let bestDiff = Infinity;
  for (const row of bmRows) {
    const t = String(row[1]).toLowerCase();
    const s = String(row[2]).toLowerCase();
    const side = String(row[3]).toLowerCase();
    if ((t === "asian_handicap" || t === "ah") && s === "full_time" && (side.startsWith("h:") || side.startsWith("home:"))) {
      const line = Number(side.split(":")[1]);
      const odd = Number(row[5] ?? row[4]);
      if (Number.isFinite(line) && odd > 1) {
        const diff = Math.abs(odd - 1.9);
        if (diff < bestDiff) {
          bestDiff = diff;
          ahLine = line;
        }
      }
    }
  }

  const map: Record<string, number> = {
    open_H: openH,
    open_D: openD,
    open_A: openA,
    close_H: closeH,
    close_D: closeD,
    close_A: closeA,
    ah_line: ahLine,
  };

  for (let c = 0; c < dim; c++) {
    const v = map[cols[c]];
    out[c] = v != null && Number.isFinite(v) ? v : 0;
  }
  return out;
}

/** Verilen odds dizisinden tablo kolonları için 1 O, 1 C, X O, X C, 2 O, 2 C değerlerini çıkarır */
export function extract1x2Columns(
  odds: any[],
  preferredBid?: number | null,
): { o1: number | null; c1: number | null; ox: number | null; cx: number | null; o2: number | null; c2: number | null; usedBid: number | null } {
  const empty = { o1: null, c1: null, ox: null, cx: null, o2: null, c2: null, usedBid: null };
  if (!Array.isArray(odds) || !odds.length) return empty;

  let targetBid = preferredBid ?? null;
  const hasPreferred =
    targetBid != null &&
    odds.some((r) => {
      const t = String(r[1]).toLowerCase();
      return Number(r[0]) === targetBid && (t === "home_draw_away" || t === "1x2") && String(r[2]).toLowerCase() === "full_time";
    });

  if (!hasPreferred) {
    targetBid = null;
    for (const r of odds) {
      const t = String(r[1]).toLowerCase();
      if ((t === "home_draw_away" || t === "1x2") && String(r[2]).toLowerCase() === "full_time") {
        targetBid = Number(r[0]);
        break;
      }
    }
  }

  if (targetBid == null) return empty;

  const out = { ...empty, usedBid: targetBid };
  for (const r of odds) {
    if (Number(r[0]) !== targetBid) continue;
    const t = String(r[1]).toLowerCase();
    const s = String(r[2]).toLowerCase();
    const side = String(r[3]).toLowerCase();
    if ((t !== "home_draw_away" && t !== "1x2") || s !== "full_time") continue;

    const op = r[4] != null && r[4] !== "" && Number(r[4]) > 1 ? Number(r[4]) : null;
    const cl = r[5] != null && r[5] !== "" && Number(r[5]) > 1 ? Number(r[5]) : null;

    if (side === "h" || side === "home") {
      if (out.o1 == null) out.o1 = op ?? cl;
      if (out.c1 == null) out.c1 = cl ?? op;
    } else if (side === "d" || side === "draw") {
      if (out.ox == null) out.ox = op ?? cl;
      if (out.cx == null) out.cx = cl ?? op;
    } else if (side === "a" || side === "away") {
      if (out.o2 == null) out.o2 = op ?? cl;
      if (out.c2 == null) out.c2 = cl ?? op;
    }
  }
  return out;
}

/** Supabase fixtureh tablosundan maçın oranlarını oku */
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
 * Meta'dan eşleşen maçların detaylarını R2'deki raw/{file} (.json.gz) dosyalarından okur
 * ve 1 O, 1 C, X O, X C, 2 O, 2 C sütunlarını doldurur.
 */
async function hydrateMatchesFromRaw(
  items: (HandballMeta & { distance?: number })[],
  preferredBmName?: string,
): Promise<HandballTableRow[]> {
  const uniqueFiles = [...new Set(items.map((x) => x.file))];
  await Promise.all(uniqueFiles.map((f) => loadRawSeason(f)));

  const targetName = preferredBmName?.toLowerCase().trim() ?? "";

  return items.map((m) => {
    const d = rawCache.get(m.file);
    let preferredBid: number | null = null;
    if (d?.bookmakers && targetName) {
      for (const [bid, name] of Object.entries(d.bookmakers)) {
        const n = String(name).toLowerCase();
        if (n === targetName || n.includes(targetName) || targetName.includes(n)) {
          preferredBid = Number(bid);
          break;
        }
      }
    }

    const rawMatch = d?.matches?.find((x: any) => x.match_id === m.id);
    const { o1, c1, ox, cx, o2, c2, usedBid } = extract1x2Columns(rawMatch?.odds ?? [], preferredBid);
    const { date, time } = formatTs(m.ts);

    return {
      ...m,
      src: "archive",
      date,
      time,
      ft: m.hs != null && m.as != null ? `${m.hs}-${m.as}` : "-",
      ftRes: getFtRes(m.hs, m.as),
      o1,
      c1,
      ox,
      cx,
      o2,
      c2,
      bmUsed: usedBid != null && d?.bookmakers ? d.bookmakers[String(usedBid)] : undefined,
    };
  });
}

export async function similar(
  eventId: string,
  k = 10,
  opts?: {
    oddsOverride?: CompactOddsRow[] | null;
    bookmakerId?: number | null;
    bookmakerName?: string;
  },
) {
  const { matches, dim: D, cols, vec, index } = await load();
  const i = index.get(eventId);

  if (i !== undefined) {
    const q = new Float32Array(D);
    for (let c = 0; c < D; c++) q[c] = vec[i * D + c];
    const nearest = nearestFromVector(q, matches, D, vec, k, eventId);
    return hydrateMatchesFromRaw(nearest, opts?.bookmakerName);
  }

  let odds = opts?.oddsOverride ?? null;
  if (!odds?.length) odds = await fetchFixtureHOdds(eventId);
  if (!odds?.length) {
    return {
      error: "not_in_archive_no_odds",
      message: "Bu maç R2 arşivinde yok ve fixtureh içinde oran bulunamadı.",
    } as const;
  }

  const q = buildFeatureVector(odds, cols, D, opts?.bookmakerId);
  let nonzero = 0;
  for (let c = 0; c < D; c++) if (q[c] !== 0) nonzero++;
  if (nonzero === 0) {
    return {
      error: "odds_features_empty",
      message: "Oranlar feature anahtarlarıyla eşleşmedi.",
    } as const;
  }

  const nearest = nearestFromVector(q, matches, D, vec, k);
  return hydrateMatchesFromRaw(nearest, opts?.bookmakerName);
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

export async function matchDetail(eventId: string) {
  const { matches, index } = await load();
  const i = index.get(eventId);
  if (i === undefined) return null;
  const d = await loadRawSeason(matches[i].file);
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
