import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { searchOddsProfile, type OddsCriterion } from "./profile";
import type { Quote } from "./types";

function q(p: Partial<Quote> & Pick<Quote, "eventId" | "side" | "closing" | "marketType">): Quote {
  return {
    sourceEventId: p.eventId,
    competition: "PL",
    seasonSlug: "england/premier-league-2017-2018",
    round: "R1",
    homeTeam: "Home",
    awayTeam: "Away",
    kickoffAt: "2017-01-01T15:00:00Z",
    homeScore: 1,
    awayScore: 0,
    marketScope: "FULL_TIME",
    marketKey: "k",
    marketName: "m",
    line: null,
    sideName: p.side,
    opening: p.closing,
    bookmakerId: "16",
    bookmakerName: "bet365",
    suspended: false,
    ...p,
  };
}

describe("searchOddsProfile", () => {
  it("finds away ~1.44 then narrows with draw and over 2.5", () => {
    const quotes: Quote[] = [
      // match A: away 1.44, draw 4.3, over 2.5 = 2.1
      q({ eventId: "a", homeTeam: "Hull", awayTeam: "Man Utd", side: "A", closing: 1.44, marketType: "HOME_DRAW_AWAY" }),
      q({ eventId: "a", side: "D", closing: 4.33, marketType: "HOME_DRAW_AWAY" }),
      q({ eventId: "a", side: "OVER", closing: 2.1, marketType: "OVER_UNDER", line: "2.5", marketName: "OU 2.5" }),
      // match B: away 1.44 but draw 3.0 — fails X filter
      q({ eventId: "b", side: "A", closing: 1.45, marketType: "HOME_DRAW_AWAY" }),
      q({ eventId: "b", side: "D", closing: 3.0, marketType: "HOME_DRAW_AWAY" }),
      q({ eventId: "b", side: "OVER", closing: 2.1, marketType: "OVER_UNDER", line: "2.5" }),
      // match C: away 2.5 — fails first filter
      q({ eventId: "c", side: "A", closing: 2.5, marketType: "HOME_DRAW_AWAY" }),
    ];

    const c1: OddsCriterion = {
      marketType: "HOME_DRAW_AWAY",
      marketScope: "FULL_TIME",
      side: "A",
      targetOdds: 1.44,
    };
    const onlyAway = searchOddsProfile(quotes, { criteria: [c1], tolerance: 0.05 });
    assert.equal(onlyAway.totalMatched, 2);

    const withX = searchOddsProfile(quotes, {
      criteria: [
        c1,
        { marketType: "HOME_DRAW_AWAY", marketScope: "FULL_TIME", side: "D", targetOdds: 4.33 },
      ],
      tolerance: 0.15,
    });
    assert.equal(withX.totalMatched, 1);
    assert.equal(withX.matches[0]?.eventId, "a");

    const withOu = searchOddsProfile(quotes, {
      criteria: [
        c1,
        { marketType: "HOME_DRAW_AWAY", marketScope: "FULL_TIME", side: "D", targetOdds: 4.33 },
        { marketType: "OVER_UNDER", marketScope: "FULL_TIME", side: "OVER", line: "2.5", targetOdds: 2.1 },
      ],
      tolerance: 0.15,
    });
    assert.equal(withOu.totalMatched, 1);
    assert.equal(withOu.matches[0]?.hits.length, 3);
  });

  it("matches opening-only when price=opening", () => {
    const quotes: Quote[] = [
      q({
        eventId: "open-only",
        side: "H",
        marketType: "HOME_DRAW_AWAY",
        marketScope: "FIRST_HALF",
        closing: 2.1,
        opening: 2.3,
      }),
    ];
    const byOpen = searchOddsProfile(quotes, {
      criteria: [
        {
          marketType: "HOME_DRAW_AWAY",
          marketScope: "FIRST_HALF",
          side: "H",
          targetOdds: 2.3,
          price: "opening",
        },
      ],
      tolerance: 0,
    });
    assert.equal(byOpen.totalMatched, 1);

    const byClose = searchOddsProfile(quotes, {
      criteria: [
        {
          marketType: "HOME_DRAW_AWAY",
          marketScope: "FIRST_HALF",
          side: "H",
          targetOdds: 2.3,
          price: "closing",
        },
      ],
      tolerance: 0,
    });
    assert.equal(byClose.totalMatched, 0);
  });

  it("HT/FT archive search works with bet365 filter on slim quotes (no per-BM blob)", () => {
    const quotes: Quote[] = [
      q({
        eventId: "ht-slim",
        side: "htft:1/2",
        marketType: "HALF_FULL_TIME",
        marketScope: "FULL_TIME",
        closing: 18,
        opening: 21,
        bookmakerId: null,
      }),
    ];
    const res = searchOddsProfile(quotes, {
      criteria: [
        {
          marketType: "HALF_FULL_TIME",
          marketScope: "FULL_TIME",
          side: "htft:1/2",
          targetOdds: 21,
          price: "opening",
          columnId: "htft_12",
        },
      ],
      bookmakerId: "16",
      tolerance: 0,
    });
    assert.equal(res.totalMatched, 1);
    assert.equal(res.matches[0]?.eventId, "ht-slim");
  });

  it("AH line from side token matches bookmaker-specific quote", () => {
    const quotes: Quote[] = [
      q({
        eventId: "ah1",
        side: "H:0.5",
        marketType: "ASIAN_HANDICAP",
        line: "0.5",
        closing: 1.5,
        opening: 1.53,
        bookmakerId: "16",
      }),
      q({
        eventId: "ah1",
        side: "H:0.5",
        marketType: "ASIAN_HANDICAP",
        line: "0.5",
        closing: 1.55,
        opening: 1.6,
        bookmakerId: "5",
      }),
      q({
        eventId: "ah2",
        side: "H:0",
        marketType: "ASIAN_HANDICAP",
        line: "0",
        closing: 1.5,
        bookmakerId: "16",
      }),
    ];
    const res = searchOddsProfile(quotes, {
      criteria: [
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
      bookmakerId: "16",
      tolerance: 0,
    });
    assert.equal(res.totalMatched, 1);
    assert.equal(res.matches[0]?.eventId, "ah1");
  });
});

