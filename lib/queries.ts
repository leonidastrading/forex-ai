import { config } from "./config";
import { getSql } from "./db";
import type { Fill, Mark } from "./sim";
import type { EntryOutcome, Horizon } from "./stats";

export interface BotSummary {
  id: number;
  slug: string;
  name: string;
  persona: string;
  active: boolean;
  starting_balance: number;
  units: number;
  avg_price: number;
  realized_pnl: number;
  decisions: number;
  trades: number;
}

export async function getBots(): Promise<BotSummary[]> {
  const sql = getSql();
  return sql<BotSummary[]>`
    SELECT b.id, b.slug, b.name, b.persona, b.active, b.starting_balance,
           coalesce(p.units, 0) AS units, coalesce(p.avg_price, 0) AS avg_price, coalesce(p.realized_pnl, 0) AS realized_pnl,
           (SELECT count(*)::int FROM decisions d WHERE d.bot_id = b.id) AS decisions,
           (SELECT count(*)::int FROM trades t WHERE t.bot_id = b.id) AS trades
    FROM bots b LEFT JOIN positions p ON p.bot_id = b.id ORDER BY b.id`;
}

export async function getBot(id: number) {
  const sql = getSql();
  const [bot] = await sql<(BotSummary & { system_prompt: string; max_trades_per_day: number; max_position_units: number; decision_interval_min: number })[]>`
    SELECT b.*, coalesce(p.units, 0) AS units, coalesce(p.avg_price, 0) AS avg_price, coalesce(p.realized_pnl, 0) AS realized_pnl,
           0 AS decisions, 0 AS trades
    FROM bots b LEFT JOIN positions p ON p.bot_id = b.id WHERE b.id = ${id}`;
  return bot ?? null;
}

export async function getEngineStatus() {
  const sql = getSql();
  const [latest] = await sql<{ ts: Date; bid: number; ask: number; source: string }[]>`
    SELECT ts, bid, ask, source FROM price_snapshots ORDER BY ts DESC LIMIT 1`;
  const [usage] = await sql<{ spent: number; calls: number; spent_total: number; calls_total: number }[]>`
    WITH d AS (
      SELECT cost_usd, model IS NOT NULL AS is_call,
             ts >= date_trunc('day', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc' AS today
      FROM decisions
    )
    SELECT coalesce(sum(cost_usd) FILTER (WHERE today), 0)::float8 AS spent,
           count(*) FILTER (WHERE today AND is_call)::int AS calls,
           coalesce(sum(cost_usd), 0)::float8 AS spent_total,
           count(*) FILTER (WHERE is_call)::int AS calls_total
    FROM d`;
  const [run] = await sql<{ started_at: Date; status: string; detail: unknown }[]>`
    SELECT started_at, status, detail FROM engine_runs ORDER BY id DESC LIMIT 1`;
  const [first] = await sql<{ ts: Date | null }[]>`SELECT min(ts) AS ts FROM price_snapshots`;
  return { latest: latest ?? null, spentToday: usage.spent, callsToday: usage.calls, spentTotal: usage.spent_total, callsTotal: usage.calls_total, lastRun: run ?? null, since: first.ts };
}

// Every entry (fill that opened or increased exposure) with the signed mid-to-mid move at each
// horizon: the first price snapshot at or after entry + horizon, within an allowed lag. 5m and 1h
// must resolve within 5 / 30 minutes (entries just before the weekend close drop out); 1d may
// take up to 3 days so Thursday/Friday entries resolve at the next open instead of vanishing.
export async function getEntryOutcomes(botId?: number): Promise<EntryOutcome[]> {
  const sql = getSql();
  const rows = await sql<{ bot_id: number; ts: Date; dir: 1 | -1; horizon: Horizon; move: number | null }[]>`
    WITH entries AS (
      SELECT t.bot_id, t.ts, CASE WHEN t.side = 'buy' THEN 1 ELSE -1 END AS dir, (t.bid + t.ask) / 2 AS mid0
      FROM trades t
      WHERE t.opening_units > 0 ${botId ? sql`AND t.bot_id = ${botId}` : sql``}
    ), horizons(horizon, iv, max_lag) AS (
      VALUES ('5m', interval '5 minutes', interval '5 minutes'),
             ('1h', interval '1 hour', interval '30 minutes'),
             ('1d', interval '1 day', interval '3 days')
    )
    SELECT e.bot_id, e.ts, e.dir, h.horizon, (e.dir * (p.mid1 - e.mid0) / ${config.pip})::float8 AS move
    FROM entries e CROSS JOIN horizons h
    LEFT JOIN LATERAL (
      SELECT (s.bid + s.ask) / 2 AS mid1 FROM price_snapshots s
      WHERE s.instrument = ${config.instrument} AND s.ts >= e.ts + h.iv AND s.ts <= e.ts + h.iv + h.max_lag
      ORDER BY s.ts LIMIT 1
    ) p ON true
    ORDER BY e.ts`;
  return rows.map((r) => ({ botId: r.bot_id, ts: r.ts.getTime(), dir: r.dir, horizon: r.horizon, movePips: r.move }));
}

export async function getFills(botId?: number): Promise<(Fill & { botId: number })[]> {
  const sql = getSql();
  const rows = await sql<{ bot_id: number; ts: Date; side: "buy" | "sell"; units: number; price: number; bid: number; ask: number }[]>`
    SELECT bot_id, ts, side, units, price, bid, ask FROM trades
    ${botId ? sql`WHERE bot_id = ${botId}` : sql``} ORDER BY ts, id`;
  return rows.map((r) => ({ botId: r.bot_id, ts: r.ts.getTime(), side: r.side, units: r.units, price: r.price, bid: r.bid, ask: r.ask }));
}

// Price marks for equity curves, thinned to roughly <= 1500 points.
export async function getMarks(): Promise<Mark[]> {
  const sql = getSql();
  const [span] = await sql<{ hours: number | null }[]>`
    SELECT (extract(epoch FROM max(ts) - min(ts)) / 3600)::float8 AS hours FROM price_snapshots`;
  const hours = span.hours ?? 0;
  const bucketMin = hours <= 72 ? 5 : hours <= 24 * 30 ? 30 : hours <= 24 * 120 ? 120 : 360;
  const rows = await sql<{ ts: Date; bid: number; ask: number }[]>`
    SELECT ts, bid, ask FROM (
      SELECT DISTINCT ON (bucket) ts, bid, ask FROM (
        SELECT date_bin(${bucketMin + " minutes"}::interval, ts, timestamptz '2000-01-01') AS bucket, ts, bid, ask
        FROM price_snapshots WHERE instrument = ${config.instrument}
      ) b ORDER BY bucket, ts DESC
    ) x ORDER BY ts`;
  return rows.map((r) => ({ ts: r.ts.getTime(), bid: r.bid, ask: r.ask }));
}

export async function getDecisions(botId: number, limit = 100) {
  const sql = getSql();
  return sql<{ id: string; ts: Date; action: string; requested_units: number; reason: string | null; status: string; status_detail: string | null; cost_usd: number; mid: number | null }[]>`
    SELECT d.id, d.ts, d.action, d.requested_units, d.reason, d.status, d.status_detail, d.cost_usd,
           ((s.bid + s.ask) / 2)::float8 AS mid
    FROM decisions d LEFT JOIN price_snapshots s ON s.id = d.snapshot_id
    WHERE d.bot_id = ${botId} ORDER BY d.ts DESC LIMIT ${limit}`;
}

export async function getTrades(botId: number, limit = 100) {
  const sql = getSql();
  return sql<{ id: string; ts: Date; side: string; units: number; price: number; bid: number; ask: number; kind: string; realized_pnl: number; position_after: number; reason: string | null }[]>`
    SELECT t.id, t.ts, t.side, t.units, t.price, t.bid, t.ask, t.kind, t.realized_pnl, t.position_after, d.reason
    FROM trades t LEFT JOIN decisions d ON d.id = t.decision_id
    WHERE t.bot_id = ${botId} ORDER BY t.ts DESC LIMIT ${limit}`;
}

export async function getPrompt(decisionId: string) {
  const sql = getSql();
  const [row] = await sql<{ prompt: string | null }[]>`SELECT prompt FROM decisions WHERE id = ${decisionId}`;
  return row?.prompt ?? null;
}
