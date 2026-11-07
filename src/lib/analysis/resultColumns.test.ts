import test from "node:test";
import assert from "node:assert/strict";
import {
  oddsByColumn,
  outcomeForColumns,
  resultFromScore,
  secondHalfScore,
} from "@/lib/analysis/tableRows";
import {
  ALL_COLUMNS,
  defaultVisibleGroupIds,
  OPT_IN_GROUPS,
  visibleColumns,
} from "@/lib/analysis/tableColumns";

test("resultFromScore maps scores to Home / Draw / Away", () => {
  assert.equal(resultFromScore("2-1"), "Home");
  assert.equal(resultFromScore("1-1"), "Draw");
  assert.equal(resultFromScore("0-0"), "Draw");
  assert.equal(resultFromScore("0-3"), "Away");
  assert.equal(resultFromScore(" 10 - 2 "), "Home");
});

test("resultFromScore is empty for missing / invalid scores (fixtures)", () => {
  assert.equal(resultFromScore(""), "");
  assert.equal(resultFromScore(null), "");
  assert.equal(resultFromScore(undefined), "");
  assert.equal(resultFromScore("abc"), "");
});

test("HT RES / FT RES / 2H RES sit right after the 2H score and before the first market column", () => {
  const cols = visibleColumns(new Set(defaultVisibleGroupIds()));
  const ids = cols.map((c) => c.id);
  const ft = ids.indexOf("skor");
  assert.equal(ids[ft + 1], "skor2y");
  assert.equal(ids[ft + 2], "htRes");
  assert.equal(ids[ft + 3], "ftRes");
  assert.equal(ids[ft + 4], "shRes");
  const firstMarket = cols.findIndex((c) => c.kind === "market");
  assert.equal(firstMarket, ft + 5);
});

test("FT 1X2 columns come before HT 1X2 columns, then 2H", () => {
  const ids = ALL_COLUMNS.map((c) => c.id);
  assert.deepEqual(ids.slice(ids.indexOf("ms_1"), ids.indexOf("ms_1") + 9), [
    "ms_1", "ms_x", "ms_2",
    "ht_1", "ht_x", "ht_2",
    "sh_1", "sh_x", "sh_2",
  ]);
  const first = ALL_COLUMNS.find((c) => c.kind === "market");
  assert.equal(first?.id, "ms_1");
});

test("secondHalfScore = FT − HT, empty when unknown or inconsistent", () => {
  assert.equal(secondHalfScore("3-2", "1-1"), "2-1");
  assert.equal(secondHalfScore("1-1", "1-1"), "0-0");
  assert.equal(secondHalfScore("1-0", ""), "");
  assert.equal(secondHalfScore("", "0-0"), "");
  assert.equal(secondHalfScore("0-1", "1-0"), ""); // HT > FT: bad data
});

test("Odd/Even columns exist for FT, HT and 2H and map archive tokens", () => {
  const oe = ALL_COLUMNS.filter((c) => c.kind === "market" && c.group === "oe");
  assert.equal(oe.length, 6);
  const cells = oddsByColumn([
    [16, "ODD_OR_EVEN", "FULL_TIME", "sel:ODD", 1.9, 1.85, true],
    [16, "ODD_OR_EVEN", "FIRST_HALF", "sel:EVEN", 1.5, 1.45, true],
    [16, "ODD_OR_EVEN", "SECOND_HALF", "sel:ODD", 2.0, 2.05, true],
  ]);
  assert.deepEqual(cells["oe_odd"], { opening: 1.9, closing: 1.85 });
  assert.deepEqual(cells["oe_even_ht"], { opening: 1.5, closing: 1.45 });
  assert.deepEqual(cells["oe_odd_2h"], { opening: 2.0, closing: 2.05 });
  assert.equal(cells["oe_even"], null);
});

test("column ids are unique and extra-line groups do not duplicate main columns", () => {
  const ids = ALL_COLUMNS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  const keys = ALL_COLUMNS.filter((c) => c.kind === "market").map(
    (c) => `${c.marketType}|${c.marketScope}|${c.side}|${c.line == null ? "" : Number(c.line)}`,
  );
  assert.equal(new Set(keys).size, keys.length);
});

test("opt-in groups are off by default and switch on as a whole", () => {
  const def = defaultVisibleGroupIds();
  for (const g of OPT_IN_GROUPS) assert.equal(def.has(g), false, g);
  const withCs = new Set(def).add("cs");
  const csCols = visibleColumns(withCs).filter((c) => c.kind === "market" && c.group === "cs");
  assert.equal(csCols.length, 36);
});

const NOW_PAST = "2020-01-01T12:00:00Z";
function settle(h: number, a: number, ht: [number, number] | null) {
  return outcomeForColumns(h, a, ALL_COLUMNS, NOW_PAST, ht?.[0] ?? null, ht?.[1] ?? null);
}

test("outcomes: 2H markets use FT − HT; HT-only data leaves 2H unpainted", () => {
  const o = settle(3, 2, [1, 1]); // 2H = 2-1
  assert.equal(o["sh_1"], "hit");
  assert.equal(o["sh_x"], "miss");
  assert.equal(o["btts_y_2h"], "hit");
  assert.equal(o["ou_2h_u2_5"], "hit"); // 3 goals in 2H
  assert.equal(o["ou_2h_a2_5"], "miss");
  assert.equal(o["cs_2h_2_1"], "hit");
  assert.equal(o["oe_odd_2h"], "hit");
  assert.equal(o["oe_even"], "miss"); // 5 goals FT
  assert.equal(o["dc_1x_2h"], "hit");
  const noHt = settle(3, 2, null);
  assert.equal(noHt["sh_1"], null);
  assert.equal(noHt["ht_1"], null);
  assert.equal(noHt["ms_1"], "hit");
});

test("outcomes: Asian handicap home side incl. quarter lines; away side unpainted", () => {
  const o = settle(2, 1, [0, 0]); // home wins by 1
  assert.equal(o["ah_h_m0_5"], "hit");
  assert.equal(o["ah_h_m1"], null); // push
  assert.equal(o["ah_h_m1_5"], "miss");
  assert.equal(o["ah_h_m0_75"], null); // -0.5 wins, -1.0 pushes → half win, not painted
  assert.equal(o["ah_h_m0_25"], "hit"); // -0 / -0.5 both win
  assert.equal(o["ah_a_m0_5"], null);
});

test("outcomes: DNB (push on draw), EH, quarter O/U", () => {
  const draw = settle(1, 1, [0, 0]);
  assert.equal(draw["dnb_h"], null);
  const win = settle(2, 0, [1, 0]);
  assert.equal(win["dnb_h"], "hit");
  assert.equal(win["dnb_a"], "miss");
  // EH home -1 with 2-0: 2-1 > 0 → home wins the handicap
  assert.equal(win["eh_h_m1"], "hit");
  assert.equal(win["eh_x_m1"], "miss");
  assert.equal(win["eh_a_m1"], "miss");
  // 2 goals: Over 1.75 → 1.5 wins / 2.0 pushes = half win (not painted); Over 2.25 → half loss
  assert.equal(win["oux_ms_u1_75"], null);
  assert.equal(win["oux_ms_u2_25"], null);
  // 3 goals: Over 1.75 and Over 2.25 are clean wins; Over 2.75 is a half win; Under 2.25 clean loss
  const three = settle(3, 0, [1, 0]);
  assert.equal(three["oux_ms_u1_75"], "hit");
  assert.equal(three["oux_ms_u2_25"], "hit");
  assert.equal(three["oux_ms_u2_75"], null);
  assert.equal(three["oux_ms_a2_25"], "miss");
  // whole line: 3 goals vs Over 3.0 → push
  assert.equal(three["oux_ms_u3"], null);
});
