/**
 * Basketbol oran yardımcıları — SAF modül (server-only / s3 importu YOK).
 * Hem sunucu (basketball.ts) hem istemci (BasketballPanel.tsx) kullanır.
 *
 * Satır formatı (fixtureb.odds ve R2 sezon dosyaları aynı):
 *   [bookmakerId, bettingType, bettingScope, side, opening, current, active]
 *   HOME_AWAY            : side = H | A
 *   ASIAN_HANDICAP       : side = H:-3.5 | A:3.5   (çizgi ev sahibi açısından, A tarafı -çizgi)
 *   OVER_UNDER           : side = OVER:165.5 | UNDER:165.5
 *   scope                : FULL_TIME_OVER_TIME (uzatma dahil) | FULL_TIME
 *
 * Feature kuralı (meta.json scope_rule ile aynı):
 *   AH / O-U / ML için FULL_TIME_OVER_TIME varsa o, yoksa FULL_TIME;
 *   ana çizgi = ev/üst olasılığı 0.5'e en yakın çizgi (vig-free);
 *   konsensüs = bookmaker medyanı.
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

export const FEATURE_COLS = ["ml_c", "ah_c", "ou_c", "ahP_c", "ouP_c"] as const;

export type Norm = Record<string, [number, number]>;

export type RawProfile = {
  /** ev sahibi kazanma olasılığı (vig-free, kapanış) */
  ml: number | null;
  /** ana AH çizgisi (ev sahibi açısından) */
  ahLine: number | null;
  /** o çizgide ev sahibi olasılığı (vig-free) */
  ahP: number | null;
  /** ana toplam barajı */
  ouLine: number | null;
  /** o barajda over olasılığı (vig-free) */
  ouP: number | null;
};

export type MarketSnapshot = {
  bmId: number | null;
  ml: { ho: number | null; hc: number | null; ao: number | null; ac: number | null };
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
};

const up = (x: unknown) => String(x ?? "").toUpperCase();
const odd = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 1 ? n : null;
};
const closeOf = (r: CompactOddsRow) => odd(r[5]) ?? odd(r[4]);
const openOf = (r: CompactOddsRow) => odd(r[4]) ?? odd(r[5]);

const T_ML = new Set(["HOME_AWAY"]);
const T_AH = new Set(["ASIAN_HANDICAP"]);
const T_OU = new Set(["OVER_UNDER"]);

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** Bu market için kullanılacak scope: FULL_TIME_OVER_TIME varsa o, yoksa FULL_TIME. */
function pickScope(rows: CompactOddsRow[], types: Set<string>): string | null {
  let hasFtot = false;
  let hasFt = false;
  for (const r of rows) {
    if (!types.has(up(r[1]))) continue;
    const s = up(r[2]);
    if (s === "FULL_TIME_OVER_TIME") hasFtot = true;
    else if (s === "FULL_TIME") hasFt = true;
  }
  return hasFtot ? "FULL_TIME_OVER_TIME" : hasFt ? "FULL_TIME" : null;
}

type LinePair = { h: CompactOddsRow | null; a: CompactOddsRow | null };

/** bookmaker -> (ev çizgisi | baraj) -> {taraf1, taraf2} satırları */
function groupLines(
  rows: CompactOddsRow[],
  types: Set<string>,
  scope: string,
  kind: "ah" | "ou",
): Map<number, Map<number, LinePair>> {
  const out = new Map<number, Map<number, LinePair>>();
  for (const r of rows) {
    if (!types.has(up(r[1])) || up(r[2]) !== scope) continue;
    const side = String(r[3] ?? "");
    const [k, vRaw] = side.split(":");
    const v = Number(vRaw);
    if (!Number.isFinite(v)) continue;
    const K = k.toUpperCase();
    let line: number;
    let isFirst: boolean;
    if (kind === "ah") {
      if (K === "H" || K === "HOME") {
        line = v;
        isFirst = true;
      } else if (K === "A" || K === "AWAY") {
        line = -v;
        isFirst = false;
      } else continue;
    } else {
      if (K === "OVER" || K === "O") isFirst = true;
      else if (K === "UNDER" || K === "U") isFirst = false;
      else continue;
      line = v;
    }
    const bm = Number(r[0]);
    let byLine = out.get(bm);
    if (!byLine) out.set(bm, (byLine = new Map()));
    let p = byLine.get(line);
    if (!p) byLine.set(line, (p = { h: null, a: null }));
    if (isFirst) p.h = r;
    else p.a = r;
  }
  return out;
}

/** Çiftin vig-free "ilk taraf" olasılığı (kapanış oranı). */
function pairProb(p: LinePair): number | null {
  if (!p.h || !p.a) return null;
  const a = closeOf(p.h);
  const b = closeOf(p.a);
  if (a == null || b == null) return null;
  const ia = 1 / a;
  const ib = 1 / b;
  return ia / (ia + ib);
}

/**
 * Dengeli çizgi: olasılığı 0.5'e en yakın çizgi.
 * Bazı bookmaker'lar (ör. Spreadex) her çizgiye aynı oranı verir → beraberlik. Bu durumda
 * çizgi belirsizdir: ortadaki çizgi alınır ve `ambiguous=true` döner (konsensüste dışlanır).
 */
function balancedLine(
  byLine: Map<number, LinePair>,
): { line: number; p: number; pair: LinePair; ambiguous: boolean } | null {
  const cands: { line: number; p: number; pair: LinePair }[] = [];
  let bestDev = Infinity;
  for (const [line, pair] of byLine) {
    const p = pairProb(pair);
    if (p == null) continue;
    const dev = Math.abs(p - 0.5);
    if (dev < bestDev - 1e-9) {
      bestDev = dev;
      cands.length = 0;
      cands.push({ line, p, pair });
    } else if (Math.abs(dev - bestDev) <= 1e-9) {
      cands.push({ line, p, pair });
    }
  }
  if (!cands.length) return null;
  cands.sort((a, b) => a.line - b.line);
  const mid = cands[(cands.length - 1) >> 1];
  return { ...mid, ambiguous: cands.length > 1 };
}

function mlProb(rows: CompactOddsRow[], scope: string): Map<number, number> {
  const per = new Map<number, { h?: number; a?: number }>();
  for (const r of rows) {
    if (!T_ML.has(up(r[1])) || up(r[2]) !== scope) continue;
    const s = up(r[3]);
    const bm = Number(r[0]);
    const v = closeOf(r);
    if (v == null) continue;
    const o = per.get(bm) ?? {};
    if (s === "H" || s === "HOME") o.h = v;
    else if (s === "A" || s === "AWAY") o.a = v;
    per.set(bm, o);
  }
  const out = new Map<number, number>();
  for (const [bm, o] of per) {
    if (o.h && o.a) out.set(bm, 1 / o.h / (1 / o.h + 1 / o.a));
  }
  return out;
}

/**
 * Ham oran satırlarından konsensüs (bookmaker medyanı) profili.
 * bookmakerId verilirse yalnızca o bookmaker'ın satırları kullanılır (BM profili).
 */
export function profileFromOdds(
  odds: CompactOddsRow[] | null | undefined,
  bookmakerId?: number | null,
): RawProfile {
  const empty: RawProfile = { ml: null, ahLine: null, ahP: null, ouLine: null, ouP: null };
  if (!Array.isArray(odds) || !odds.length) return empty;
  const rows = bookmakerId != null ? odds.filter((r) => Number(r[0]) === bookmakerId) : odds;
  if (!rows.length) return empty;

  const mlScope = pickScope(rows, T_ML);
  const ahScope = pickScope(rows, T_AH);
  const ouScope = pickScope(rows, T_OU);

  const mls = mlScope ? [...mlProb(rows, mlScope).values()] : [];

  const collect = (scope: string | null, types: Set<string>, kind: "ah" | "ou") => {
    const all: { line: number; p: number; ambiguous: boolean }[] = [];
    if (scope) {
      for (const byLine of groupLines(rows, types, scope, kind).values()) {
        const b = balancedLine(byLine);
        if (b) all.push(b);
      }
    }
    const clear = all.filter((x) => !x.ambiguous);
    const use = clear.length ? clear : all;
    return { lines: use.map((x) => x.line), ps: use.map((x) => x.p) };
  };
  const ah = collect(ahScope, T_AH, "ah");
  const ou = collect(ouScope, T_OU, "ou");
  return {
    ml: median(mls),
    ahLine: median(ah.lines),
    ahP: median(ah.ps),
    ouLine: median(ou.lines),
    ouP: median(ou.ps),
  };
}

/** Profil -> z-skor vektörü (meta.norm ile). Eksik bileşen = NaN. */
export function zVector(p: RawProfile, cols: readonly string[], norm: Norm): Float32Array {
  const raw: Record<string, number | null> = {
    ml_c: p.ml,
    ah_c: p.ahLine,
    ou_c: p.ouLine,
    ahP_c: p.ahP,
    ouP_c: p.ouP,
  };
  const out = new Float32Array(cols.length);
  cols.forEach((c, i) => {
    const v = raw[c];
    const n = norm[c];
    out[i] = v == null || !n ? NaN : (v - n[0]) / n[1];
  });
  return out;
}

/** z -> ham değer (tolerans / baraj filtresi için). */
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
    const a = q[c];
    const b = v[vOff + c];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const t = (a - b) * w[c];
    d += t * t;
    n++;
  }
  return n >= 2 ? Math.sqrt(d) : Infinity;
}

/** Tablo/fikstür için seçilen bookmaker'ın ana market oranları (açılış/kapanış). */
export function marketSnapshot(
  odds: CompactOddsRow[] | null | undefined,
  bookmakerId: number | null,
): MarketSnapshot {
  const empty: MarketSnapshot = {
    bmId: bookmakerId,
    ml: { ho: null, hc: null, ao: null, ac: null },
    ahLine: null,
    ahH_o: null,
    ahH_c: null,
    ahA_o: null,
    ahA_c: null,
    ouLine: null,
    ouO_o: null,
    ouO_c: null,
    ouU_o: null,
    ouU_c: null,
  };
  if (!Array.isArray(odds) || !odds.length || bookmakerId == null) return empty;
  const rows = odds.filter((r) => Number(r[0]) === bookmakerId);
  if (!rows.length) return empty;

  const out = { ...empty, ml: { ...empty.ml } };

  const mlScope = pickScope(rows, T_ML);
  if (mlScope) {
    for (const r of rows) {
      if (!T_ML.has(up(r[1])) || up(r[2]) !== mlScope) continue;
      const s = up(r[3]);
      if (s === "H" || s === "HOME") {
        out.ml.ho = openOf(r);
        out.ml.hc = closeOf(r);
      } else if (s === "A" || s === "AWAY") {
        out.ml.ao = openOf(r);
        out.ml.ac = closeOf(r);
      }
    }
  }

  const ahScope = pickScope(rows, T_AH);
  if (ahScope) {
    const b = balancedLine(groupLines(rows, T_AH, ahScope, "ah").get(bookmakerId) ?? new Map());
    if (b) {
      out.ahLine = b.line;
      if (b.pair.h) {
        out.ahH_o = openOf(b.pair.h);
        out.ahH_c = closeOf(b.pair.h);
      }
      if (b.pair.a) {
        out.ahA_o = openOf(b.pair.a);
        out.ahA_c = closeOf(b.pair.a);
      }
    }
  }
  const ouScope = pickScope(rows, T_OU);
  if (ouScope) {
    const b = balancedLine(groupLines(rows, T_OU, ouScope, "ou").get(bookmakerId) ?? new Map());
    if (b) {
      out.ouLine = b.line;
      if (b.pair.h) {
        out.ouO_o = openOf(b.pair.h);
        out.ouO_c = closeOf(b.pair.h);
      }
      if (b.pair.a) {
        out.ouU_o = openOf(b.pair.a);
        out.ouU_c = closeOf(b.pair.a);
      }
    }
  }
  return out;
}

/** Maçta (ML+AH+OU) en çok ana-market satırı olan bookmaker. */
export function defaultBookmaker(odds: CompactOddsRow[] | null | undefined): number | null {
  if (!Array.isArray(odds) || !odds.length) return null;
  const score = new Map<number, number>();
  for (const r of odds) {
    const t = up(r[1]);
    const s = up(r[2]);
    if (s !== "FULL_TIME" && s !== "FULL_TIME_OVER_TIME") continue;
    if (!T_ML.has(t) && !T_AH.has(t) && !T_OU.has(t)) continue;
    const bm = Number(r[0]);
    score.set(bm, (score.get(bm) ?? 0) + 1);
  }
  let best: number | null = null;
  let bn = -1;
  for (const [bm, n] of score) if (n > bn) ((best = bm), (bn = n));
  return best;
}

/** Bu bookmaker maçın ana marketlerinden en az ML veya AH + OU veriyor mu? */
export function bmHasCore(odds: CompactOddsRow[] | null | undefined, bm: number): boolean {
  const p = profileFromOdds(odds, bm);
  return p.ouLine != null && (p.ml != null || p.ahLine != null);
}
