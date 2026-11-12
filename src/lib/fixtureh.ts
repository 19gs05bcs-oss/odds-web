import { sql } from "@/lib/db";
import { DISPLAY_TZ } from "@/lib/time";
import type { FixtureRow } from "@/lib/archiveCache";

const META =
  "match_id,bulletin_date,day_offset,league,league_country,kickoff_at,kickoff_ts,home_name,away_name,home_id,away_id,home_score,away_score,home_ht_score,away_ht_score,match_url,odds_count";

/** Günler DISPLAY_TZ'deki kickoff gününe göre (futboldaki fixture ile aynı mantık). */
export async function listFixtureHDates(limit = 30): Promise<string[]> {
  const rows = await sql.unsafe<{ d: string }[]>(
    `SELECT to_char((kickoff_at AT TIME ZONE $1::text)::date, 'YYYY-MM-DD') AS d
       FROM fixtureh WHERE kickoff_at IS NOT NULL
      GROUP BY 1 ORDER BY 1 DESC LIMIT $2`,
    [DISPLAY_TZ, limit],
  );
  return rows.map((r) => r.d).filter(Boolean);
}

/**
 * Seçili günün hentbol fikstürleri.
 * odds varsa birlikte döner (benzer maç hesabı için); kolon yoksa null bırakılır.
 */
export async function fetchFixtureHMeta(date: string): Promise<FixtureRow[]> {
  try {
    const rows = await sql.unsafe<FixtureRow[]>(
      `SELECT ${META}, odds, bookmakers FROM fixtureh
        WHERE kickoff_at IS NOT NULL AND (kickoff_at AT TIME ZONE $1::text)::date = $2::date
        ORDER BY kickoff_at ASC`,
      [DISPLAY_TZ, date],
    );
    return rows.map((r) => ({
      ...r,
      odds: r.odds ?? null,
      bookmakers: r.bookmakers ?? null,
      odds_count: r.odds_count ?? (Array.isArray(r.odds) ? r.odds.length : 0),
    }));
  } catch (e) {
    // odds / bookmakers kolonu yoksa meta ile devam
    const message = e instanceof Error ? e.message : String(e);
    if (!/odds|bookmakers|42703/i.test(message)) throw e;
    const rows = await sql.unsafe<FixtureRow[]>(
      `SELECT ${META} FROM fixtureh
        WHERE kickoff_at IS NOT NULL AND (kickoff_at AT TIME ZONE $1::text)::date = $2::date
        ORDER BY kickoff_at ASC`,
      [DISPLAY_TZ, date],
    );
    return rows.map((r) => ({ ...r, odds: null, bookmakers: null, odds_count: r.odds_count ?? 0 }));
  }
}
