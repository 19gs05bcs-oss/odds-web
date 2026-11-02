import test from "node:test";
import assert from "node:assert/strict";
import { resultFromScore } from "@/lib/analysis/tableRows";
import { defaultVisibleGroupIds, visibleColumns } from "@/lib/analysis/tableColumns";

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

test("HT RES / FT RES sit right after FT and before the first market column", () => {
  const cols = visibleColumns(new Set(defaultVisibleGroupIds()));
  const ids = cols.map((c) => c.id);
  const ft = ids.indexOf("skor");
  assert.equal(ids[ft + 1], "htRes");
  assert.equal(ids[ft + 2], "ftRes");
  const firstMarket = cols.findIndex((c) => c.kind === "market");
  assert.equal(firstMarket, ft + 3);
});
