import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeEventQuotes } from "./normalize";

describe("normalizeEventQuotes", () => {
  it("expands nested bookmakers for AH (not only best price)", () => {
    const quotes = normalizeEventQuotes({
      id: "e1",
      source: "flashscore",
      source_event_id: "s1",
      sport: "football",
      competition: "T",
      home_team: "H",
      away_team: "A",
      kickoff_at: "2026-01-01T12:00:00Z",
      status: "scheduled",
      is_closed: false,
      markets_json: {
        bookmakers: { "16": "bet365", "5": "X" },
        markets: [
          {
            key: "ASIAN_HANDICAP:FULL_TIME",
            name: "AH",
            type: "ASIAN_HANDICAP",
            scope: "FULL_TIME",
            line: null,
            selections: [
              {
                key: "H:0.5",
                name: "Home",
                odds: 1.55,
                opening: 1.6,
                bookmaker_id: "5",
                bookmaker_name: "X",
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
      created_at: null,
      updated_at: null,
    });
    assert.equal(quotes.length, 2);
    const bm16 = quotes.find((q) => q.bookmakerId === "16");
    assert.ok(bm16);
    assert.equal(bm16!.closing, 1.5);
    assert.equal(bm16!.line, "0.5");
    assert.equal(bm16!.side, "H:0.5");
  });
});
