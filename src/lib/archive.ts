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
import type { FetchResult } from "@/lib/events";
import { getSupabase, hasSupabaseEnv } from "@/lib/supabase";
import type { MarketsBlob, OddsEvent, SeasonRow, BookmakerOption } from "@/lib/types";

export type MarketOption = { type: string; label: string };
export type { BookmakerOption };

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

function isMissingHtColumn(message: string): boolean {
  return /home_ht_score|away_ht_score/i.test(message);
}

async function fetchSeasonsUncached(): Promise<FetchResult<SeasonRow[]>> {
  if (!hasSupabaseEnv()) {
    return { ok: false, error: "Supabase environment variables missing.", missingEnv: true };
  }
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "Could not create Supabase client.", missingEnv: true };

  const { data, error } = await sb
    .from("seasons")
    .select(
      "id,source,competition,season_label,template_id,season_code,match_count,bookmaker_count,updated_at",
    )
    .eq("source", "flashscore")
    .order("season_label", { ascending: false });

  if (error) return { ok: false, error: error.message };
  return { ok: true, data: (data ?? []) as SeasonRow[] };
}

export const listSeasons = unstable_cache(fetchSeasonsUncached, ["flashscore-seasons"], {
  revalidate: 300,
  tags: ["seasons"],
});

/** Distinct market types from events.markets_json sample. */
export async function listSeasonMarkets(seasonSlug: string): Promise<MarketOption[]> {
  const sb = getSupabase();
  if (!sb || !seasonSlug) return [];

  const { data, error } = await sb
    .from("events")
    .select("markets_json")
    .eq("source", "flashscore")
    .eq("season_slug", seasonSlug)
    .limit(60);
  if (error || !data) return [];

  const map = new Map<string, string>();
  for (const row of data as { markets_json: OddsEvent["markets_json"] }[]) {
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
}

export async function listEventMetaBySeason(
  seasonSlug: string,
): Promise<FetchResult<OddsEvent[]>> {
  if (!hasSupabaseEnv()) {
    return { ok: false, error: "Supabase environment variables missing.", missingEnv: true };
  }
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "Could not create Supabase client.", missingEnv: true };

  const { data, error } = await sb
    .from("events")
    .select(META_COLS)
    .eq("source", "flashscore")
    .eq("season_slug", seasonSlug)
    .order("kickoff_at", { ascending: true });

  if (error && isMissingHtColumn(error.message)) {
    const retry = await sb
      .from("events")
      .select(META_COLS_BASE)
      .eq("source", "flashscore")
      .eq("season_slug", seasonSlug)
      .order("kickoff_at", { ascending: true });
    if (retry.error) return { ok: false, error: retry.error.message };
    return { ok: true, data: (retry.data ?? []) as unknown as OddsEvent[] };
  }

  if (error) return { ok: false, error: error.message };
  return { ok: true, data: (data ?? []) as unknown as OddsEvent[] };
}

async function fetchEventsWithMarkets(seasonSlug: string): Promise<OddsEvent[]> {
  const sb = getSupabase();
  if (!sb) return [];

  const pageSize = 200;
  let from = 0;
  const all: OddsEvent[] = [];
  let useHt = true;
  for (;;) {
    const cols = useHt ? FULL_COLS : FULL_COLS_BASE;
    const { data, error } = await sb
      .from("events")
      .select(cols)
      .eq("source", "flashscore")
      .eq("season_slug", seasonSlug)
      .order("kickoff_at", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error && useHt && isMissingHtColumn(error.message)) {
      useHt = false;
      from = 0;
      all.length = 0;
      continue;
    }
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as unknown as OddsEvent[];
    all.push(...batch);
    if (batch.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

/** Full markets_json seasons exceed Next 2MB data-cache limit — do not unstable_cache. */
export async function loadSeasonEvents(seasonSlug: string): Promise<OddsEvent[]> {
  return fetchEventsWithMarkets(seasonSlug);
}

/** Archive quotes from events.markets_json (no event_quotes table). */
async function loadQuotesForSeason(seasonSlug: string, _filters: FilterState): Promise<Quote[]> {
  const events = await loadSeasonEvents(seasonSlug);
  return normalizeMany(events);
}

export async function analyzeSeason(filters: FilterState): Promise<FetchResult<AnalyzeResult>> {
  if (!filters.seasonSlug) {
    return { ok: false, error: "seasonSlug gerekli." };
  }
  if (!hasSupabaseEnv()) {
    return { ok: false, error: "Supabase environment variables missing.", missingEnv: true };
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

/** Stacked odds profile search — warm cache üzerinden (sayfa açılışında deparse). */
export async function searchProfile(
  query: ProfileQuery,
): Promise<FetchResult<ProfileResult & { tableRows: TableRow[]; cacheStatus?: string }>> {
  if (!hasSupabaseEnv()) {
    return { ok: false, error: "Supabase environment variables missing.", missingEnv: true };
  }
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

  try {
    const { ensureArchiveCache } = await import("@/lib/archiveCache");
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

    // seasonSlugs verilmişse cache içinden daralt
    let pool = quotes;
    const seasons = query.seasonSlugs?.filter(Boolean) ?? [];
    if (seasons.length) {
      const set = new Set(seasons);
      pool = quotes.filter((q) => q.seasonSlug && set.has(q.seasonSlug));
    }

    const result = searchOddsProfile(pool, query);
    const bm = Number(query.bookmakerId);
    const preferredBm = Number.isFinite(bm) && bm > 0 ? bm : PREFERRED_BM;
    const tableRows: TableRow[] = result.matches.map((m) => {
      const event = byId.get(m.eventId);
      const hitsRow = profileMatchToTableRow(m);
      if (!event) return hitsRow;
      const full = getCachedEventTableRow(event, preferredBm);
      // Arama isabetindeki O/C değerlerini yaz (slim arşivde BM başına tek satır)
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
        cacheStatus: `${status.status} seasons=${status.seasonsDone}/${status.seasonsTotal} quotes=${status.quotes}`,
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function listBookmakers(seasonSlug?: string): Promise<BookmakerOption[]> {
  const sb = getSupabase();
  if (!sb) return [];

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

  let q = sb
    .from("events")
    .select("markets_json")
    .eq("source", "flashscore")
    .limit(80);
  if (seasonSlug) q = q.eq("season_slug", seasonSlug);
  const { data: events } = await q;
  for (const row of (events ?? []) as { markets_json: OddsEvent["markets_json"] }[]) {
    absorbBlob(row.markets_json);
  }

  const { data: fixtures } = await sb.from("fixture").select("bookmakers").limit(30);
  for (const row of (fixtures ?? []) as { bookmakers: Record<string, string> | null }[]) {
    const bms = row.bookmakers;
    if (!bms || typeof bms !== "object") continue;
    for (const [id, name] of Object.entries(bms)) {
      if (id && id !== "bookmakers" && !map.has(id)) map.set(id, String(name || id));
    }
  }

  return [...map.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
}
