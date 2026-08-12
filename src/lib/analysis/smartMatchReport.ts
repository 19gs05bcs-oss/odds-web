/**
 * Smart Analysis — one upcoming fixture vs season .json.gz archive.
 */

import type { CompactOddsRow, FixtureRow } from "@/lib/fixtures";
import {
  fixtureToTableRow,
  normalizeSideToken,
  PREFERRED_BM,
  type TableRow,
} from "@/lib/analysis/tableRows";
import type { SeasonGzMatch } from "@/lib/analysis/seasonGzCache";

export type MoveKind = "shortened" | "lengthened" | "stable";

export type Bm1x2Row = {
  id: string;
  name: string;
  H: number | null;
  D: number | null;
  A: number | null;
  favorite: "H" | "D" | "A" | null;
  moveH: MoveKind | null;
  moveD: MoveKind | null;
  moveA: MoveKind | null;
};

export type OutcomeStats = {
  n: number;
  H: number;
  D: number;
  A: number;
  top: "H" | "D" | "A" | null;
  topPct: number;
};

export type MovementInsight = {
  market: string;
  scope: string;
  side: string;
  sideLabel: string;
  bookmakerId: string;
  bookmakerName: string;
  opening: number;
  closing: number;
  changePct: number;
  move: MoveKind;
  historical: {
    n: number;
    winPct: number;
    impliedPct: number;
    reversedPct: number;
    note: string;
  } | null;
};

export type SimilarMatchRow = {
  id: string;
  season: string;
  home: string;
  away: string;
  kickoff: string | null;
  score: string;
  outcome: "H" | "D" | "A";
  oddsH: number;
  oddsD: number;
  oddsA: number;
};

export type SmartMatchReport = {
  home: string;
  away: string;
  kickoff: string | null;
  league: string | null;
  referenceBm: number;
  tolerancePct: number;
  archiveMatches: number;
  archiveSource: string | null;
  profile1x2: { H: number; D: number; A: number } | null;
  similar1x2: OutcomeStats & { samples: SimilarMatchRow[] };
  movements: MovementInsight[];
  bookmakerGrid: Bm1x2Row[];
  consensus: {
    favorite: "H" | "D" | "A" | null;
    counts: { H: number; D: number; A: number };
    aligned: boolean;
    alignedPct: number;
    historical: OutcomeStats | null;
  };
  selectedRow: TableRow | null;
  similarTableRows: TableRow[];
  summary: string[];
};

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1.01 ? n : null;
}

function pctChange(opening: number, closing: number): number {
  return opening >= 1.01 ? ((closing - opening) / opening) * 100 : 0;
}

function moveKind(opening: number | null, closing: number | null): MoveKind | null {
  if (opening == null || closing == null || opening < 1.01 || closing < 1.01) return null;
  const ch = pctChange(opening, closing);
  if (ch <= -2) return "shortened";
  if (ch >= 2) return "lengthened";
  return "stable";
}

function oddsClose(a: number, b: number, tolPct: number): boolean {
  if (tolPct <= 0) return Math.round(a * 100) === Math.round(b * 100);
  return Math.abs(a - b) / b <= tolPct;
}

function outcome1x2(h: number, a: number): "H" | "D" | "A" {
  if (h > a) return "H";
  if (h < a) return "A";
  return "D";
}

function sideLabel(side: string): string {
  if (side === "H") return "1";
  if (side === "D") return "X";
  if (side === "A") return "2";
  return side;
}

function pickOdds(
  odds: CompactOddsRow[] | null | undefined,
  bmId: number,
  mtype: string,
  scope: string,
  side: string,
  homeId?: string | null,
  awayId?: string | null,
): { opening: number | null; closing: number | null } {
  let opening: number | null = null;
  let closing: number | null = null;
  for (const row of odds || []) {
    if (!Array.isArray(row) || row.length < 7) continue;
    if (Number(row[0]) !== bmId) continue;
    if (row[1] !== mtype || row[2] !== scope) continue;
    const tok = normalizeSideToken(String(row[3]), homeId, awayId);
    if (side.includes(":")) {
      if (tok !== side) continue;
    } else {
      const base = tok.startsWith("H:") || tok.startsWith("A:") || tok.startsWith("D:")
        ? tok[0]
        : tok.split(":")[0];
      if (base !== side && tok !== side) continue;
    }
    opening = num(row[4]);
    closing = num(row[5]) ?? opening;
    break;
  }
  return { opening, closing };
}

function extract1x2(
  odds: CompactOddsRow[] | null | undefined,
  bmId: number,
  homeId?: string | null,
  awayId?: string | null,
): { H: number; D: number; A: number } | null {
  const H = pickOdds(odds, bmId, "HOME_DRAW_AWAY", "FULL_TIME", "H", homeId, awayId).closing;
  const D = pickOdds(odds, bmId, "HOME_DRAW_AWAY", "FULL_TIME", "D", homeId, awayId).closing;
  const A = pickOdds(odds, bmId, "HOME_DRAW_AWAY", "FULL_TIME", "A", homeId, awayId).closing;
  if (H == null || D == null || A == null) return null;
  return { H, D, A };
}

function favoriteSide(H: number | null, D: number | null, A: number | null): "H" | "D" | "A" | null {
  const vals: Array<["H" | "D" | "A", number]> = [];
  if (H != null) vals.push(["H", H]);
  if (D != null) vals.push(["D", D]);
  if (A != null) vals.push(["A", A]);
  if (!vals.length) return null;
  vals.sort((a, b) => a[1] - b[1]);
  return vals[0][0];
}

function sideWon(side: string, h: number, a: number, mtype: string, line?: string | null): boolean | null {
  if (mtype === "HOME_DRAW_AWAY") return side === outcome1x2(h, a);
  if (mtype === "BOTH_TEAMS_TO_SCORE") {
    const yes = h > 0 && a > 0;
    if (/YES|True/i.test(side)) return yes;
    if (/NO|False/i.test(side)) return !yes;
  }
  if (mtype === "OVER_UNDER" && line) {
    const total = h + a;
    const ln = Number(line);
    if (!Number.isFinite(ln)) return null;
    const over = total > ln;
    if (side.startsWith("OVER")) return over;
    if (side.startsWith("UNDER")) return !over;
  }
  return null;
}

function bmIds(odds: CompactOddsRow[] | null | undefined): number[] {
  const s = new Set<number>();
  for (const row of odds || []) {
    if (!Array.isArray(row)) continue;
    const n = Number(row[0]);
    if (Number.isFinite(n) && n > 0) s.add(n);
  }
  return [...s].sort((a, b) => a - b);
}

function buildBmGrid(
  odds: CompactOddsRow[] | null | undefined,
  bookmakers: Record<string, string> | null | undefined,
  homeId?: string | null,
  awayId?: string | null,
): Bm1x2Row[] {
  const bms = bookmakers || {};
  return bmIds(odds).map((id) => {
    const pH = pickOdds(odds, id, "HOME_DRAW_AWAY", "FULL_TIME", "H", homeId, awayId);
    const pD = pickOdds(odds, id, "HOME_DRAW_AWAY", "FULL_TIME", "D", homeId, awayId);
    const pA = pickOdds(odds, id, "HOME_DRAW_AWAY", "FULL_TIME", "A", homeId, awayId);
    return {
      id: String(id),
      name: bms[String(id)] || `#${id}`,
      H: pH.closing,
      D: pD.closing,
      A: pA.closing,
      favorite: favoriteSide(pH.closing, pD.closing, pA.closing),
      moveH: moveKind(pH.opening, pH.closing),
      moveD: moveKind(pD.opening, pD.closing),
      moveA: moveKind(pA.opening, pA.closing),
    };
  });
}

function countOutcomes(rows: SimilarMatchRow[]): OutcomeStats {
  const stats = { n: rows.length, H: 0, D: 0, A: 0, top: null as "H" | "D" | "A" | null, topPct: 0 };
  for (const r of rows) stats[r.outcome] += 1;
  if (!stats.n) return stats;
  const entries: Array<["H" | "D" | "A", number]> = [
    ["H", stats.H],
    ["D", stats.D],
    ["A", stats.A],
  ];
  entries.sort((a, b) => b[1] - a[1]);
  stats.top = entries[0][0];
  stats.topPct = (entries[0][1] / stats.n) * 100;
  return stats;
}

function gzToFixtureLike(m: SeasonGzMatch): FixtureRow {
  return {
    match_id: m.matchId,
    bulletin_date: m.kickoffAt?.slice(0, 10) || "",
    day_offset: 0,
    league: m.competition,
    league_country: null,
    kickoff_at: m.kickoffAt,
    kickoff_ts: m.kickoffAt ? Math.floor(new Date(m.kickoffAt).getTime() / 1000) : null,
    home_name: m.home,
    away_name: m.away,
    home_score: String(m.homeScore),
    away_score: String(m.awayScore),
    home_ht_score: m.homeHtScore,
    away_ht_score: m.awayHtScore,
    match_url: null,
    odds: m.odds,
    bookmakers: m.bookmakers,
    odds_count: m.odds.length,
  };
}

function findSimilar1x2(
  archive: SeasonGzMatch[],
  profile: { H: number; D: number; A: number },
  bmId: number,
  tolPct: number,
  limit = 120,
): SimilarMatchRow[] {
  const out: SimilarMatchRow[] = [];
  for (const m of archive) {
    const tri = extract1x2(m.odds, bmId);
    if (!tri) continue;
    if (
      !oddsClose(tri.H, profile.H, tolPct) ||
      !oddsClose(tri.D, profile.D, tolPct) ||
      !oddsClose(tri.A, profile.A, tolPct)
    ) {
      continue;
    }
    out.push({
      id: m.id,
      season: m.seasonSlug,
      home: m.home,
      away: m.away,
      kickoff: m.kickoffAt,
      score: `${m.homeScore}-${m.awayScore}`,
      outcome: outcome1x2(m.homeScore, m.awayScore),
      oddsH: tri.H,
      oddsD: tri.D,
      oddsA: tri.A,
    });
    if (out.length >= limit) break;
  }
  return out;
}

function historicalForMove(
  archive: SeasonGzMatch[],
  bmId: number,
  mtype: string,
  scope: string,
  side: string,
  opening: number,
  closing: number,
  move: MoveKind,
  tolPct: number,
  homeId?: string | null,
  awayId?: string | null,
): MovementInsight["historical"] {
  if (move === "stable") return null;
  let n = 0;
  let wins = 0;
  let reversed = 0;
  let sumImpl = 0;
  for (const m of archive) {
    const p = pickOdds(m.odds, bmId, mtype, scope, side, homeId, awayId);
    if (p.opening == null || p.closing == null) continue;
    if (!oddsClose(p.closing, closing, tolPct)) continue;
    const mk = moveKind(p.opening, p.closing);
    if (mk !== move) continue;
    const won = sideWon(side, m.homeScore, m.awayScore, mtype);
    if (won == null) continue;
    n += 1;
    if (won) wins += 1;
    sumImpl += 1 / p.closing;
    const impliedFav = move === "shortened";
    if (won !== impliedFav) reversed += 1;
  }
  if (n < 8) return null;
  const winPct = wins / n;
  const impliedPct = sumImpl / n;
  const reversedPct = reversed / n;
  const note =
    move === "shortened"
      ? `Oran düştü (steam) — geçmişte bu seçim ${(winPct * 100).toFixed(0)}% isabet; tersine ${(reversedPct * 100).toFixed(0)}%`
      : `Oran uzadı (drift) — geçmişte ${(winPct * 100).toFixed(0)}% isabet; beklenenin tersi ${(reversedPct * 100).toFixed(0)}%`;
  return { n, winPct, impliedPct, reversedPct, note };
}

function historicalConsensus(
  archive: SeasonGzMatch[],
  favorite: "H" | "D" | "A",
  profile: { H: number; D: number; A: number },
  tolPct: number,
  minAgree = 0.75,
): OutcomeStats | null {
  const samples: SimilarMatchRow[] = [];
  for (const m of archive) {
    const grid = buildBmGrid(m.odds, m.bookmakers);
    if (grid.length < 10) continue;
    const tri = extract1x2(m.odds, PREFERRED_BM);
    if (!tri) continue;
    if (
      !oddsClose(tri.H, profile.H, tolPct * 1.5) ||
      !oddsClose(tri.D, profile.D, tolPct * 1.5) ||
      !oddsClose(tri.A, profile.A, tolPct * 1.5)
    ) {
      continue;
    }
    const favCount = grid.filter((g) => g.favorite === favorite).length;
    if (favCount / grid.length < minAgree) continue;
    samples.push({
      id: m.id,
      season: m.seasonSlug,
      home: m.home,
      away: m.away,
      kickoff: m.kickoffAt,
      score: `${m.homeScore}-${m.awayScore}`,
      outcome: outcome1x2(m.homeScore, m.awayScore),
      oddsH: tri.H,
      oddsD: tri.D,
      oddsA: tri.A,
    });
  }
  if (samples.length < 10) return null;
  return countOutcomes(samples);
}

export function buildSmartMatchReport(input: {
  fixture: Pick<
    FixtureRow,
    | "match_id"
    | "home_name"
    | "away_name"
    | "kickoff_at"
    | "league"
    | "odds"
    | "bookmakers"
    | "home_id"
    | "away_id"
  >;
  archive: SeasonGzMatch[];
  archiveSource?: string | null;
  referenceBm?: number;
  tolerancePct?: number;
}): SmartMatchReport {
  const bm = input.referenceBm ?? PREFERRED_BM;
  const tol = input.tolerancePct ?? 0.03;
  const f = input.fixture;
  const home = f.home_name || "Home";
  const away = f.away_name || "Away";
  const profile = extract1x2(f.odds, bm, f.home_id, f.away_id);
  const grid = buildBmGrid(f.odds, f.bookmakers, f.home_id, f.away_id);
  const similarSamples = profile
    ? findSimilar1x2(input.archive, profile, bm, tol)
    : [];
  const similar1x2 = { ...countOutcomes(similarSamples), samples: similarSamples.slice(0, 40) };

  const favCounts = { H: 0, D: 0, A: 0 };
  for (const g of grid) {
    if (g.favorite) favCounts[g.favorite] += 1;
  }
  const totalBm = grid.length;
  const topFav = (Object.keys(favCounts) as Array<"H" | "D" | "A">).sort(
    (a, b) => favCounts[b] - favCounts[a],
  )[0];
  const alignedCount = favCounts[topFav];
  const aligned = totalBm > 0 && alignedCount / totalBm >= 0.7;
  const consensusHist =
    profile && aligned ? historicalConsensus(input.archive, topFav, profile, tol) : null;

  const movements: MovementInsight[] = [];
  const bmName = (id: string) => f.bookmakers?.[id] || `#${id}`;
  const keyMarkets: Array<[string, string, string, string?]> = [
    ["HOME_DRAW_AWAY", "FULL_TIME", "H"],
    ["HOME_DRAW_AWAY", "FULL_TIME", "D"],
    ["HOME_DRAW_AWAY", "FULL_TIME", "A"],
    ["BOTH_TEAMS_TO_SCORE", "FULL_TIME", "btts:YES"],
    ["BOTH_TEAMS_TO_SCORE", "FULL_TIME", "btts:NO"],
    ["OVER_UNDER", "FULL_TIME", "OVER", "2.5"],
    ["OVER_UNDER", "FULL_TIME", "UNDER", "2.5"],
  ];

  for (const [mtype, scope, side, line] of keyMarkets) {
    const sideTok = line && mtype === "OVER_UNDER" ? `${side}:${line}` : side;
    const p = pickOdds(f.odds, bm, mtype, scope, sideTok, f.home_id, f.away_id);
    if (p.opening == null || p.closing == null) continue;
    const move = moveKind(p.opening, p.closing);
    if (!move || move === "stable") continue;
    const ch = pctChange(p.opening, p.closing);
    movements.push({
      market: mtype,
      scope,
      side: sideTok,
      sideLabel: sideLabel(side.split(":")[0]),
      bookmakerId: String(bm),
      bookmakerName: bmName(String(bm)),
      opening: p.opening,
      closing: p.closing,
      changePct: Math.round(ch * 10) / 10,
      move,
      historical: historicalForMove(
        input.archive,
        bm,
        mtype,
        scope,
        sideTok,
        p.opening,
        p.closing,
        move,
        tol,
        f.home_id,
        f.away_id,
      ),
    });
  }
  movements.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));

  const fixtureRow: FixtureRow = {
    match_id: f.match_id,
    bulletin_date: f.kickoff_at?.slice(0, 10) || "",
    day_offset: 0,
    league: f.league,
    league_country: null,
    kickoff_at: f.kickoff_at,
    kickoff_ts: null,
    home_name: home,
    away_name: away,
    home_id: f.home_id,
    away_id: f.away_id,
    home_score: null,
    away_score: null,
    match_url: null,
    odds: f.odds,
    bookmakers: f.bookmakers,
    odds_count: f.odds?.length ?? 0,
  };

  const similarTableRows = similarSamples.slice(0, 60).map((s) => {
    const src = input.archive.find((m) => m.id === s.id);
    if (!src) {
      return fixtureToTableRow(fixtureRow, bm);
    }
    return fixtureToTableRow(gzToFixtureLike(src), bm);
  });

  const summary: string[] = [];
  if (profile && similar1x2.n >= 5) {
    summary.push(
      `MS 1X2 profiline ±${(tol * 100).toFixed(0)}% uyan ${similar1x2.n} maçta en sık sonuç MS ${sideLabel(similar1x2.top || "D")} (%${similar1x2.topPct.toFixed(0)}).`,
    );
  } else if (profile) {
    summary.push(`MS 1X2 profiline uyan yeterli arşiv maçı yok (n=${similar1x2.n}). Toleransı artırın.`);
  }
  if (aligned && totalBm) {
    summary.push(
      `${alignedCount}/${totalBm} bookmaker favoriyi MS ${sideLabel(topFav)} olarak gösteriyor.` +
        (consensusHist
          ? ` Geçmişte aynı BM uyumunda MS ${sideLabel(consensusHist.top || topFav)} %${consensusHist.topPct.toFixed(0)}.`
          : ""),
    );
  } else if (totalBm) {
    summary.push(`Bookmaker'lar dağılmış — tek yönde güçlü konsensüs yok (en çok MS ${sideLabel(topFav)}: ${alignedCount}/${totalBm}).`);
  }
  const topMove = movements[0];
  if (topMove?.historical) {
    summary.push(topMove.historical.note);
  }

  return {
    home,
    away,
    kickoff: f.kickoff_at,
    league: f.league,
    referenceBm: bm,
    tolerancePct: tol,
    archiveMatches: input.archive.length,
    archiveSource: input.archiveSource ?? null,
    profile1x2: profile,
    similar1x2,
    movements,
    bookmakerGrid: grid,
    consensus: {
      favorite: totalBm ? topFav : null,
      counts: favCounts,
      aligned,
      alignedPct: totalBm ? (alignedCount / totalBm) * 100 : 0,
      historical: consensusHist,
    },
    selectedRow: f.odds ? fixtureToTableRow(fixtureRow, bm) : null,
    similarTableRows,
    summary,
  };
}
