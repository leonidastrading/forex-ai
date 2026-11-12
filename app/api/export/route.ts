import { analyseBot, parseInverseParams } from "@/lib/analysis";
import { config } from "@/lib/config";
import { getSql } from "@/lib/db";
import { getBots, getEntryOutcomes, getFills, getMarks } from "@/lib/queries";
import { HORIZONS } from "@/lib/stats";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// CSV downloads of everything the dashboard is built from. Behind the dashboard login (middleware).
//   ?what=summary    one row per bot per horizon, every skill number + P&L
//   ?what=entries    every entry with its signed move at +5m / +1h / +1d
//   ?what=trades     every simulated fill
//   ?what=decisions  every bot decision with its reason (prompts left out: they are large)
export async function GET(req: Request) {
  const url = new URL(req.url);
  const what = url.searchParams.get("what") ?? "summary";
  const sql = getSql();
  let header: string[];
  let rows: unknown[][];

  if (what === "summary") {
    const inv = parseInverseParams(Object.fromEntries(url.searchParams));
    const [bots, outcomes, fills, marks] = await Promise.all([getBots(), getEntryOutcomes(), getFills(), getMarks()]);
    header = ["bot", "persona", "horizon", "entries", "pending", "hit_rate", "mean_pips", "sd_pips", "t_stat", "days",
      "t_daily", "bot_pnl_usd", "inverse_pnl_usd", "inverse_max_drawdown_usd", "inverse_multiplier", "inverse_extra_cost_pips"];
    rows = bots.flatMap((b) => {
      const a = analyseBot(b.starting_balance, fills.filter((f) => f.botId === b.id), marks,
        outcomes.filter((o) => o.botId === b.id), inv);
      return HORIZONS.map((h) => {
        const s = a.skill[h];
        return [b.name, b.persona, h, s.n, s.pending, s.hitRate, s.meanPips, s.sdPips, s.tStat, s.days, s.tStatDaily,
          a.pnl, a.inversePnl, a.inverseMaxDd, inv.multiplier, inv.extraCostPips];
      });
    });
  } else if (what === "entries") {
    const [bots, outcomes] = await Promise.all([getBots(), getEntryOutcomes()]);
    const name = new Map(bots.map((b) => [b.id, b.name]));
    const byEntry = new Map<string, { bot: string; ts: number; dir: number; m: Record<string, number | null> }>();
    for (const o of outcomes) {
      const key = `${o.botId}|${o.ts}|${o.dir}`;
      const e = byEntry.get(key) ?? { bot: name.get(o.botId) ?? String(o.botId), ts: o.ts, dir: o.dir, m: {} };
      e.m[o.horizon] = o.movePips;
      byEntry.set(key, e);
    }
    header = ["bot", "entry_time_utc", "direction", ...HORIZONS.map((h) => `move_pips_${h}`)];
    rows = [...byEntry.values()].map((e) => [e.bot, new Date(e.ts).toISOString(), e.dir > 0 ? "long" : "short",
      ...HORIZONS.map((h) => e.m[h])]);
  } else if (what === "trades") {
    header = ["trade_id", "bot", "time_utc", "side", "units", "fill_price", "bid", "ask", "spread_pips", "kind",
      "opening_units", "realized_pnl_usd", "position_after", "reason"];
    const r = await sql`
      SELECT t.id, b.name, t.ts, t.side, t.units, t.price, t.bid, t.ask, t.kind, t.opening_units, t.realized_pnl,
             t.position_after, d.reason
      FROM trades t JOIN bots b ON b.id = t.bot_id LEFT JOIN decisions d ON d.id = t.decision_id
      ORDER BY t.ts, t.id`;
    rows = r.map((t) => [t.id, t.name, t.ts.toISOString(), t.side, t.units, t.price, t.bid, t.ask,
      (t.ask - t.bid) / config.pip, t.kind, t.opening_units, t.realized_pnl, t.position_after, t.reason]);
  } else if (what === "decisions") {
    header = ["decision_id", "bot", "time_utc", "action", "requested_units", "status", "status_detail", "mid",
      "reason", "model", "input_tokens", "output_tokens", "cost_usd", "latency_ms"];
    const r = await sql`
      SELECT d.id, b.name, d.ts, d.action, d.requested_units, d.status, d.status_detail,
             ((s.bid + s.ask) / 2)::float8 AS mid, d.reason, d.model, d.input_tokens, d.output_tokens, d.cost_usd,
             d.latency_ms
      FROM decisions d JOIN bots b ON b.id = d.bot_id LEFT JOIN price_snapshots s ON s.id = d.snapshot_id
      ORDER BY d.ts, d.id`;
    rows = r.map((d) => [d.id, d.name, d.ts.toISOString(), d.action, d.requested_units, d.status, d.status_detail,
      d.mid, d.reason, d.model, d.input_tokens, d.output_tokens, d.cost_usd, d.latency_ms]);
  } else {
    return new Response("what must be one of: summary, entries, trades, decisions", { status: 400 });
  }

  const csv = [header, ...rows].map((r) => r.map(cell).join(",")).join("\n") + "\n";
  const date = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="forex-ai-${what}-${date}.csv"`,
    },
  });
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
