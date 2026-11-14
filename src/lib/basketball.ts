import "server-only";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { gunzipSync } from "zlib";
import { sql } from "@/lib/db";
import {
  bmHasCore,
  defaultBookmaker,
  denorm,
  marketSnapshot,
  maskedDistance,
  profileFromOdds,
  zVector,
  type CompactOddsRow,
  type Norm,
  type RawProfile,
} from "@/lib/basketballOdds";

export type { CompactOddsRow } from "@/lib/basketballOdds";

const BUCKET = process.env.R2_BASKETBALL_BUCKET || "basketball-odds";

/* ------------------------------------------------------------------ R2 */

let _s3: S3Client | null = null;
function s3(): S3Client {
  if (_s3) return _s3;
  const need = (n: string) => {
    const v = process.env[n];
    if (!v) throw new Error(`Missing R2 env var: ${n}. R2_ACCOUNT_ID, R2_KEY and R2_SECRET must be set.`);
    return v;
  };
  _s3 = new S3Client({
    region: "auto",
    endpoint: `https://${need("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: need("R2_KEY"), secretAccessKey: need("R2_SECRET") },
  });
  return _s3;
}

async function get(key: string): Promise<Buffer> {
  try {
    const out = await s3().send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    if (!out.Body) throw new Error("empty body");
    return Buffer.from(await out.Body.transformToByteArray());
  } catch (e: any) {
    throw new Error(`R2 read error [${BUCKET}/${key}] ${e?.name || e?.Code || ""}: ${e?.message || e}`);
  }
}

/* ------------------------------------------------------------- tipler */

export type BasketballMeta = {
  id: string;
  season: string;
  league: string;
  file: string;
  ts: number;
  home: string;
  away: string;
  hs: string | null;
  as: string | null;
};

export type BasketballTableRow = BasketballMeta & {
  src: "archive";
  date: string;
  time: string;
  ft: string;
  ftRes: "Home" | "Away" | "-";
  hts: string | null;
  ats: string | null;
  /** "23-20, 25-18, ..." çeyrek skorları (varsa) */
  periods: string | null;
  total: number | null;
  margin: number | null;
  o1: number | null;
  c1: number | null;
  o2: number | null;
  c2: number | null;
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
  bmUsed?: string;
  distance?: number;
  /** kullanılan ML olasılık toleransı (mutlak, ör. 0.04) */
  tol?: number | null;
  /** O/U barajı toleransı (puan) */
  ouLineTol?: number | null;
  probDiff?: number | null;
};

type Store = {
  matches: BasketballMeta[];
  dim: number;
  cols: string[];
  weights: Float32Array;
  norm: Norm;
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

/* ------------------------------------------------------- meta + features */

let cache: Promise<Store> | null = null;
const load = () =>
  (cache ??= (async () => {
    const [m, b] = await Promise.all([get("meta.json"), get("features.bin")]);
    let meta: any;
    try {
      meta = JSON.parse(m.toString("utf8"));
    } catch (e: any) {
      throw new Error(`meta.json JSON.parse failed: ${e?.message || e}`);
    }
    const matches = meta.matches as BasketballMeta[];
    if (!Array.isArray(matches) || !matches.length) throw new Error("meta.json has no matches (missing or empty).");

    const dim = Number(meta.dim ?? 5);
    if (b.byteLength !== matches.length * dim * 4) {
      throw new Error(
        `features.bin size mismatch: got=${b.byteLength} expected=${matches.length * dim * 4} (matches=${matches.length} dim=${dim})`,
      );
    }
    // Buffer byteOffset'i hizalı olmayabilir → kopyalayarak oku
    const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    const vec = new Float32Array(ab);

    const cols: string[] = Array.isArray(meta.cols) ? meta.cols.map(String) : ["ml_c", "ah_c", "ou_c", "ahP_c", "ouP_c"];
    const w = Array.isArray(meta.weights) ? meta.weights.map(Number) : cols.map(() => 1);
    const weights = new Float32Array(dim);
    for (let c = 0; c < dim; c++) weights[c] = Number.isFinite(w[c]) ? w[c] : 1;
    const norm = (meta.norm ?? {}) as Norm;

    const index = new Map<string, number>(matches.map((x, i) => [x.id, i]));
    const haystack = matches.map((x) => fold(`${x.home} ${x.away} ${x.league} ${x.season}`));
    return { matches, dim, cols, weights, norm, vec, index, haystack };
  })().catch((e) => {
    cache = null;
    throw e;
  }));

/* ------------------------------------------------------------ raw sezon */

type RawSeason = { bookmakers: Record<string, string>; matches: any[]; byId: Map<string, any> };
const rawCache = new Map<string, RawSeason>();

async function loadRawSeason(file: string): Promise<RawSeason> {
  const hit = rawCache.get(file);
  if (hit) return hit;
  let buf: Buffer;
  try {
    buf = await get(file);
  } catch (e1: any) {
    try {
      buf = await get(`raw/${file}`);
    } catch (e2: any) {
      throw new Error(`Season file not found (${file}, raw/${file}): ${e2?.message || e2}`);
    }
  }
  let text: string;
  try {
    text = gunzipSync(buf).toString("utf8");
  } catch {
    text = buf.toString("utf8");
  }
  const d = JSON.parse(text);
  const matches: any[] = Array.isArray(d?.matches) ? d.matches : [];
  const season: RawSeason = {
    bookmakers: d?.bookmakers ?? {},
    matches,
    byId: new Map(matches.map((x) => [String(x.match_id), x])),
  };
  if (rawCache.size >= 25) rawCache.delete(rawCache.keys().next().value!);
  rawCache.set(file, season);
  return season;
}

/* ------------------------------------------------------------- yardımcı */

const hasScore = (m: BasketballMeta) => m.hs != null && m.hs !== "" && m.as != null && m.as !== "";

function formatTs(ts: number) {
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
    time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`,
  };
}

function periodsText(h: unknown, a: unknown): string | null {
  const hs = String(h ?? "").split(",").filter(Boolean);
  const as = String(a ?? "").split(",").filter(Boolean);
  if (!hs.length || hs.length !== as.length) return null;
  return hs.map((x, i) => `${x}-${as[i]}`).join(", ");
}

/** Supabase fixtureb tablosundan maçın oranlarını oku */
export async function fetchFixtureBOdds(matchId: string): Promise<CompactOddsRow[] | null> {
  try {
    const rows = await sql.unsafe<{ odds: CompactOddsRow[] | null }[]>(
      `SELECT odds FROM fixtureb WHERE match_id = $1 LIMIT 1`,
      [matchId],
    );
    const odds = rows[0]?.odds;
    return Array.isArray(odds) && odds.length ? odds : null;
  } catch (e) {
    console.error("fixtureb odds okunamadı:", e);
    return null;
  }
}

/* ---------------------------------------------------------- benzerlik */

/** ML olasılık toleransı kademeleri (mutlak fark, vig-free ev sahibi olasılığı). */
const PROB_TOLS = [0.02, 0.04, 0.06, 0.1];
/** O/U barajı kademeleri (puan). BM modunda tam çizgi, konsensüste medyan çizgi (x.25 olabilir). */
const OU_STEPS_BM = [0, 1, 2.5, 4];
const OU_STEPS_CONSENSUS = [0.5, 1.5, 3, 5];

type Cand = {
  j: number;
  distance: number;
  /** aday vektörden çıkan ham değerler */
  prob: number | null;
  ou: number | null;
};

export function pickSimilar<T extends Cand>(
  scored: T[],
  opts: { qProb: number | null; qOu: number | null; steps: number[]; k: number },
): { rows: T[]; tol: number | null; ouStep: number | null } {
  const { qProb, qOu, steps, k } = opts;
  const ouSteps: (number | null)[] = qOu != null ? steps : [null];
  const tols: (number | null)[] = qProb != null ? PROB_TOLS : [null];
  let last: { within: T[]; tol: number | null; step: number | null } = { within: scored, tol: null, step: null };
  for (const step of ouSteps) {
    for (const tol of tols) {
      const within = scored.filter(
        (r) =>
          (tol == null || (r.prob != null && Math.abs(r.prob - (qProb as number)) <= tol + 1e-9)) &&
          (step == null || (r.ou != null && Math.abs(r.ou - (qOu as number)) <= step + 1e-9)),
      );
      last = { within, tol, step };
      if (within.length >= k) return finish(last, qOu, k);
    }
  }
  return finish(last, qOu, k);
}

function finish<T extends Cand>(
  r: { within: T[]; tol: number | null; step: number | null },
  qOu: number | null,
  k: number,
) {
  const rows = [...r.within];
  // baraja yakın olanlar önce, eşitlikte mesafe
  if (qOu != null) {
    rows.sort(
      (a, b) =>
        Math.abs((a.ou ?? 1e9) - qOu) - Math.abs((b.ou ?? 1e9) - qOu) || a.distance - b.distance,
    );
  } else {
    rows.sort((a, b) => a.distance - b.distance);
  }
  return { rows: rows.slice(0, k), tol: r.tol, ouStep: r.step };
}

function nearestStored(
  q: Float32Array,
  S: Store,
  pool: number,
  skipId?: string,
): { j: number; distance: number }[] {
  const sc: { j: number; distance: number }[] = [];
  for (let j = 0; j < S.matches.length; j++) {
    if (skipId && S.matches[j].id === skipId) continue;
    if (!hasScore(S.matches[j])) continue;
    const d = maskedDistance(q, S.vec, S.weights, j * S.dim);
    if (d !== Infinity) sc.push({ j, distance: d });
  }
  sc.sort((a, b) => a.distance - b.distance);
  return sc.slice(0, pool);
}

const colIdx = (cols: string[], name: string) => cols.indexOf(name);

export async function similar(
  eventId: string,
  k = 10,
  opts?: {
    oddsOverride?: CompactOddsRow[] | null;
    bookmakerId?: number | null;
    bookmakerName?: string;
  },
) {
  const S = await load();
  const { matches, cols, norm, weights, vec, dim } = S;
  const iMl = colIdx(cols, "ml_c");
  const iOu = colIdx(cols, "ou_c");
  const bmId = opts?.bookmakerId ?? null;
  const strictBm = bmId != null;

  const archiveIdx = S.index.get(eventId);
  let queryOdds: CompactOddsRow[] | null = opts?.oddsOverride ?? null;

  if (!queryOdds?.length) {
    if (archiveIdx !== undefined) {
      try {
        const rs = await loadRawSeason(matches[archiveIdx].file);
        queryOdds = rs.byId.get(eventId)?.odds ?? null;
      } catch {
        /* arşiv maçı: features.bin yeterli */
      }
    } else {
      queryOdds = await fetchFixtureBOdds(eventId);
    }
  }
  if (archiveIdx === undefined && !queryOdds?.length) {
    return {
      error: "not_in_archive_no_odds",
      message: "This match is not in the R2 archive and has no odds in fixtureb.",
    } as const;
  }

  // 1) Aday bulma: konsensüs (features.bin ile aynı uzay)
  let qCons: Float32Array;
  let consProfile: RawProfile | null = null;
  if (archiveIdx !== undefined && !opts?.oddsOverride?.length) {
    qCons = Float32Array.from(vec.subarray(archiveIdx * dim, archiveIdx * dim + dim));
  } else {
    consProfile = profileFromOdds(queryOdds, null);
    qCons = zVector(consProfile, cols, norm);
  }
  if (qCons.filter((x) => Number.isFinite(x)).length < 2) {
    return {
      error: "odds_features_empty",
      message: "Odds could not be turned into features (ML / AH / O-U markets missing).",
    } as const;
  }

  // 2) BM modu: sorgu BM profili
  let qBm: Float32Array | null = null;
  let qBmProfile: RawProfile | null = null;
  if (strictBm) {
    if (!queryOdds?.some((r) => Number(r[0]) === bmId)) {
      return { error: "no_bm_odds", message: "The selected bookmaker has no odds for this match." } as const;
    }
    qBmProfile = profileFromOdds(queryOdds, bmId);
    qBm = zVector(qBmProfile, cols, norm);
    if (qBm.filter((x) => Number.isFinite(x)).length < 2) {
      return {
        error: "odds_features_empty",
        message: "The selected bookmaker's ML / AH / O-U odds are not enough to build features.",
      } as const;
    }
  }

  const pool = strictBm ? Math.max(k * 40, 600) : Math.max(k * 8, 120);
  const nearest = nearestStored(qCons, S, pool, eventId);

  // 3) Ham sezon dosyalarını yükle
  const files = [...new Set(nearest.map((x) => matches[x.j].file))];
  const errs: string[] = [];
  await Promise.all(
    files.map(async (f) => {
      try {
        await loadRawSeason(f);
      } catch (e: any) {
        errs.push(`${f}: ${e?.message || e}`);
      }
    }),
  );
  if (files.length && errs.length === files.length) {
    throw new Error(`No season file could be loaded (${files.length}). Example: ${errs[0]}`);
  }

  // 4) Hidrasyon + (BM modunda) yeniden sıralama
  const qUse = qBm ?? qCons;
  const qProb = denorm(qUse[iMl], "ml_c", norm);
  const qOu = denorm(qUse[iOu], "ou_c", norm);

  type Scored = Cand & { row: BasketballTableRow };
  const scored: Scored[] = [];
  for (const n of nearest) {
    const m = matches[n.j];
    const rs = rawCache.get(m.file);
    if (!rs) continue;
    const raw = rs.byId.get(m.id);
    const rawOdds: CompactOddsRow[] = raw?.odds ?? [];

    let z: ArrayLike<number>;
    let zOff = 0;
    let distance = n.distance;
    if (strictBm) {
      if (!rawOdds.some((r) => Number(r[0]) === bmId) || !bmHasCore(rawOdds, bmId!)) continue;
      const zb = zVector(profileFromOdds(rawOdds, bmId), cols, norm);
      distance = maskedDistance(qBm!, zb, weights);
      if (distance === Infinity) continue;
      z = zb;
    } else {
      z = vec;
      zOff = n.j * dim;
    }
    const prob = denorm(z[zOff + iMl], "ml_c", norm);
    const ou = denorm(z[zOff + iOu], "ou_c", norm);

    const bm = strictBm ? bmId : defaultBookmaker(rawOdds);
    const snap = marketSnapshot(rawOdds, bm);
    const hsN = m.hs != null && m.hs !== "" ? Number(m.hs) : NaN;
    const asN = m.as != null && m.as !== "" ? Number(m.as) : NaN;
    const ok = Number.isFinite(hsN) && Number.isFinite(asN);
    const { date, time } = formatTs(m.ts);
    const htS = raw?.home_ht_score;
    const atS = raw?.away_ht_score;

    scored.push({
      j: n.j,
      distance,
      prob,
      ou,
      row: {
        ...m,
        src: "archive",
        date,
        time,
        ft: ok ? `${m.hs}-${m.as}` : "-",
        ftRes: ok ? (hsN > asN ? "Home" : "Away") : "-",
        hts: htS != null && htS !== "" ? String(htS) : null,
        ats: atS != null && atS !== "" ? String(atS) : null,
        periods: periodsText(raw?.home_periods, raw?.away_periods),
        total: ok ? hsN + asN : null,
        margin: ok ? hsN - asN : null,
        o1: snap.ml.ho,
        c1: snap.ml.hc,
        o2: snap.ml.ao,
        c2: snap.ml.ac,
        ahLine: snap.ahLine,
        ahH_o: snap.ahH_o,
        ahH_c: snap.ahH_c,
        ahA_o: snap.ahA_o,
        ahA_c: snap.ahA_c,
        ouLine: snap.ouLine,
        ouO_o: snap.ouO_o,
        ouO_c: snap.ouO_c,
        ouU_o: snap.ouU_o,
        ouU_c: snap.ouU_c,
        bmUsed: bm != null ? rs.bookmakers[String(bm)] : undefined,
        distance,
      },
    });
  }

  scored.sort((a, b) => a.distance - b.distance);
  const picked = pickSimilar(scored, {
    qProb,
    qOu,
    steps: strictBm ? OU_STEPS_BM : OU_STEPS_CONSENSUS,
    k,
  });

  if (strictBm && picked.rows.length === 0) {
    return {
      error: "no_matches_for_bookmaker",
      message: `Not enough similar archive matches for the selected bookmaker (${opts?.bookmakerName || bmId}).`,
    } as const;
  }

  return picked.rows.map((r) => ({
    ...r.row,
    tol: picked.tol,
    ouLineTol: picked.ouStep,
    probDiff: qProb != null && r.prob != null ? Number(Math.abs(r.prob - qProb).toFixed(4)) : null,
  }));
}

/* -------------------------------------------------------- arama / detay */

export async function searchMatches(q: string, limit = 20) {
  const { matches, haystack } = await load();
  const terms = fold(q).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const out: BasketballMeta[] = [];
  for (let i = 0; i < matches.length; i++) {
    if (terms.every((t) => haystack[i].includes(t))) out.push(matches[i]);
  }
  return out.sort((a, b) => b.ts - a.ts).slice(0, limit);
}

export async function matchDetail(eventId: string) {
  const { matches, index } = await load();
  const i = index.get(eventId);
  if (i === undefined) return null;
  const rs = await loadRawSeason(matches[i].file);
  const m = rs.byId.get(eventId);
  if (!m) return null;
  const odds = (m.odds ?? []).map(([bid, type, scope, side, opening, current, active]: any[]) => ({
    bookmaker: rs.bookmakers[String(bid)] ?? String(bid),
    type,
    scope,
    side,
    opening: opening === "" || opening == null ? null : Number(opening),
    current: current === "" || current == null ? null : Number(current),
    active: !!active,
  }));
  return { ...matches[i], odds };
}
