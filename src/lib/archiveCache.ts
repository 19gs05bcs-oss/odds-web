/**
 * Server-side in-memory archive cache.
 * Analyze sayfası açılınca warm edilir; filtre tıklanınca markets_json
 * yeniden çekilmez — deparse edilmiş Quote[] üzerinden aranır.
 */

import { normalizeMany } from "@/lib/analysis/normalize";
import type { Quote } from "@/lib/analysis/types";
import type { OddsEvent, SeasonRow } from "@/lib/types";
import { getSupabase, hasSupabaseEnv } from "@/lib/supabase";

export type WarmStatus = {
  status: "idle" | "loading" | "ready" | "error";
  seasonsDone: number;
  seasonsTotal: number;
  events: number;
  quotes: number;
  error?: string;
  startedAt?: number;
  readyAt?: number;
};

type CacheBag = {
  status: WarmStatus["status"];
  seasonsDone: number;
  seasonsTotal: number;
  events: OddsEvent[];
  quotes: Quote[];
  byId: Map<string, OddsEvent>;
  error?: string;
  startedAt?: number;
  readyAt?: number;
  promise?: Promise<void>;
};

const META_COLS =
  "id,source,source_event_id,sport,competition,home_team,away_team,kickoff_at,status,is_closed,markets_hash,odds_updated_at,opening_captured_at,closing_captured_at,created_at,updated_at,round,home_score,away_score,home_ht_score,away_ht_score,season_slug,markets_json";

const META_COLS_BASE =
  "id,source,source_event_id,sport,competition,home_team,away_team,kickoff_at,status,is_closed,markets_hash,odds_updated_at,opening_captured_at,closing_captured_at,created_at,updated_at,round,home_score,away_score,season_slug,markets_json";

/** Bump when normalize/quote shape changes so stale warm cache is dropped. */
const CACHE_VERSION = 3;

function globalStore(): { cache: CacheBag } {
  const g = globalThis as unknown as {
    __oddsArchiveCache?: { cache: CacheBag; version?: number };
  };
  if (!g.__oddsArchiveCache || g.__oddsArchiveCache.version !== CACHE_VERSION) {
    g.__oddsArchiveCache = {
      version: CACHE_VERSION,
      cache: {
        status: "idle",
        seasonsDone: 0,
        seasonsTotal: 0,
        events: [],
        quotes: [],
        byId: new Map(),
      },
    };
  }
  return g.__oddsArchiveCache;
}

function appendAll<T>(target: T[], items: readonly T[]): void {
  for (let i = 0; i < items.length; i++) target.push(items[i]);
}

async function loadSeasonEvents(seasonSlug: string): Promise<OddsEvent[]> {
  const sb = getSupabase();
  if (!sb) return [];
  const pageSize = 150;
  let from = 0;
  const all: OddsEvent[] = [];
  let useHt = true;
  for (;;) {
    const cols = useHt ? META_COLS : META_COLS_BASE;
    const { data, error } = await sb
      .from("events")
      .select(cols)
      .eq("source", "flashscore")
      .eq("season_slug", seasonSlug)
      .order("kickoff_at", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error && useHt && /home_ht_score|away_ht_score/i.test(error.message)) {
      useHt = false;
      from = 0;
      all.length = 0;
      continue;
    }
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as unknown as OddsEvent[];
    appendAll(all, batch);
    if (batch.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

async function listSeasonIds(): Promise<string[]> {
  const sb = getSupabase();
  if (!sb) return [];
  const { data, error } = await sb
    .from("seasons")
    .select("id")
    .eq("source", "flashscore")
    .order("season_label", { ascending: false });
  if (error) throw new Error(error.message);
  return ((data ?? []) as Pick<SeasonRow, "id">[]).map((s) => s.id);
}

async function runWarm(maxSeasons: number): Promise<void> {
  const { cache } = globalStore();
  cache.status = "loading";
  cache.startedAt = Date.now();
  cache.error = undefined;
  cache.events = [];
  cache.quotes = [];
  cache.byId = new Map();
  cache.seasonsDone = 0;

  try {
    if (!hasSupabaseEnv() || !getSupabase()) {
      throw new Error("Supabase env missing");
    }
    const allIds = await listSeasonIds();
    const seasonIds = allIds.slice(0, maxSeasons);
    cache.seasonsTotal = seasonIds.length;

    // Arka plan: 2 paralel sezon — UI'yi kilitlemeden ısınır
    let cursor = 0;
    async function worker() {
      for (;;) {
        const i = cursor++;
        if (i >= seasonIds.length) return;
        const slug = seasonIds[i];
        const evs = await loadSeasonEvents(slug);
        for (const e of evs) {
          cache.events.push(e);
          cache.byId.set(e.id, e);
        }
        const q = normalizeMany(evs);
        appendAll(cache.quotes, q);
        cache.seasonsDone += 1;
      }
    }
    await Promise.all([worker(), worker(), worker(), worker()]);

    cache.status = "ready";
    cache.readyAt = Date.now();
  } catch (e) {
    cache.status = "error";
    cache.error = e instanceof Error ? e.message : String(e);
  }
}

/** Sayfa açılışında çağır — idempotent. */
export function startArchiveWarm(maxSeasons = 24): WarmStatus {
  const { cache } = globalStore();
  if (cache.status === "ready") return getWarmStatus();
  if (cache.status === "loading" && cache.promise) return getWarmStatus();
  cache.promise = runWarm(maxSeasons).finally(() => {
    /* keep promise for awaiters */
  });
  return getWarmStatus();
}

export function getWarmStatus(): WarmStatus {
  const { cache } = globalStore();
  return {
    status: cache.status,
    seasonsDone: cache.seasonsDone,
    seasonsTotal: cache.seasonsTotal,
    events: cache.events.length,
    quotes: cache.quotes.length,
    error: cache.error,
    startedAt: cache.startedAt,
    readyAt: cache.readyAt,
  };
}

/** Filtre için: ready ise anında; loading ise bitmesini bekle (max waitMs). */
export async function ensureArchiveCache(opts?: {
  maxSeasons?: number;
  waitMs?: number;
}): Promise<{
  quotes: Quote[];
  byId: Map<string, OddsEvent>;
  status: WarmStatus;
}> {
  const maxSeasons = opts?.maxSeasons ?? 24;
  const waitMs = opts?.waitMs ?? 120_000;
  const { cache } = globalStore();

  if (cache.status !== "ready" && cache.status !== "loading") {
    startArchiveWarm(maxSeasons);
  }

  if (cache.status === "loading" && cache.promise) {
    await Promise.race([
      cache.promise,
      new Promise<void>((resolve) => setTimeout(resolve, waitMs)),
    ]);
  }

  // Kısmi cache ile de ara (ısınma bitmeden tıklanırsa)
  return {
    quotes: cache.quotes,
    byId: cache.byId,
    status: getWarmStatus(),
  };
}
