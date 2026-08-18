/**
 * Smart Analysis — Koyeb yerine, analyze sayfasıyla AYNI desen: doğrudan
 * Supabase `match_odds`/`events` tablolarına karşı SQL (bkz.
 * searchOddsProfileSQL.ts / analyzeSeasonSQL.ts). Ağır tarama (283 sezon)
 * Postgres'te WHERE + agregasyon ile yapılır; Node sadece küçük sonuç
 * kümesini işler. Koyeb worker'a, seasonGzCache'e (tüm sezonları RAM'e
 * çeken eski yol) ve events.markets_json'a hiç dokunulmaz.
 */
import { sql } from "@/lib/db";
import { MATCH_ODDS_TABLE, fetchQuoteRowsByEventIds, type MatchOddsWithMetaRow } from "./marketQuotes";
import { sideCandidates } from "./marketQuoteCriteria";
import {
  PREFERRED_BM,
  PREFERRED_BM_NAME,
  bookmakerNameToPseudoId,
  marketQuoteRowsToCompactOdds,
} from "./tableRows";
import {
  extract1x2,
  buildBmGrid,
  pickOdds,
  moveKind,
  pctChange,
  sideLabel,
  describeMovement,
  outcome1x2,
  countOutcomes,
  type SmartMatchReport,
  type MovementInsight,
  type SimilarMatchRow,
  type MoveKind,
  type OutcomeStats,
} from "./smartMatchReport";
import { AH_LINES, CS_SCORES } from "./tableColumns";
import type { CompactOddsRow, FixtureRow } from "@/lib/fixtures";

/** Genişletilmiş kapsamda sorgu patlamasın diye CS'de en sık görülen skorlar. */
const CS_KEY_SCORES = CS_SCORES.slice(0, 6);

type SqlParamPusher = (v: unknown) => string;

function makePush(params: unknown[]): SqlParamPusher {
  return (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
}

/**
 * Referans bookmaker'ın 1X2 kapanış profiline ±tol uyan, BİTMİŞ arşiv
 * maçları — match_odds'a karşı 3 CTE JOIN (searchOddsProfileSQL'in aynısı,
 * sabit HOME_DRAW_AWAY:FULL_TIME + tek bookmaker için basitleştirilmiş).
 */
async function findSimilar1x2SQL(
  bmName: string,
  profile: { H: number; D: number; A: number },
  tolPct: number,
  limit = 400,
): Promise<SimilarMatchRow[]> {
  const params: unknown[] = [];
  const push = makePush(params);
  const marketPh = push("HOME_DRAW_AWAY:FULL_TIME");
  const bmPh = push(bmName);

  const sideCte = (alias: string, side: "H" | "D" | "A", target: number): string => {
    const lo = push(target * (1 - tolPct));
    const hi = push(target * (1 + tolPct));
    return `${alias} AS (
      SELECT event_id, odds FROM ${MATCH_ODDS_TABLE}
      WHERE bookmaker = ${bmPh} AND market = ${marketPh} AND selection = ${push(side)}
        AND odds BETWEEN ${lo} AND ${hi}
    )`;
  };

  const cteH = sideCte("qh", "H", profile.H);
  const cteD = sideCte("qd", "D", profile.D);
  const cteA = sideCte("qa", "A", profile.A);
  const limitPh = push(limit);

  const text = `
    WITH ${cteH},
    ${cteD},
    ${cteA}
    SELECT e.id AS event_id, e.season_slug, e.home_team, e.away_team, e.kickoff_at,
           e.home_score, e.away_score, qh.odds AS odds_h, qd.odds AS odds_d, qa.odds AS odds_a
    FROM qh
    JOIN qd ON qd.event_id = qh.event_id
    JOIN qa ON qa.event_id = qh.event_id
    JOIN events e ON e.id = qh.event_id
    WHERE e.home_score IS NOT NULL AND e.away_score IS NOT NULL
    LIMIT ${limitPh}
  `;

  const rows = (await sql.unsafe(text, params as never[])) as Record<string, unknown>[];
  const out: SimilarMatchRow[] = [];
  for (const r of rows) {
    const h = Number(r.home_score);
    const a = Number(r.away_score);
    const oh = Number(r.odds_h);
    const od = Number(r.odds_d);
    const oa = Number(r.odds_a);
    if (!Number.isFinite(h) || !Number.isFinite(a)) continue;
    if (!Number.isFinite(oh) || !Number.isFinite(od) || !Number.isFinite(oa)) continue;
    out.push({
      id: String(r.event_id),
      season: (r.season_slug as string) ?? "",
      home: (r.home_team as string) ?? "",
      away: (r.away_team as string) ?? "",
      kickoff: (r.kickoff_at as string) ?? null,
      score: `${h}-${a}`,
      outcome: outcome1x2(h, a),
      oddsH: oh,
      oddsD: od,
      oddsA: oa,
    });
  }
  return out;
}

/**
 * Genişletilmiş market kapsamı — kazanan tarafı skordan (events) türeten
 * numeric (0/0.5/1) SQL ifadesi. HT scope'lu marketler home_ht_score/
 * away_ht_score kullanır (extraWhere ile NULL satırlar elenir). Asian
 * Handicap çeyrek çizgiler (±.25/±.75) iki yarım-bahis ortalaması olarak
 * (0/0.5/1 karışımı) hesaplanır — klasik boolean win/lose yetmez.
 */
function winExprSql(
  mtype: string,
  scope: string,
  side: string,
  line?: string,
): { expr: string; extraWhere?: string } | null {
  const isHt = scope === "FIRST_HALF";
  const hCol = isHt ? "e.home_ht_score" : "e.home_score";
  const aCol = isHt ? "e.away_ht_score" : "e.away_score";
  const htGuard = isHt ? `${hCol} IS NOT NULL AND ${aCol} IS NOT NULL` : undefined;

  if (mtype === "HOME_DRAW_AWAY") {
    let cond: string | null = null;
    if (side === "H") cond = `${hCol} > ${aCol}`;
    else if (side === "D") cond = `${hCol} = ${aCol}`;
    else if (side === "A") cond = `${hCol} < ${aCol}`;
    if (!cond) return null;
    return { expr: `(CASE WHEN ${cond} THEN 1 ELSE 0 END)`, extraWhere: htGuard };
  }
  if (mtype === "BOTH_TEAMS_TO_SCORE") {
    const yes = /YES/i.test(side);
    const cond = "(e.home_score > 0 AND e.away_score > 0)";
    return { expr: `(CASE WHEN ${yes ? cond : `NOT ${cond}`} THEN 1 ELSE 0 END)` };
  }
  if (mtype === "OVER_UNDER" && line != null) {
    const ln = Number(line);
    if (!Number.isFinite(ln)) return null;
    const cond = side.startsWith("OVER")
      ? `(${hCol} + ${aCol}) > ${ln}`
      : `(${hCol} + ${aCol}) < ${ln}`;
    return { expr: `(CASE WHEN ${cond} THEN 1 ELSE 0 END)`, extraWhere: htGuard };
  }
  if (mtype === "DOUBLE_CHANCE") {
    const code = side.replace(/^DC:/, "");
    const wants: Record<string, string[]> = { "1X": ["H", "D"], "12": ["H", "A"], "X2": ["D", "A"] };
    const allowed = wants[code];
    if (!allowed) return null;
    const outcome =
      "(CASE WHEN e.home_score > e.away_score THEN 'H' WHEN e.home_score < e.away_score THEN 'A' ELSE 'D' END)";
    return {
      expr: `(CASE WHEN ${outcome} IN (${allowed.map((w) => `'${w}'`).join(", ")}) THEN 1 ELSE 0 END)`,
    };
  }
  if (mtype === "ASIAN_HANDICAP" && line != null) {
    if (!side.startsWith("H")) return null;
    const ln = Number(line);
    if (!Number.isFinite(ln)) return null;
    const margin = (l: number) => `((e.home_score - e.away_score) + (${l}))`;
    const singleResult = (l: number) =>
      `(CASE WHEN ${margin(l)} > 0 THEN 1 WHEN ${margin(l)} = 0 THEN 0.5 ELSE 0 END)`;
    const isQuarter = Math.abs((ln * 4) % 2) === 1;
    if (isQuarter) {
      const l1 = ln - 0.25;
      const l2 = ln + 0.25;
      return { expr: `((${singleResult(l1)} + ${singleResult(l2)}) / 2.0)` };
    }
    return { expr: singleResult(ln) };
  }
  if (mtype === "CORRECT_SCORE") {
    const code = side.replace(/^score:/, "");
    const [hs, as] = code.split(":").map((v) => Number(v));
    if (!Number.isFinite(hs) || !Number.isFinite(as)) return null;
    return { expr: `(CASE WHEN e.home_score = ${hs} AND e.away_score = ${as} THEN 1 ELSE 0 END)` };
  }
  return null;
}

/**
 * Bir oran hareketinin (steam/drift) geçmiş isabet istatistiği — TEK bir
 * agregasyon sorgusuyla (COUNT/SUM), hiçbir satır Node'a inmeden.
 */
async function historicalForMoveSQL(
  bmName: string,
  mtype: string,
  scope: string,
  side: string,
  closing: number,
  move: MoveKind,
  tolPct: number,
  line?: string,
): Promise<MovementInsight["historical"]> {
  if (move === "stable") return null;
  const w = winExprSql(mtype, scope, side, line);
  if (!w) return null;

  const { exact, prefixes } = sideCandidates(side);
  const params: unknown[] = [];
  const push = makePush(params);

  const sideExactPh = exact.map((v) => push(v));
  const sideConds = [`q.selection IN (${sideExactPh.join(", ")})`];
  for (const p of prefixes) {
    sideConds.push(`q.selection = ${push(p)}`);
    sideConds.push(`q.selection LIKE ${push(`${p}:%`)}`);
  }
  // AH/OU compact token yerine ayrı `line` kolonu kullanan satırları da
  // yakalamak için ek fallback (side'ın "base" kısmı + numeric line eşleşmesi).
  if (line != null && (mtype === "OVER_UNDER" || mtype === "ASIAN_HANDICAP")) {
    const base = side.split(":")[0];
    const basePh = push(base);
    const lineNumPh = push(Number(line));
    sideConds.push(`(q.selection = ${basePh} AND q.line IS NOT NULL AND q.line::numeric = ${lineNumPh})`);
  }
  const sideCond = `(${sideConds.join(" OR ")})`;

  const marketPh = push(`${mtype}:${scope}`);
  const bmPh = push(bmName);
  const lo = push(closing * (1 - tolPct));
  const hi = push(closing * (1 + tolPct));
  const movePh = push(move);
  const moveExpr = `
    CASE
      WHEN q.opening IS NULL OR q.opening < 1.01 OR q.odds IS NULL OR q.odds < 1.01 THEN NULL
      WHEN (q.odds - q.opening) / q.opening <= -0.02 THEN 'shortened'
      WHEN (q.odds - q.opening) / q.opening >= 0.02 THEN 'lengthened'
      ELSE 'stable'
    END`;

  const text = `
    SELECT COUNT(*)::int AS n,
           SUM(${w.expr})::float AS wins,
           SUM(1.0 / q.odds) AS sum_impl
    FROM ${MATCH_ODDS_TABLE} q
    JOIN events e ON e.id = q.event_id
    WHERE q.bookmaker = ${bmPh}
      AND q.market = ${marketPh}
      AND ${sideCond}
      AND q.odds BETWEEN ${lo} AND ${hi}
      AND (${moveExpr}) = ${movePh}
      AND e.home_score IS NOT NULL AND e.away_score IS NOT NULL
      ${w.extraWhere ? `AND ${w.extraWhere}` : ""}
  `;

  const rows = (await sql.unsafe(text, params as never[])) as Record<string, unknown>[];
  const row = rows[0];
  const n = Number(row?.n ?? 0);
  if (!n || n < 8) return null;
  const wins = Number(row?.wins ?? 0);
  const sumImpl = Number(row?.sum_impl ?? 0);
  const winPct = wins / n;
  const impliedPct = sumImpl / n;
  const impliedFav = move === "shortened";
  const reversed = impliedFav ? n - wins : wins;
  const reversedPct = reversed / n;
  const note =
    move === "shortened"
      ? `Oran düştü (steam) — geçmişte bu seçim ${(winPct * 100).toFixed(0)}% isabet; tersine ${(reversedPct * 100).toFixed(0)}%`
      : `Oran uzadı (drift) — geçmişte ${(winPct * 100).toFixed(0)}% isabet; beklenenin tersi ${(reversedPct * 100).toFixed(0)}%`;
  return { n, winPct, impliedPct, reversedPct, note };
}

/**
 * Konsensüs (BM'lerin çoğunluğu aynı favoriyi gösteriyor) geçmişte ne sıklıkla
 * doğru çıkmış — 1X2-profili benzer adayların TAM bookmaker grid'ini
 * (match_odds'tan, markets_json'suz) çekip favori uyumuna göre filtreler.
 */
async function historicalConsensusSQL(
  candidateIds: string[],
  favorite: "H" | "D" | "A",
  minAgree = 0.75,
): Promise<OutcomeStats | null> {
  if (!candidateIds.length) return null;
  const rows = await fetchQuoteRowsByEventIds(candidateIds.slice(0, 300));
  const byEvent = new Map<string, MatchOddsWithMetaRow[]>();
  for (const r of rows) {
    const id = String(r.event_id ?? "");
    if (!id) continue;
    const arr = byEvent.get(id);
    if (arr) arr.push(r);
    else byEvent.set(id, [r]);
  }

  const samples: SimilarMatchRow[] = [];
  for (const [id, qrows] of byEvent) {
    const compact = marketQuoteRowsToCompactOdds(qrows);
    const bmNamesMap: Record<string, string> = {};
    for (const r of qrows) {
      if (r.bookmaker) {
        bmNamesMap[String(bookmakerNameToPseudoId(String(r.bookmaker)))] = String(r.bookmaker);
      }
    }
    const grid = buildBmGrid(compact, bmNamesMap);
    if (grid.length < 10) continue;
    const favCount = grid.filter((g) => g.favorite === favorite).length;
    if (favCount / grid.length < minAgree) continue;
    const meta = qrows[0];
    const h = Number(meta.home_score);
    const a = Number(meta.away_score);
    if (!Number.isFinite(h) || !Number.isFinite(a)) continue;
    samples.push({
      id,
      season: meta.season_slug ?? "",
      home: meta.home_team ?? "",
      away: meta.away_team ?? "",
      kickoff: meta.kickoff_at ?? null,
      score: `${h}-${a}`,
      outcome: outcome1x2(h, a),
      oddsH: 0,
      oddsD: 0,
      oddsA: 0,
    });
  }
  if (samples.length < 10) return null;
  return countOutcomes(samples);
}

export async function buildSmartMatchReportSQL(input: {
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
  referenceBm?: number;
  tolerancePct?: number;
}): Promise<Omit<SmartMatchReport, "selectedRow" | "similarTableRows">> {
  const bm = input.referenceBm ?? PREFERRED_BM;
  const tol = input.tolerancePct ?? 0.03;
  const f = input.fixture;
  const home = f.home_name || "Home";
  const away = f.away_name || "Away";
  // Canlı bültende gelen bookmaker adı — match_odds'ta bookmaker İSİM olarak
  // tutuluyor, bu yüzden arşiv sorgularında numeric bm yerine ismi kullanıyoruz.
  const bmName = f.bookmakers?.[String(bm)] || PREFERRED_BM_NAME;

  const profile = extract1x2(f.odds, bm, f.home_id, f.away_id);
  const grid = buildBmGrid(f.odds, f.bookmakers, f.home_id, f.away_id);

  const similarSamples = profile ? await findSimilar1x2SQL(bmName, profile, tol) : [];
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
    profile && aligned
      ? await historicalConsensusSQL(
          similarSamples.map((s) => s.id),
          topFav,
        )
      : null;

  const movements: MovementInsight[] = [];
  const bmDisplayName = (id: string) => f.bookmakers?.[id] || `#${id}`;
  const keyMarkets: Array<[string, string, string, string?]> = [
    ["HOME_DRAW_AWAY", "FULL_TIME", "H"],
    ["HOME_DRAW_AWAY", "FULL_TIME", "D"],
    ["HOME_DRAW_AWAY", "FULL_TIME", "A"],
    ["HOME_DRAW_AWAY", "FIRST_HALF", "H"],
    ["HOME_DRAW_AWAY", "FIRST_HALF", "D"],
    ["HOME_DRAW_AWAY", "FIRST_HALF", "A"],
    ["BOTH_TEAMS_TO_SCORE", "FULL_TIME", "btts:YES"],
    ["BOTH_TEAMS_TO_SCORE", "FULL_TIME", "btts:NO"],
    ["OVER_UNDER", "FULL_TIME", "OVER", "2.5"],
    ["OVER_UNDER", "FULL_TIME", "UNDER", "2.5"],
    ["DOUBLE_CHANCE", "FULL_TIME", "DC:1X"],
    ["DOUBLE_CHANCE", "FULL_TIME", "DC:12"],
    ["DOUBLE_CHANCE", "FULL_TIME", "DC:X2"],
    ...AH_LINES.map((l): [string, string, string, string] => ["ASIAN_HANDICAP", "FULL_TIME", "H", String(l)]),
    ...CS_KEY_SCORES.map((s): [string, string, string] => ["CORRECT_SCORE", "FULL_TIME", `score:${s}`]),
  ];

  for (const [mtype, scope, side, line] of keyMarkets) {
    const sideTok =
      line && (mtype === "OVER_UNDER" || mtype === "ASIAN_HANDICAP") ? `${side}:${line}` : side;
    const p = pickOdds(f.odds, bm, mtype, scope, sideTok, f.home_id, f.away_id);
    if (p.opening == null || p.closing == null) continue;
    const move = moveKind(p.opening, p.closing);
    if (!move || move === "stable") continue;
    const ch = pctChange(p.opening, p.closing);
    const historical = await historicalForMoveSQL(
      bmName,
      mtype,
      scope,
      sideTok,
      p.closing,
      move,
      tol,
      line,
    );
    const { marketLabel, sideLabel: sideLbl } = describeMovement(mtype, scope, side, line);
    movements.push({
      market: mtype,
      marketLabel,
      scope,
      side: sideTok,
      sideLabel: sideLbl,
      bookmakerId: String(bm),
      bookmakerName: bmDisplayName(String(bm)),
      opening: p.opening,
      closing: p.closing,
      changePct: Math.round(ch * 10) / 10,
      move,
      historical,
    });
  }
  movements.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));
  const limitedMovements = movements.slice(0, 20);

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
    summary.push(
      `Bookmaker'lar dağılmış — tek yönde güçlü konsensüs yok (en çok MS ${sideLabel(topFav)}: ${alignedCount}/${totalBm}).`,
    );
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
    archiveMatches: similar1x2.n,
    archiveSource: "supabase:match_odds",
    profile1x2: profile,
    similar1x2,
    movements: limitedMovements,
    bookmakerGrid: grid,
    consensus: {
      favorite: totalBm ? topFav : null,
      counts: favCounts,
      aligned,
      alignedPct: totalBm ? (alignedCount / totalBm) * 100 : 0,
      historical: consensusHist,
    },
    summary,
  };
}
