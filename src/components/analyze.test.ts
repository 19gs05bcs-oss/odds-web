import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeQuotes } from "./analyze";
import type { Quote } from "./types";

function q(partial: Partial<Quote> & Pick<Quote, "side" | "opening" | "closing">): Quote {
  return {
    eventId: "flashscore:1",
    sourceEventId: "1",
    competition: "Premier League 2025-2026",
    seasonSlug: "england/premier-league-2025-2026",
    round: "Round 1",
    homeTeam: "Home",
    awayTeam: "Away",
    kickoffAt: "2025-08-15T15:00:00Z",
    homeScore: 1,
    awayScore: 0,
    marketType: "HOME_DRAW_AWAY",
    marketScope: "FULL_TIME",
    marketKey: "HOME_DRAW_AWAY:FULL_TIME",
    marketName: "1X2",
    line: null,
    sideName: partial.side,
    bookmakerId: "16",
    bookmakerName: "bet365",
    suspended: false,
    ...partial,
  };
}

describe("analyzeQuotes", () => {
  it("computes drift and filters by minAbsDriftPct", () => {
    const quotes = [
      q({ side: "H", sideName: "Home", opening: 2.0, closing: 2.4 }),
      q({ side: "D", sideName: "Draw", opening: 3.2, closing: 3.3 }),
      q({ side: "A", sideName: "Away", opening: 3.5, closing: 3.4 }),
    ];
    const res = analyzeQuotes(quotes, { minAbsDriftPct: 10, marketType: "HOME_DRAW_AWAY" });
    assert.ok(res.totalMatched >= 1);
    assert.ok(res.rows.every((r) => Math.abs(r.driftProbPct ?? r.driftOddsPct ?? 0) >= 10));
  });

  it("attaches model edge from de-vig", () => {
    const quotes = [
      q({ side: "H", opening: 1.9, closing: 1.9 }),
      q({ side: "D", opening: 3.5, closing: 3.5 }),
      q({ side: "A", opening: 4.0, closing: 4.0 }),
    ];
    const res = analyzeQuotes(quotes, {});
    assert.equal(res.rows.length, 3);
    assert.ok(res.rows.some((r) => r.fairProb != null && r.edgePct != null));
  });

  it("filters by odds band before ranking", () => {
    const quotes = [
      q({ side: "H", opening: 1.5, closing: 1.5 }),
      q({ side: "D", opening: 1.9, closing: 1.92 }),
      q({ side: "A", opening: 4.0, closing: 4.2 }),
    ];
    const res = analyzeQuotes(quotes, { minOdds: 1.8, maxOdds: 2.1, sort: "odds" });
    assert.equal(res.totalMatched, 1);
    assert.equal(res.rows[0]?.side, "D");
  });
});
