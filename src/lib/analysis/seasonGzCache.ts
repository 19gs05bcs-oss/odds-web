/**
 * Smart Analysis archive — Supabase `events` tablosundan belleğe yüklenir.
 * (Eski kaynak: GitHub'daki season .json.gz dökümleri.)
 */

import type { CompactOddsRow } from "@/lib/fixtures";
import { marketsBlobToCompactOdds } from "@/lib/analysis/tableRows";
import type { MarketsBlob, OddsEvent, SeasonRow } from "@/lib/types";
import { sql } from "@/lib/db";

export type SeasonGzMatch = {
  id: string;
  matchId: string;
  seasonSlug: string;
  competition: string;
  home: string;
  away: string;
  kickoffAt: string | null;
  homeScore: number;
  awayScore: number;
  homeHtScore: number | null;
  awayHtScore: number | null;
  odds: CompactOddsRow[];
  bookmakers: Record<string, string>;
};

export type GzWarmStatus = {
  status: "idle" | "loading" | "ready" | "error";
  phase: "idle" | "listing" | "downloading";
  files: number;
  filesDone: number;
  matches: number;
  error?: string;
  startedAt?: number;
  readyAt?: number;
  /** Veri kaynağı etiketi (raporda gösterilir). */
  dir?: string | null;
};

type GzBag = {
  status: GzWarmStatus["status"];
  phase: GzWarmStatus["phase"];
  files: number;
  filesDone: number;
  matches: SeasonGzMatch[];
  error?: string;
  startedAt?: number;
  readyAt?: number;
  promise?: Promise<void>;
};

const CACHE_VERSION = 6;
const SOURCE_LABEL = "supabase:events";

const EVENT_COLS =
  "id,source_event_id,competition,home_team,away_team,kickoff_at,home_score,away_score,home_ht_score,away_ht_score,season_slug,markets_json";
const EVENT_COLS_BASE =
  "id,source_event_id,competition,home_team,away_team,kickoff_at,home_score,away_score,season_slug,markets_json";

function globalStore(): { bag: GzBag } {
  const g = globalThis as unknown as { __seasonGzCache?: { bag: GzBag; version?: number } };
  if (!g.__seasonGzCache || g.__seasonGzCache.version !== CACHE_VERSION) {
    g.__seasonGzCache = {
      version: CACHE_VERSION,
      bag: {
        status: "idle",
        phase: "idle",
        files: 0,
        filesDone: 0,
        matches: [],
      },
    };
  }
  return g.__seasonGzCache;
}

/** Ana thread'i uzun dönüşümlerde nefeslendir — yoksa sunucu isteklere cevap veremiyor. */
const yieldToLoop = () => new Promise<void>((r) => setImmediate(r));

function asBlob(raw: OddsEvent["markets_json"]): MarketsBlob {
  if (!raw) return { markets: [] };
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as MarketsBlob;
    } catch {
      return { markets: [] };
    }
  }
  return raw;
}

function parseScore(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function competitionLabel(slug: string): string {
  const parts = slug.split("/");
  if (parts.length < 2) return slug;
  const league = parts[1]
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  const country = parts[0].replace(/\b\w/g, (c) => c.toUpperCase());
  return `${country}: ${league}`;
}

function eventToMatch(event: OddsEvent): SeasonGzMatch | null {
  const hs = parseScore(event.home_score);
  const as = parseScore(event.away_score);
  if (hs == null || as == null) return null;
  const blob = asBlob(event.markets_json);
  const odds = marketsBlobToCompactOdds(blob);
  if (!odds.length) return null;
  const mid = event.source_event_id || event.id;
  if (!mid) return null;
  return {
    id: `flashscore:${mid}`,
    matchId: mid,
    seasonSlug: event.season_slug || "",
    competition: event.competition || competitionLabel(event.season_slug || ""),
    home: event.home_team || "Home",
    away: event.away_team || "Away",
    kickoffAt: event.kickoff_at ?? null,
    homeScore: hs,
    awayScore: as,
    homeHtScore: parseScore(event.home_ht_score),
    awayHtScore: parseScore(event.away_ht_score),
    odds,
    bookmakers: blob.bookmakers ?? {},
  };
}

function isMissingHtColumn(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /home_ht_score|away_ht_score|42703/i.test(message);
}

async function listSeasonIds(): Promise<string[]> {
  const query = "SELECT id FROM seasons WHERE source = 'flashscore' ORDER BY season_label DESC";
  const data = await sql.unsafe<{id: string}[]>(query);
  return data.map((s) => s.id);
}

async function loadSeasonMatchesOnce(
  seasonSlug: string,
  pageSize: number,
): Promise<SeasonGzMatch[]> {
  let from = 0;
  let useHt = true;
  const out: SeasonGzMatch[] = [];
  
  for (;;) {
    const cols = useHt ? EVENT_COLS : EVENT_COLS_BASE;
    try {
      const query = `SELECT ${cols} FROM events WHERE source = 'flashscore' AND season_slug = $1 ORDER BY kickoff_at ASC LIMIT $2 OFFSET $3`;
      const batch = await sql.unsafe<OddsEvent[]>(query, [seasonSlug, pageSize, from]);
      
      for (const e of batch) {
        let m: SeasonGzMatch | null = null;
        try {
          m = eventToMatch(e);
        } catch (e2) {
          console.error("[seasonArchive] event parse error", e?.id, e2);
        }
        if (m) out.push(m);
      }
      await yieldToLoop();
      if (batch.length < pageSize) break;
      from += pageSize;
    } catch (error) {
      if (useHt && isMissingHtColumn(error)) {
        useHt = false;
        from = 0;
        out.length = 0;
        continue;
      }
      throw error;
    }
  }
  return out;
}

/** Statement timeout'a takılırsa sayfa boyunu küçülterek dene. */
async function loadSeasonMatches(seasonSlug: string): Promise<SeasonGzMatch[]> {
  for (const pageSize of [150, 60]) {
    try {
      return await loadSeasonMatchesOnce(seasonSlug, pageSize);
    } catch (e) {
      if (pageSize === 60) throw e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  return [];
}

async function runWarm(): Promise<void> {
  const { bag } = globalStore();
  bag.status = "loading";
  bag.phase = "listing";
  bag.startedAt = Date.now();
  bag.error = undefined;
  bag.matches = [];
  bag.filesDone = 0;
  bag.files = 0;

  try {
    const seasonIds = await listSeasonIds();
    bag.files = seasonIds.length;
    bag.phase = "downloading";

    const failed: string[] = [];
    let cursor = 0;
    async function worker() {
      for (;;) {
        const i = cursor++;
        if (i >= seasonIds.length) return;
        const slug = seasonIds[i];
        try {
          const batch = await loadSeasonMatches(slug);
          bag.matches.push(...batch);
          console.log(
            `[seasonArchive] ${bag.filesDone + 1}/${seasonIds.length} ${slug} → ${batch.length} matches`,
          );
        } catch (e) {
          console.error("[seasonArchive] skip", slug, e);
          failed.push(slug);
        } finally {
          bag.filesDone += 1;
        }
        await yieldToLoop();
      }
    }
    // 3 worker — events tablosu büyük blob'larla yüksek eşzamanlılıkta timeout veriyor
    await Promise.all([worker(), worker(), worker()]);

    // Kurtarma turu: başarısız sezonları tek tek, düşük eşzamanlılıkla tekrar dene
    for (const slug of failed) {
      try {
        const batch = await loadSeasonMatchesOnce(slug, 40);
        bag.matches.push(...batch);
        console.log(`[seasonArchive] rescue ${slug} → ${batch.length} matches`);
      } catch (e) {
        console.error("[seasonArchive] rescue failed", slug, e);
      }
      await yieldToLoop();
    }

    if (!bag.matches.length) {
      throw new Error("Arşivden hiç bitmiş maç yüklenemedi.");
    }
    bag.status = "ready";
    bag.phase = "idle";
    bag.readyAt = Date.now();
  } catch (e) {
    bag.status = "error";
    bag.phase = "idle";
    bag.error = e instanceof Error ? e.message : String(e);
  }
}

export function startSeasonGzWarm(): GzWarmStatus {
  const { bag } = globalStore();
  if (bag.status === "ready") return getSeasonGzStatus();
  if (bag.status === "loading" && bag.promise) return getSeasonGzStatus();
  if (bag.status === "error") {
    bag.status = "idle";
    bag.promise = undefined;
  }
  bag.promise = runWarm();
  return getSeasonGzStatus();
}

export function getSeasonGzStatus(): GzWarmStatus {
  const { bag } = globalStore();
  return {
    status: bag.status,
    phase: bag.phase,
    files: bag.files,
    filesDone: bag.filesDone,
    matches: bag.matches.length,
    error: bag.error,
    startedAt: bag.startedAt,
    readyAt: bag.readyAt,
    dir: SOURCE_LABEL,
  };
}

export async function ensureSeasonGzCache(waitMs = 600_000): Promise<{
  matches: SeasonGzMatch[];
  status: GzWarmStatus;
}> {
  const { bag } = globalStore();
  if (bag.status !== "ready" && bag.status !== "loading") {
    startSeasonGzWarm();
  }
  if (bag.status === "loading" && bag.promise) {
    await Promise.race([bag.promise, new Promise<void>((r) => setTimeout(r, waitMs))]);
  }
  return { matches: bag.matches, status: getSeasonGzStatus() };
}
