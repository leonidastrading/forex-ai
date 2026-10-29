import { describe, expect, it } from "vitest";
import { applyFill, FLAT, fillPrice, invertFills, maxDrawdown, replayEquity, unrealizedPnl, type Fill } from "./sim";
import { planOrder } from "./engine";

describe("applyFill", () => {
  it("opens, adds with weighted average, reduces, and closes", () => {
    let r = applyFill(FLAT, "buy", 10_000, 1.1);
    expect(r.kind).toBe("open");
    expect(r.openingUnits).toBe(10_000);
    r = applyFill(r.position, "buy", 10_000, 1.12);
    expect(r.kind).toBe("add");
    expect(r.position.avgPrice).toBeCloseTo(1.11, 10);
    r = applyFill(r.position, "sell", 5_000, 1.13);
    expect(r.kind).toBe("reduce");
    expect(r.openingUnits).toBe(0);
    expect(r.realizedPnl).toBeCloseTo(100, 6); // 5000 * 0.02
    expect(r.position.avgPrice).toBeCloseTo(1.11, 10);
    r = applyFill(r.position, "sell", 15_000, 1.1);
    expect(r.kind).toBe("close");
    expect(r.position.units).toBe(0);
    expect(r.position.realizedPnl).toBeCloseTo(100 - 150, 6);
  });

  it("flips through zero and counts only the new exposure as opening", () => {
    const long = applyFill(FLAT, "buy", 10_000, 1.1).position;
    const r = applyFill(long, "sell", 25_000, 1.09);
    expect(r.kind).toBe("flip");
    expect(r.position.units).toBe(-15_000);
    expect(r.position.avgPrice).toBe(1.09);
    expect(r.openingUnits).toBe(15_000);
    expect(r.realizedPnl).toBeCloseTo(-100, 6);
  });

  it("marks shorts at the ask and longs at the bid", () => {
    const short = applyFill(FLAT, "sell", 10_000, 1.1).position;
    expect(unrealizedPnl(short, 1.0999, 1.1001)).toBeCloseTo(-1, 6);
    const long = applyFill(FLAT, "buy", 10_000, 1.1).position;
    expect(unrealizedPnl(long, 1.0999, 1.1001)).toBeCloseTo(-1, 6);
  });
});

describe("inverse bot", () => {
  const fills: Fill[] = [
    { ts: 1, side: "buy", units: 10_000, price: 1.1001, bid: 1.0999, ask: 1.1001 },
    { ts: 3, side: "sell", units: 10_000, price: 1.0989, bid: 1.0989, ask: 1.0991 },
  ];
  const marks = [
    { ts: 2, bid: 1.0995, ask: 1.0997 },
    { ts: 4, bid: 1.0989, ask: 1.0991 },
  ];

  it("takes the other side of the book, paying its own spread", () => {
    const inv = invertFills(fills, 1, 0);
    expect(inv[0]).toMatchObject({ side: "sell", price: 1.0999 });
    expect(inv[1]).toMatchObject({ side: "buy", price: 1.0991 });
    const bot = replayEquity(fills, marks, 10_000).at(-1)!.equity - 10_000;
    const anti = replayEquity(inv, marks, 10_000).at(-1)!.equity - 10_000;
    expect(bot).toBeCloseTo(-12, 6);
    expect(anti).toBeCloseTo(8, 6);
    // bot + inverse = -(both round-trip spreads)
    expect(bot + anti).toBeCloseTo(-4, 6);
  });

  it("scales size and charges extra cost", () => {
    const inv = invertFills(fills, 2, 0.0001);
    expect(inv[0].units).toBe(20_000);
    expect(inv[0].price).toBeCloseTo(1.0998, 10);
    expect(fillPrice("buy", 1.0, 1.0002, 0.0001)).toBeCloseTo(1.0003, 10);
  });

  it("computes max drawdown", () => {
    expect(maxDrawdown([{ ts: 1, equity: 100 }, { ts: 2, equity: 120 }, { ts: 3, equity: 90 }, { ts: 4, equity: 130 }])).toBe(-30);
  });
});

describe("planOrder", () => {
  const limits = { maxPositionUnits: 100_000, maxEntriesPerDay: 3, entriesToday: 0 };
  const flat = FLAT;
  const long50 = { units: 50_000, avgPrice: 1.1, realizedPnl: 0 };

  it("holds and rejects closing a flat book", () => {
    expect(planOrder({ action: "hold", units: 0, reason: "" }, flat, limits)).toBeNull();
    expect(planOrder({ action: "close", units: 0, reason: "" }, flat, limits)).toBe("nothing to close");
  });

  it("rounds size down to 1000s and clips to the position limit", () => {
    expect(planOrder({ action: "buy", units: 12_345, reason: "" }, flat, limits)).toMatchObject({ side: "buy", units: 12_000 });
    expect(planOrder({ action: "buy", units: 80_000, reason: "" }, long50, limits)).toMatchObject({ units: 50_000 });
    expect(planOrder({ action: "buy", units: 1_000, reason: "" }, { ...long50, units: 100_000 }, limits)).toBe("position limit reached");
    expect(planOrder({ action: "sell", units: 500, reason: "" }, flat, limits)).toBe("size 500 below 1000");
  });

  it("enforces the daily entry limit but always allows reducing", () => {
    const capped = { ...limits, entriesToday: 3 };
    expect(planOrder({ action: "buy", units: 1_000, reason: "" }, flat, capped)).toBe("daily entry limit reached");
    expect(planOrder({ action: "sell", units: 10_000, reason: "" }, long50, capped)).toMatchObject({ side: "sell", units: 10_000 });
    expect(planOrder({ action: "sell", units: 80_000, reason: "" }, long50, capped)).toMatchObject({ side: "sell", units: 50_000 });
    expect(planOrder({ action: "close", units: 0, reason: "" }, long50, capped)).toMatchObject({ side: "sell", units: 50_000 });
  });
});
