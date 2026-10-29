import { describe, expect, it } from "vitest";
import { skillStats, tStat, type EntryOutcome } from "./stats";

describe("tStat", () => {
  it("matches a hand calculation", () => {
    const { mean, sd, t } = tStat([1, 2, 3, 4]);
    expect(mean).toBe(2.5);
    expect(sd).toBeCloseTo(Math.sqrt(5 / 3), 10);
    expect(t).toBeCloseTo(2.5 / (Math.sqrt(5 / 3) / 2), 10);
  });
  it("is 0 for fewer than two observations", () => {
    expect(tStat([]).t).toBe(0);
    expect(tStat([3]).t).toBe(0);
  });
});

describe("skillStats", () => {
  it("ignores unresolved entries and clusters by UTC day", () => {
    const day = (d: number, h: number) => Date.UTC(2026, 0, d, h);
    const o = (ts: number, move: number | null): EntryOutcome => ({ botId: 1, ts, dir: 1, horizon: "1h", movePips: move });
    const s = skillStats([o(day(5, 1), -2), o(day(5, 2), -4), o(day(6, 1), -1), o(day(7, 1), -3), o(day(7, 2), null)]);
    expect(s.n).toBe(4);
    expect(s.meanPips).toBe(-2.5);
    expect(s.hitRate).toBe(0);
    expect(s.days).toBe(3);
    expect(s.tStat).toBeLessThan(0);
    expect(s.tStatDaily).toBeCloseTo(tStat([-3, -1, -3]).t, 10);
  });
});
