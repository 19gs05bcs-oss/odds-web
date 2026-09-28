/**
 * Saf/DB'siz yardımcılar — super_radar_v23.py'deki `extract_h2h_form`,
 * `vector_distance` ve 888 M6 KNN (k=5) ikiz teyidinin BİREBİR TS portu.
 * Hem client (anatomyEngine) hem server (market-detect route) import eder.
 */

export type H2hForm = {
  lambdaForm: number; // zaman ağırlıklı son maç toplam gol ortalaması
  gamma: number; // formun sentez lambdaya etki payı (maks 0.30)
  n: number;
  wSum: number;
};

const XI = 0.00385; // ~180 gün yarı ömür (Dixon-Coles zaman ağırlığı)
const MAX_AGE_DAYS = 1095; // 3 yıldan eski maçlar sıfırlanır

export function extractH2hForm(h2hRaw: unknown, kickoffTs: number | null | undefined): H2hForm | null {
  if (!h2hRaw) return null;
  let data: unknown = h2hRaw;
  if (typeof h2hRaw === "string") {
    try {
      data = JSON.parse(h2hRaw);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const matches = (data as { matches?: unknown }).matches;
  if (!Array.isArray(matches) || !matches.length) return null;

  const refTs = kickoffTs && Number.isFinite(kickoffTs) ? kickoffTs : Date.now() / 1000;

  const valid = (matches as Array<{ ts?: unknown; s?: unknown }>)
    .map((m) => ({ ts: Number(m?.ts), s: String(m?.s ?? "").trim() }))
    .filter((m) => Number.isFinite(m.ts) && m.ts > 0 && m.ts < refTs)
    .sort((a, b) => b.ts - a.ts);
  const recent = valid.slice(0, 5);
  if (!recent.length) return null;

  let weighted = 0;
  let wSum = 0;
  for (const m of recent) {
    const daysAgo = Math.max(0, (refTs - m.ts) / 86400);
    if (daysAgo > MAX_AGE_DAYS) continue;
    const parts = m.s.split("-");
    if (parts.length !== 2) continue;
    const a = Number(parts[0]);
    const b = Number(parts[1]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const w = Math.exp(-XI * daysAgo);
    weighted += (a + b) * w;
    wSum += w;
  }
  if (wSum < 0.3) return null;
  return {
    lambdaForm: Math.round((weighted / wSum) * 100) / 100,
    gamma: Math.min(0.3, Math.round((wSum / 5) * 100) / 100),
    n: recent.length,
    wSum: Math.round(wSum * 100) / 100,
  };
}

// ---------------------------------------------------------------------------
// 888 M6 ikiz bankası (match_feature_codes) — KNN
// ---------------------------------------------------------------------------

export type TwinFeatures = {
  fav: number;
  dog: number;
  dna: number; // opening U2.5 - O2.5
  o25: number;
  o35: number;
  o45: number;
  htO15: number;
};

export type BankRow = TwinFeatures & { tot: number; score: string };

export type TwinRef = { score: string; tot: number; dist: number };

export type TwinResult = {
  simPct: number;
  k: number;
  bankSize: number;
  twinO35: number; // top-k içinde 4+ gol
  twinO55: number; // top-k içinde 6+ gol
  twinU25: number; // top-k içinde <3 gol
  top: TwinRef[];
};

export function vectorDistance(a: TwinFeatures, b: TwinFeatures): number {
  const wFav = ((a.fav - b.fav) / 1.5) ** 2;
  const wDog = ((Math.min(12, a.dog) - Math.min(12, b.dog)) / 4.0) ** 2;
  const wDna = ((a.dna - b.dna) / 1.0) ** 2;
  const wO25 = ((a.o25 - b.o25) / 0.5) ** 2;
  const wO35 = ((a.o35 - b.o35) / 1.0) ** 2;
  const wO45 = ((Math.min(6, a.o45) - Math.min(6, b.o45)) / 1.5) ** 2;
  const wHt = ((Math.min(5, a.htO15) - Math.min(5, b.htO15)) / 1.0) ** 2;
  return Math.sqrt(
    wFav * 2.5 + wDog * 1.0 + wDna * 3.0 + wO25 * 2.0 + wO35 * 2.0 + wO45 * 1.5 + wHt * 1.5,
  );
}

export function knnTwins(f: TwinFeatures, bank: BankRow[], k = 5): TwinResult | null {
  if (bank.length < k) return null;
  const ranked = bank
    .map((r) => ({ d: vectorDistance(f, r), r }))
    .sort((x, y) => x.d - y.d)
    .slice(0, k);
  const avg = ranked.reduce((s, x) => s + x.d, 0) / k;
  return {
    simPct: Math.max(0, 100 - avg * 35),
    k,
    bankSize: bank.length,
    twinO35: ranked.filter((x) => x.r.tot >= 4).length,
    twinO55: ranked.filter((x) => x.r.tot >= 6).length,
    twinU25: ranked.filter((x) => x.r.tot < 3).length,
    top: ranked.map((x) => ({ score: x.r.score, tot: x.r.tot, dist: Math.round(x.d * 100) / 100 })),
  };
}
