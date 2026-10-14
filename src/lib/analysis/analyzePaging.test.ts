import test from "node:test";
import assert from "node:assert/strict";
import {
  applyFiltersToMatches,
  clampPage,
  clampPageSize,
  filtersKey,
  pageCount,
  sanitizeFilters,
  searchCacheKey,
  splitFilters,
} from "./analyzePaging";
import { buildQuoteCandidateCte } from "./marketQuoteCriteria";
import type { ProfileMatch } from "./profile";

function mk(id: string, home: string, away: string, score: string): ProfileMatch {
  return {
    eventId: id,
    sourceEventId: id,
    competition: "England - Premier League",
    seasonSlug: "2020",
    round: null,
    homeTeam: home,
    awayTeam: away,
    kickoffAt: "2020-01-01T15:00:00Z",
    score,
    htScore: null,
    hits: [],
  };
}

test("page helpers clamp inputs", () => {
  assert.equal(clampPage(undefined), 1);
  assert.equal(clampPage(-3), 1);
  assert.equal(clampPage("4"), 4);
  assert.equal(clampPageSize(undefined), 50);
  assert.equal(clampPageSize(10000), 100);
  assert.equal(pageCount(0, 50), 1);
  assert.equal(pageCount(101, 50), 3);
});

test("sanitizeFilters drops junk and trims", () => {
  const f = sanitizeFilters({ ev: "  Arsenal ", "bad key!": "x", n: 5, empty: "  ", ms_1__o: "2.00" });
  assert.deepEqual(f, { ev: "Arsenal", ms_1__o: "2.00" });
  assert.equal(filtersKey({}), "");
  assert.notEqual(filtersKey({ ev: "a" }), filtersKey({ ev: "b" }));
});

test("splitFilters separates meta and odds columns", () => {
  const { meta, odds } = splitFilters({ ev: "ars", ms_1__o: "2.00", ms_1: "2.1" });
  assert.deepEqual(Object.keys(meta), ["ev"]);
  assert.deepEqual(Object.keys(odds).sort(), ["ms_1", "ms_1__o"]);
});

test("meta filters apply to ALL matches, not a page", async () => {
  const matches: ProfileMatch[] = [];
  for (let i = 0; i < 500; i++) matches.push(mk(`e${i}`, i % 50 === 0 ? "Arsenal" : "Other", "Away", "1-0"));
  const r = await applyFiltersToMatches(matches, { ev: "arsenal" }, async () => {
    throw new Error("odds builder must not be called for meta-only filters");
  });
  assert.equal(r.ids.length, 10);
  assert.equal(r.scanCapped, false);
});

test("cache key is per user and stable", () => {
  const q = { criteria: [{ marketType: "HOME_DRAW_AWAY", marketScope: "FULL_TIME", side: "H", targetOdds: 2 }], bookmakerId: "bet365", tolerance: 0 };
  assert.equal(searchCacheKey("u1", q), searchCacheKey("u1", { ...q }));
  assert.notEqual(searchCacheKey("u1", q), searchCacheKey("u2", q));
});

function cte(opts: Parameters<typeof buildQuoteCandidateCte>[1]): string {
  const params: unknown[] = [];
  const text = buildQuoteCandidateCte("q0", opts, (v) => {
    params.push(v);
    return `$${params.length}`;
  });
  return text + "\n-- " + JSON.stringify(params);
}

test("O/U with line uses exact market + exact selections, no LIKE, bookmaker equality", () => {
  const t = cte({ marketType: "OVER_UNDER", marketScope: "FULL_TIME", side: "OVER", line: "2.5", oddsRange: [1.895, 1.905], bookmakerId: "bet365" });
  assert.ok(!/LIKE/.test(t), t);
  assert.ok(!/bookmaker IS NULL/.test(t), t);
  assert.ok(t.includes('"OVER:2.5"'), t);
  assert.ok(t.includes("AND bookmaker = $"), t);
});

test("1X2 uses exact market and exact selection", () => {
  const t = cte({ marketType: "HOME_DRAW_AWAY", marketScope: "FULL_TIME", side: "H", oddsRange: [1.99, 2.01], bookmakerId: "bet365" });
  assert.ok(!/LIKE/.test(t), t);
  assert.ok(/market = \$/.test(t), t);
});

test("unknown market types keep the loose (backward compatible) predicates", () => {
  const t = cte({ marketType: "SOME_NEW_MARKET", marketScope: "FULL_TIME", side: "H", oddsRange: [1.5, 1.6] });
  assert.ok(/market LIKE/.test(t), t);
  assert.ok(/selection LIKE/.test(t), t);
});

test("AH with line accepts both 2-part and 3-part market strings", () => {
  const t = cte({ marketType: "ASIAN_HANDICAP", marketScope: "FULL_TIME", side: "H", line: "-0.5", oddsRange: [1.9, 2.0], bookmakerId: "bet365" });
  assert.ok(/market IN \(\$\d+, \$\d+\)/.test(t), t);
  assert.ok(t.includes("ASIAN_HANDICAP:FULL_TIME:-0.5"), t);
});
