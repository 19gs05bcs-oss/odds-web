import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  compareFixturesForTable,
  eventToTableRow,
  fixtureToTableRow,
  fixturesToTableRows,
  mergeFixtureAndArchiveRows,
  normalizeSideToken,
  oddsByColumn,
  profileMatchToTableRow,
  splitLeague,
  tableRowMatchesCriteria,
} from "./tableRows";
import type { FixtureRow } from "@/lib/fixtures";

describe("tableRows", () => {
  it("splits league country / name", () => {
    assert.deepEqual(splitLeague("DENMARK: Superliga"), {
      lig: "DENMARK",
      altLig: "Superliga",
    });
  });

  it("normalizes p:teamId sides", () => {
    assert.equal(normalizeSideToken("p:abc", "abc", "xyz"), "H");
    assert.equal(normalizeSideToken("p:xyz", "abc", "xyz"), "A");
    assert.equal(normalizeSideToken("p:abc:-0.5", "abc", "xyz"), "H:-0.5");
  });

  it("maps compact odds into market columns", () => {
    const f: FixtureRow = {
      match_id: "x",
      bulletin_date: "2026-08-10",
      day_offset: 0,
      league: "DENMARK: Superliga",
      league_country: "DENMARK",
      kickoff_at: "2026-08-10T17:00:00.000Z",
      kickoff_ts: 1,
      home_name: "Silkeborg",
      away_name: "Odense",
      home_id: "h1",
      away_id: "a1",
      home_score: null,
      away_score: null,
      match_url: null,
      bookmakers: { "16": "bet365" },
      odds_count: 4,
      odds: [
        [16, "HOME_DRAW_AWAY", "FULL_TIME", "H", null, 1.9, true],
        [16, "OVER_UNDER", "FULL_TIME", "OVER:2.5", null, 1.85, true],
        [16, "ASIAN_HANDICAP", "FULL_TIME", "H:-0.5", null, 1.95, true],
        [16, "HALF_FULL_TIME", "FULL_TIME", "htft:1/1", null, 5.5, true],
      ],
    };
    const row = fixtureToTableRow(f, 16);
    assert.equal(row.meta.lig, "DENMARK");
    assert.equal(row.meta.altLig, "Superliga");
    assert.equal(row.odds.ms_1?.closing, 1.9);
    assert.equal(row.odds.ou_ms_u2_5?.closing, 1.85);
    assert.equal(row.odds.ah_h_m0_5?.closing, 1.95);
    assert.equal(row.odds.htft_11?.closing, 5.5);
  });

  it("keeps opening and closing separately", () => {
    const f: FixtureRow = {
      match_id: "oc",
      bulletin_date: "2026-08-10",
      day_offset: 0,
      league: "X: Y",
      league_country: "X",
      kickoff_at: "2026-08-10T17:00:00.000Z",
      kickoff_ts: 1,
      home_name: "A",
      away_name: "B",
      home_id: "h",
      away_id: "a",
      home_score: null,
      away_score: null,
      match_url: null,
      bookmakers: {},
      odds_count: 1,
      odds: [[16, "HOME_DRAW_AWAY", "FULL_TIME", "H", "2.50", "2.40", true]] as unknown as FixtureRow["odds"],
    };
    const row = fixtureToTableRow(f, 16);
    assert.equal(row.odds.ms_1?.opening, 2.5);
    assert.equal(row.odds.ms_1?.closing, 2.4);
  });

  it("repairs p: participant 1X2 when team ids wrong", () => {
    const odds = [
      [16, "HOME_DRAW_AWAY", "FULL_TIME", "p:homeX", null, 2.1, true],
      [16, "HOME_DRAW_AWAY", "FULL_TIME", "D", null, 3.2, true],
      [16, "HOME_DRAW_AWAY", "FULL_TIME", "p:awayY", null, 3.5, true],
    ] as const;
    const mapped = oddsByColumn(odds as unknown as import("@/lib/fixtures").CompactOddsRow[], {
      bookmakerId: 16,
      homeId: "WRONG",
      awayId: "ALSO_WRONG",
    });
    assert.equal(mapped.ms_1?.closing, 2.1);
    assert.equal(mapped.ms_x?.closing, 3.2);
    assert.equal(mapped.ms_2?.closing, 3.5);
  });

  it("merges archive + matching fixtures in one list", () => {
    const bulletin = [
      fixtureToTableRow({
        match_id: "f1",
        bulletin_date: "2026-08-10",
        day_offset: 0,
        league: "DENMARK: Superliga",
        league_country: "DENMARK",
        kickoff_at: "2026-08-10T17:00:00.000Z",
        kickoff_ts: 1,
        home_name: "Silkeborg",
        away_name: "Odense",
        home_score: null,
        away_score: null,
        match_url: null,
        bookmakers: {},
        odds_count: 1,
        odds: [[16, "HOME_DRAW_AWAY", "FULL_TIME", "H", null, 1.9, true]],
      }),
    ];
    const archive = [
      {
        ...bulletin[0],
        id: "e1",
        source: "archive" as const,
        meta: { ...bulletin[0].meta, kaynak: "archive", ev: "Old Home", dep: "Old Away" },
      },
    ];
    const merged = mergeFixtureAndArchiveRows(bulletin, archive, {
      criteria: [
        {
          marketType: "HOME_DRAW_AWAY",
          marketScope: "FULL_TIME",
          side: "H",
          targetOdds: 1.9,
        },
      ],
      tolerance: 0,
    });
    assert.equal(merged.length, 2);
    assert.equal(merged[0].meta.kaynak, "fixture");
    assert.equal(merged[1].meta.kaynak, "archive");
  });

  it("includes archive rows even without criteria", () => {
    const bulletin = [
      fixtureToTableRow({
        match_id: "f1",
        bulletin_date: "2026-08-10",
        day_offset: 0,
        league: "X: Y",
        league_country: "X",
        kickoff_at: "2026-08-10T12:00:00.000Z",
        kickoff_ts: 1,
        home_name: "A",
        away_name: "B",
        home_score: null,
        away_score: null,
        match_url: null,
        bookmakers: {},
        odds_count: 0,
        odds: [],
      }),
    ];
    const archive = [
      {
        ...bulletin[0],
        id: "flashscore:x",
        source: "archive" as const,
        meta: { ...bulletin[0].meta, kaynak: "archive", ev: "C", dep: "D" },
      },
    ];
    const merged = mergeFixtureAndArchiveRows(bulletin, archive);
    assert.equal(merged.length, 2);
  });

  it("does not paint outcome for prematch 0-0", () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    const f: FixtureRow = {
      match_id: "y",
      bulletin_date: "2026-08-10",
      day_offset: 0,
      league: "X: Y",
      league_country: "X",
      kickoff_at: future,
      kickoff_ts: 1,
      home_name: "A",
      away_name: "B",
      home_score: "0",
      away_score: "0",
      match_url: null,
      bookmakers: {},
      odds_count: 1,
      odds: [[16, "HOME_DRAW_AWAY", "FULL_TIME", "D", null, 3.0, true]],
    };
    const row = fixtureToTableRow(f, 16);
    assert.equal(row.outcome.ms_x, null);
    assert.equal(row.outcome.ms_1, null);
    assert.equal(row.meta.skor, "");
    assert.equal(row.meta.skor1y, "");
  });

  it("shows half-time score in 1Y column", () => {
    const past = new Date(Date.now() - 3 * 3600000).toISOString();
    const f: FixtureRow = {
      match_id: "ht1",
      bulletin_date: "2026-08-10",
      day_offset: 0,
      league: "X: Y",
      league_country: "X",
      kickoff_at: past,
      kickoff_ts: 1,
      home_name: "A",
      away_name: "B",
      home_score: "2",
      away_score: "1",
      home_ht_score: "1",
      away_ht_score: "0",
      match_url: null,
      bookmakers: {},
      odds_count: 0,
      odds: [],
    };
    const row = fixtureToTableRow(f, 16);
    assert.equal(row.meta.skor, "2-1");
    assert.equal(row.meta.skor1y, "1-0");
    assert.equal(row.outcome.ht_1, "hit");
    assert.equal(row.outcome.ht_x, "miss");
  });

  it("eventToTableRow fills all 1X2 + HT/FT sides from markets_json", () => {
    const event = {
      id: "ev1",
      source: "flashscore",
      source_event_id: "abc",
      sport: "football",
      competition: "ESP: LaLiga",
      home_team: "Sevilla",
      away_team: "X",
      kickoff_at: new Date(Date.now() - 5 * 3600000).toISOString(),
      status: "finished",
      is_closed: true,
      markets_json: {
        markets: [
          {
            type: "HOME_DRAW_AWAY",
            scope: "FULL_TIME",
            selections: [
              { key: "H", odds: 2.5, bookmaker_id: "16" },
              { key: "D", odds: 3.3, bookmaker_id: "16" },
              { key: "A", odds: 3.1, bookmaker_id: "16" },
            ],
          },
          {
            type: "HALF_FULL_TIME",
            scope: "FULL_TIME",
            selections: [
              { key: "htft:1/1", odds: 5.5, bookmaker_id: "16" },
              { key: "htft:1/X", odds: 12, bookmaker_id: "16" },
              { key: "htft:1/2", odds: 18, bookmaker_id: "16" },
              { key: "htft:X/1", odds: 9, bookmaker_id: "16" },
              { key: "htft:X/X", odds: 8, bookmaker_id: "16" },
              { key: "htft:X/2", odds: 11, bookmaker_id: "16" },
              { key: "htft:2/1", odds: 22, bookmaker_id: "16" },
              { key: "htft:2/X", odds: 14, bookmaker_id: "16" },
              { key: "htft:2/2", odds: 7, bookmaker_id: "16" },
            ],
          },
        ],
      },
      markets_hash: null,
      odds_updated_at: null,
      opening_captured_at: null,
      closing_captured_at: null,
      created_at: "",
      updated_at: "",
      home_score: 0,
      away_score: 2,
    };
    const full = eventToTableRow(event as never, 16);
    assert.equal(full.odds.ms_1?.closing, 2.5);
    assert.equal(full.odds.ms_x?.closing, 3.3);
    assert.equal(full.odds.ms_2?.closing, 3.1);
    assert.equal(full.odds.htft_11?.closing, 5.5);
    assert.equal(full.odds.htft_1X?.closing, 12);
    assert.equal(full.odds.htft_22?.closing, 7);

    const sparse = profileMatchToTableRow({
      eventId: "ev1",
      sourceEventId: "abc",
      competition: "ESP: LaLiga",
      seasonSlug: null,
      round: null,
      homeTeam: "Sevilla",
      awayTeam: "X",
      kickoffAt: event.kickoff_at,
      score: "0-2",
      htScore: null,
      hits: [
        {
          marketType: "HOME_DRAW_AWAY",
          marketScope: "FULL_TIME",
          side: "D",
          sideName: "Draw",
          line: null,
          targetOdds: 3.3,
          closing: 3.3,
          opening: null,
          bookmakerId: "16",
          bookmakerName: "bet365",
        },
      ],
    });
    assert.equal(sparse.odds.ms_x?.closing, 3.3);
    assert.equal(sparse.odds.ms_1, null);
    assert.equal(sparse.odds.ms_2, null);
  });

  it("puts finished fixtures below upcoming/live", () => {
    const future = new Date(Date.now() + 2 * 3600000).toISOString();
    const past = new Date(Date.now() - 3 * 3600000).toISOString();
    const sampleOdds: FixtureRow["odds"] = [
      [16, "HOME_DRAW_AWAY", "FULL_TIME", "H", null, 1.9, true],
    ];
    const base = {
      bulletin_date: "2026-08-10",
      day_offset: 0,
      league: "X: Y",
      league_country: "X",
      kickoff_ts: 1,
      home_id: "h",
      away_id: "a",
      match_url: null,
      bookmakers: {},
      odds_count: 1,
      odds: sampleOdds,
    };
    const finished: FixtureRow = {
      ...base,
      match_id: "done",
      kickoff_at: past,
      home_name: "Finished FC",
      away_name: "B",
      home_score: "2",
      away_score: "1",
      odds_count: 500,
      odds: [[16, "HOME_DRAW_AWAY", "FULL_TIME", "H", null, 1.5, true]],
    };
    const upcoming: FixtureRow = {
      ...base,
      match_id: "up",
      kickoff_at: future,
      home_name: "Upcoming FC",
      away_name: "C",
      home_score: null,
      away_score: null,
    };
    const liveSoon: FixtureRow = {
      ...base,
      match_id: "live",
      kickoff_at: new Date(Date.now() - 30 * 60000).toISOString(),
      home_name: "Live FC",
      away_name: "D",
      home_score: "1",
      away_score: "0",
    };
    assert.ok(compareFixturesForTable(upcoming, finished) < 0);
    assert.ok(compareFixturesForTable(liveSoon, finished) < 0);
    const rows = fixturesToTableRows([finished, upcoming, liveSoon], 16);
    assert.deepEqual(
      rows.map((r) => r.meta.ev),
      ["Live FC", "Upcoming FC", "Finished FC"],
    );
  });

  it("AH uses nested bookmakers and ignores other BM prices", () => {
    const event = {
      id: "ah-nested",
      source: "flashscore",
      source_event_id: "ahx",
      sport: "football",
      competition: "SCO: Prem",
      home_team: "Home",
      away_team: "Away",
      kickoff_at: "2026-08-11T12:00:00.000Z",
      status: "scheduled",
      is_closed: false,
      markets_json: {
        bookmakers: { "16": "bet365", "5": "Other" },
        markets: [
          {
            type: "ASIAN_HANDICAP",
            scope: "FULL_TIME",
            line: null,
            selections: [
              {
                key: "H:0.5",
                name: "Home +0.5",
                odds: 1.55,
                opening: 1.6,
                bookmaker_id: "5",
                bookmaker_name: "Other",
                suspended: false,
                bookmakers: {
                  "16": { opening: 1.53, current: 1.5, active: true },
                  "5": { opening: 1.6, current: 1.55, active: true },
                },
              },
            ],
          },
        ],
      },
      markets_hash: null,
      odds_updated_at: null,
      opening_captured_at: null,
      closing_captured_at: null,
      created_at: "",
      updated_at: "",
      home_score: null,
      away_score: null,
    };
    const row16 = eventToTableRow(event as never, 16);
    assert.equal(row16.odds.ah_h_0_5?.closing, 1.5);
    assert.equal(row16.odds.ah_h_0_5?.opening, 1.53);
    const row5 = eventToTableRow(event as never, 5);
    assert.equal(row5.odds.ah_h_0_5?.closing, 1.55);
    assert.equal(
      tableRowMatchesCriteria(
        row16,
        [
          {
            marketType: "ASIAN_HANDICAP",
            marketScope: "FULL_TIME",
            side: "H",
            line: "0.5",
            targetOdds: 1.5,
            price: "closing",
            columnId: "ah_h_0_5",
          },
        ],
        0,
      ),
      true,
    );
  });

  it("AH filter matches only the clicked line column", () => {
    const row = fixtureToTableRow(
      {
        match_id: "ah1",
        bulletin_date: "2026-08-11",
        day_offset: 0,
        league: "X: Y",
        league_country: "X",
        kickoff_at: "2026-08-11T12:00:00.000Z",
        kickoff_ts: 1,
        home_name: "A",
        away_name: "B",
        home_score: null,
        away_score: null,
        match_url: null,
        bookmakers: {},
        odds_count: 2,
        odds: [
          [16, "ASIAN_HANDICAP", "FULL_TIME", "H:0.5", 1.53, 1.5, true],
          [16, "ASIAN_HANDICAP", "FULL_TIME", "H:0", 1.9, 1.48, true],
        ],
      },
      16,
    );
    const ok = tableRowMatchesCriteria(
      row,
      [
        {
          marketType: "ASIAN_HANDICAP",
          marketScope: "FULL_TIME",
          side: "H",
          line: "0.5",
          targetOdds: 1.5,
          price: "closing",
          columnId: "ah_h_0_5",
        },
      ],
      0,
    );
    assert.equal(ok, true);
    const bad = tableRowMatchesCriteria(
      row,
      [
        {
          marketType: "ASIAN_HANDICAP",
          marketScope: "FULL_TIME",
          side: "H",
          line: "0.5",
          targetOdds: 1.48,
          price: "closing",
          columnId: "ah_h_0_5",
        },
      ],
      0,
    );
    assert.equal(bad, false);
  });

  it("hides fixtures with no odds markets", () => {
    const future = new Date(Date.now() + 3600000).toISOString();
    const withOdds: FixtureRow = {
      match_id: "ok",
      bulletin_date: "2026-08-10",
      day_offset: 0,
      league: "X: Y",
      league_country: "X",
      kickoff_at: future,
      kickoff_ts: 1,
      home_name: "Has Odds",
      away_name: "B",
      home_id: "h",
      away_id: "a",
      home_score: null,
      away_score: null,
      match_url: null,
      bookmakers: {},
      odds_count: 1,
      odds: [[16, "HOME_DRAW_AWAY", "FULL_TIME", "H", null, 2.0, true]],
    };
    const noOdds: FixtureRow = {
      ...withOdds,
      match_id: "empty",
      home_name: "No Market",
      odds_count: 0,
      odds: [],
    };
    const countOnly: FixtureRow = {
      ...withOdds,
      match_id: "count-lie",
      home_name: "Count Only",
      odds_count: 12,
      odds: null,
    };
    const rows = fixturesToTableRows([noOdds, countOnly, withOdds], 16);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].meta.ev, "Has Odds");
  });
});



