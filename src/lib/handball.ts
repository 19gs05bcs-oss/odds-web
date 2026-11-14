import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { gunzipSync } from "zlib";
import { sql } from "@/lib/db";

const BUCKET = "handball-odds";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `R2 env eksik: ${name}. Railway/hosting ortamında R2_ACCOUNT_ID, R2_KEY, R2_SECRET tanımlı olmalı.`,
    );
  }
  return v;
}

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${requireEnv("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: requireEnv("R2_KEY"),
    secretAccessKey: requireEnv("R2_SECRET"),
  },
});

const get = async (key: string) => {
  try {
    const out = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    if (!out.Body) throw new Error(`R2 boş body: ${key}`);
    return Buffer.from(await out.Body.transformToByteArray());
  } catch (e: any) {
    const code = e?.name || e?.Code || e?.code || "";
    const msg = e?.message || String(e);
    throw new Error(`R2 okuma hatası [${BUCKET}/${key}] ${code}: ${msg}`);
  }
};

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
  /** Half-time scores from raw archive (meta.json'da yok) */
  hts: string | null;
  ats: string | null;
  /** FT total goals */
  total: number | null;
  // 1X2
  o1: number | null;
  c1: number | null;
  ox: number | null;
  cx: number | null;
  o2: number | null;
  c2: number | null;
  // Asian Handicap (main line ~1.90)
  ahLine: number | null;
  ahH_o: number | null;
  ahH_c: number | null;
  ahA_o: number | null;
  ahA_c: number | null;
  // Over/Under (main line ~1.90)
  ouLine: number | null;
  ouO_o: number | null;
  ouO_c: number | null;
  ouU_o: number | null;
  ouU_c: number | null;
  // Double Chance (current)
  dc1x: number | null;
  dc12: number | null;
  dcx2: number | null;
  // Draw No Bet (current)
  dnbH: number | null;
  dnbA: number | null;
  bmUsed?: string;
  distance?: number;
  /** Kullanılan oran toleransı (göreli, örn. 0.1 = ±%10) */
  tol?: number | null;
  /** Sorgu maçına göre en büyük göreli oran sapması */
  oddsDiff?: number | null;
  /** O/U barajı toleransı (gol): 0 = sorgu maçıyla aynı baraj, 1 = ±1, 2 = ±2. null = filtre uygulanmadı */
  ouLineTol?: number | null;
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

    let meta: any;
    try {
      meta = JSON.parse(m.toString("utf8"));
    } catch (e: any) {
      throw new Error(`meta.json JSON.parse başarısız: ${e?.message || e}`);
    }

    const matches = meta.matches as HandballMeta[];
    if (!Array.isArray(matches) || !matches.length) {
      throw new Error("meta.json içinde matches dizisi yok veya boş.");
    }

    const dim = Number(meta.dim ?? 7);
    const expectedBytes = matches.length * dim * 4;
    if (b.byteLength !== expectedBytes) {
      throw new Error(
        `features.bin boyutu uyuşmuyor: got=${b.byteLength} expected=${expectedBytes} (matches=${matches.length} dim=${dim})`,
      );
    }

    // Node Buffer byteOffset güvenli okuma
    const u8 = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    const vec = new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength / 4);

    const index = new Map<string, number>(matches.map((x, i) => [x.id, i]));
    const haystack = matches.map((x) => fold(`${x.home} ${x.away} ${x.season}`));
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
  if (d) return d;

  // R2'de raw/ klasörü yok — dosyalar bucket kökünde
  // Önce kök, yoksa raw/ dene (geriye uyumluluk)
  let buf: Buffer;
  let usedKey = file;
  try {
    buf = await get(usedKey);
  } catch (e1: any) {
    try {
      usedKey = `raw/${file}`;
      buf = await get(usedKey);
    } catch (e2: any) {
      throw new Error(
        `Sezon dosyası bulunamadı. Denenen keyler: ${file}, raw/${file}. Son hata: ${e2?.message || e2}`,
      );
    }
  }

  let text: string;
  try {
    try {
      text = gunzipSync(buf).toString("utf8");
    } catch {
      text = buf.toString("utf8");
    }
  } catch (e: any) {
    throw new Error(`Sezon dosyası açılamadı (${usedKey}): ${e?.message || e}`);
  }

  try {
    d = JSON.parse(text);
  } catch (e: any) {
    throw new Error(
      `Sezon JSON.parse başarısız (${usedKey}), ilk 120 char: ${text.slice(0, 120)} — ${e?.message || e}`,
    );
  }

  if (rawCache.size >= 25) rawCache.delete(rawCache.keys().next().value!);
  rawCache.set(file, d);
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

  let openH = 0,
    openD = 0,
    openA = 0;
  let closeH = 0,
    closeD = 0,
    closeA = 0;

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
    if (
      (t === "asian_handicap" || t === "ah") &&
      s === "full_time" &&
      (side.startsWith("h:") || side.startsWith("home:"))
    ) {
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
  /** true ise preferredBid yoksa veya satırı yoksa başka BM'ye düşme */
  strict = false,
): {
  o1: number | null;
  c1: number | null;
  ox: number | null;
  cx: number | null;
  o2: number | null;
  c2: number | null;
  usedBid: number | null;
} {
  const empty = {
    o1: null as number | null,
    c1: null as number | null,
    ox: null as number | null,
    cx: null as number | null,
    o2: null as number | null,
    c2: null as number | null,
    usedBid: null as number | null,
  };

  if (!Array.isArray(odds) || !odds.length) return empty;

  let targetBid = preferredBid ?? null;
  const hasPreferred =
    targetBid != null &&
    odds.some((r) => {
      const t = String(r[1]).toLowerCase();
      return (
        Number(r[0]) === targetBid &&
        (t === "home_draw_away" || t === "1x2") &&
        String(r[2]).toLowerCase() === "full_time"
      );
    });

  if (!hasPreferred) {
    if (strict) return empty; // başka BM'ye düşme
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


/** Seçilen BM için ana marketleri çıkar (1X2 zaten extract1x2Columns'ta). */
export function extractMarkets(
  odds: any[],
  preferredBid: number | null,
): {
  ahLine: number | null;
  ahH_o: number | null;
  ahH_c: number | null;
  ahA_o: number | null;
  ahA_c: number | null;
  ouLine: number | null;
  ouO_o: number | null;
  ouO_c: number | null;
  ouU_o: number | null;
  ouU_c: number | null;
  dc1x: number | null;
  dc12: number | null;
  dcx2: number | null;
  dnbH: number | null;
  dnbA: number | null;
} {
  const empty = {
    ahLine: null as number | null,
    ahH_o: null as number | null,
    ahH_c: null as number | null,
    ahA_o: null as number | null,
    ahA_c: null as number | null,
    ouLine: null as number | null,
    ouO_o: null as number | null,
    ouO_c: null as number | null,
    ouU_o: null as number | null,
    ouU_c: null as number | null,
    dc1x: null as number | null,
    dc12: null as number | null,
    dcx2: null as number | null,
    dnbH: null as number | null,
    dnbA: null as number | null,
  };
  if (!Array.isArray(odds) || !odds.length || preferredBid == null) return empty;

  const bmRows = odds.filter((r) => Number(r[0]) === preferredBid);
  if (!bmRows.length) return empty;

  const num = (v: any) => {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 1 ? n : null;
  };

  // --- Asian Handicap: line closest to odd 1.90 on home side ---
  let bestAh = Infinity;
  let ahLine: number | null = null;
  for (const row of bmRows) {
    const t = String(row[1]).toLowerCase();
    const s = String(row[2]).toLowerCase();
    const side = String(row[3]);
    if (!((t === "asian_handicap" || t === "ah" || t === "handicap") && s === "full_time")) continue;
    const sideL = side.toLowerCase();
    if (!(sideL.startsWith("h:") || sideL.startsWith("home:"))) continue;
    const line = Number(side.split(":")[1]);
    const odd = num(row[5]) ?? num(row[4]);
    if (!Number.isFinite(line) || odd == null) continue;
    const diff = Math.abs(odd - 1.9);
    if (diff < bestAh) {
      bestAh = diff;
      ahLine = line;
    }
  }
  let ahH_o: number | null = null, ahH_c: number | null = null;
  let ahA_o: number | null = null, ahA_c: number | null = null;
  if (ahLine != null) {
    const hSides = new Set([`h:${ahLine}`, `home:${ahLine}`, `H:${ahLine}`]);
    const aSides = new Set([`a:${-ahLine}`, `away:${-ahLine}`, `A:${-ahLine}`, `a:${ahLine}`, `A:${ahLine}`]);
    // also try opposite sign conventions
    for (const row of bmRows) {
      const t = String(row[1]).toLowerCase();
      const s = String(row[2]).toLowerCase();
      const side = String(row[3]);
      if (!((t === "asian_handicap" || t === "ah" || t === "handicap") && s === "full_time")) continue;
      const sideL = side.toLowerCase();
      const op = num(row[4]);
      const cl = num(row[5]);
      if (sideL === `h:${ahLine}` || sideL === `home:${ahLine}`) {
        if (ahH_o == null) ahH_o = op ?? cl;
        if (ahH_c == null) ahH_c = cl ?? op;
      }
      // away side is typically opposite line
      if (
        sideL === `a:${-ahLine}` ||
        sideL === `away:${-ahLine}` ||
        sideL === `a:${ahLine}` ||
        sideL === `away:${ahLine}`
      ) {
        if (ahA_o == null) ahA_o = op ?? cl;
        if (ahA_c == null) ahA_c = cl ?? op;
      }
    }
  }

  // --- Over/Under: line closest to odd 1.90 on over ---
  let bestOu = Infinity;
  let ouLine: number | null = null;
  for (const row of bmRows) {
    const t = String(row[1]).toLowerCase();
    const s = String(row[2]).toLowerCase();
    const side = String(row[3]).toLowerCase();
    if (!((t === "over_under" || t === "totals" || t === "total" || t === "ou") && s === "full_time")) continue;
    if (!(side.startsWith("over:") || side.startsWith("o:"))) continue;
    const line = Number(side.split(":")[1]);
    const odd = num(row[5]) ?? num(row[4]);
    if (!Number.isFinite(line) || odd == null) continue;
    const diff = Math.abs(odd - 1.9);
    if (diff < bestOu) {
      bestOu = diff;
      ouLine = line;
    }
  }
  let ouO_o: number | null = null, ouO_c: number | null = null;
  let ouU_o: number | null = null, ouU_c: number | null = null;
  if (ouLine != null) {
    for (const row of bmRows) {
      const t = String(row[1]).toLowerCase();
      const s = String(row[2]).toLowerCase();
      const side = String(row[3]).toLowerCase();
      if (!((t === "over_under" || t === "totals" || t === "total" || t === "ou") && s === "full_time")) continue;
      const op = num(row[4]);
      const cl = num(row[5]);
      if (side === `over:${ouLine}` || side === `o:${ouLine}`) {
        if (ouO_o == null) ouO_o = op ?? cl;
        if (ouO_c == null) ouO_c = cl ?? op;
      }
      if (side === `under:${ouLine}` || side === `u:${ouLine}`) {
        if (ouU_o == null) ouU_o = op ?? cl;
        if (ouU_c == null) ouU_c = cl ?? op;
      }
    }
  }

  // --- Double Chance (current preferred) ---
  let dc1x: number | null = null, dc12: number | null = null, dcx2: number | null = null;
  for (const row of bmRows) {
    const t = String(row[1]).toLowerCase();
    const s = String(row[2]).toLowerCase();
    const side = String(row[3]).toLowerCase();
    if (!(t === "double_chance" || t === "dc") || s !== "full_time") continue;
    const odd = num(row[5]) ?? num(row[4]);
    if (side === "dc:1x" || side === "1x" || side === "home_draw") dc1x = dc1x ?? odd;
    if (side === "dc:12" || side === "12" || side === "home_away") dc12 = dc12 ?? odd;
    if (side === "dc:x2" || side === "x2" || side === "draw_away") dcx2 = dcx2 ?? odd;
  }

  // --- Draw No Bet ---
  let dnbH: number | null = null, dnbA: number | null = null;
  for (const row of bmRows) {
    const t = String(row[1]).toLowerCase();
    const s = String(row[2]).toLowerCase();
    const side = String(row[3]).toLowerCase();
    if (!(t === "draw_no_bet" || t === "dnb") || s !== "full_time") continue;
    const odd = num(row[5]) ?? num(row[4]);
    if (side === "h" || side === "home" || side === "1") dnbH = dnbH ?? odd;
    if (side === "a" || side === "away" || side === "2") dnbA = dnbA ?? odd;
  }

  return {
    ahLine, ahH_o, ahH_c, ahA_o, ahA_c,
    ouLine, ouO_o, ouO_c, ouU_o, ouU_c,
    dc1x, dc12, dcx2,
    dnbH, dnbA,
  };
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

/** ah_line gibi ölçeksiz kolonlar olasılıkları ezmesin diye ağırlık (1X2 olasılıkları = 1). */
function colWeights(cols: string[], dim: number): Float32Array {
  const w = new Float32Array(dim).fill(1);
  for (let c = 0; c < dim; c++) {
    if (cols[c] === "ah_line") w[c] = 0.03; // 1 gol farkı ≈ 0.03 olasılık farkı
  }
  return w;
}

function nearestFromVector(
  q: Float32Array,
  matches: HandballMeta[],
  dim: number,
  vec: Float32Array,
  k: number,
  skipId?: string,
  cols: string[] = [],
) {
  const w = colWeights(cols, dim);
  const sc: [number, number][] = [];
  for (let j = 0; j < matches.length; j++) {
    if (skipId && matches[j].id === skipId) continue;
    if (!hasScore(matches[j])) continue;
    let d = 0;
    const base = j * dim;
    for (let c = 0; c < dim; c++) {
      const t = (q[c] - vec[base + c]) * w[c];
      d += t * t;
    }
    sc.push([d, j]);
  }
  sc.sort((a, b) => a[0] - b[0]);
  return sc.slice(0, k).map(([d, j]) => ({ ...matches[j], distance: Math.sqrt(d) }));
}

/** Bookmaker adını sezon dosyasındaki id'ye çevir (esnek eşleşme). */
function resolveBookmakerId(
  bookmakers: Record<string, string> | undefined,
  preferredName: string,
  preferredId?: number | null,
): number | null {
  if (preferredId != null && Number.isFinite(preferredId) && bookmakers) {
    if (bookmakers[String(preferredId)] != null) return preferredId;
  }
  const target = preferredName?.toLowerCase().trim() ?? "";
  if (!target || !bookmakers) return preferredId ?? null;

  // 1) exact
  for (const [bid, name] of Object.entries(bookmakers)) {
    if (String(name).toLowerCase() === target) return Number(bid);
  }
  // 2) includes
  for (const [bid, name] of Object.entries(bookmakers)) {
    const n = String(name).toLowerCase();
    if (n.includes(target) || target.includes(n)) return Number(bid);
  }
  return preferredId ?? null;
}

/**
 * Seçilen BM'ye özel zengin vektör:
 * 1X2 open/close implied (6) + AH line + OU line + OU over/under close probs
 * features.bin ile aynı boyutta olmak zorunda değil — sadece BM re-rank için.
 */
function buildBmRichVector(
  odds: any[],
  preferredBid: number | null,
): Float32Array {
  // [openH, openD, openA, closeH, closeD, closeA, ahLine, ouLine, ouOver, ouUnder]
  const out = new Float32Array(10);
  if (!odds?.length || preferredBid == null) return out;

  const bmRows = odds.filter((r) => Number(r[0]) === preferredBid);
  if (!bmRows.length) return out;

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

  // AH line closest to 1.90 (home side)
  let ahLine = 0;
  let bestAh = Infinity;
  for (const row of bmRows) {
    const t = String(row[1]).toLowerCase();
    const s = String(row[2]).toLowerCase();
    const side = String(row[3]).toLowerCase();
    if (
      (t === "asian_handicap" || t === "ah" || t === "handicap") &&
      s === "full_time" &&
      (side.startsWith("h:") || side.startsWith("home:"))
    ) {
      const line = Number(side.split(":")[1]);
      const odd = Number(row[5] ?? row[4]);
      if (Number.isFinite(line) && odd > 1) {
        const diff = Math.abs(odd - 1.9);
        if (diff < bestAh) {
          bestAh = diff;
          ahLine = line;
        }
      }
    }
  }

  // OU main line closest to 1.90 over
  let ouLine = 0;
  let ouOver = 0;
  let ouUnder = 0;
  let bestOu = Infinity;
  for (const row of bmRows) {
    const t = String(row[1]).toLowerCase();
    const s = String(row[2]).toLowerCase();
    const side = String(row[3]).toLowerCase();
    if (
      (t === "over_under" || t === "totals" || t === "total" || t === "ou") &&
      s === "full_time" &&
      (side.startsWith("over:") || side.startsWith("o:"))
    ) {
      const line = Number(side.split(":")[1]);
      const odd = Number(row[5] ?? row[4]);
      if (Number.isFinite(line) && odd > 1) {
        const diff = Math.abs(odd - 1.9);
        if (diff < bestOu) {
          bestOu = diff;
          ouLine = line;
          ouOver = 1 / odd;
        }
      }
    }
  }
  if (ouLine !== 0) {
    for (const row of bmRows) {
      const t = String(row[1]).toLowerCase();
      const s = String(row[2]).toLowerCase();
      const side = String(row[3]).toLowerCase();
      if (
        (t === "over_under" || t === "totals" || t === "total" || t === "ou") &&
        s === "full_time" &&
        (side === `under:${ouLine}` || side === `u:${ouLine}`)
      ) {
        const odd = Number(row[5] ?? row[4]);
        if (odd > 1) ouUnder = 1 / odd;
      }
    }
    // normalize ou probs
    const sOu = ouOver + ouUnder;
    if (sOu > 0) {
      ouOver /= sOu;
      ouUnder /= sOu;
    }
  }

  out[0] = openH;
  out[1] = openD;
  out[2] = openA;
  out[3] = closeH;
  out[4] = closeD;
  out[5] = closeA;
  // Çizgiler ölçeksiz (AH ±5, OU ~58) — olasılıkları ezmesin diye küçük ağırlık
  out[6] = ahLine * 0.03;
  out[7] = ouLine * 0.01;
  out[8] = ouOver;
  out[9] = ouUnder;
  return out;
}

function vectorDistance(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let d = 0;
  for (let i = 0; i < n; i++) {
    const t = a[i] - b[i];
    d += t * t;
  }
  return Math.sqrt(d);
}

/** Seçilen BM'nin 1X2 satırı var mı? */
function hasBm1x2(odds: any[], bid: number): boolean {
  for (const r of odds) {
    if (Number(r[0]) !== bid) continue;
    const t = String(r[1]).toLowerCase();
    const s = String(r[2]).toLowerCase();
    if ((t === "home_draw_away" || t === "1x2") && s === "full_time") return true;
  }
  return false;
}

/** Oran toleransı kademeleri (göreli): önce dar, yetmezse genişlet. */
const ODDS_TOLS = [0.03, 0.05, 0.08];
/** O/U barajı kademeleri (gol): önce AYNI baraj, yetmezse ±1, en fazla ±2. */
const OU_LINE_STEPS = [0, 1, 2];

/**
 * Benzer maç seçimi: sorgu maçının O/U barajı (ör. 57.5) ile aynı barajda açılan maçlar önce gelir;
 * baraj kademesi dış döngü, 1X2 oran toleransı iç döngüdür (baraj, oran toleransından daha önceliklidir).
 * Eskiden baraj sadece vektörde ouLine*0.01 ağırlığıyla vardı (5 gol fark = 0.05), yani 57.5 için 62.5 gelebiliyordu.
 */
export function pickSimilar<
  T extends { ouLine: number | null; distance?: number; _oddsDiff: number | null },
>(
  scored: T[],
  opts: { qOuLine: number | null; has1x2: boolean; k: number },
): { rows: T[]; tol: number | null; ouLineTol: number | null } {
  const { qOuLine, has1x2, k } = opts;
  const steps: (number | null)[] = qOuLine != null ? OU_LINE_STEPS : [null];
  const tols: (number | null)[] = has1x2 ? ODDS_TOLS : [null];
  let last: { within: T[]; tol: number | null; step: number | null } = {
    within: scored,
    tol: null,
    step: null,
  };
  for (const step of steps) {
    for (const tol of tols) {
      const within = scored.filter(
        (r) =>
          (tol == null || (r._oddsDiff != null && r._oddsDiff <= tol)) &&
          (step == null ||
            (r.ouLine != null && Math.abs(r.ouLine - (qOuLine as number)) <= step + 1e-9)),
      );
      last = { within, tol, step };
      if (within.length >= k) {
        return finishPick(last, qOuLine, k);
      }
    }
  }
  return finishPick(last, qOuLine, k);
}

function finishPick<T extends { ouLine: number | null; distance?: number }>(
  r: { within: T[]; tol: number | null; step: number | null },
  qOuLine: number | null,
  k: number,
) {
  const rows = [...r.within];
  if (qOuLine != null) {
    // Aynı barajdakiler önce, sonra yakın barajlar; eşitlikte vektör mesafesi.
    rows.sort(
      (a, b) =>
        Math.abs((a.ouLine ?? 1e9) - qOuLine) - Math.abs((b.ouLine ?? 1e9) - qOuLine) ||
        (a.distance ?? 99) - (b.distance ?? 99),
    );
  }
  return { rows: rows.slice(0, k), tol: r.tol, ouLineTol: r.step };
}

/**
 * Meta adaylarını R2 raw dosyalarından doldurur.
 * strictBm=true ise: sadece seçilen BM'nin oranının olduğu maçlar kalır,
 * distance o BM'nin rich vektörüne göre yeniden hesaplanır.
 */
async function hydrateMatchesFromRaw(
  items: (HandballMeta & { distance?: number })[],
  opts?: {
    preferredBmName?: string;
    preferredBmId?: number | null;
    queryOdds?: CompactOddsRow[] | null;
    strictBm?: boolean;
    k?: number;
  },
): Promise<HandballTableRow[]> {
  const preferredBmName = opts?.preferredBmName ?? "";
  const preferredBmId = opts?.preferredBmId ?? null;
  const strictBm = opts?.strictBm ?? false;
  const k = opts?.k ?? items.length;
  const queryOdds = opts?.queryOdds ?? null;

  const uniqueFiles = [...new Set(items.map((x) => x.file))];
  const loadErrors: string[] = [];
  await Promise.all(
    uniqueFiles.map(async (f) => {
      try {
        await loadRawSeason(f);
      } catch (e: any) {
        loadErrors.push(`${f}: ${e?.message || e}`);
      }
    }),
  );
  if (loadErrors.length === uniqueFiles.length && uniqueFiles.length > 0) {
    throw new Error(
      `Hiçbir sezon dosyası yüklenemedi (${uniqueFiles.length} dosya). Örnek: ${loadErrors[0]}`,
    );
  }

  // Query tarafı rich vektör (seçilen BM)
  let queryVec: Float32Array | null = null;
  if (queryOdds?.length && (preferredBmId != null || preferredBmName)) {
    // Query odds genelde tek havuz; id ile filtrele
    queryVec = buildBmRichVector(queryOdds, preferredBmId);
    // id ile hiç satır yoksa isim zaten resolve edilemez (farklı sezon dosyası yok)
    let nz = 0;
    for (let i = 0; i < queryVec.length; i++) if (queryVec[i] !== 0) nz++;
    if (nz === 0) queryVec = null;
  }

  // Sorgu maçının seçilen BM'deki 1X2 oranları (tolerans filtresi için)
  const qBid = queryVec ? preferredBmId : null;
  const q1x2 =
    queryOdds?.length && qBid != null
      ? extract1x2Columns(queryOdds, qBid, true)
      : null;
  // Sorgu maçının seçilen BM'deki O/U barajı (canlıda açık olan baraj) — benzer maçlar buna göre filtrelenir
  const qOuLine =
    queryOdds?.length && qBid != null ? extractMarkets(queryOdds, qBid).ouLine : null;
  const relDiff = (a: number | null, b: number | null) =>
    a == null || b == null ? null : Math.abs(a - b) / a;

  type Scored = HandballTableRow & { _hasBm: boolean; _oddsDiff: number | null };
  const scored: Scored[] = [];

  for (const m of items) {
    const d = rawCache.get(m.file);
    if (!d) continue;

    const bid = resolveBookmakerId(d.bookmakers, preferredBmName, preferredBmId);
    const rawMatch = d?.matches?.find((x: any) => x.match_id === m.id);
    const rawOdds: any[] = rawMatch?.odds ?? [];

    const bmPresent = bid != null && hasBm1x2(rawOdds, bid);

    // strict: seçilen BM yoksa atla
    if (strictBm && preferredBmName && !bmPresent) continue;

    // Sadece bu BM'nin oranları (fallback yok)
    const extractBid = bmPresent ? bid : null;
    const { o1, c1, ox, cx, o2, c2, usedBid } = extract1x2Columns(
      rawOdds,
      extractBid,
      true, // strict: sadece seçilen BM
    );
    const markets = extractMarkets(rawOdds, extractBid);

    // BM özel distance
    let distance = m.distance ?? 0;
    if (queryVec && bmPresent && bid != null) {
      const archVec = buildBmRichVector(rawOdds, bid);
      distance = vectorDistance(queryVec, archVec);
    }

    const { date, time } = formatTs(m.ts);
    const hts =
      rawMatch?.home_ht_score != null && rawMatch.home_ht_score !== ""
        ? String(rawMatch.home_ht_score)
        : null;
    const ats =
      rawMatch?.away_ht_score != null && rawMatch.away_ht_score !== ""
        ? String(rawMatch.away_ht_score)
        : null;
    const hsN = m.hs != null && m.hs !== "" ? Number(m.hs) : NaN;
    const asN = m.as != null && m.as !== "" ? Number(m.as) : NaN;
    const total = Number.isFinite(hsN) && Number.isFinite(asN) ? hsN + asN : null;
    scored.push({
      ...m,
      distance,
      src: "archive",
      date,
      time,
      ft: m.hs != null && m.as != null ? `${m.hs}-${m.as}` : "-",
      ftRes: getFtRes(m.hs, m.as),
      hts,
      ats,
      total,
      o1,
      c1,
      ox,
      cx,
      o2,
      c2,
      ...markets,
      bmUsed:
        usedBid != null && d?.bookmakers
          ? d.bookmakers[String(usedBid)]
          : undefined,
      _hasBm: bmPresent,
      _oddsDiff: (() => {
        if (!q1x2 || q1x2.o1 == null) return null;
        // Ev/deplasman açılış + kapanış oranlarının en büyük göreli sapması
        const ds = [
          relDiff(q1x2.o1, o1),
          relDiff(q1x2.c1, c1),
          relDiff(q1x2.o2, o2),
          relDiff(q1x2.c2, c2),
        ];
        if (ds.some((x) => x == null)) return 99;
        return Math.max(...(ds as number[]));
      })(),
    });
  }

  // BM'ye göre yeniden sırala
  scored.sort((a, b) => (a.distance ?? 99) - (b.distance ?? 99));

  // Baraj (O/U) + oran toleransı: önce aynı baraj ve dar oran, yetmezse kademeli genişlet.
  // Kapsam dışı (1.65 vs 1.11 gibi veya 57.5 vs 62.5) maçlar hiçbir zaman listeye girmez.
  const { rows: picked, tol: tolUsed, ouLineTol } = pickSimilar(scored, {
    qOuLine,
    has1x2: !!(q1x2 && q1x2.o1 != null),
    k,
  });

  return picked.map(({ _hasBm, _oddsDiff, ...rest }) => ({
    ...rest,
    tol: tolUsed,
    ouLineTol,
    oddsDiff: _oddsDiff != null && _oddsDiff < 99 ? Number(_oddsDiff.toFixed(4)) : null,
  }));
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

  const bmName = opts?.bookmakerName ?? "";
  const bmId = opts?.bookmakerId ?? null;
  const strictBm = !!(bmName || bmId != null);

  // Aday havuzu: BM filtre + re-rank için daha geniş çek
  const candidateK = strictBm ? Math.max(k * 30, 400) : k;

  let nearest: (HandballMeta & { distance?: number })[];
  let queryOdds: CompactOddsRow[] | null = opts?.oddsOverride ?? null;

  if (i !== undefined) {
    // Arşiv maçı: features.bin vektörü ile aday bul
    const q = new Float32Array(D);
    for (let c = 0; c < D; c++) q[c] = vec[i * D + c];
    nearest = nearestFromVector(q, matches, D, vec, candidateK, eventId, cols);

    // Arşiv maçının kendi odds'unu da al (BM re-rank query için)
    if (!queryOdds?.length) {
      try {
        const d = await loadRawSeason(matches[i].file);
        const rawMatch = d?.matches?.find((x: any) => x.match_id === eventId);
        if (rawMatch?.odds) queryOdds = rawMatch.odds;
      } catch {
        /* ignore */
      }
    }
  } else {
    if (!queryOdds?.length) queryOdds = await fetchFixtureHOdds(eventId);
    if (!queryOdds?.length) {
      return {
        error: "not_in_archive_no_odds",
        message: "Bu maç R2 arşivinde yok ve fixtureh içinde oran bulunamadı.",
      } as const;
    }

    const q = buildFeatureVector(queryOdds, cols, D, bmId);
    let nonzero = 0;
    for (let c = 0; c < D; c++) if (q[c] !== 0) nonzero++;
    if (nonzero === 0) {
      return {
        error: "odds_features_empty",
        message: "Oranlar feature anahtarlarıyla eşleşmedi.",
      } as const;
    }

    nearest = nearestFromVector(q, matches, D, vec, candidateK, undefined, cols);
  }

  const rows = await hydrateMatchesFromRaw(nearest, {
    preferredBmName: bmName,
    preferredBmId: bmId,
    queryOdds,
    strictBm,
    k,
  });

  // strict BM ile hiç sonuç yoksa anlamlı hata
  if (strictBm && rows.length === 0) {
    return {
      error: "no_matches_for_bookmaker",
      message: `Seçilen bahis şirketi (${bmName || bmId}) için arşivde yeterli benzer maç bulunamadı.`,
    } as const;
  }

  return rows;
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
