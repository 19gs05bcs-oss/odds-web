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

describe("prettySideName (handball markets)", () => {
  it("labels bare OVER/UNDER, odd/even and HT/FT", () => {
    assert.equal(prettySideName("OVER", "OVER", "OVER_UNDER"), "Over");
    assert.equal(prettySideName("UNDER", "UNDER", "OVER_UNDER"), "Under");
    assert.equal(prettySideName("sel:ODD", "sel:ODD", "ODD_OR_EVEN"), "Odd");
    assert.equal(prettySideName("sel:EVEN", "sel:EVEN", "ODD_OR_EVEN"), "Even");
    assert.equal(prettySideName("htft:1/X", "htft:1/X", "HALF_FULL_TIME"), "1/X");
    assert.equal(prettySideName("OVER:59.5", "", "OVER_UNDER"), "Over 59.5");
  });
});
