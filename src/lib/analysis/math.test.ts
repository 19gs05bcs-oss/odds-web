import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bestClosing,
  devigMultiplicative,
  driftOddsPct,
  edgePct,
  impliedProb,
} from "./math";

describe("impliedProb", () => {
  it("maps decimal odds to probability", () => {
    assert.equal(impliedProb(2), 0.5);
    assert.ok(Math.abs((impliedProb(1.5) ?? 0) - 2 / 3) < 1e-9);
    assert.equal(impliedProb(1), null);
    assert.equal(impliedProb(null), null);
  });
});

describe("devigMultiplicative", () => {
  it("normalizes overround to 1", () => {
    const fair = devigMultiplicative([0.55, 0.3, 0.25]);
    const sum = (fair[0] ?? 0) + (fair[1] ?? 0) + (fair[2] ?? 0);
    assert.ok(Math.abs(sum - 1) < 1e-9);
  });
});

describe("edgePct", () => {
  it("is positive when odds beat fair", () => {
    // fair 50%, odds 2.2 → implied ~45.45% → positive edge
    const e = edgePct(2.2, 0.5);
    assert.ok(e != null && e > 0);
  });
});

describe("driftOddsPct", () => {
  it("measures opening to closing move", () => {
    assert.ok(Math.abs((driftOddsPct(2, 2.2) ?? 0) - 10) < 1e-9);
    assert.ok(Math.abs((driftOddsPct(2, 1.8) ?? 0) - -10) < 1e-9);
  });
});

describe("bestClosing", () => {
  it("picks highest closing price", () => {
    const b = bestClosing([
      { closing: 1.9, bookmakerId: "1", bookmakerName: "A" },
      { closing: 2.1, bookmakerId: "2", bookmakerName: "B" },
    ]);
    assert.equal(b?.closing, 2.1);
    assert.equal(b?.bookmakerName, "B");
  });
});
