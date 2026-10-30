import { config } from "./config";
import { invertFills, maxDrawdown, replayEquity, type EquityPoint, type Fill, type Mark } from "./sim";
import { HORIZONS, skillStats, type EntryOutcome, type Horizon, type SkillStats } from "./stats";

export interface InverseParams {
  multiplier: number;
  extraCostPips: number; // per fill, on top of the live spread the bot itself paid
}

export function parseInverseParams(sp: Record<string, string | string[] | undefined>): InverseParams {
  const num = (v: unknown, d: number, lo: number, hi: number) => {
    const n = Number(Array.isArray(v) ? v[0] : v);
    return Number.isFinite(n) && v !== undefined && v !== "" ? Math.min(hi, Math.max(lo, n)) : d;
  };
  return { multiplier: num(sp.mult, 1, 0.01, 100), extraCostPips: num(sp.cost, 0, 0, 20) };
}

export function parseHorizon(v: unknown): Horizon {
  return HORIZONS.includes(v as Horizon) ? (v as Horizon) : "1h";
}

export interface BotAnalysis {
  skill: Record<Horizon, SkillStats>;
  equity: EquityPoint[];
  inverse: EquityPoint[];
  pnl: number;
  inversePnl: number;
  inverseMaxDd: number;
}

export function analyseBot(
  startingBalance: number,
  fills: Fill[],
  marks: Mark[],
  outcomes: EntryOutcome[],
  inv: InverseParams,
): BotAnalysis {
  const skill = Object.fromEntries(
    HORIZONS.map((h) => [h, skillStats(outcomes.filter((o) => o.horizon === h))]),
  ) as Record<Horizon, SkillStats>;
  const equity = replayEquity(fills, marks, startingBalance);
  const inverse = replayEquity(invertFills(fills, inv.multiplier, inv.extraCostPips * config.pip), marks, startingBalance);
  const last = (pts: EquityPoint[]) => (pts.length ? pts[pts.length - 1].equity - startingBalance : 0);
  return { skill, equity, inverse, pnl: last(equity), inversePnl: last(inverse), inverseMaxDd: maxDrawdown(inverse) };
}

// "Most consistently wrong" first: most negative t-stat at the chosen horizon. Bots with fewer
// than 2 resolved entries have no t-stat yet and sort last.
export function wrongnessOrder<T extends { analysis: BotAnalysis }>(rows: T[], h: Horizon): T[] {
  const key = (r: T) => (r.analysis.skill[h].n >= 2 ? r.analysis.skill[h].tStat : Infinity);
  return [...rows].sort((a, b) => key(a) - key(b));
}

// Rounded to whole dollars first, so a tiny loss shows as "$0" rather than "-$0".
export const fmtUsd = (v: number) => {
  const r = Math.round(v);
  return `${r < 0 ? "-" : r > 0 ? "+" : ""}$${Math.abs(r).toLocaleString("en-US")}`;
};
// Green for a gain, red for a loss, neutral when it rounds to $0.
export const pnlClass = (v: number) => (Math.round(v) > 0 ? "pos" : Math.round(v) < 0 ? "neg" : "");
export const fmtNum = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "–");
