import { sql } from "@/lib/db";
import { DISPLAY_TZ, shiftDayKey, todayInTz } from "@/lib/time";
import type { FixtureRow } from "@/lib/archiveCache";

/** Bugünden en fazla kaç gün geriye gidilsin (3 = bugün-3 ve sonrası görünür). */
export const TENNIS_BACK_DAYS = 3;

const META =
  "match_id,bulletin_date,day_offset,league,league_country,tour,state,status,kickoff_at,kickoff_ts,home_name,away_name,home_id,away_id,home_score,away_score,home_ht_score,away_ht_score,home_periods,away_periods,home_tb,away_tb,match_url,odds_count";

const minDay = () => shiftDayKey(todayInTz(), -TENNIS_BACK_DAYS);

/**
 * Tabloda olan günler: bugün-3 ve sonrası (gelecek günlerde tabloya ne kadar çekildiyse hepsi).
 * Gün = DISPLAY_TZ'deki kickoff günü. Artan sıralı.
 */
export async function listFixtureTDates(): Promise<string[]> {
  const rows = await sql.unsafe<{ d: string }[]>(
    `SELECT d FROM (
        SELECT to_char((kickoff_at AT TIME ZONE $1::text)::date, 'YYYY-MM-DD') AS d
          FROM fixturet
         WHERE kickoff_at IS NOT NULL
           AND (kickoff_at AT TIME ZONE $1::text)::date >= $2::date
         GROUP BY 1
      ) x ORDER BY d ASC`,
    [DISPLAY_TZ, minDay()],
  );
  return rows.map((r) => r.d).filter(Boolean);
}

/** Seçili günün tenis maçları (odds + bookmakers ile). 3 günden eski gün istenirse boş döner. */
export async function fetchFixtureTMeta(date: string): Promise<FixtureRow[]> {
  if (date < minDay()) return [];
  const rows = await sql.unsafe<(FixtureRow & Record<string, unknown>)[]>(
    `SELECT ${META}, odds, bookmakers FROM fixturet
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
}
