// Pure position/fill accounting for a single net EUR/USD position. No I/O, so it is unit-tested
// and reused by both the live engine and the dashboard's equity replays (bot and inverse bot).

export type Side = "buy" | "sell";

export interface Position {
  units: number; // signed: + long EUR, - short EUR
  avgPrice: number;
  realizedPnl: number; // cumulative USD
}

export interface FillResult {
  position: Position;
  kind: "open" | "add" | "reduce" | "close" | "flip";
  openingUnits: number; // portion of the fill that increased exposure
  realizedPnl: number; // realized by this fill, USD
}

export const FLAT: Position = { units: 0, avgPrice: 0, realizedPnl: 0 };

// Buys lift the ask, sells hit the bid, both worsened by `slippage` (in price units).
export function fillPrice(side: Side, bid: number, ask: number, slippage = 0): number {
  return side === "buy" ? ask + slippage : bid - slippage;
}

export function applyFill(pos: Position, side: Side, units: number, price: number): FillResult {
  if (!(units > 0)) throw new Error(`units must be positive, got ${units}`);
  const q = side === "buy" ? units : -units;
  const cur = pos.units;

  if (cur === 0 || Math.sign(cur) === Math.sign(q)) {
    const total = Math.abs(cur) + units;
    const avg = (Math.abs(cur) * pos.avgPrice + units * price) / total;
    return {
      position: { units: cur + q, avgPrice: avg, realizedPnl: pos.realizedPnl },
      kind: cur === 0 ? "open" : "add",
      openingUnits: units,
      realizedPnl: 0,
    };
  }

  const closing = Math.min(units, Math.abs(cur));
  const realized = closing * (price - pos.avgPrice) * Math.sign(cur);
  const next = cur + q;
  const realizedPnl = pos.realizedPnl + realized;

  if (next === 0) {
    return { position: { units: 0, avgPrice: 0, realizedPnl }, kind: "close", openingUnits: 0, realizedPnl: realized };
  }
  if (Math.sign(next) === Math.sign(cur)) {
    return {
      position: { units: next, avgPrice: pos.avgPrice, realizedPnl },
      kind: "reduce",
      openingUnits: 0,
      realizedPnl: realized,
    };
  }
  return {
    position: { units: next, avgPrice: price, realizedPnl },
    kind: "flip",
    openingUnits: Math.abs(next),
    realizedPnl: realized,
  };
}

// Mark-to-market: a long would be sold at the bid, a short bought back at the ask.
export function unrealizedPnl(pos: Position, bid: number, ask: number): number {
  if (pos.units === 0) return 0;
  const exit = pos.units > 0 ? bid : ask;
  return pos.units * (exit - pos.avgPrice);
}

export function equity(startingBalance: number, pos: Position, bid: number, ask: number): number {
  return startingBalance + pos.realizedPnl + unrealizedPnl(pos, bid, ask);
}

// ---- Equity replay -------------------------------------------------------------------------

export interface Fill {
  ts: number; // epoch ms
  side: Side;
  units: number;
  price: number;
  bid: number;
  ask: number;
}

export interface Mark {
  ts: number;
  bid: number;
  ask: number;
}

export interface EquityPoint {
  ts: number;
  equity: number;
}

export function replayEquity(fills: Fill[], marks: Mark[], startingBalance: number): EquityPoint[] {
  const out: EquityPoint[] = [];
  let pos = FLAT;
  let i = 0;
  for (const m of marks) {
    while (i < fills.length && fills[i].ts <= m.ts) {
      const f = fills[i++];
      pos = applyFill(pos, f.side, f.units, f.price).position;
    }
    out.push({ ts: m.ts, equity: equity(startingBalance, pos, m.bid, m.ask) });
  }
  return out;
}

// The inverse bot takes the opposite side of every fill, scaled by `multiplier`, and pays the
// spread on its own side of the book plus `extraCost` (price units) per fill. It does not get
// the original bot's fill price: if the bot bought at the ask, the inverse sells at the bid.
export function invertFills(fills: Fill[], multiplier: number, extraCost: number): Fill[] {
  return fills
    .map((f) => {
      const side: Side = f.side === "buy" ? "sell" : "buy";
      const units = Math.round(f.units * multiplier);
      return { ...f, side, units, price: fillPrice(side, f.bid, f.ask, extraCost) };
    })
    .filter((f) => f.units > 0);
}

export function maxDrawdown(points: EquityPoint[]): number {
  let peak = -Infinity;
  let dd = 0;
  for (const p of points) {
    peak = Math.max(peak, p.equity);
    dd = Math.min(dd, p.equity - peak);
  }
  return dd;
}
