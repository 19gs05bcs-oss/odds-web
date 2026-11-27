/**
 * Tenis oran yardımcıları (voleybol sürümünden uyarlandı) — SAF modül (server-only / s3 importu YOK).
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
 * FEATURE_COLS ve hesap kuralları build-tennis-index.ts ile BİREBİR aynı olmalı:
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
  "cs_20", "cs_21", "cs_12", "cs_02",
  "cs_30", "cs_31", "cs_32", "cs_23", "cs_13", "cs_03",
  "sets_over25", "sets_over35", "sets_over45",
  "games_line_open", "games_line_close",
  "ah_games_line_open", "ah_games_line_close",
  "s1_games_line", "s1_ah_line",
  "odd_ft",
] as const;

/** Varsayılan ağırlıklar (z-skor sonrası). meta.weights varsa o kullanılır. */
export const DEFAULT_WEIGHTS: Record<string, number> = {
  ha_ft_open: 1, ha_ft_close: 1, ha_s1_open: 0.7, ha_s1_close: 0.7,
  cs_20: 0.8, cs_21: 0.8, cs_12: 0.8, cs_02: 0.8,
  cs_30: 0.8, cs_31: 0.8, cs_32: 0.8, cs_23: 0.8, cs_13: 0.8, cs_03: 0.8,
  sets_over25: 0.7, sets_over35: 0.7, sets_over45: 0.7,
  games_line_open: 0.8, games_line_close: 0.8,
  ah_games_line_open: 0.8, ah_games_line_close: 0.8,
  s1_games_line: 0.4, s1_ah_line: 0.6,
  odd_ft: 0,
};

export type Norm = Record<string, [number, number]>;
/** kolon adı -> ham (ölçeklenmiş) değer; eksik = null */
export type RawProfile = Record<string, number | null>;

/** Çizgili market (AH: h=ev/a=deplasman, OU: h=over/a=under); açılış + kapanış */
export type LineQuote = {
  line: number | null;
  h_o: number | null;
  h_c: number | null;
  a_o: number | null;
  a_c: number | null;
};

/** Tabloya eklenen ek marketler (tek bookmaker). */
export type ExtraMarkets = {
  /** 1. set kazananı (FIRST_SET HOME_AWAY) */
  s1: { ho: number | null; hc: number | null; ao: number | null; ac: number | null };
  /** SET handikapı (FULL_TIME AH, |çizgi| <= 3) */
  setAh: LineQuote;
  /** SET toplamı (FULL_TIME OU, çizgi < 100; ör. 3.5 / 4.5) */
  setOu: LineQuote;
  /** 1. set sayı handikapı */
  s1Ah: LineQuote;
  /** 1. set toplam sayı */
  s1Ou: LineQuote;
  /** Toplam sayı tek/çift (FULL_TIME) */
  oe: { oo: number | null; oc: number | null; eo: number | null; ec: number | null };
  /** Set skoru doğru skor: "3:1" -> [açılış, kapanış] (ev:deplasman set) */
  cs: Record<string, [number | null, number | null]>;
};

/** Doğru skor kolonları (en çok 5 set); best-of-3 ligler için 2:0 / 2:1 / 0:2 / 1:2 */
export const CS_KEYS = ["3:0", "3:1", "3:2", "2:3", "1:3", "0:3"] as const;
export const CS_KEYS_BO3 = ["2:0", "2:1", "1:2", "0:2"] as const;

export type MarketSnapshot = {
  bmId: number | null;
  x: ExtraMarkets;
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

/** Özellik ölçeği (build-tennis-index.ts ile aynı) */
/** Toplam oyun sayısı ölçeği (tenis) */
export const PTS_CENTER = 22;
export const PTS_SCALE = 4;
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
    const groups: [string[], string[]][] = [
      [["2:0", "2:1", "1:2", "0:2"], ["cs_20", "cs_21", "cs_12", "cs_02"]],
      [["3:0", "3:1", "3:2", "2:3", "1:3", "0:3"], ["cs_30", "cs_31", "cs_32", "cs_23", "cs_13", "cs_03"]],
    ];
    for (const [keys, cols] of groups) {
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
        const sum = keys.reduce((a, k) => a + row[k], 0);
        per.push(Object.fromEntries(keys.map((k) => [k, row[k] / sum])));
      }
      if (per.length) keys.forEach((k, i) => (f[cols[i]] = median(per.map((p) => p[k]))));
    }
  }

  const ou = mk.get("OVER_UNDER|FULL_TIME");
  if (ou) {
    const L = splitOu(ou);
    const sets = filterLines(L, (l) => l < 10);
    const games = filterLines(L, (l) => l >= 10);
    const s25 = sets.get(2.5);
    const s35 = sets.get(3.5);
    const s45 = sets.get(4.5);
    f.sets_over25 = s25 ? pTwo(s25 as unknown as BmSides, "OVER", "UNDER", 1) : null;
    f.sets_over35 = s35 ? pTwo(s35 as unknown as BmSides, "OVER", "UNDER", 1) : null;
    f.sets_over45 = s45 ? pTwo(s45 as unknown as BmSides, "OVER", "UNDER", 1) : null;
    if (games.size) {
      const c = fairLine(games, 1, "ou");
      const o = fairLine(games, 0, "ou");
      f.games_line_close = c == null ? null : (c - PTS_CENTER) / PTS_SCALE;
      f.games_line_open = o == null ? null : (o - PTS_CENTER) / PTS_SCALE;
    }
  }

  // Oyun handikapı: |çizgi| >= 2.5 (±1.5 set handikapı ile karışabildiği için dışarıda)
  const ah = mk.get("ASIAN_HANDICAP|FULL_TIME");
  if (ah) {
    const games = filterLines(splitAh(ah), (l) => Math.abs(l) >= 2.5);
    if (games.size) {
      const c = fairLine(games, 1, "ah");
      const o = fairLine(games, 0, "ah");
      f.ah_games_line_close = c == null ? null : c / 6;
      f.ah_games_line_open = o == null ? null : o / 6;
    }
  }

  const o1 = mk.get("OVER_UNDER|FIRST_SET");
  if (o1) {
    const L = splitOu(o1);
    if (L.size) {
      const v = fairLine(L, 1, "ou");
      f.s1_games_line = v == null ? null : (v - 10) / 2;
    }
  }
  const a1 = mk.get("ASIAN_HANDICAP|FIRST_SET");
  if (a1) {
    const L = splitAh(a1);
    if (L.size) {
      const v = fairLine(L, 1, "ah");
      f.s1_ah_line = v == null ? null : v / 2;
    }
  }

  f.odd_ft = pTwo(mk.get("ODD_OR_EVEN|FULL_TIME"), "sel:ODD", "sel:EVEN", 1);
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
type LineSpec = {
  type: "ASIAN_HANDICAP" | "OVER_UNDER";
  scope: string;
  /** ev perspektifli handikap çizgisi / baraj için filtre */
  keep: (line: number) => boolean;
};

/** Ana tablo: FT sayı handikapı (|çizgi|>3) ve FT sayı toplamı (>=100) */
const specFor = (type: "ASIAN_HANDICAP" | "OVER_UNDER"): LineSpec => ({
  type,
  scope: "FULL_TIME",
  keep: type === "ASIAN_HANDICAP" ? (l) => Math.abs(l) >= 2.5 : (l) => l >= 10,
});

const SPEC_SET_AH: LineSpec = { type: "ASIAN_HANDICAP", scope: "FULL_TIME", keep: (l) => Math.abs(l) <= 2 };
const SPEC_SET_OU: LineSpec = { type: "OVER_UNDER", scope: "FULL_TIME", keep: (l) => l < 10 };
const SPEC_S1_AH: LineSpec = { type: "ASIAN_HANDICAP", scope: "FIRST_SET", keep: () => true };
const SPEC_S1_OU: LineSpec = { type: "OVER_UNDER", scope: "FIRST_SET", keep: () => true };

function rowLines(rows: CompactOddsRow[], type: "ASIAN_HANDICAP" | "OVER_UNDER"): Map<number, LinePair> {
  return rowLinesBy(rows, specFor(type));
}

function rowLinesBy(rows: CompactOddsRow[], spec: LineSpec): Map<number, LinePair> {
  const type = spec.type;
  const out = new Map<number, LinePair>();
  for (const r of rows) {
    if (up(r[1]) !== type || up(r[2]) !== spec.scope) continue;
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
    } else {
      if (K !== "OVER" && K !== "UNDER") continue;
      line = v;
      first = K === "OVER";
    }
    if (!spec.keep(line)) continue;
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

const emptyLine = (): LineQuote => ({ line: null, h_o: null, h_c: null, a_o: null, a_c: null });

export const emptyExtra = (): ExtraMarkets => ({
  s1: { ho: null, hc: null, ao: null, ac: null },
  setAh: emptyLine(),
  setOu: emptyLine(),
  s1Ah: emptyLine(),
  s1Ou: emptyLine(),
  oe: { oo: null, oc: null, eo: null, ec: null },
  cs: {},
});

function lineQuote(rows: CompactOddsRow[], spec: LineSpec): LineQuote {
  const b = balanced(rowLinesBy(rows, spec));
  if (!b) return emptyLine();
  return {
    line: b.line,
    h_o: b.pair.h ? openOf(b.pair.h) : null,
    h_c: b.pair.h ? closeOf(b.pair.h) : null,
    a_o: b.pair.a ? openOf(b.pair.a) : null,
    a_c: b.pair.a ? closeOf(b.pair.a) : null,
  };
}

/** Tek bookmaker satırlarından ek marketler (1. set, set AH/OU, 1. set AH/OU, tek/çift, doğru skor). */
export function extraMarkets(rows: CompactOddsRow[]): ExtraMarkets {
  const x = emptyExtra();
  for (const r of rows) {
    const t = up(r[1]);
    const sc = up(r[2]);
    const side = up(r[3]);
    if (t === "HOME_AWAY" && sc === "FIRST_SET") {
      if (side === "H") [x.s1.ho, x.s1.hc] = [openOf(r), closeOf(r)];
      else if (side === "A") [x.s1.ao, x.s1.ac] = [openOf(r), closeOf(r)];
    } else if (t === "ODD_OR_EVEN" && sc === "FULL_TIME") {
      if (side === "SEL:ODD") [x.oe.oo, x.oe.oc] = [openOf(r), closeOf(r)];
      else if (side === "SEL:EVEN") [x.oe.eo, x.oe.ec] = [openOf(r), closeOf(r)];
    } else if (t === "CORRECT_SCORE" && (sc === "FULL_TIME" || sc === "")) {
      // side = "SCORE:3:1" (ev:deplasman set)
      const m = /^SCORE:(\d+):(\d+)$/.exec(side);
      if (m) x.cs[`${m[1]}:${m[2]}`] = [openOf(r), closeOf(r)];
    }
  }
  x.setAh = lineQuote(rows, SPEC_SET_AH);
  x.setOu = lineQuote(rows, SPEC_SET_OU);
  x.s1Ah = lineQuote(rows, SPEC_S1_AH);
  x.s1Ou = lineQuote(rows, SPEC_S1_OU);
  return x;
}

export function marketSnapshot(
  odds: CompactOddsRow[] | null | undefined,
  bookmakerId: number | null,
): MarketSnapshot {
  const empty: MarketSnapshot = {
    bmId: bookmakerId,
    x: emptyExtra(),
    ml: { ho: null, hc: null, ao: null, ac: null },
    ahLine: null, ahH_o: null, ahH_c: null, ahA_o: null, ahA_c: null,
    ouLine: null, ouO_o: null, ouO_c: null, ouU_o: null, ouU_c: null,
  };
  if (!Array.isArray(odds) || !odds.length || bookmakerId == null) return empty;
  const rows = odds.filter((r) => Number(r[0]) === bookmakerId);
  if (!rows.length) return empty;
  const out: MarketSnapshot = { ...empty, ml: { ...empty.ml }, x: extraMarkets(rows) };

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

/** Maçta en çok (FT + 1. set) market satırı olan bookmaker; FT maç kazananı olanlar tercih edilir. */
export function defaultBookmaker(odds: CompactOddsRow[] | null | undefined): number | null {
  if (!Array.isArray(odds) || !odds.length) return null;
  const TYPES = new Set(["HOME_AWAY", "ASIAN_HANDICAP", "OVER_UNDER", "ODD_OR_EVEN", "CORRECT_SCORE"]);
  const score = new Map<number, number>();
  for (const r of odds) {
    const sc = up(r[2]);
    if (sc !== "FULL_TIME" && sc !== "FIRST_SET") continue;
    if (!TYPES.has(up(r[1]))) continue;
    const bm = Number(r[0]);
    score.set(bm, (score.get(bm) ?? 0) + 1);
  }
  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]);
  const core = ranked.find(([bm]) => bmHasCore(odds, bm));
  return (core ?? ranked[0])?.[0] ?? null;
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
