/**
 * Flat oran tablosu ("match_odds") üzerinde çalışan Postgres data-access
 * katmanı.
 *
 * ESKİSİ: DuckDB'ye Koyeb'den NDJSON stream edilip materialize edilen
 * `quotes_flat` (bkz. duckdbMaterialize.ts / duckdbQuotes.ts — artık
 * kullanılmıyor, deprecated).
 *
 * ŞİMDİ: Zaten production'da sorunsuz çalışan `sql` (postgres.js,
 * Supavisor transaction pooler — bkz. src/lib/db.ts) bağlantısını,
 * `match_odds` tablosuna doğrudan filtreli SELECT atmak için kullanıyoruz.
 * events.markets_json hiçbir yerde parse edilmiyor, DuckDB/Koyeb hiç devreye
 * girmiyor.
 *
 * VARSAYILAN ŞEMA (gerçek kolon adları farklıysa aşağıdaki sabiti / SELECT
 * listelerini güncelle):
 *   event_id, source_event_id, season_slug, competition, round,
 *   home_team, away_team, kickoff_at,
 *   home_score, away_score, home_ht_score, away_ht_score,
 *   bookmaker_id, market_type, market_scope, side, opening, closing, active
 */
import { sql } from "@/lib/db";
import { marketTypeLabel } from "./labels";

/** Gerçek tablo adı market_quotes DEĞİL, match_odds. */
export const MATCH_ODDS_TABLE = "match_odds";

export type SqlParamPusher = (v: unknown) => string;

export type MatchOddsRow = {
  event_id: string;
  source_event_id: string | null;
  season_slug: string | null;
  competition: string | null;
  round: string | null;
  home_team: string | null;
  away_team: string | null;
  kickoff_at: string | null;
  home_score: number | string | null;
  away_score: number | string | null;
  home_ht_score: number | string | null;
  away_ht_score: number | string | null;
  bookmaker_id: number | string | null;
  market_type: string | null;
  market_scope: string | null;
  side: string | null;
  opening: number | string | null;
  closing: number | string | null;
  active: boolean | string | null;
};

/** Bir event'in tüm quote satırlarını + meta'sını taşıyan SELECT listesi. */
export const MATCH_ODDS_FULL_SELECT = `
  event_id, source_event_id, season_slug, competition, round,
  home_team, away_team, kickoff_at,
  home_score, away_score, home_ht_score, away_ht_score,
  bookmaker_id, market_type, market_scope, side, opening, closing, active`;

/** Sadece event meta (DISTINCT ON event_id) — quote satırı gerekmeyen yerlerde. */
export const MATCH_ODDS_EVENT_META_SELECT = `
  event_id, source_event_id, season_slug, competition, round,
  home_team, away_team, kickoff_at,
  home_score, away_score, home_ht_score, away_ht_score`;

/** Aşırı geniş/filtresiz istekte bile Node'a inen satır sayısını sınırlayan güvenlik supabı. */
export const HARD_ROW_CAP = 20_000;

export type SeasonQuotesFilters = {
  seasonSlug: string;
  marketType?: string | null;
  marketScope?: string | null;
  bookmakerId?: string | null;
  minOdds?: number | null;
  maxOdds?: number | null;
  targetOdds?: number | null;
  oddsTolerance?: number | null;
  dateFrom?: string | null;
  dateTo?: string | null;
};

/**
 * Bir sezonun ham quote adaylarını match_odds'tan çeken SQL. Kesin filtre
 * (side substring, competition substring, round, date range post-check)
 * hâlâ analyzeSeasonSQL.ts → analyzeQuotes içinde, değişmeden çalışır —
 * burada sadece satır hacmini erken daraltıyoruz.
 */
export function buildSeasonQuotesSql(f: SeasonQuotesFilters, push: SqlParamPusher): string {
  const conds = [`season_slug = ${push(f.seasonSlug)}`];
  if (f.marketType) conds.push(`market_type = ${push(f.marketType)}`);
  if (f.marketScope) conds.push(`market_scope = ${push(f.marketScope)}`);
  if (f.bookmakerId) {
    conds.push(`(bookmaker_id IS NULL OR bookmaker_id = ${push(String(f.bookmakerId))})`);
  }
  if (f.dateFrom) conds.push(`kickoff_at >= ${push(f.dateFrom)}`);
  if (f.dateTo) conds.push(`kickoff_at <= ${push(f.dateTo)}`);

  // odds = closing ?? opening (analyze.ts/filters.ts semantiği) — SQL'de OR ile
  // over-inclusive tutuyoruz, kesin seçim JS'te quoteMatchesFilters'ta yapılıyor.
  if (f.minOdds != null) {
    const ph = push(f.minOdds);
    conds.push(`(closing >= ${ph} OR opening >= ${ph})`);
  }
  if (f.maxOdds != null) {
    const ph = push(f.maxOdds);
    conds.push(`(closing <= ${ph} OR opening <= ${ph})`);
  }
  if (f.targetOdds != null) {
    const tol = f.oddsTolerance != null && f.oddsTolerance >= 0 ? f.oddsTolerance : 0.05;
    const lo = push(f.targetOdds - tol);
    const hi = push(f.targetOdds + tol);
    conds.push(`((closing BETWEEN ${lo} AND ${hi}) OR (opening BETWEEN ${lo} AND ${hi}))`);
  }

  return `
    SELECT ${MATCH_ODDS_FULL_SELECT}
    FROM ${MATCH_ODDS_TABLE}
    WHERE ${conds.join(" AND ")}`;
}

/** analyzeSeasonSQL.ts'in kaynağı: bir sezonun filtrelenmiş flat satırları. */
export async function fetchSeasonQuoteRows(
  filters: SeasonQuotesFilters,
  hardCap: number = HARD_ROW_CAP,
): Promise<MatchOddsRow[]> {
  const params: unknown[] = [];
  const push: SqlParamPusher = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  const body = buildSeasonQuotesSql(filters, push);
  const limitPh = push(hardCap);
  const text = `${body}\n    LIMIT ${limitPh}`;
  return sql.unsafe(text, params as never[]) as unknown as Promise<MatchOddsRow[]>;
}

/** Verilen event_id listesi için TÜM quote satırlarını (tam bookmaker grid'i) çeker. */
export async function fetchQuoteRowsByEventIds(eventIds: string[]): Promise<MatchOddsRow[]> {
  const ids = [...new Set(eventIds)].filter(Boolean);
  if (!ids.length) return [];
  const rows = await sql.unsafe(
    `SELECT ${MATCH_ODDS_FULL_SELECT} FROM ${MATCH_ODDS_TABLE} WHERE event_id = ANY($1)`,
    [ids] as never[],
  );
  return rows as unknown as MatchOddsRow[];
}

/** Bir sezondaki distinct market type'ları (filtre dropdown'ı için). */
export async function listDistinctSeasonMarketTypes(
  seasonSlug: string,
): Promise<{ type: string; label: string }[]> {
  if (!seasonSlug) return [];
  try {
    const rows = (await sql.unsafe(
      `SELECT DISTINCT market_type FROM ${MATCH_ODDS_TABLE} WHERE season_slug = $1 AND market_type IS NOT NULL`,
      [seasonSlug] as never[],
    )) as { market_type: string }[];
    return rows
      .map((r) => ({ type: r.market_type, label: marketTypeLabel(r.market_type) }))
      .sort((a, b) => a.label.localeCompare(b.label, "tr"));
  } catch (err) {
    console.error("[marketQuotes] listDistinctSeasonMarketTypes error:", err);
    return [];
  }
}

/** Bir sezondaki (veya tüm arşivdeki) distinct bookmaker id'leri. */
export async function listDistinctBookmakerIds(seasonSlug?: string | null): Promise<string[]> {
  try {
    const rows = seasonSlug
      ? ((await sql.unsafe(
          `SELECT DISTINCT bookmaker_id FROM ${MATCH_ODDS_TABLE} WHERE season_slug = $1 AND bookmaker_id IS NOT NULL`,
          [seasonSlug] as never[],
        )) as { bookmaker_id: string | number }[])
      : ((await sql.unsafe(
          `SELECT DISTINCT bookmaker_id FROM ${MATCH_ODDS_TABLE} WHERE bookmaker_id IS NOT NULL LIMIT 500`,
        )) as { bookmaker_id: string | number }[]);
    return rows.map((r) => String(r.bookmaker_id)).filter(Boolean);
  } catch (err) {
    console.error("[marketQuotes] listDistinctBookmakerIds error:", err);
    return [];
  }
}
