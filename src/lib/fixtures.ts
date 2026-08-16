import { unstable_cache } from "next/cache";
import { analyzeQuotes } from "@/lib/analysis/analyze";
import { parseFilterState } from "@/lib/analysis/filters";
import { eventsMetaAndQuotesToTableRows, profileMatchToTableRow, PREFERRED_BM_NAME, type TableRow } from "@/lib/analysis/tableRows";
import { fetchQuoteRowsByEventIds, listDistinctBookmakerIds, listDistinctSeasonMarketTypes } from "@/lib/analysis/marketQuotes";
import { loadBookmakerNames } from "@/lib/analysis/bookmakerNames";
import type { ProfileQuery, ProfileResult } from "@/lib/analysis/profile";
import type { AnalyzeResult, FilterState } from "@/lib/analysis/types";
import type { FetchResult } from "@/lib/archive";
import { sql } from "@/lib/db";
import type { OddsEvent, SeasonRow, BookmakerOption } from "@/lib/types";

export type MarketOption = { type: string; label: string };
export type { BookmakerOption };
export type { FixtureRow, CompactOddsRow } from "@/lib/archiveCache";

/** Avoid `arr.push(...huge)` — that throws Maximum call stack size exceeded. */
function appendAll<T>(target: T[], items: readonly T[]): void {
  for (let i = 0; i < items.length; i++) target.push(items[i]);
}

const META_COLS_BASE =
  "id,source,source_event_id,sport,competition,home_team,away_team,kickoff_at,status,is_closed,markets_hash,odds_updated_at,opening_captured_at,closing_captured_at,created_at,updated_at,round,home_score,away_score,season_slug";

const META_COLS =
  "id,source,source_event_id,sport,competition,home_team,away_team,kickoff_at,status,is_closed,markets_hash,odds_updated_at,opening_captured_at,closing_captured_at,created_at,updated_at,round,home_score,away_score,home_ht_score,away_ht_score,season_slug";

const FULL_COLS = META_COLS + ",markets_json";
const FULL_COLS_BASE = META_COLS_BASE + ",markets_json";

function isMissingHtColumn(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /home_ht_score|away_ht_score|42703/i.test(message);
}

// fixtures.ts icindeki fetchSeasonsUncached'i BUNUNLA degistir:
// (listSeasons = unstable_cache(fetchSeasonsUncached, ...) satiri AYNEN kalir)

async function fetchSeasonsUncached(): Promise<FetchResult<SeasonRow[]>> {
  try {
    const { fetchKoyebSeasonsMeta } = await import("@/lib/koyebCache");
    const seasons = await fetchKoyebSeasonsMeta();
    // KoyebSeasonMeta ile SeasonRow ayni alan adlarini kullaniyor —
    // dogrudan atanabilir. Bu artik hem Supabase'de canli takip edilen
    // sezonlari HEM GitHub'daki 330 tarihsel sezonu birlikte dondurur
    // (archive_cache_server.py._fetch_seasons_meta zaten ikisini birlestiriyor).
    return { ok: true, data: seasons as unknown as SeasonRow[] };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export const listSeasons = unstable_cache(fetchSeasonsUncached, ["flashscore-seasons"], {
  revalidate: 300,
  tags: ["seasons"],
});

/** Distinct market types for a season, read straight from match_odds. */
export async function listSeasonMarkets(seasonSlug: string): Promise<MarketOption[]> {
  if (!seasonSlug) return [];
  return listDistinctSeasonMarketTypes(seasonSlug);
}

export async function listEventMetaBySeason(
  seasonSlug: string,
): Promise<FetchResult<OddsEvent[]>> {
  try {
    const query = `SELECT ${META_COLS} FROM events WHERE source = 'flashscore' AND season_slug = $1 ORDER BY kickoff_at ASC`;
    const data = await sql.unsafe<OddsEvent[]>(query, [seasonSlug]);
    return { ok: true, data };
  } catch (error) {
    if (isMissingHtColumn(error)) {
      try {
        const retryQuery = `SELECT ${META_COLS_BASE} FROM events WHERE source = 'flashscore' AND season_slug = $1 ORDER BY kickoff_at ASC`;
        const retryData = await sql.unsafe<OddsEvent[]>(retryQuery, [seasonSlug]);
        return { ok: true, data: retryData };
      } catch (retryError) {
        return { ok: false, error: retryError instanceof Error ? retryError.message : String(retryError) };
      }
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function fetchEventsWithMarkets(seasonSlug: string): Promise<OddsEvent[]> {
  const pageSize = 200;
  let from = 0;
  const all: OddsEvent[] = [];
  let useHt = true;
  
  for (;;) {
    const cols = useHt ? FULL_COLS : FULL_COLS_BASE;
    try {
      const query = `SELECT ${cols} FROM events WHERE source = 'flashscore' AND season_slug = $1 ORDER BY kickoff_at ASC LIMIT $2 OFFSET $3`;
      const batch = await sql.unsafe<OddsEvent[]>(query, [seasonSlug, pageSize, from]);
      
      all.push(...batch);
      if (batch.length < pageSize) break;
      from += pageSize;
    } catch (error) {
      if (useHt && isMissingHtColumn(error)) {
        useHt = false;
        from = 0;
        all.length = 0;
        continue;
      }
      throw error;
    }
  }
  return all;
}

/**
 * Tek bir event'i markets_json dahil id ile çeker. searchProfile (DuckDB
 * yolu) eşleşen event_id listesini bulduktan SONRA, sadece o birkaç yüz
 * maçın tam bookmaker grid'ini almak için kullanır — sezonun tamamını değil.
 */
async function fetchEventsWithMarketsByIds(eventIds: string[]): Promise<Map<string, OddsEvent>> {
  const ids = [...new Set(eventIds)];
  const map = new Map<string, OddsEvent>();
  if (!ids.length) return map;
  try {
    const query = `SELECT ${FULL_COLS} FROM events WHERE id = ANY($1)`;
    const rows = await sql.unsafe<OddsEvent[]>(query, [ids]);
    for (const r of rows) map.set(r.id, r);
    return map;
  } catch (error) {
    if (!isMissingHtColumn(error)) throw error;
  }
  const query = `SELECT ${FULL_COLS_BASE} FROM events WHERE id = ANY($1)`;
  const rows = await sql.unsafe<OddsEvent[]>(query, [ids]);
  for (const r of rows) map.set(r.id, r);
  return map;
}

/** Full markets_json seasons exceed Next 2MB data-cache limit — do not unstable_cache. */
// fixtures.ts icindeki loadSeasonEvents'i BUNUNLA degistir:

export async function loadSeasonEvents(seasonSlug: string): Promise<OddsEvent[]> {
  const { fetchKoyebArchiveSeason } = await import("@/lib/koyebCache");
  const { events } = await fetchKoyebArchiveSeason(seasonSlug);
  return events as unknown as OddsEvent[];
}

/**
 * Archive quotes — match_odds tablosundan, market/scope/bookmaker/odds
 * filtresiyle erken daraltılmış olarak doğrudan Postgres'ten çekilir (bkz.
 * analyzeSeasonSQL.ts). Sezonun TÜM markets_json'ını Node'a çekip
 * normalizeMany ile parse etmiyoruz; DuckDB/Koyeb'e hiç dokunulmuyor.
 */
export async function analyzeSeason(filters: FilterState): Promise<FetchResult<AnalyzeResult>> {
  if (!filters.seasonSlug) {
    return { ok: false, error: "seasonSlug gerekli." };
  }

  try {
    const { loadSeasonQuotesSQL } = await import("@/lib/analysis/analyzeSeasonSQL");
    const quotes = await loadSeasonQuotesSQL({ ...filters, seasonSlug: filters.seasonSlug });
    const result = analyzeQuotes(quotes, filters);
    return { ok: true, data: result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function analyzeFromSearchParams(
  params: URLSearchParams,
): Promise<FetchResult<AnalyzeResult>> {
  const filters = parseFilterState(params);
  return analyzeSeason(filters);
}

/**
 * Stacked odds profile search — doğrudan Postgres'in `match_odds` tablosuna
 * karşı (bkz. searchOddsProfileSQL.ts). Node'da global bir "24 sezon RAM'de"
 * cache YOK; DuckDB/Koyeb'e hiç dokunulmuyor.
 */
export async function searchProfile(
  query: ProfileQuery,
): Promise<FetchResult<ProfileResult & { tableRows: TableRow[]; cacheStatus?: string }>> {
  if (!query.criteria.length) {
    return {
      ok: true,
      data: {
        matches: [],
        totalMatched: 0,
        truncated: false,
        tookMs: 0,
        criteria: [],
        tableRows: [],
      },
    };
  }

  // match_odds.bookmaker artık isim (ör. "bet365") — sayısal Flashscore id değil.
  const preferredBm = query.bookmakerId || PREFERRED_BM_NAME;

  try {
    const { searchOddsProfileSQL } = await import("@/lib/analysis/searchOddsProfileSQL");
    const result = await searchOddsProfileSQL(query);

    // Eşleşen event'lerin tüm bookmaker grid'ini TEK sorguda match_odds'tan
    // çekiyoruz — events.markets_json'a hiç dokunmuyoruz.
    const quoteRows = await fetchQuoteRowsByEventIds(result.matches.map((m) => m.eventId));
    const fullRowsById = eventsMetaAndQuotesToTableRows(quoteRows, preferredBm);

    const tableRows: TableRow[] = result.matches.map((m) => {
      const hitsRow = profileMatchToTableRow(m);
      const full = fullRowsById.get(m.eventId);
      if (!full) return hitsRow;
      for (const [colId, cell] of Object.entries(hitsRow.odds)) {
        if (cell) full.odds[colId] = cell;
      }
      return full;
    });

    return {
      ok: true,
      data: { ...result, tableRows, cacheStatus: "postgres:match_odds" },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Bookmaker id → isim listesi — match_odds'taki distinct id'ler, fixture.bookmakers'tan isimlendirilir. */
async function fetchBookmakersUncached(seasonSlug?: string): Promise<BookmakerOption[]> {
  try {
    const [ids, names] = await Promise.all([
      listDistinctBookmakerIds(seasonSlug || null),
      loadBookmakerNames(),
    ]);
    return ids
      .map((id) => ({ id, name: names.get(id) || id }))
      .sort((a, b) => a.name.localeCompare(b.name, "en"));
  } catch (err) {
    console.error("listBookmakers error:", err);
    return [];
  }
}

/**
 * `listDistinctBookmakerIds` match_odds üzerinde tam tablo taramalı bir
 * `SELECT DISTINCT` çalıştırıyor — bookmaker listesi neredeyse hiç
 * değişmediği halde bu her sayfa yüklemesinde (force-dynamic SSR) tekrar
 * çalışıyordu ve Supabase compute/CPU'yu tüketen asıl sorgulardan biriydi.
 * unstable_cache ile sarmalayıp 1 saatlik bir pencerede tek sorguya
 * düşürüyoruz; argümanlar (seasonSlug) otomatik olarak cache key'e dahil olur.
 */
export const listBookmakers = unstable_cache(fetchBookmakersUncached, ["match-odds-bookmakers"], {
  revalidate: 3600,
  tags: ["bookmakers"],
});
