/** Stacked odds-profile search: click 1.44 away → add X → add Over 2.5 → intersect matches. */

import { prettySideName } from "./labels";
import type { Quote } from "./types";

export type OddsPrice = "opening" | "closing";

export type OddsCriterion = {
  marketType: string;
  marketScope: string;
  side: string;
  line?: string | null;
  targetOdds: number;
  /** Tıklanan hücre: O veya C — yoksa (eski URL) ikisinden biri. */
  price?: OddsPrice;
  /** Tıklanan tablo kolonu (AH +0.5 vs başka line karışmasın). */
  columnId?: string;
  /** Oran seçili maça göre çözülür (chip'te sabit oran yok). */
  relative?: boolean;
};

export type ProfileQuery = {
  criteria: OddsCriterion[];
  /** null/empty = all bookmakers */
  bookmakerId?: string | null;
  /** empty = all seasons */
  seasonSlugs?: string[];
  tolerance?: number;
  limit?: number;
};

export type CriterionHit = {
  marketType: string;
  marketScope: string;
  side: string;
  sideName: string;
  line: string | null;
  targetOdds: number;
  closing: number | null;
  opening: number | null;
  bookmakerId: string | null;
  bookmakerName: string | null;
};

export type ProfileMatch = {
  eventId: string;
  sourceEventId: string;
  competition: string | null;
  seasonSlug: string | null;
  round: string | null;
  homeTeam: string | null;
  awayTeam: string | null;
  kickoffAt: string | null;
  score: string | null;
  htScore: string | null;
  hits: CriterionHit[];
};

export type ProfileResult = {
  matches: ProfileMatch[];
  totalMatched: number;
  truncated: boolean;
  tookMs: number;
  criteria: OddsCriterion[];
  /** "Tüm sezonlar" araması, arşiv çok büyüdüğü için son N sezonla sınırlandıysa doldurulur. */
  scannedSeasons?: { capped: boolean; count: number };
};

export function criterionLabel(c: OddsCriterion): string {
  const scope =
    c.marketScope === "FULL_TIME"
      ? ""
      : c.marketScope === "FIRST_HALF"
        ? " HT"
        : c.marketScope === "SECOND_HALF"
          ? " 2H"
          : ` ${c.marketScope}`;
  const oc = c.price === "opening" ? " · O" : c.price === "closing" ? " · C" : "";
  const odds = c.relative ? "" : ` ≈ ${c.targetOdds}`;
  if (c.marketType === "HOME_DRAW_AWAY") {
    const side = c.side === "H" ? "1" : c.side === "D" ? "X" : c.side === "A" ? "2" : c.side;
    return `1X2${scope} ${side}${oc}${odds}`;
  }
  if (c.marketType === "OVER_UNDER") {
    const ou = c.side.startsWith("UNDER") ? "Under" : "Over";
    const line = c.line || (c.side.includes(":") ? c.side.split(":")[1] : "");
    return `${ou} ${line}${scope}${oc}${odds}`;
  }
  if (c.marketType === "ASIAN_HANDICAP" || c.marketType === "EUROPEAN_HANDICAP") {
    const n = c.line != null && c.line !== "" ? Number(c.line) : NaN;
    const lineLabel = Number.isFinite(n) ? (n > 0 ? `+${n}` : String(n)) : c.line || "";
    const side =
      c.side === "H" || c.side.startsWith("H")
        ? "H"
        : c.side === "D" || c.side.startsWith("D")
          ? "X"
          : c.side === "A" || c.side.startsWith("A")
            ? "A"
            : c.side;
    const label = c.marketType === "EUROPEAN_HANDICAP" ? "EH" : "AH";
    return `${label} ${lineLabel} ${side}${oc}${odds}`;
  }
  if (c.marketType === "DRAW_NO_BET") {
    const side = c.side === "H" ? "1" : c.side === "A" ? "2" : c.side;
    return `DNB${scope} ${side}${oc}${odds}`;
  }
  if (c.marketType === "BOTH_TEAMS_TO_SCORE") {
    const yn = /YES|True/i.test(c.side) ? "Yes" : "No";
    return `BTTS ${yn}${scope}${oc}${odds}`;
  }
  return `${c.marketType}${scope} ${prettySideName(c.side, null, c.marketType)}${oc}${odds}`;
}

/** Aynı market slot (relative veya mutlak) için benzersiz anahtar. */
export function marketSlotKey(c: OddsCriterion): string {
  return [
    c.columnId ?? "",
    c.price ?? "",
    c.marketType,
    c.marketScope,
    c.side,
    c.line ?? "",
    c.relative ? "rel" : String(c.targetOdds),
  ].join("|");
}

function oddsOf(q: Quote): number | null {
  return q.closing ?? q.opening;
}

function oddsEquals(v: number, target: number, tolerance: number): boolean {
  if (tolerance <= 0) return Math.round(v * 100) === Math.round(target * 100);
  return Math.abs(v - target) <= tolerance;
}

/** price verilmişse sadece o alan; yoksa opening veya closing. */
function quoteOddsMatchTarget(
  q: Quote,
  target: number,
  tolerance: number,
  price?: OddsPrice,
): boolean {
  const vals: number[] = [];
  if (price === "opening") {
    if (q.opening != null && Number.isFinite(q.opening) && q.opening >= 1.01) {
      vals.push(q.opening);
    }
  } else if (price === "closing") {
    if (q.closing != null && Number.isFinite(q.closing) && q.closing >= 1.01) {
      vals.push(q.closing);
    }
  } else {
    if (q.closing != null && Number.isFinite(q.closing) && q.closing >= 1.01) {
      vals.push(q.closing);
    }
    if (q.opening != null && Number.isFinite(q.opening) && q.opening >= 1.01) {
      vals.push(q.opening);
    }
  }
  return vals.some((v) => oddsEquals(v, target, tolerance));
}

function sideEquals(qSide: string, want: string): boolean {
  if (qSide === want) return true;
  // OVER matches OVER or OVER:2.5
  if (want === "OVER" || want === "UNDER") {
    return qSide === want || qSide.startsWith(want + ":");
  }
  // H matches H or H:-0.5 (line checked separately)
  if (want === "H" || want === "A" || want === "D") {
    return qSide === want || qSide.startsWith(want + ":");
  }
  if (want.startsWith("htft:")) {
    const code = want.slice(5);
    return (
      qSide === want ||
      qSide === code ||
      qSide === `htft:${code}` ||
      qSide.replace(/^htft:/, "") === code
    );
  }
  if (want.startsWith("btts:")) {
    const yn = /YES$/i.test(want);
    return yn
      ? /btts:(YES|True)$/i.test(qSide) || qSide === "YES" || qSide === "True"
      : /btts:(NO|False)$/i.test(qSide) || qSide === "NO" || qSide === "False";
  }
  return qSide.toLowerCase() === want.toLowerCase();
}

function lineFromSideToken(side: string): string | null {
  const m = /^[HDA]:(.+)$/i.exec(side) || /^(?:OVER|UNDER):(.+)$/i.exec(side);
  return m ? m[1] : null;
}

function lineEquals(
  qLine: string | null,
  qSide: string,
  want: string | null | undefined,
): boolean {
  // Handicap / OU line zorunlu — boş want her satırı yutmasın
  if (want == null || want === "") return true;
  const have = qLine != null && qLine !== "" ? String(qLine) : lineFromSideToken(qSide);
  if (have == null) return false;
  return have === String(want) || Number(have) === Number(want);
}

export function quoteMatchesCriterion(
  q: Quote,
  c: OddsCriterion,
  tolerance: number,
  bookmakerId?: string | null,
): boolean {
  if (q.marketType !== c.marketType) return false;
  if (c.marketScope && q.marketScope !== c.marketScope) return false;
  if (!sideEquals(q.side, c.side)) return false;
  if (
    (c.marketType === "ASIAN_HANDICAP" ||
      c.marketType === "EUROPEAN_HANDICAP" ||
      c.marketType === "OVER_UNDER") &&
    (c.line == null || c.line === "")
  ) {
    return false;
  }
  if (!lineEquals(q.line, q.side, c.line)) return false;
  if (bookmakerId && q.bookmakerId != null && q.bookmakerId !== bookmakerId) return false;
  return quoteOddsMatchTarget(q, c.targetOdds, tolerance, c.price);
}

/** Intersect events that satisfy every criterion (AND). */
export function searchOddsProfile(quotes: Quote[], query: ProfileQuery): ProfileResult {
  const t0 = Date.now();
  const criteria = query.criteria.filter((c) => c.targetOdds > 1);
  const tol = query.tolerance != null && query.tolerance >= 0 ? query.tolerance : 0;
  const limit = query.limit && query.limit > 0 ? Math.min(query.limit, 500) : 200;
  const bm = query.bookmakerId || null;
  const seasons = query.seasonSlugs?.filter(Boolean) ?? [];

  if (!criteria.length) {
    return { matches: [], totalMatched: 0, truncated: false, tookMs: 0, criteria };
  }

  let pool = quotes;
  if (seasons.length) {
    const set = new Set(seasons);
    pool = pool.filter((q) => q.seasonSlug && set.has(q.seasonSlug));
  }

  // eventId → best hit per criterion index
  const byEvent = new Map<string, { meta: Quote; hits: (CriterionHit | null)[] }>();

  for (let ci = 0; ci < criteria.length; ci++) {
    const c = criteria[ci];
    const next = new Map<string, { meta: Quote; hits: (CriterionHit | null)[] }>();

    for (const q of pool) {
      if (!quoteMatchesCriterion(q, c, tol, bm)) continue;
      const prev = ci === 0 ? undefined : byEvent.get(q.eventId);
      if (ci > 0 && !prev) continue;

      const odds = oddsOf(q)!;
      const hit: CriterionHit = {
        marketType: c.marketType,
        marketScope: c.marketScope,
        side: q.side,
        sideName: prettySideName(q.side, q.sideName, q.marketType),
        line: q.line,
        targetOdds: c.targetOdds,
        closing: q.closing,
        opening: q.opening,
        bookmakerId: q.bookmakerId,
        bookmakerName: q.bookmakerName,
      };

      const existing = next.get(q.eventId);
      if (!existing) {
        const hits = prev ? prev.hits.slice() : Array(criteria.length).fill(null);
        hits[ci] = hit;
        next.set(q.eventId, { meta: prev?.meta ?? q, hits });
      } else {
        const cur = existing.hits[ci];
        if (!cur || Math.abs((cur.closing ?? cur.opening ?? 0) - c.targetOdds) > Math.abs(odds - c.targetOdds)) {
          existing.hits[ci] = hit;
        }
      }
    }
    byEvent.clear();
    for (const [k, v] of next) byEvent.set(k, v);
  }

  const matches: ProfileMatch[] = [];
  for (const { meta, hits } of byEvent.values()) {
    if (hits.some((h) => h == null)) continue;
    matches.push({
      eventId: meta.eventId,
      sourceEventId: meta.sourceEventId,
      competition: meta.competition,
      seasonSlug: meta.seasonSlug,
      round: meta.round,
      homeTeam: meta.homeTeam,
      awayTeam: meta.awayTeam,
      kickoffAt: meta.kickoffAt,
      score:
        meta.homeScore != null && meta.awayScore != null
          ? `${meta.homeScore}-${meta.awayScore}`
          : null,
      htScore:
        meta.homeHtScore != null && meta.awayHtScore != null
          ? `${meta.homeHtScore}-${meta.awayHtScore}`
          : null,
      hits: hits as CriterionHit[],
    });
  }

  matches.sort((a, b) => {
    const aa = a.hits[0]?.closing ?? a.hits[0]?.opening ?? 0;
    const bb = b.hits[0]?.closing ?? b.hits[0]?.opening ?? 0;
    const da = Math.abs(aa - criteria[0].targetOdds);
    const db = Math.abs(bb - criteria[0].targetOdds);
    return da - db;
  });

  return {
    matches: matches.slice(0, limit),
    totalMatched: matches.length,
    truncated: matches.length > limit,
    tookMs: Date.now() - t0,
    criteria,
  };
}

/** Encode/decode: type|scope|side|line|odds(|o|c)(|columnId)(|rel) */
export function encodeCriterion(c: OddsCriterion): string {
  const base = [
    c.marketType,
    c.marketScope,
    c.side,
    c.line ?? "",
    c.relative ? "0" : String(c.targetOdds),
  ];
  if (c.price === "opening") base.push("o");
  else if (c.price === "closing") base.push("c");
  else base.push("");
  if (c.columnId) base.push(c.columnId);
  if (c.relative) base.push("rel");
  return base.join("|");
}

export function decodeCriterion(raw: string): OddsCriterion | null {
  const parts = raw.split("|");
  if (parts.length < 5) return null;
  const relative = parts.includes("rel");
  const clean = parts.filter((p) => p !== "rel");
  if (clean.length < 5) return null;
  const targetOdds = Number(clean[4]);
  if (!relative && (!Number.isFinite(targetOdds) || targetOdds <= 1)) return null;
  let price: OddsPrice | undefined;
  if (clean[5] === "o") price = "opening";
  else if (clean[5] === "c") price = "closing";
  const columnId =
    clean[6] && clean[6] !== "o" && clean[6] !== "c" ? clean[6] : undefined;
  return {
    marketType: clean[0],
    marketScope: clean[1] || "FULL_TIME",
    side: clean[2],
    line: clean[3] || null,
    targetOdds: relative ? 0 : targetOdds,
    price,
    columnId,
    relative: relative || undefined,
  };
}

export function parseProfileQuery(params: URLSearchParams): ProfileQuery {
  const criteria = params
    .getAll("c")
    .map(decodeCriterion)
    .filter((x): x is OddsCriterion => x != null);
  const seasons = params.getAll("season").filter(Boolean);
  const oneSeason = params.get("seasonSlug");
  if (oneSeason) seasons.push(oneSeason);
  const tol = Number(params.get("tol") || params.get("tolerance") || "");
  const limit = Number(params.get("limit") || "");
  return {
    criteria,
    bookmakerId: params.get("bookmaker") || params.get("bookmakerId") || null,
    seasonSlugs: seasons,
    tolerance: Number.isFinite(tol) ? tol : 0,
    limit: Number.isFinite(limit) && limit > 0 ? limit : 200,
  };
}
