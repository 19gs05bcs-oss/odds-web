import { sql } from "@/lib/db";

/** Compact odds row from fetchday / season schema_version=2. */
export type CompactOddsRow = [
  bookmakerId: number,
  bettingType: string,
  bettingScope: string,
  side: string,
  opening: number | null,
  current: number | null,
  active: boolean,
];

export type FixtureRow = {
  match_id: string;
  bulletin_date: string;
  day_offset: number;
  league: string | null;
  league_country: string | null;
  kickoff_at: string | null;
  kickoff_ts: number | null;
  home_name: string | null;
  away_name: string | null;
  home_id?: string | null;
  away_id?: string | null;
  home_score: string | null;
  away_score: string | null;
  home_ht_score?: string | number | null;
  away_ht_score?: string | number | null;
  match_url: string | null;
  odds: CompactOddsRow[] | null;
  bookmakers: Record<string, string> | null;
  odds_count: number;
};

function todayUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

const FIXTURE_META_HT =
  "match_id,bulletin_date,day_offset,league,league_country,kickoff_at,kickoff_ts,home_name,away_name,home_id,away_id,home_score,away_score,home_ht_score,away_ht_score,match_url,odds_count";

const FIXTURE_META_BASE =
  "match_id,bulletin_date,day_offset,league,league_country,kickoff_at,kickoff_ts,home_name,away_name,home_id,away_id,home_score,away_score,match_url,odds_count";

const ODDS_COLS = "match_id,odds,bookmakers,odds_count";
const ODDS_CHUNK = 30;
const ODDS_CONCURRENCY = 8;

function isMissingHtColumn(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /home_ht_score|away_ht_score|42703/i.test(message);
}

function withTimeout<T>(p: PromiseLike<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms);
    Promise.resolve(p).then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

type OddsPatch = Pick<FixtureRow, "odds" | "bookmakers" | "odds_count">;

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

async function fetchOddsSlice(slice: string[]): Promise<Map<string, OddsPatch>> {
  const out = new Map<string, OddsPatch>();
  if (!slice.length) return out;
  
  try {
    const query = `SELECT ${ODDS_COLS} FROM fixture WHERE match_id = ANY($1)`;
    // `withTimeout` içerisinde sql.unsafe çalıştırılıyor. 
    // ANY($1) postgres formatı string array'i direk bekler.
    const data = await withTimeout(
      sql.unsafe<{ match_id: string; odds: FixtureRow["odds"]; bookmakers: FixtureRow["bookmakers"]; odds_count: number }[]>(query, [slice]),
      20000,
      "fixture-odds"
    );
    
    for (const row of data) {
      out.set(row.match_id, {
        odds: row.odds,
        bookmakers: row.bookmakers,
        odds_count: row.odds_count ?? 0,
      });
    }
  } catch (error) {
    console.error("fetchOddsSlice error:", error instanceof Error ? error.message : String(error));
  }
  return out;
}

/** Parallel DB chunks — much faster than serial for 200+ fixtures. */
export async function fetchFixturesOdds(
  matchIds: string[],
): Promise<Map<string, OddsPatch>> {
  const out = new Map<string, OddsPatch>();
  if (!matchIds.length) return out;

  const slices: string[][] = [];
  for (let i = 0; i < matchIds.length; i += ODDS_CHUNK) {
    slices.push(matchIds.slice(i, i + ODDS_CHUNK));
  }

  const parts = await mapPool(slices, ODDS_CONCURRENCY, (slice) => fetchOddsSlice(slice));
  for (const part of parts) {
    for (const [k, v] of part) out.set(k, v);
  }
  return out;
}

/**
 * Bulletin day odds — meta ids + parallel chunks (bulk JSONB query too slow/unreliable).
 */
export async function fetchFixturesOddsByDate(
  date: string,
): Promise<Map<string, OddsPatch>> {
  const meta = await fetchFixturesMeta(date);
  if (!meta.length) return new Map();
  return fetchFixturesOdds(meta.map((r) => r.match_id));
}

export async function fetchFixturesMeta(date: string): Promise<FixtureRow[]> {
  let useHt = true;
  for (let attempt = 0; attempt < 2; attempt++) {
    const cols = useHt ? FIXTURE_META_HT : FIXTURE_META_BASE;
    try {
      const query = `SELECT ${cols} FROM fixture WHERE bulletin_date = $1 ORDER BY kickoff_at ASC`;
      const data = await withTimeout(sql.unsafe<FixtureRow[]>(query, [date]), 18000, "fixture-meta");
      
      return data.map((row) => ({
        ...row,
        odds: null,
        bookmakers: null,
        odds_count: row.odds_count ?? 0,
      }));
    } catch (e) {
      if (useHt && isMissingHtColumn(e)) {
        useHt = false;
        continue;
      }
      console.error("fetchFixturesMeta error:", e instanceof Error ? e.message : e);
      return [];
    }
  }
  return [];
}

/** Meta + odds (odds ayrı chunk; timeout olursa meta yine döner). */
export async function listFixtures(bulletinDate?: string): Promise<FixtureRow[]> {
  const date = (bulletinDate || todayUtcDate()).trim();
  const meta = await fetchFixturesMeta(date);
  if (!meta.length) return [];

  const oddsMap = await fetchFixturesOddsByDate(date);
  return meta.map((r) => {
    const o = oddsMap.get(r.match_id);
    if (!o) return r;
    return { ...r, odds: o.odds, bookmakers: o.bookmakers, odds_count: o.odds_count };
  });
}

export async function listFixtureDates(limit = 14): Promise<string[]> {
  try {
    const query = "SELECT bulletin_date FROM fixture ORDER BY bulletin_date DESC LIMIT 300";
    const data = await withTimeout(
      sql.unsafe<{ bulletin_date: string }[]>(query),
      8000,
      "fixture-dates"
    );
    
    const seen = new Set<string>();
    for (const row of data) {
      if (row.bulletin_date) seen.add(row.bulletin_date);
      if (seen.size >= limit) break;
    }
    return [...seen];
  } catch (e) {
    console.error("listFixtureDates error:", e instanceof Error ? e.message : e);
    return [];
  }
}

export function fixtureTitle(f: FixtureRow): string {
  return `${f.home_name || "?"} – ${f.away_name || "?"}`;
}
