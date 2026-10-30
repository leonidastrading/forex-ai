// Gross direction skill: for every entry, the mid-price move over a horizon, signed by the
// entry's direction, in pips. Spread is excluded on purpose (mid to mid), so this measures
// pure directional skill, not tradability. A consistently negative mean = consistently wrong.

export type Horizon = "5m" | "1h" | "1d";
export const HORIZONS: Horizon[] = ["5m", "1h", "1d"];

export interface EntryOutcome {
  botId: number;
  ts: number; // entry time, epoch ms
  dir: 1 | -1;
  horizon: Horizon;
  movePips: number | null; // signed by dir; null = horizon not reached yet / no price
}

export interface SkillStats {
  n: number; // entries whose horizon has resolved
  pending: number; // entries still waiting for their horizon (or with no price at it yet)
  meanPips: number;
  sdPips: number;
  tStat: number; // mean / (sd / sqrt(n)) over individual entries
  hitRate: number; // share of entries where price moved in the bot's favour
  days: number;
  tStatDaily: number; // t-stat over per-UTC-day mean moves (robust to overlapping entries)
}

export function tStat(xs: number[]): { mean: number; sd: number; t: number } {
  const n = xs.length;
  if (n === 0) return { mean: 0, sd: 0, t: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { mean, sd: 0, t: 0 };
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  const t = sd > 0 ? mean / (sd / Math.sqrt(n)) : 0;
  return { mean, sd, t };
}

export function skillStats(outcomes: EntryOutcome[]): SkillStats {
  const done = outcomes.filter((o) => o.movePips !== null);
  const moves = done.map((o) => o.movePips as number);
  const { mean, sd, t } = tStat(moves);

  const byDay = new Map<string, number[]>();
  for (const o of done) {
    const day = new Date(o.ts).toISOString().slice(0, 10);
    const arr = byDay.get(day) ?? [];
    arr.push(o.movePips as number);
    byDay.set(day, arr);
  }
  const dailyMeans = [...byDay.values()].map((a) => a.reduce((x, y) => x + y, 0) / a.length);

  return {
    n: moves.length,
    pending: outcomes.length - moves.length,
    meanPips: mean,
    sdPips: sd,
    tStat: t,
    hitRate: moves.length ? moves.filter((m) => m > 0).length / moves.length : 0,
    days: dailyMeans.length,
    tStatDaily: tStat(dailyMeans).t,
  };
}
