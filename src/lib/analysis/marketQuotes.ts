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
 * GERÇEK ŞEMA — match_odds (flat quote satırı, maç meta'sı YOK):
 *   idx, id, event_id, season_slug, kickoff_at,
 *   bookmaker (metin, ör. "bet365" — sayısal id DEĞİL),
 *   market (birleşik "TYPE:SCOPE", ör. "HOME_DRAW_AWAY:FIRST_HALF"),
 *   selection (ör. "H", "OVER", "btts:YES"), line, odds (güncel/kapanış),
 *   opening, active
 *
 * Maç meta'sı (home_team/away_team/competition/round/score/source_event_id)
 * match_odds'ta YOK — events tablosundan event_id = events.id ile JOIN
 * edilir (bkz. fixtures.ts'teki events sorguları, aynı tablo/kolonlar).
 */
import { sql } from "@/lib/db";
import { marketTypeLabel } from "./labels";
import { splitMarket } from "./marketFormat";
export { splitMarket };

/** Gerçek tablo adı market_quotes DEĞİL, match_odds. */
export const MATCH_ODDS_TABLE = "match_odds";

/** Maç meta'sının yaşadığı tablo — match_odds.event_id buraya JOIN edilir. */
export const EVENTS_TABLE = "events";

export type SqlParamPusher = (v: unknown) => string;

/** match_odds tablosunun ham satırı — event meta içermez. */
export type MatchOddsRow = {
  event_id: string;
  season_slug: string | null;
  kickoff_at: string | null;
  bookmaker: string | null;
  market: string | null;
  selection: string | null;
  line: string | number | null;
  odds: number | string | null;
  opening: number | string | null;
  active: boolean | string | null;
};

/** match_odds JOIN events — tam satır (meta dahil). */
export type MatchOddsWithMetaRow = MatchOddsRow & {
  source_event_id: string | null;
  competition: string | null;
  round: string | null;
  home_team: string | null;
  away_team: string | null;
  home_score: number | string | null;
  away_score: number | string | null;
  home_ht_score: number | string | null;
  away_ht_score: number | string | null;
};

/** Bir quote satırının kendi kolonları — meta hariç. */
const QUOTE_COLS = `q.event_id, q.season_slug, q.kickoff_at, q.bookmaker, q.market, q.selection, q.line, q.odds, q.opening, q.active`;

/** Bir event'in tüm quote satırlarını + meta'sını taşıyan SELECT listesi (events JOIN'li). */
export const MATCH_ODDS_FULL_SELECT = `
  ${QUOTE_COLS},
  e.source_event_id, e.competition, e.round,
  e.home_team, e.away_team,
  e.home_score, e.away_score, e.home_ht_score, e.away_ht_score`;

/** Sadece event meta (DISTINCT event_id) — quote satırı gerekmeyen yerlerde. */
export const MATCH_ODDS_EVENT_META_SELECT = `
  e.id AS event_id, e.source_event_id, e.season_slug, e.competition, e.round,
  e.home_team, e.away_team, e.kickoff_at,
  e.home_score, e.away_score, e.home_ht_score, e.away_ht_score`;

/** match_odds -> events JOIN'li FROM/JOIN klozu — tüm sorgular bunu paylaşır. */
const FROM_JOIN = `FROM ${MATCH_ODDS_TABLE} q JOIN ${EVENTS_TABLE} e ON e.id = q.event_id`;

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
 *
 * NOT: market_type/market_scope ayrı kolon değil — market (birleşik) üzerinden
 * filtreleniyor; bookmakerId artık isim (bookmaker metin kolonu) ile eşleşiyor.
 */
export function buildSeasonQuotesSql(f: SeasonQuotesFilters, push: SqlParamPusher): string {
  const conds = [`q.season_slug = ${push(f.seasonSlug)}`];
  if (f.marketType) {
    const marketPh = push(`${f.marketType}:${f.marketScope || "FULL_TIME"}`);
    conds.push(`q.market = ${marketPh}`);
  }
  if (f.bookmakerId) {
    conds.push(`(q.bookmaker IS NULL OR q.bookmaker = ${push(String(f.bookmakerId))})`);
  }
  if (f.dateFrom) conds.push(`q.kickoff_at >= ${push(f.dateFrom)}`);
  if (f.dateTo) conds.push(`q.kickoff_at <= ${push(f.dateTo)}`);

  // odds = closing/güncel değer (analyze.ts/filters.ts semantiği) — SQL'de OR ile
  // over-inclusive tutuyoruz, kesin seçim JS'te quoteMatchesFilters'ta yapılıyor.
  if (f.minOdds != null) {
    const ph = push(f.minOdds);
    conds.push(`(q.odds >= ${ph} OR q.opening >= ${ph})`);
  }
  if (f.maxOdds != null) {
    const ph = push(f.maxOdds);
    conds.push(`(q.odds <= ${ph} OR q.opening <= ${ph})`);
  }
  if (f.targetOdds != null) {
    const tol = f.oddsTolerance != null && f.oddsTolerance >= 0 ? f.oddsTolerance : 0.05;
    const lo = push(f.targetOdds - tol);
    const hi = push(f.targetOdds + tol);
    conds.push(`((q.odds BETWEEN ${lo} AND ${hi}) OR (q.opening BETWEEN ${lo} AND ${hi}))`);
  }

  return `
    SELECT ${MATCH_ODDS_FULL_SELECT}
    ${FROM_JOIN}
    WHERE ${conds.join(" AND ")}`;
}

/** analyzeSeasonSQL.ts'in kaynağı: bir sezonun filtrelenmiş flat satırları. */
export async function fetchSeasonQuoteRows(
  filters: SeasonQuotesFilters,
  hardCap: number = HARD_ROW_CAP,
): Promise<MatchOddsWithMetaRow[]> {
  const params: unknown[] = [];
  const push: SqlParamPusher = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  const body = buildSeasonQuotesSql(filters, push);
  const limitPh = push(hardCap);
  const text = `${body}\n    LIMIT ${limitPh}`;
  return sql.unsafe(text, params as never[]) as unknown as Promise<MatchOddsWithMetaRow[]>;
}

/** Verilen event_id listesi için TÜM quote satırlarını (tam bookmaker grid'i) çeker. */
export async function fetchQuoteRowsByEventIds(eventIds: string[]): Promise<MatchOddsWithMetaRow[]> {
  const ids = [...new Set(eventIds)].filter(Boolean);
  if (!ids.length) return [];
  const rows = await sql.unsafe(
    `SELECT ${MATCH_ODDS_FULL_SELECT} ${FROM_JOIN} WHERE q.event_id = ANY($1)`,
    [ids] as never[],
  );
  return rows as unknown as MatchOddsWithMetaRow[];
}

/** Bir sezondaki distinct market type'ları (filtre dropdown'ı için). "market" birleşik kolondan türetilir. */
export async function listDistinctSeasonMarketTypes(
  seasonSlug: string,
): Promise<{ type: string; label: string }[]> {
  if (!seasonSlug) return [];
  try {
    const rows = (await sql.unsafe(
      `SELECT DISTINCT market FROM ${MATCH_ODDS_TABLE} WHERE season_slug = $1 AND market IS NOT NULL`,
      [seasonSlug] as never[],
    )) as { market: string }[];
    const types = new Set<string>();
    for (const r of rows) types.add(splitMarket(r.market).marketType);
    return [...types]
      .map((type) => ({ type, label: marketTypeLabel(type) }))
      .sort((a, b) => a.label.localeCompare(b.label, "tr"));
  } catch (err) {
    console.error("[marketQuotes] listDistinctSeasonMarketTypes error:", err);
    return [];
  }
}

/** Bir sezondaki (veya tüm arşivdeki) distinct bookmaker isimleri ("id" olarak string döner). */
export async function listDistinctBookmakerIds(seasonSlug?: string | null): Promise<string[]> {
  try {
    const rows = seasonSlug
      ? ((await sql.unsafe(
          `SELECT DISTINCT bookmaker FROM ${MATCH_ODDS_TABLE} WHERE season_slug = $1 AND bookmaker IS NOT NULL`,
          [seasonSlug] as never[],
        )) as { bookmaker: string }[])
      : ((await sql.unsafe(
          `SELECT DISTINCT bookmaker FROM ${MATCH_ODDS_TABLE} WHERE bookmaker IS NOT NULL LIMIT 500`,
        )) as { bookmaker: string }[]);
    return rows.map((r) => String(r.bookmaker)).filter(Boolean);
  } catch (err) {
    console.error("[marketQuotes] listDistinctBookmakerIds error:", err);
    return [];
  }
}
