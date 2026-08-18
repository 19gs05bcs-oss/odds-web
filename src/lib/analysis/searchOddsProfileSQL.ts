/**
 * searchOddsProfile'ın Postgres tabanlı eşdeğeri.
 *
 * ESKİSİ: DuckDB'nin quotes_flat (Koyeb'den NDJSON stream edilip
 * materialize edilmiş) tablosuna karşı çalışıyordu.
 *
 * ŞİMDİ: doğrudan `match_odds` tablosuna (bkz. marketQuotes.ts,
 * marketQuoteCriteria.ts) sql.unsafe ile basit bir WHERE atıp
 * (buildQuoteCandidateCte) event_id üzerinden JOIN ediyor — "N kriterin
 * AND'i" işini Postgres'in kendi execution planına devrediyoruz, Node
 * RAM'inde büyük bir ara küme tutmuyoruz. DuckDB/Koyeb'e hiç dokunmuyor.
 *
 * SQL filtresi kasıtlı olarak biraz gevşek (side için prefix/OR eşleşmesi) —
 * sonuç seti (yüzlerce satır) üzerinde profile.ts'teki BİREBİR AYNI
 * `quoteMatchesCriterion` fonksiyonu ile kesin doğrulama yapılıyor.
 *
 * NOT: match_odds maç meta'sı (home_team/away_team/score/competition) TAŞIMAZ
 * — o `events` tablosunda (id = match_odds.event_id). Meta burada match_odds
 * üzerinden değil, doğrudan events'ten JOIN edilir.
 */
import { MATCH_ODDS_TABLE } from "./marketQuotes";
import { buildQuoteCandidateCte, runCriteriaQuery } from "./marketQuoteCriteria";
import { loadBookmakerNames } from "./bookmakerNames";
import { prettySideName } from "./labels";
import {
  quoteMatchesCriterion,
  type OddsCriterion,
  type ProfileMatch,
  type ProfileQuery,
  type ProfileResult,
  type CriterionHit,
} from "./profile";
import type { Quote } from "./types";

const EVENTS_TABLE = "events";

type SqlRow = Record<string, unknown>;

type SqlBuild = { text: string; params: unknown[] };

function buildQuery(query: ProfileQuery, fetchLimit: number): SqlBuild | null {
  const criteria = query.criteria.filter((c) => c.targetOdds > 1);
  if (!criteria.length) return null;

  const params: unknown[] = [];
  const push = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };

  const tol = query.tolerance != null && query.tolerance >= 0 ? query.tolerance : 0;
  const bm = query.bookmakerId || null;
  const seasons = (query.seasonSlugs ?? []).filter(Boolean);

  const ctes = criteria.map((c, i) => {
    const effTol = tol > 0 ? tol : 0.005;
    return buildQuoteCandidateCte(
      `q${i}`,
      {
        marketType: c.marketType,
        marketScope: c.marketScope || "FULL_TIME",
        side: c.side,
        line: c.line ?? null,
        oddsRange: [c.targetOdds - effTol, c.targetOdds + effTol],
        price: c.price,
        bookmakerId: bm,
        seasonSlugs: seasons,
      },
      push,
    );
  });

  const joinCols = criteria
    .map(
      (_, i) =>
        `q${i}.side AS c${i}_side, q${i}.line AS c${i}_line, q${i}.opening AS c${i}_opening, q${i}.current AS c${i}_closing, q${i}.bookmaker_id AS c${i}_bookmaker_id`,
    )
    .join(",\n      ");

  const joins = criteria
    .slice(1)
    .map((_, idx) => `JOIN q${idx + 1} ON q${idx + 1}.event_id = q0.event_id`)
    .join("\n      ");

  const outerJoinCols = criteria
    .map((_, i) => `j.c${i}_side, j.c${i}_line, j.c${i}_opening, j.c${i}_closing, j.c${i}_bookmaker_id`)
    .join(",\n      ");

  let seasonWhere = "";
  if (seasons.length) {
    const phs = seasons.map((s) => push(s));
    seasonWhere = `WHERE season_slug IN (${phs.join(", ")})`;
  }

  const limitPh = push(fetchLimit);

  const text = `
    WITH ${ctes.join(",\n")}
    , joined AS (
      SELECT q0.event_id,
      ${joinCols}
      FROM q0
      ${joins}
    )
    SELECT
      e.event_id, e.source_event_id, e.competition, e.season_slug, e.round,
      e.home_team, e.away_team, e.kickoff_at, e.home_score, e.away_score,
      e.home_ht_score, e.away_ht_score,
      ${outerJoinCols}
    FROM joined j
    JOIN (
      SELECT id AS event_id, source_event_id, competition, season_slug, round,
             home_team, away_team, kickoff_at, home_score, away_score,
             home_ht_score, away_ht_score
      FROM ${EVENTS_TABLE}
      ${seasonWhere}
    ) e ON e.event_id = j.event_id
    LIMIT ${limitPh}
  `;

  return { text, params };
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Postgres (match_odds) üzerinden çok kriterli profile araması. */
export async function searchOddsProfileSQL(query: ProfileQuery): Promise<ProfileResult> {
  const t0 = Date.now();
  const criteria = query.criteria.filter((c) => c.targetOdds > 1);
  const tol = query.tolerance != null && query.tolerance >= 0 ? query.tolerance : 0;
  const limit = query.limit && query.limit > 0 ? Math.min(query.limit, 500) : 200;
  const bm = query.bookmakerId || null;

  if (!criteria.length) {
    return { matches: [], totalMatched: 0, truncated: false, tookMs: 0, criteria };
  }

  // JS tarafında kesin doğrulamada bir kısmı elenecek — biraz fazla çek.
  const fetchLimit = Math.min(Math.max(limit * 4, 400), 3000);
  const built = buildQuery(query, fetchLimit);
  if (!built) {
    return { matches: [], totalMatched: 0, truncated: false, tookMs: 0, criteria };
  }

  const rows = await runCriteriaQuery<SqlRow>(built.text, built.params);
  const bmNames = await loadBookmakerNames();

  const matches: ProfileMatch[] = [];
  for (const row of rows) {
    const hits: (CriterionHit | null)[] = new Array(criteria.length).fill(null);
    let ok = true;

    for (let i = 0; i < criteria.length; i++) {
      const c = criteria[i];
      const side = row[`c${i}_side`] as string | null;
      const line = row[`c${i}_line`] as string | number | null;
      const opening = num(row[`c${i}_opening`]);
      const closing = num(row[`c${i}_closing`]);
      const bookmakerIdRaw = row[`c${i}_bookmaker_id`];
      const bookmakerId = bookmakerIdRaw != null ? String(bookmakerIdRaw) : null;

      if (!side || (opening == null && closing == null)) {
        ok = false;
        break;
      }

      // profile.ts'teki BİREBİR AYNI fonksiyon — SQL'in kaba filtresini kesinleştirir.
      const fakeQuote: Quote = {
        eventId: String(row.event_id),
        sourceEventId: String(row.source_event_id ?? ""),
        competition: (row.competition as string) ?? null,
        seasonSlug: (row.season_slug as string) ?? null,
        round: (row.round as string) ?? null,
        homeTeam: (row.home_team as string) ?? null,
        awayTeam: (row.away_team as string) ?? null,
        kickoffAt: (row.kickoff_at as string) ?? null,
        homeScore: num(row.home_score),
        awayScore: num(row.away_score),
        homeHtScore: num(row.home_ht_score),
        awayHtScore: num(row.away_ht_score),
        marketType: c.marketType,
        marketScope: c.marketScope,
        marketKey: `${c.marketType}:${c.marketScope}`,
        marketName: c.marketType,
        line: line != null ? String(line) : null,
        side,
        sideName: "",
        opening,
        closing,
        bookmakerId,
        bookmakerName: bookmakerId ? bmNames.get(bookmakerId) ?? bookmakerId : null,
        suspended: false,
      };

      if (!quoteMatchesCriterion(fakeQuote, c, tol, bm)) {
        ok = false;
        break;
      }

      hits[i] = {
        marketType: c.marketType,
        marketScope: c.marketScope,
        side,
        sideName: prettySideName(side, null, c.marketType),
        line: c.line ?? null,
        targetOdds: c.targetOdds,
        closing,
        opening,
        bookmakerId,
        bookmakerName: fakeQuote.bookmakerName,
      };
    }

    if (!ok) continue;

    matches.push({
      eventId: String(row.event_id),
      sourceEventId: String(row.source_event_id ?? ""),
      competition: (row.competition as string) ?? null,
      seasonSlug: (row.season_slug as string) ?? null,
      round: (row.round as string) ?? null,
      homeTeam: (row.home_team as string) ?? null,
      awayTeam: (row.away_team as string) ?? null,
      kickoffAt: (row.kickoff_at as string) ?? null,
      score:
        row.home_score != null && row.away_score != null
          ? `${row.home_score}-${row.away_score}`
          : null,
      htScore:
        row.home_ht_score != null && row.away_ht_score != null
          ? `${row.home_ht_score}-${row.away_ht_score}`
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

  const truncated = matches.length > limit || rows.length >= fetchLimit;

  return {
    matches: matches.slice(0, limit),
    totalMatched: matches.length,
    truncated,
    tookMs: Date.now() - t0,
    criteria,
  };
}
