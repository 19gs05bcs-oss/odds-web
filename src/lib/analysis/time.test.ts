import test from "node:test";
import assert from "node:assert/strict";
import { clockInTz, dayKeyInTz, shiftDayKey, zonedParts } from "@/lib/time";
import { kickoffParts } from "@/lib/analysis/tableRows";

test("23:00 CET kickoff stays on its own European day (not the next Turkish day)", () => {
  // 2026-01-15 22:00Z = 23:00 CET (winter) = 01:00 on the 16th in Istanbul (UTC+3)
  assert.equal(clockInTz("2026-01-15T22:00:00Z", "Europe/Berlin"), "23:00");
  assert.equal(dayKeyInTz("2026-01-15T22:00:00Z", "Europe/Berlin"), "2026-01-15");
  assert.equal(dayKeyInTz("2026-01-15T22:00:00Z", "Europe/Istanbul"), "2026-01-16");
});

test("summer time (CEST) is applied", () => {
  // 2026-07-15 21:00Z = 23:00 CEST
  assert.equal(clockInTz("2026-07-15T21:00:00Z", "Europe/Berlin"), "23:00");
  assert.equal(dayKeyInTz("2026-07-15T21:00:00Z", "Europe/Berlin"), "2026-07-15");
});

test("midnight is 00:00, never 24:00", () => {
  assert.equal(clockInTz("2026-01-15T23:00:00Z", "Europe/Berlin"), "00:00");
  assert.equal(dayKeyInTz("2026-01-15T23:00:00Z", "Europe/Berlin"), "2026-01-16");
});

test("invalid / missing input is safe", () => {
  assert.equal(clockInTz(null), "");
  assert.equal(clockInTz("not-a-date"), "");
  assert.equal(zonedParts("nope"), null);
});

test("shiftDayKey is pure calendar arithmetic", () => {
  assert.equal(shiftDayKey("2026-03-01", -1), "2026-02-28");
  assert.equal(shiftDayKey("2026-12-31", 1), "2027-01-01");
});

test("kickoffParts uses European wall clock regardless of process TZ", () => {
  const p = kickoffParts("2026-01-15T22:00:00Z");
  assert.equal(p.saat, "23:00");
  assert.equal(p.gun, "15");
  assert.equal(p.ay, "01");
  assert.equal(p.gunAdi, "Thursday");
});
