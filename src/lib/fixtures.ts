import { unstable_cache } from "next/cache";
import { analyzeQuotes } from "@/lib/analysis/analyze";
import { parseFilterState } from "@/lib/analysis/filters";
import { marketTypeLabel } from "@/lib/analysis/labels";
import { normalizeMany } from "@/lib/analysis/normalize";
import {
  searchOddsProfile,
  type ProfileQuery,
  type ProfileResult,
} from "@/lib/analysis/profile";
import type { AnalyzeResult, FilterState, Quote } from "@/lib/analysis/types";
import {
  eventToTableRow,
  profileMatchToTableRow,
  PREFERRED_BM,
  type TableRow,
} from "@/lib/analysis/tableRows";
import type { FetchResult } from "@/lib/archive";
import { sql } from "@/lib/db";
import type { MarketsBlob, OddsEvent, SeasonRow, BookmakerOption } from "@/lib/types";

export type MarketOption = { type: string; label: string };
export type { BookmakerOption };
export type { FixtureRow, CompactOddsRow } from "@/lib/archiveCache";

/** Memoize event→table row (markets_json parse is expensive per search). */
const eventRowCache = new Map<string, TableRow>();

export function getCachedEventTableRow(
  event: OddsEvent,
  bookmakerId: number = PREFERRED_BM,
): TableRow {
  const key = `${event.id}:${bookmakerId}`;
  const hit = eventRowCache.get(key);
  if (hit) return hit;
  const row = eventToTableRow(event, bookmakerId);
  eventRowCache.set(key, row);
  return row;
}

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

/** Distinct market types from events.markets_json sample. */
export async function listSeasonMarkets(seasonSlug: string): Promise<MarketOption[]> {
  if (!seasonSlug) return [];

  try {
    const query = "SELECT markets_json FROM events WHERE source = 'flashscore' AND season_slug = $1 LIMIT 60";
    const data = await sql.unsafe<{ markets_json: OddsEvent["markets_json"] }[]>(query, [seasonSlug]);
    
    const map = new Map<string, string>();
    for (const row of data) {
      let blob: MarketsBlob | null = null;
      const raw = row.markets_json;
      if (typeof raw === "string") {
        try {
          blob = JSON.parse(raw) as MarketsBlob;
        } catch {
          continue;
        }
      } else if (raw && typeof raw === "object") {
        blob = raw as MarketsBlob;
      }
      for (const m of blob?.markets ?? []) {
        const type = m.type || "UNKNOWN";
        if (map.has(type)) continue;
        map.set(type, marketTypeLabel(type, m.name));
      }
    }
    return [...map.entries()]
      .map(([type, label]) => ({ type, label }))
      .sort((a, b) => a.label.localeCompare(b.label, "tr"));
  } catch (err) {
    console.error("listSeasonMarkets error:", err);
    return [];
  }
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
export async function loadSeasonEvents(seasonSlug: string): Promise<OddsEvent[]> {
  return fetchEventsWithMarkets(seasonSlug);
}

/**
 * Archive quotes from events.markets_json — DuckDB üzerinden, market/scope/
 * bookmaker/odds filtresiyle erken daraltılmış olarak çekilir (bkz.
 * analyzeSeasonSQL.ts). Eskisi gibi sezonun TÜM markets_json'ını Node'a
 * çekip normalizeMany ile parse etmiyoruz.
 */
async function loadQuotesForSeason(seasonSlug: string, filters: FilterState): Promise<Quote[]> {
  const { loadSeasonQuotesSQL } = await import("@/lib/analysis/analyzeSeasonSQL");
  try {
    return await loadSeasonQuotesSQL({ ...filters, seasonSlug });
  } catch (e) {
    // DuckDB/Postgres attach başarısızsa (örn. DUCKDB_PG_DSN yok) eski
    // Node-side yola düş — en azından özellik çalışmaya devam etsin.
    console.error("[loadQuotesForSeason] DuckDB path failed, falling back to Node:", e);
    const events = await loadSeasonEvents(seasonSlug);
    return normalizeMany(events);
  }
}

export async function analyzeSeason(filters: FilterState): Promise<FetchResult<AnalyzeResult>> {
  if (!filters.seasonSlug) {
    return { ok: false, error: "seasonSlug gerekli." };
  }
  
  try {
    const quotes = await loadQuotesForSeason(filters.seasonSlug, filters);
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
 * Stacked odds profile search — DuckDB üzerinden (events.markets_json'ı
 * doğrudan JSON-unnest ile sorgular, Node'da global bir "24 sezon RAM'de"
 * cache YOK artık). DuckDB/attach başarısız olursa eski warm-cache yoluna
 * düşer (feature çalışmaya devam etsin diye), ama bu yavaş/RAM-ağır yoldur —
 * DUCKDB_PG_DSN doğru kurulduysa asla tetiklenmemeli.
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

  const bm = Number(query.bookmakerId);
  const preferredBm = Number.isFinite(bm) && bm > 0 ? bm : PREFERRED_BM;

  try {
    const { searchOddsProfileSQL } = await import("@/lib/analysis/searchOddsProfileSQL");
    const result = await searchOddsProfileSQL(query);

    // Eşleşen event'lerin tam satırını (tüm bookmaker grid'i) TEK sorguda çekiyoruz —
    // eskisi gibi 24 sezonun tamamını değil, sadece bu birkaç yüz maçı.
    const byId = await fetchEventsWithMarketsByIds(result.matches.map((m) => m.eventId));

    const tableRows: TableRow[] = result.matches.map((m) => {
      const event = byId.get(m.eventId);
      const hitsRow = profileMatchToTableRow(m);
      if (!event) return hitsRow;
      const full = getCachedEventTableRow(event, preferredBm);
      for (const [colId, cell] of Object.entries(hitsRow.odds)) {
        if (cell) full.odds[colId] = cell;
      }
      return full;
    });

    return {
      ok: true,
      data: { ...result, tableRows, cacheStatus: "duckdb" },
    };
  } catch (e) {
    console.error("[searchProfile] DuckDB path failed, falling back to Node RAM cache:", e);
  }

  // --- Fallback: eski global warm-cache yolu ---
  try {
    const { ensureArchiveCache } = await import("@/lib/events");
    const { quotes, byId, status } = await ensureArchiveCache({
      maxSeasons: 24,
      waitMs: 90_000,
    });

    if (!quotes.length) {
      return {
        ok: false,
        error:
          status.status === "loading"
            ? "Archive still warming — try again in a few seconds."
            : status.error ||
              "No archive odds in cache. Refresh Analyze to start background load.",
      };
    }

    let pool = quotes;
    const seasons = query.seasonSlugs?.filter(Boolean) ?? [];
    if (seasons.length) {
      const set = new Set(seasons);
      pool = quotes.filter((q) => q.seasonSlug && set.has(q.seasonSlug));
    }

    const result = searchOddsProfile(pool, query);
    const tableRows: TableRow[] = result.matches.map((m) => {
      const event = byId.get(m.eventId);
      const hitsRow = profileMatchToTableRow(m);
      if (!event) return hitsRow;
      const full = getCachedEventTableRow(event, preferredBm);
      for (const [colId, cell] of Object.entries(hitsRow.odds)) {
        if (cell) full.odds[colId] = cell;
      }
      return full;
    });
    return {
      ok: true,
      data: {
        ...result,
        tableRows,
        cacheStatus: `fallback:${status.status} seasons=${status.seasonsDone}/${status.seasonsTotal} quotes=${status.quotes}`,
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function listBookmakers(seasonSlug?: string): Promise<BookmakerOption[]> {
  const map = new Map<string, string>();

  const absorbBlob = (raw: OddsEvent["markets_json"] | null | undefined) => {
    let blob: MarketsBlob | null = null;
    if (typeof raw === "string") {
      try {
        blob = JSON.parse(raw) as MarketsBlob;
      } catch {
        return;
      }
    } else if (raw && typeof raw === "object") {
      blob = raw as MarketsBlob;
    }
    if (!blob) return;
    if (blob.bookmakers && typeof blob.bookmakers === "object") {
      for (const [id, name] of Object.entries(blob.bookmakers)) {
        if (id && id !== "bookmakers" && !map.has(id)) map.set(id, name || id);
      }
    }
    for (const m of blob.markets ?? []) {
      for (const s of m.selections ?? []) {
        const id = s.bookmaker_id != null ? String(s.bookmaker_id) : "";
        if (!id || map.has(id)) continue;
        map.set(id, s.bookmaker_name || id);
      }
    }
  };

  try {
    let query = "SELECT markets_json FROM events WHERE source = 'flashscore'";
    const params: any[] = [];
    if (seasonSlug) {
      query += " AND season_slug = $1";
      params.push(seasonSlug);
    }
    query += " LIMIT 80";
    
    const events = await sql.unsafe<{ markets_json: OddsEvent["markets_json"] }[]>(query, params);
    for (const row of events) {
      absorbBlob(row.markets_json);
    }

    const fixturesQuery = "SELECT bookmakers FROM fixture LIMIT 30";
    const fixtures = await sql.unsafe<{ bookmakers: Record<string, string> | null }[]>(fixturesQuery);
    
    for (const row of fixtures) {
      const bms = row.bookmakers;
      if (!bms || typeof bms !== "object") continue;
      for (const [id, name] of Object.entries(bms)) {
        if (id && id !== "bookmakers" && !map.has(id)) map.set(id, String(name || id));
      }
    }

    return [...map.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, "en"));
  } catch (err) {
    console.error("listBookmakers error:", err);
    return [];
  }
}
