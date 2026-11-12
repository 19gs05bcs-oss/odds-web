import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { gunzipSync } from "zlib";

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
    await (await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))).Body!.transformToByteArray()
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

type Store = {
  matches: HandballMeta[];
  dim: number;
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

// Benzerlik verisi: bir kez indirilir, bellekte tutulur
let cache: Promise<Store> | null = null;
const load = () =>
  (cache ??= (async () => {
    const [m, b] = await Promise.all([get("meta.v2.json"), get("features.v2.bin")]);
    const meta = JSON.parse(m.toString());
    const matches = meta.matches as HandballMeta[];
    const vec = new Float32Array(new Uint8Array(b).buffer); // kopya: hizalama güvenli
    const index = new Map<string, number>(matches.map((x, i) => [x.id, i]));
    const haystack = matches.map((x) => fold(`${x.home} ${x.away} ${x.season}`));
    return { matches, dim: meta.dim as number, vec, index, haystack };
  })().catch((e) => {
    cache = null;
    throw e;
  }));

const hasScore = (m: HandballMeta) =>
  m.hs != null && m.hs !== "" && m.as != null && m.as !== "";

export async function similar(eventId: string, k = 10) {
  const { matches, dim: D, vec, index } = await load();
  const i = index.get(eventId);
  if (i === undefined) return null;
  const sc: [number, number][] = [];
  for (let j = 0; j < matches.length; j++) {
    if (j === i || !hasScore(matches[j])) continue;
    let d = 0;
    for (let c = 0; c < D; c++) {
      const t = vec[i * D + c] - vec[j * D + c];
      d += t * t;
    }
    sc.push([d, j]);
  }
  sc.sort((a, b) => a[0] - b[0]);
  return sc.slice(0, k).map(([d, j]) => ({ ...matches[j], distance: Math.sqrt(d) }));
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
