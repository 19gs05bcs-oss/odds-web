/** Fictional fixtures and odds for the public demo (no API / no real data). */

import { ALL_COLUMNS, type MarketColumnDef } from "@/lib/analysis/tableColumns";
import { PREFERRED_BM } from "@/lib/analysis/tableRows";
import type { CompactOddsRow, FixtureRow } from "@/lib/fixtures";

export const DEMO_BOOKMAKER_ID = PREFERRED_BM;
export const DEMO_BOOKMAKER_NAME = "Sample BK";

function seededOdd(seed: number, min: number, max: number): number {
  const x = Math.abs(Math.sin(seed * 12.9898) * 43758.5453);
  const f = x - Math.floor(x);
  return Math.round((min + f * (max - min)) * 100) / 100;
}

function sideToken(col: MarketColumnDef): string {
  if (col.marketType === "OVER_UNDER" && col.line != null) {
    return `${col.side}:${col.line}`;
  }
  if (
    (col.marketType === "ASIAN_HANDICAP" || col.marketType === "EUROPEAN_HANDICAP") &&
    col.line != null &&
    col.line !== ""
  ) {
    return `${col.side}:${col.line}`;
  }
  return col.side;
}

/** Every analyze column → one compact odds row (opening + closing). */
export function buildDemoOdds(seed: number): CompactOddsRow[] {
  const cols = ALL_COLUMNS.filter((c): c is MarketColumnDef => c.kind === "market");
  const rows: CompactOddsRow[] = [];
  let i = seed;

  for (const col of cols) {
    const isCs = col.group === "cs";
    const opening = seededOdd(i++, isCs ? 7 : 1.35, isCs ? 34 : 5.5);
    const drift = seededOdd(i++ * 1.7, -0.12, 0.08);
    const closing = Math.max(1.01, Math.round((opening + drift) * 100) / 100);
    rows.push([
      DEMO_BOOKMAKER_ID,
      col.marketType,
      col.marketScope,
      sideToken(col),
      opening,
      closing,
      true,
    ]);
  }
  return rows;
}

function baseFixture(
  id: string,
  opts: {
    home: string;
    away: string;
    league: string;
    kickoff: string;
    homeScore?: string | null;
    awayScore?: string | null;
    homeHt?: string | null;
    awayHt?: string | null;
    oddsSeed: number;
  },
): FixtureRow {
  const odds = buildDemoOdds(opts.oddsSeed);
  return {
    match_id: id,
    bulletin_date: "2026-08-11",
    day_offset: 0,
    league: opts.league,
    league_country: "DEMO",
    kickoff_at: opts.kickoff,
    kickoff_ts: new Date(opts.kickoff).getTime(),
    home_name: opts.home,
    away_name: opts.away,
    home_id: `h-${id}`,
    away_id: `a-${id}`,
    home_score: opts.homeScore ?? null,
    away_score: opts.awayScore ?? null,
    home_ht_score: opts.homeHt ?? null,
    away_ht_score: opts.awayHt ?? null,
    match_url: null,
    odds,
    bookmakers: { [String(DEMO_BOOKMAKER_ID)]: DEMO_BOOKMAKER_NAME },
    odds_count: odds.length,
  };
}

/** Upcoming bulletin — prematch, fictional teams. */
export const DEMO_BULLETIN: FixtureRow[] = [
  baseFixture("demo-b1", {
    home: "Northport FC",
    away: "Riverside United",
    league: "DEMO: Sample League",
    kickoff: "2026-08-11T15:30:00.000Z",
    oddsSeed: 101,
  }),
  baseFixture("demo-b2", {
    home: "Harbor City",
    away: "Summit Athletic",
    league: "DEMO: Sample Cup",
    kickoff: "2026-08-11T17:00:00.000Z",
    oddsSeed: 202,
  }),
  baseFixture("demo-b3", {
    home: "Valley Town",
    away: "Coastal Rovers",
    league: "DEMO: Sample League",
    kickoff: "2026-08-11T17:45:00.000Z",
    oddsSeed: 303,
  }),
];

/** Settled archive samples — scores drive win/loss coloring (incl. correct score). */
export const DEMO_ARCHIVE: FixtureRow[] = [
  baseFixture("demo-a1", {
    home: "Demo FC",
    away: "Sample Town",
    league: "ARCHIVE: Demo Div",
    kickoff: "2023-12-04T18:00:00.000Z",
    homeScore: "2",
    awayScore: "1",
    homeHt: "1",
    awayHt: "0",
    oddsSeed: 401,
  }),
  baseFixture("demo-a2", {
    home: "Fictional Rovers",
    away: "Mock City",
    league: "ARCHIVE: Demo Div",
    kickoff: "2022-09-18T14:00:00.000Z",
    homeScore: "0",
    awayScore: "2",
    homeHt: "0",
    awayHt: "1",
    oddsSeed: 402,
  }),
  baseFixture("demo-a3", {
    home: "Placeholder Utd",
    away: "Example FC",
    league: "ARCHIVE: Sample Cup",
    kickoff: "2024-03-11T20:00:00.000Z",
    homeScore: "3",
    awayScore: "0",
    homeHt: "2",
    awayHt: "0",
    oddsSeed: 403,
  }),
  baseFixture("demo-a4", {
    home: "Alpha FC",
    away: "Beta Town",
    league: "ARCHIVE: Demo Div",
    kickoff: "2024-01-22T19:30:00.000Z",
    homeScore: "2",
    awayScore: "2",
    homeHt: "1",
    awayHt: "1",
    oddsSeed: 404,
  }),
  baseFixture("demo-a5", {
    home: "Gamma City",
    away: "Delta Utd",
    league: "ARCHIVE: Sample Cup",
    kickoff: "2023-10-07T16:00:00.000Z",
    homeScore: "1",
    awayScore: "0",
    homeHt: "0",
    awayHt: "0",
    oddsSeed: 405,
  }),
  baseFixture("demo-a6", {
    home: "Echo Wanderers",
    away: "Foxglove AFC",
    league: "ARCHIVE: Demo Div",
    kickoff: "2023-05-14T15:00:00.000Z",
    homeScore: "1",
    awayScore: "1",
    homeHt: "0",
    awayHt: "1",
    oddsSeed: 406,
  }),
  baseFixture("demo-a7", {
    home: "Iron Vale",
    away: "Juniper SC",
    league: "ARCHIVE: Sample Cup",
    kickoff: "2022-11-26T18:45:00.000Z",
    homeScore: "2",
    awayScore: "1",
    homeHt: "1",
    awayHt: "1",
    oddsSeed: 407,
  }),
  baseFixture("demo-a8", {
    home: "Kite Harbor",
    away: "Lumen FC",
    league: "ARCHIVE: Demo Div",
    kickoff: "2024-08-03T12:30:00.000Z",
    homeScore: "0",
    awayScore: "0",
    homeHt: "0",
    awayHt: "0",
    oddsSeed: 408,
  }),
];
