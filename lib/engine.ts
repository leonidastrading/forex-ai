import type postgres from "postgres";
import { config, maxCallCost } from "./config";
import { getSql } from "./db";
import { askBot, type BotDecision, type LlmResult } from "./llm";
import { fxMarketOpen, getCandles, getQuote, type Candle, type Quote } from "./market";
import { relevantNews, type NewsEvent } from "./news";
import { applyFill, equity, fillPrice, unrealizedPnl, type Position, type Side } from "./sim";

interface BotRow {
  id: number;
  slug: string;
  name: string;
  system_prompt: string;
  model: string | null;
  starting_balance: number;
  max_trades_per_day: number;
  max_position_units: number;
  decision_interval_min: number;
  last_decision_at: Date | null;
}

export interface TickSummary {
  status: string;
  quote?: { bid: number; ask: number };
  asked?: string[];
  skippedForBudget?: string[];
  results?: { bot: string; status: string; detail?: string | null }[];
  spentTodayUsd?: number;
  error?: string;
}

const LOCK_SECONDS = 240;

export async function runTick(opts: { force?: boolean } = {}): Promise<TickSummary> {
  const sql = getSql();
  const lock = await sql`
    UPDATE engine_lock SET locked_until = now() + ${LOCK_SECONDS + " seconds"}::interval
    WHERE id = 1 AND locked_until < now() RETURNING id`;
  if (!lock.length) return { status: "locked" };

  const [run] = await sql<{ id: string }[]>`INSERT INTO engine_runs (status) VALUES ('running') RETURNING id`;
  let summary: TickSummary;
  try {
    summary = await tick(sql, opts);
  } catch (err) {
    summary = { status: "error", error: err instanceof Error ? err.message : String(err) };
  } finally {
    await sql`UPDATE engine_lock SET locked_until = 'epoch' WHERE id = 1`;
  }
  await sql`
    UPDATE engine_runs SET finished_at = now(), status = ${summary.status}, detail = ${sql.json(summary as never)}
    WHERE id = ${run.id}`;
  return summary;
}

async function tick(sql: postgres.Sql, opts: { force?: boolean }): Promise<TickSummary> {
  const now = new Date();
  if (!opts.force && !fxMarketOpen(now)) return { status: "market_closed" };

  let quote: Quote;
  try {
    quote = await getQuote();
  } catch (err) {
    // Feed outages are expected now and then; record them without failing the whole tick.
    return { status: "price_unavailable", error: err instanceof Error ? err.message : String(err) };
  }
  if (!quote.tradeable && !opts.force) return { status: "not_tradeable", quote: { bid: quote.bid, ask: quote.ask } };

  const [snap] = await sql<{ id: string }[]>`
    INSERT INTO price_snapshots (ts, instrument, bid, ask, source)
    VALUES (now(), ${config.instrument}, ${quote.bid}, ${quote.ask}, ${quote.source})
    RETURNING id`;

  const bots = await sql<BotRow[]>`
    SELECT b.id, b.slug, b.name, b.system_prompt, b.model, b.starting_balance, b.max_trades_per_day,
           b.max_position_units, b.decision_interval_min,
           (SELECT max(ts) FROM decisions d WHERE d.bot_id = b.id) AS last_decision_at
    FROM bots b WHERE b.active ORDER BY b.id`;

  const due = bots
    .filter((b) => !b.last_decision_at || now.getTime() - b.last_decision_at.getTime() >= b.decision_interval_min * 60e3 - 30e3)
    .sort((a, b) => (a.last_decision_at?.getTime() ?? 0) - (b.last_decision_at?.getTime() ?? 0));

  // Budget: reserve the worst-case cost of each call up front so parallel calls can't overshoot.
  const [usage] = await sql<{ spent: number; calls: number }[]>`
    SELECT coalesce(sum(cost_usd), 0)::float8 AS spent, count(*) FILTER (WHERE model IS NOT NULL)::int AS calls
    FROM decisions WHERE ts >= date_trunc('day', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc'`;
  const perCall = config.llmProvider === "mock" ? 0 : maxCallCost();
  const selected: BotRow[] = [];
  const skippedForBudget: BotRow[] = [];
  for (const b of due) {
    const fits =
      usage.spent + (selected.length + 1) * perCall <= config.dailyBudgetUsd &&
      usage.calls + selected.length + 1 <= config.maxLlmCallsPerDay;
    (fits ? selected : skippedForBudget).push(b);
  }
  const base = {
    quote: { bid: quote.bid, ask: quote.ask },
    asked: selected.map((b) => b.slug),
    skippedForBudget: skippedForBudget.map((b) => b.slug),
    spentTodayUsd: usage.spent,
  };
  if (!selected.length) return { status: skippedForBudget.length ? "budget_exhausted" : "no_bots_due", ...base };

  const [m5, h1, news] = await Promise.all([getCandles("M5", 36), getCandles("H1", 24), relevantNews(now)]);

  const results = await Promise.all(
    selected.map(async (bot) => {
      try {
        const state = await loadBotState(sql, bot);
        const prompt = buildPrompt({ now, bot, quote, m5, h1, news, ...state });
        const llm = await askBot(bot.system_prompt, prompt, bot.model);
        const out = await executeDecision(sql, bot, quote, snap.id, llm, prompt);
        return { bot: bot.slug, ...out };
      } catch (err) {
        return { bot: bot.slug, status: "error", detail: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
  return { status: "ok", ...base, results };
}

// ---- Bot context ----------------------------------------------------------------------------

interface BotState {
  position: Position;
  tradesToday: number;
  entriesToday: number;
  realizedToday: number;
  recent: { ts: Date; action: string; requested_units: number; status: string; status_detail: string | null; reason: string | null; mid: number | null }[];
}

async function loadBotState(sql: postgres.Sql, bot: BotRow): Promise<BotState> {
  const [pos] = await sql<{ units: number; avg_price: number; realized_pnl: number }[]>`
    SELECT units, avg_price, realized_pnl FROM positions WHERE bot_id = ${bot.id}`;
  const [today] = await sql<{ trades: number; entries: number; realized: number }[]>`
    SELECT count(*)::int AS trades, count(*) FILTER (WHERE opening_units > 0)::int AS entries,
           coalesce(sum(realized_pnl), 0)::float8 AS realized
    FROM trades WHERE bot_id = ${bot.id} AND ts >= date_trunc('day', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc'`;
  const recent = await sql<BotState["recent"]>`
    SELECT d.ts, d.action, d.requested_units, d.status, d.status_detail, d.reason, ((s.bid + s.ask) / 2)::float8 AS mid
    FROM decisions d LEFT JOIN price_snapshots s ON s.id = d.snapshot_id
    WHERE d.bot_id = ${bot.id} ORDER BY d.ts DESC LIMIT 6`;
  return {
    position: pos ? { units: pos.units, avgPrice: pos.avg_price, realizedPnl: pos.realized_pnl } : { units: 0, avgPrice: 0, realizedPnl: 0 },
    tradesToday: today.trades,
    entriesToday: today.entries,
    realizedToday: today.realized,
    recent: recent.reverse(),
  };
}

const hhmm = (d: Date) => d.toISOString().slice(11, 16);
const px = (n: number) => n.toFixed(5);

function sessions(now: Date): string {
  const h = now.getUTCHours();
  const open = [];
  if (h >= 22 || h < 7) open.push("Sydney/Tokyo");
  if (h >= 7 && h < 16) open.push("London");
  if (h >= 12 && h < 21) open.push("New York");
  return open.join(" + ") || "late New York";
}

export function buildPrompt(ctx: {
  now: Date;
  bot: Pick<BotRow, "starting_balance" | "max_trades_per_day" | "max_position_units">;
  quote: Quote;
  m5: Candle[];
  h1: Candle[];
  news: NewsEvent[];
} & BotState): string {
  const { now, bot, quote, position: pos } = ctx;
  const spreadPips = (quote.ask - quote.bid) / config.pip;
  const mid = (quote.bid + quote.ask) / 2;
  const upnl = unrealizedPnl(pos, quote.bid, quote.ask);
  const eq = equity(bot.starting_balance, pos, quote.bid, quote.ask);
  const candleRows = (cs: Candle[], fmt: (d: Date) => string) =>
    cs.map((c) => `${fmt(c.ts)} ${px(c.o)} ${px(c.h)} ${px(c.l)} ${px(c.c)}${c.complete ? "" : " (forming)"}`).join("\n");

  const posLine =
    pos.units === 0
      ? "Flat (no position)."
      : `${pos.units > 0 ? "LONG" : "SHORT"} ${Math.abs(pos.units).toLocaleString("en-US")} EUR @ ${px(pos.avgPrice)}, ` +
        `unrealized ${upnl >= 0 ? "+" : ""}$${upnl.toFixed(2)} (${(((pos.units > 0 ? quote.bid : quote.ask) - pos.avgPrice) * Math.sign(pos.units) / config.pip).toFixed(1)} pips)`;

  const news = ctx.news.length
    ? ctx.news
        .map((e) => {
          const mins = Math.round((Date.parse(e.ts) - now.getTime()) / 60e3);
          const when = mins >= 0 ? `in ${mins} min` : `${-mins} min ago`;
          return `- ${e.ts.slice(11, 16)} UTC (${when}) [${e.country}, ${e.impact}] ${e.title}` +
            (e.forecast || e.previous ? ` (forecast ${e.forecast || "n/a"}, previous ${e.previous || "n/a"})` : "");
        })
        .join("\n")
    : "- Nothing scheduled.";

  const recent = ctx.recent.length
    ? ctx.recent
        .map((d) => `- ${d.ts.toISOString().slice(5, 16).replace("T", " ")} ${d.action}${d.requested_units ? " " + d.requested_units : ""}` +
          `${d.mid ? ` @~${px(d.mid)}` : ""} [${d.status}${d.status_detail ? ": " + d.status_detail : ""}] ${d.reason ?? ""}`)
        .join("\n")
    : "- None yet.";

  return `Time: ${now.toISOString().slice(0, 16).replace("T", " ")} UTC (${now.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })}). Sessions open: ${sessions(now)}.

EUR/USD now: bid ${px(quote.bid)} / ask ${px(quote.ask)} (mid ${px(mid)}, spread ${spreadPips.toFixed(1)} pips).

Your account:
- Position: ${posLine}
- Equity $${eq.toFixed(2)} (started at $${bot.starting_balance.toFixed(0)}); realized P&L today ${ctx.realizedToday >= 0 ? "+" : ""}$${ctx.realizedToday.toFixed(2)}.
- New entries today: ${ctx.entriesToday} of ${bot.max_trades_per_day} allowed (closing or reducing is always allowed).
- Max position size: ${bot.max_position_units.toLocaleString("en-US")} EUR either direction.

Economic calendar (EUR & USD, medium/high impact):
${news}

Last 3 hours, 5-minute candles (time UTC, open high low close):
${candleRows(ctx.m5, hhmm)}

Last 24 hours, hourly candles:
${candleRows(ctx.h1, (d) => d.toISOString().slice(5, 13).replace("T", " ") + "h")}

Your recent decisions:
${recent}

What do you do now? Reply with action, units and a one-line reason.`;
}

// ---- Execution ------------------------------------------------------------------------------

export interface Order {
  side: Side;
  units: number;
  note: string | null;
}

// Turns a bot's decision into an executable order, applying desk rules. Returns a string for rejections.
export function planOrder(
  d: BotDecision,
  pos: Position,
  limits: { maxPositionUnits: number; maxEntriesPerDay: number; entriesToday: number },
): Order | string | null {
  if (d.action === "hold") return null;
  if (d.action === "close") {
    if (pos.units === 0) return "nothing to close";
    return { side: pos.units > 0 ? "sell" : "buy", units: Math.abs(pos.units), note: null };
  }
  let units = Math.floor(Math.abs(d.units) / 1000) * 1000;
  if (units <= 0) return `size ${d.units} below 1000`;
  const side: Side = d.action;
  const sign = side === "buy" ? 1 : -1;
  let target = pos.units + sign * units;
  let note: string | null = null;
  if (Math.abs(target) > limits.maxPositionUnits) {
    target = Math.sign(target) * limits.maxPositionUnits;
    const clipped = Math.abs(target - pos.units);
    if (clipped === 0) return "position limit reached";
    note = `size cut from ${units} to ${clipped} (position limit)`;
    units = clipped;
  }
  const increasesExposure = Math.abs(target) > Math.abs(pos.units) || Math.sign(target) === -Math.sign(pos.units);
  if (increasesExposure && limits.entriesToday >= limits.maxEntriesPerDay) {
    // Still let them reduce towards flat: a flip is cut down to a close.
    if (Math.sign(target) === -Math.sign(pos.units) && pos.units !== 0) {
      return { side, units: Math.abs(pos.units), note: "daily entry limit: flip reduced to close" };
    }
    return "daily entry limit reached";
  }
  return { side, units, note };
}

async function executeDecision(
  sql: postgres.Sql,
  bot: BotRow,
  quote: Quote,
  snapshotId: string,
  llm: LlmResult,
  prompt: string,
): Promise<{ status: string; detail?: string | null }> {
  return sql.begin(async (tx) => {
    await tx`INSERT INTO positions (bot_id) VALUES (${bot.id}) ON CONFLICT DO NOTHING`;
    const [p] = await tx<{ units: number; avg_price: number; realized_pnl: number }[]>`
      SELECT units, avg_price, realized_pnl FROM positions WHERE bot_id = ${bot.id} FOR UPDATE`;
    const pos: Position = { units: p.units, avgPrice: p.avg_price, realizedPnl: p.realized_pnl };
    const [today] = await tx<{ entries: number }[]>`
      SELECT count(*) FILTER (WHERE opening_units > 0)::int AS entries FROM trades
      WHERE bot_id = ${bot.id} AND ts >= date_trunc('day', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc'`;

    const d = llm.decision;
    let status: string;
    let detail: string | null = null;
    let order: Order | null = null;
    if (!d) {
      status = "error";
      detail = llm.error ?? "no decision";
    } else {
      const planned = planOrder(d, pos, {
        maxPositionUnits: bot.max_position_units,
        maxEntriesPerDay: bot.max_trades_per_day,
        entriesToday: today.entries,
      });
      if (planned === null) status = "hold";
      else if (typeof planned === "string") {
        status = "rejected";
        detail = planned;
      } else {
        status = "executed";
        detail = planned.note;
        order = planned;
      }
    }

    const [dec] = await tx<{ id: string }[]>`
      INSERT INTO decisions (bot_id, snapshot_id, action, requested_units, reason, status, status_detail, model,
                             input_tokens, output_tokens, cost_usd, latency_ms, prompt, raw_response)
      VALUES (${bot.id}, ${snapshotId}, ${d?.action ?? "hold"}, ${d?.units ?? 0}, ${d?.reason?.slice(0, 500) ?? null},
              ${status}, ${detail}, ${llm.model}, ${llm.inputTokens}, ${llm.outputTokens}, ${llm.costUsd},
              ${llm.latencyMs}, ${prompt}, ${llm.raw === null ? null : tx.json(llm.raw as never)})
      RETURNING id`;

    if (order) {
      const price = fillPrice(order.side, quote.bid, quote.ask, config.slippagePips * config.pip);
      const fill = applyFill(pos, order.side, order.units, price);
      await tx`
        INSERT INTO trades (bot_id, decision_id, side, units, price, bid, ask, kind, opening_units, realized_pnl, position_after)
        VALUES (${bot.id}, ${dec.id}, ${order.side}, ${order.units}, ${price}, ${quote.bid}, ${quote.ask}, ${fill.kind},
                ${fill.openingUnits}, ${fill.realizedPnl}, ${fill.position.units})`;
      await tx`
        UPDATE positions SET units = ${fill.position.units}, avg_price = ${fill.position.avgPrice},
               realized_pnl = ${fill.position.realizedPnl}, updated_at = now()
        WHERE bot_id = ${bot.id}`;
    }
    return { status, detail };
  });
}
