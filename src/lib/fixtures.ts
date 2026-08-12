import { getSupabase, hasSupabaseEnv } from "@/lib/supabase";

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

const ODDS_COLS = "match_id,odds,bookmakers,odds_count";
const ODDS_CHUNK = 30;
const ODDS_CONCURRENCY = 8;

async function fetchOddsSlice(
  sb: NonNullable<ReturnType<typeof getSupabase>>,
  slice: string[],
): Promise<Map<string, OddsPatch>> {
  const out = new Map<string, OddsPatch>();
  if (!slice.length) return out;
  const { data, error } = await withTimeout(
    sb.from("fixture").select(ODDS_COLS).in("match_id", slice),
    20000,
    "fixture-odds",
  );
  if (error) {
    console.error("fetchOddsSlice", error.message);
    return out;
  }
  for (const row of (data ?? []) as {
    match_id: string;
    odds: FixtureRow["odds"];
    bookmakers: FixtureRow["bookmakers"];
    odds_count: number;
  }[]) {
    out.set(row.match_id, {
      odds: row.odds,
      bookmakers: row.bookmakers,
      odds_count: row.odds_count ?? 0,
    });
  }
  return out;
}

/** Parallel DB chunks — much faster than serial for 200+ fixtures. */
export async function fetchFixturesOdds(
  matchIds: string[],
): Promise<Map<string, OddsPatch>> {
  const out = new Map<string, OddsPatch>();
  const sb = getSupabase();
  if (!sb || !matchIds.length) return out;

  const slices: string[][] = [];
  for (let i = 0; i < matchIds.length; i += ODDS_CHUNK) {
    slices.push(matchIds.slice(i, i + ODDS_CHUNK));
  }

  const parts = await mapPool(slices, ODDS_CONCURRENCY, (slice) => fetchOddsSlice(sb, slice));
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
  const sb = getSupabase();
  if (!sb) return new Map();

  const meta = await fetchFixturesMeta(date);
  if (!meta.length) return new Map();
  return fetchFixturesOdds(meta.map((r) => r.match_id));
}

export async function fetchFixturesMeta(date: string): Promise<FixtureRow[]> {
  const sb = getSupabase();
  if (!sb) return [];

  let useHt = true;
  for (let attempt = 0; attempt < 2; attempt++) {
    const cols = useHt ? FIXTURE_META_HT : FIXTURE_META_BASE;
    try {
      const { data, error } = await withTimeout(
        sb
          .from("fixture")
          .select(cols)
          .eq("bulletin_date", date)
          .order("kickoff_at", { ascending: true }),
        18000,
        "fixture-meta",
      );
      if (error && useHt && /home_ht_score|away_ht_score/i.test(error.message)) {
        useHt = false;
        continue;
      }
      if (error) {
        console.error("fetchFixturesMeta", error.message);
        return [];
      }
      return ((data ?? []) as unknown as FixtureRow[]).map((row) => ({
        ...row,
        odds: null,
        bookmakers: null,
        odds_count: row.odds_count ?? 0,
      }));
    } catch (e) {
      console.error("fetchFixturesMeta", e instanceof Error ? e.message : e);
      return [];
    }
  }
  return [];
}

/** Meta + odds (odds ayrı chunk; timeout olursa meta yine döner). */
export async function listFixtures(bulletinDate?: string): Promise<FixtureRow[]> {
  if (!hasSupabaseEnv() || !getSupabase()) return [];
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
  if (!hasSupabaseEnv()) return [];
  const sb = getSupabase();
  if (!sb) return [];

  try {
    const { data, error } = await withTimeout(
      sb
        .from("fixture")
        .select("bulletin_date")
        .order("bulletin_date", { ascending: false })
        .limit(300),
      8000,
      "fixture-dates",
    );
    if (error || !data) {
      if (error) console.error("listFixtureDates", error.message);
      return [];
    }
    const seen = new Set<string>();
    for (const row of data as { bulletin_date: string }[]) {
      if (row.bulletin_date) seen.add(row.bulletin_date);
      if (seen.size >= limit) break;
    }
    return [...seen];
  } catch (e) {
    console.error("listFixtureDates", e instanceof Error ? e.message : e);
    return [];
  }
}

export function fixtureTitle(f: FixtureRow): string {
  return `${f.home_name || "?"} – ${f.away_name || "?"}`;
}
