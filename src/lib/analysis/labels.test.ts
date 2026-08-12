import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { prettySideName, sideMatchesFilter } from "./labels";

describe("prettySideName", () => {
  it("labels BTTS yes/no distinctly", () => {
    assert.equal(prettySideName("btts:YES", "No", "BOTH_TEAMS_TO_SCORE"), "BTTS Yes");
    assert.equal(prettySideName("btts:NO", "No", "BOTH_TEAMS_TO_SCORE"), "BTTS No");
    assert.equal(prettySideName("btts:YES", "Yes", "BOTH_TEAMS_TO_SCORE"), "BTTS Yes");
  });
});

describe("sideMatchesFilter", () => {
  it("matches BTTS aliases", () => {
    assert.equal(sideMatchesFilter("btts:YES", "BTTS Yes", "btts:YES"), true);
    assert.equal(sideMatchesFilter("btts:YES", "BTTS Yes", "yes"), true);
    assert.equal(sideMatchesFilter("btts:NO", "BTTS No", "no"), true);
    assert.equal(sideMatchesFilter("btts:YES", "BTTS Yes", "btts:NO"), false);
  });
});
