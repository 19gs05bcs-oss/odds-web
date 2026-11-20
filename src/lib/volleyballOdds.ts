/**
 * Voleybol oran yardımcıları — SAF modül (server-only / s3 importu YOK).
 * Hem sunucu (volleyball.ts) hem istemci (VolleyballPanel.tsx) kullanır.
 *
 * Satır formatı (fixturev.odds ve R2 sezon dosyaları aynı):
 *   [bookmakerId, bettingType, bettingScope, side, opening, current, active]
 *   HOME_AWAY       : side = H | A                       scope FULL_TIME | FIRST_SET
 *   OVER_UNDER      : side = OVER:180.5 | UNDER:180.5    FULL_TIME'da hem SET (3.5/4.5) hem PUAN (~180) çizgileri
 *   ASIAN_HANDICAP  : side = H:-1.5 | A:1.5              FULL_TIME'da hem SET (±1.5/2.5) hem PUAN (±11..29) çizgileri
 *   CORRECT_SCORE   : side = score:3:1                   (set skoru)
 *   ODD_OR_EVEN     : side = sel:ODD | sel:EVEN
 *
 * FEATURE_COLS ve hesap kuralları build_features_volleyball.py ile BİREBİR aynı olmalı:
 *   marjsız olasılık, bookmaker medyanı, "adil çizgi" (P=0.5 enterpolasyonu), aynı ölçekler.
 */

export type CompactOddsRow = [
  bookmakerId: number,
  bettingType: string,
  bettingScope: string,
  side: string,
  opening: number | string | null,
  current: number | string | null,
  active?: boolean,
];

export const FEATURE_COLS = [
  "ha_ft_open", "ha_ft_close", "ha_s1_open", "ha_s1_close",
  "cs_30", "cs_31", "cs_32", "cs_23", "cs_13", "cs_03",
  "sets_over35", "sets_over45",
  "pts_line_open", "pts_line_close",
  "ah_sets_line",
  "ah_pts_line_open", "ah_pts_line_close",
  "s1_line", "s1_ah_line",
  "odd_ft", "odd_s1",
] as const;

/** Varsayılan ağırlıklar (z-skor sonrası). meta.weights varsa o kullanılır. odd_* bilgi taşımadığı için 0. */
export const DEFAULT_WEIGHTS: Record<string, number> = {
  ha_ft_open: 1, ha_ft_close: 1, ha_s1_open: 0.7, ha_s1_close: 0.7,
  cs_30: 0.8, cs_31: 0.8, cs_32: 0.8, cs_23: 0.8, cs_13: 0.8, cs_03: 0.8,
  sets_over35: 0.7, sets_over45: 0.7,
  pts_line_open: 0.8, pts_line_close: 0.8,
  ah_sets_line: 1,
  ah_pts_line_open: 0.8, ah_pts_line_close: 0.8,
  s1_line: 0.4, s1_ah_line: 0.6,
  odd_ft: 0, odd_s1: 0,
};

export type Norm = Record<string, [number, number]>;
/** kolon adı -> ham (ölçeklenmiş) değer; eksik = null */
export type RawProfile = Record<string, number | null>;

export type MarketSnapshot = {
  bmId: number | null;
  ml: { ho: number | null; hc: number | null; ao: number | null; ac: number | null };
  /** puan handikapı (ev perspektifi) */
  ahLine: number | null;
  ahH_o: number | null;
  ahH_c: number | null;
  ahA_o: number | null;
  ahA_c: number | null;
  /** puan toplamı */
  ouLine: number | null;
  ouO_o: number | null;
  ouO_c: number | null;
  ouU_o: number | null;
  ouU_c: number | null;
};

/** Özellik ölçeği (build_features_volleyball.py ile aynı) */
export const PTS_CENTER = 180;
export const PTS_SCALE = 25;
export const ptsFromRaw = (x: number | null) => (x == null ? null : x * PTS_SCALE + PTS_CENTER);

const up = (x: unknown) => String(x ?? "").toUpperCase();
/** Python fl(): >1.0 geçerli oran, aksi halde null */
const odd = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 1 ? n : null;
};

export function median(xs: (number | null | undefined)[]): number | null {
  const a = xs.filter((x): x is number => x != null && Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

const norm2 = (a: number, b: number) => 1 / a / (1 / a + 1 / b);

/* ------------------------------------------------------------------ toplama */

type OC = [number, number]; // [açılış, kapanış]
type BmSides = Map<number, Map<string, OC>>; // bookmaker -> side -> [o,c]

/** (type,scope) -> bookmaker -> side -> [open, close]; Python collect() ile aynı (iki oran da geçerli olmalı) */
function collect(rows: CompactOddsRow[]): Map<string, BmSides> {
  const mk = new Map<string, BmSides>();
  for (const r of rows) {
    const o = odd(r[4]);
    const c = odd(r[5]);
    if (o == null || c == null) continue;
    const key = `${r[1]}|${r[2]}`;
    let bms = mk.get(key);
    if (!bms) mk.set(key, (bms = new Map()));
    const bid = Number(r[0]);
    let d = bms.get(bid);
    if (!d) bms.set(bid, (d = new Map()));
    d.set(String(r[3]), [o, c]);
  }
  return mk;
}

function pTwo(bms: BmSides | undefined, s1: string, s2: string, idx: 0 | 1): number | null {
  if (!bms) return null;
  const out: number[] = [];
  for (const d of bms.values()) {
    const a = d.get(s1);
    const b = d.get(s2);
    if (a && b) out.push(norm2(a[idx], b[idx]));
  }
  return median(out);
}

type Lines = Map<number, BmSides>; // çizgi -> bookmaker -> {OVER/UNDER | H/A}

function splitOu(bms: BmSides): Lines {
  const out: Lines = new Map();
  for (const [bid, d] of bms) {
    for (const [side, v] of d) {
      const i = side.indexOf(":");
      if (i < 0) continue;
      const k = side.slice(0, i);
      if (k !== "OVER" && k !== "UNDER") continue;
      const line = Number(side.slice(i + 1));
      if (!Number.isFinite(line)) continue;
      let lb = out.get(line);
      if (!lb) out.set(line, (lb = new Map()));
      let dd = lb.get(bid);
      if (!dd) lb.set(bid, (dd = new Map()));
      dd.set(k, v);
    }
  }
  return out;
}

function splitAh(bms: BmSides): Lines {
  const out: Lines = new Map();
  for (const [bid, d] of bms) {
    for (const [side, v] of d) {
      const i = side.indexOf(":");
      if (i < 0) continue;
      const s = side.slice(0, i);
      if (s !== "H" && s !== "A") continue;
      const x = Number(side.slice(i + 1));
      if (!Number.isFinite(x) || Math.abs(x) > 40) continue; // -999 gibi geçersizler
      const line = s === "H" ? x : -x; // ev perspektifi
      let lb = out.get(line);
      if (!lb) out.set(line, (lb = new Map()));
      let dd = lb.get(bid);
      if (!dd) lb.set(bid, (dd = new Map()));
      dd.set(s, v);
    }
  }
  return out;
}

const filterLines = (L: Lines, keep: (line: number) => boolean): Lines =>
  new Map([...L].filter(([line]) => keep(line)));

/** Her bookmaker için çizgiler arasında P=0.5 noktasını enterpole et, bookmaker medyanı (Python fair_line). */
function fairLine(lines: Lines, idx: 0 | 1, kind: "ou" | "ah"): number | null {
  const per = new Map<number, [number, number][]>();
  for (const [line, bms] of lines) {
    for (const [bid, d] of bms) {
      let p: number | null = null;
      if (kind === "ou") {
        const a = d.get("OVER");
        const b = d.get("UNDER");
        if (a && b) p = norm2(a[idx], b[idx]);
      } else {
        const a = d.get("H");
        const b = d.get("A");
        if (a && b) p = norm2(a[idx], b[idx]);
      }
      if (p == null) continue;
      let arr = per.get(bid);
      if (!arr) per.set(bid, (arr = []));
      arr.push([line, p]);
    }
  }
  const out: number[] = [];
  for (const pts of per.values()) {
    pts.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    if (pts.length === 1) {
      out.push(pts[0][0]);
      continue;
    }
    let hit: number | null = null;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [l1, p1] = pts[i];
      const [l2, p2] = pts[i + 1];
      const lo = Math.min(p1, p2);
      const hi = Math.max(p1, p2);
      if (lo <= 0.5 && 0.5 <= hi && p1 !== p2) {
        hit = l1 + ((0.5 - p1) * (l2 - l1)) / (p2 - p1);
        break;
      }
    }
    if (hit == null) {
      let best = pts[0];
      for (const x of pts) if (Math.abs(x[1] - 0.5) < Math.abs(best[1] - 0.5)) best = x;
      hit = best[0];
    }
    out.push(hit);
  }
  return median(out);
}

/* --------------------------------------------------------------- profil */

/**
 * Ham oran satırlarından özellik profili (Python features() ile aynı).
 * bookmakerId verilirse yalnızca o bookmaker'ın satırları kullanılır (BM profili).
 * Eksik bileşen = null.
 */
export function profileFromOdds(
  odds: CompactOddsRow[] | null | undefined,
  bookmakerId?: number | null,
): RawProfile {
  const f: RawProfile = {};
  for (const c of FEATURE_COLS) f[c] = null;
  if (!Array.isArray(odds) || !odds.length) return f;
  const rows = bookmakerId != null ? odds.filter((r) => Number(r[0]) === bookmakerId) : odds;
  if (!rows.length) return f;
  const mk = collect(rows);

  const ha = mk.get("HOME_AWAY|FULL_TIME");
  f.ha_ft_open = pTwo(ha, "H", "A", 0);
  f.ha_ft_close = pTwo(ha, "H", "A", 1);
  const h1 = mk.get("HOME_AWAY|FIRST_SET");
  f.ha_s1_open = pTwo(h1, "H", "A", 0);
  f.ha_s1_close = pTwo(h1, "H", "A", 1);

  const cs = mk.get("CORRECT_SCORE|FULL_TIME");
  if (cs) {
    const keys = ["3:0", "3:1", "3:2", "2:3", "1:3", "0:3"];
    const cols = ["cs_30", "cs_31", "cs_32", "cs_23", "cs_13", "cs_03"];
    const per: Record<string, number>[] = [];
    for (const d of cs.values()) {
      const row: Record<string, number> = {};
      let ok = true;
      for (const k of keys) {
        const v = d.get("score:" + k);
        if (!v) {
          ok = false;
          break;
        }
        row[k] = 1 / v[1];
      }
      if (!ok) continue;
      const s = keys.reduce((a, k) => a + row[k], 0);
      per.push(Object.fromEntries(keys.map((k) => [k, row[k] / s])));
    }
    keys.forEach((k, i) => (f[cols[i]] = median(per.map((p) => p[k]))));
  }

  const ou = mk.get("OVER_UNDER|FULL_TIME");
  if (ou) {
    const L = splitOu(ou);
    const sets = filterLines(L, (l) => l < 20);
    const pts = filterLines(L, (l) => l >= 100);
    const s35 = sets.get(3.5);
    const s45 = sets.get(4.5);
    f.sets_over35 = s35 ? pTwo(s35 as unknown as BmSides, "OVER", "UNDER", 1) : null;
    f.sets_over45 = s45 ? pTwo(s45 as unknown as BmSides, "OVER", "UNDER", 1) : null;
    if (pts.size) {
      const c = fairLine(pts, 1, "ou");
      const o = fairLine(pts, 0, "ou");
      f.pts_line_close = c == null ? null : (c - PTS_CENTER) / PTS_SCALE;
      f.pts_line_open = o == null ? null : (o - PTS_CENTER) / PTS_SCALE;
    }
  }

  const ah = mk.get("ASIAN_HANDICAP|FULL_TIME");
  if (ah) {
    const L = splitAh(ah);
    const sets = filterLines(L, (l) => Math.abs(l) <= 3);
    const pts = filterLines(L, (l) => Math.abs(l) > 3);
    if (sets.size) {
      const v = fairLine(sets, 1, "ah");
      f.ah_sets_line = v == null ? null : v / 2.5;
    }
    if (pts.size) {
      const c = fairLine(pts, 1, "ah");
      const o = fairLine(pts, 0, "ah");
      f.ah_pts_line_close = c == null ? null : c / 15;
      f.ah_pts_line_open = o == null ? null : o / 15;
    }
  }

  const o1 = mk.get("OVER_UNDER|FIRST_SET");
  if (o1) {
    const L = splitOu(o1);
    if (L.size) {
      const v = fairLine(L, 1, "ou");
      f.s1_line = v == null ? null : (v - 45) / 5;
    }
  }
  const a1 = mk.get("ASIAN_HANDICAP|FIRST_SET");
  if (a1) {
    const L = splitAh(a1);
    if (L.size) {
      const v = fairLine(L, 1, "ah");
      f.s1_ah_line = v == null ? null : v / 5;
    }
  }

  f.odd_ft = pTwo(mk.get("ODD_OR_EVEN|FULL_TIME"), "sel:ODD", "sel:EVEN", 1);
  f.odd_s1 = pTwo(mk.get("ODD_OR_EVEN|FIRST_SET"), "sel:ODD", "sel:EVEN", 1);
  return f;
}

/** Profil -> z-skor vektörü (norm: [ortalama, std]). Eksik veya sabit kolon = NaN. */
export function zVector(p: RawProfile, cols: readonly string[], norm: Norm): Float32Array {
  const out = new Float32Array(cols.length);
  cols.forEach((c, i) => {
    const v = p[c];
    const n = norm[c];
    out[i] = v == null || !n || !(n[1] > 1e-6) ? NaN : (v - n[0]) / n[1];
  });
  return out;
}

/** z -> ham değer */
export function denorm(z: number, col: string, norm: Norm): number | null {
  const n = norm[col];
  return Number.isFinite(z) && n ? z * n[1] + n[0] : null;
}

/** Eksik bileşenleri atlayan ağırlıklı öklid mesafesi. */
export function maskedDistance(
  q: ArrayLike<number>,
  v: ArrayLike<number>,
  w: ArrayLike<number>,
  vOff = 0,
): number {
  let d = 0;
  let n = 0;
  for (let c = 0; c < w.length; c++) {
    if (!(w[c] > 0)) continue;
    const a = q[c];
    const b = v[vOff + c];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const t = (a - b) * w[c];
    d += t * t;
    n++;
  }
  return n >= 2 ? Math.sqrt(d) : Infinity;
}

/* ---------------------------------------------------- tablo / fikstür */

const closeOf = (r: CompactOddsRow) => odd(r[5]) ?? odd(r[4]);
const openOf = (r: CompactOddsRow) => odd(r[4]) ?? odd(r[5]);

type LinePair = { h: CompactOddsRow | null; a: CompactOddsRow | null };

function pairProb(p: LinePair): number | null {
  if (!p.h || !p.a) return null;
  const a = closeOf(p.h);
  const b = closeOf(p.a);
  return a == null || b == null ? null : norm2(a, b);
}

/** Bir bookmaker'ın puan çizgileri: ev handikap çizgisi | baraj -> satır çifti */
function rowLines(
  rows: CompactOddsRow[],
  type: "ASIAN_HANDICAP" | "OVER_UNDER",
): Map<number, LinePair> {
  const out = new Map<number, LinePair>();
  for (const r of rows) {
    if (up(r[1]) !== type || up(r[2]) !== "FULL_TIME") continue;
    const side = String(r[3] ?? "");
    const i = side.indexOf(":");
    if (i < 0) continue;
    const K = side.slice(0, i).toUpperCase();
    const v = Number(side.slice(i + 1));
    if (!Number.isFinite(v)) continue;
    let line: number;
    let first: boolean;
    if (type === "ASIAN_HANDICAP") {
      if (K !== "H" && K !== "A") continue;
      if (Math.abs(v) > 40) continue;
      line = K === "H" ? v : -v;
      first = K === "H";
      if (Math.abs(line) <= 3) continue; // set handikapı: tabloda değil
    } else {
      if (K !== "OVER" && K !== "UNDER") continue;
      line = v;
      first = K === "OVER";
      if (line < 100) continue; // set toplamı: tabloda değil
    }
    let p = out.get(line);
    if (!p) out.set(line, (p = { h: null, a: null }));
    if (first) p.h = r;
    else p.a = r;
  }
  return out;
}

function balanced(byLine: Map<number, LinePair>): { line: number; pair: LinePair } | null {
  let best: { line: number; pair: LinePair; dev: number } | null = null;
  for (const [line, pair] of byLine) {
    const p = pairProb(pair);
    if (p == null) continue;
    const dev = Math.abs(p - 0.5);
    if (!best || dev < best.dev - 1e-9 || (Math.abs(dev - best.dev) <= 1e-9 && line < best.line)) {
      best = { line, pair, dev };
    }
  }
  return best;
}

export function marketSnapshot(
  odds: CompactOddsRow[] | null | undefined,
  bookmakerId: number | null,
): MarketSnapshot {
  const empty: MarketSnapshot = {
    bmId: bookmakerId,
    ml: { ho: null, hc: null, ao: null, ac: null },
    ahLine: null, ahH_o: null, ahH_c: null, ahA_o: null, ahA_c: null,
    ouLine: null, ouO_o: null, ouO_c: null, ouU_o: null, ouU_c: null,
  };
  if (!Array.isArray(odds) || !odds.length || bookmakerId == null) return empty;
  const rows = odds.filter((r) => Number(r[0]) === bookmakerId);
  if (!rows.length) return empty;
  const out: MarketSnapshot = { ...empty, ml: { ...empty.ml } };

  for (const r of rows) {
    if (up(r[1]) !== "HOME_AWAY" || up(r[2]) !== "FULL_TIME") continue;
    const s = up(r[3]);
    if (s === "H") {
      out.ml.ho = openOf(r);
      out.ml.hc = closeOf(r);
    } else if (s === "A") {
      out.ml.ao = openOf(r);
      out.ml.ac = closeOf(r);
    }
  }
  const ah = balanced(rowLines(rows, "ASIAN_HANDICAP"));
  if (ah) {
    out.ahLine = ah.line;
    if (ah.pair.h) [out.ahH_o, out.ahH_c] = [openOf(ah.pair.h), closeOf(ah.pair.h)];
    if (ah.pair.a) [out.ahA_o, out.ahA_c] = [openOf(ah.pair.a), closeOf(ah.pair.a)];
  }
  const ou = balanced(rowLines(rows, "OVER_UNDER"));
  if (ou) {
    out.ouLine = ou.line;
    if (ou.pair.h) [out.ouO_o, out.ouO_c] = [openOf(ou.pair.h), closeOf(ou.pair.h)];
    if (ou.pair.a) [out.ouU_o, out.ouU_c] = [openOf(ou.pair.a), closeOf(ou.pair.a)];
  }
  return out;
}

/** Maçta en çok FT ana-market satırı (ML + AH + OU) olan bookmaker. */
export function defaultBookmaker(odds: CompactOddsRow[] | null | undefined): number | null {
  if (!Array.isArray(odds) || !odds.length) return null;
  const score = new Map<number, number>();
  for (const r of odds) {
    if (up(r[2]) !== "FULL_TIME") continue;
    const t = up(r[1]);
    if (t !== "HOME_AWAY" && t !== "ASIAN_HANDICAP" && t !== "OVER_UNDER") continue;
    const bm = Number(r[0]);
    score.set(bm, (score.get(bm) ?? 0) + 1);
  }
  let best: number | null = null;
  let bn = -1;
  for (const [bm, n] of score) if (n > bn) [best, bn] = [bm, n];
  return best;
}

/** Bu bookmaker maç kazananı (FT HOME_AWAY) oranı veriyor mu? Benzerlik için asgari koşul. */
export function bmHasCore(odds: CompactOddsRow[] | null | undefined, bm: number): boolean {
  const p = profileFromOdds(odds, bm);
  return p.ha_ft_close != null;
}

/** "25,31,25" + "23,29,21" -> toplam puanlar */
export function periodPoints(h: unknown, a: unknown): { ph: number; pa: number; sets: number } | null {
  const hs = String(h ?? "").split(",").filter(Boolean).map(Number);
  const as = String(a ?? "").split(",").filter(Boolean).map(Number);
  if (!hs.length || hs.length !== as.length || [...hs, ...as].some((x) => !Number.isFinite(x))) return null;
  return { ph: hs.reduce((x, y) => x + y, 0), pa: as.reduce((x, y) => x + y, 0), sets: hs.length };
}
