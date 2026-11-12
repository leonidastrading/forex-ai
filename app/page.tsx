import Link from "next/link";
import { LineChart } from "@/components/LineChart";
import { StatusTiles } from "@/components/StatusTiles";
import { analyseBot, fmtNum, fmtUsd, parseInverseParams, pnlClass } from "@/lib/analysis";
import { getBots, getEngineStatus, getEntryOutcomes, getFills, getMarks } from "@/lib/queries";
import { skillStats } from "@/lib/stats";

export const dynamic = "force-dynamic";

type SP = Promise<Record<string, string | string[] | undefined>>;

// The t-stat shown here is the +1h direction t-stat: is the price an hour after each entry on the
// bot's side or against it, consistently? Negative = consistently wrong.
const T_HORIZON = "1h" as const;

export default async function Overview({ searchParams }: { searchParams: SP }) {
  const inv = parseInverseParams(await searchParams);
  const [bots, status, outcomes, fills, marks] = await Promise.all([
    getBots(),
    getEngineStatus(),
    getEntryOutcomes(),
    getFills(),
    getMarks(),
  ]);

  const rows = bots
    .map((bot, i) => ({
      bot,
      slot: (i % 8) + 1,
      a: analyseBot(
        bot.starting_balance,
        fills.filter((f) => f.botId === bot.id),
        marks,
        outcomes.filter((o) => o.botId === bot.id),
        inv,
      ),
    }))
    .sort((x, y) => y.a.inversePnl - x.a.inversePnl);

  const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((t, r) => t + f(r), 0);
  const total = {
    pnl: sum((r) => r.a.pnl),
    fills: sum((r) => r.a.trades.fills),
    closed: sum((r) => r.a.trades.closed),
    wins: sum((r) => r.a.trades.wins),
    t: skillStats(outcomes.filter((o) => o.horizon === T_HORIZON)).tStat,
    inversePnl: sum((r) => r.a.inversePnl),
    inverseClosed: sum((r) => r.a.inverseTrades.closed),
    inverseWins: sum((r) => r.a.inverseTrades.wins),
  };
  const qs = `?mult=${inv.multiplier}&cost=${inv.extraCostPips}`;

  return (
    <>
      <StatusTiles status={status} />

      <section>
        <div className="section-head">
          <h2>Bots</h2>
          <Link href={`/stats${qs}`}>All stats →</Link>
        </div>
        <div className="table-wrap basic-wrap">
          <table className="basic-table">
            <thead>
              <tr>
                <th rowSpan={2}>Bot</th>
                <th colSpan={4} className="group">Bot</th>
                <th colSpan={3} className="group">Inverse</th>
              </tr>
              <tr>
                <th className="num group-start">P&amp;L</th>
                <th className="num">Trades</th>
                <th className="num">Win %</th>
                <th className="num" title="Direction t-stat at +1h. Negative = consistently wrong.">t-stat</th>
                <th className="num group-start">P&amp;L</th>
                <th className="num">Win %</th>
                <th className="num">Max DD</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ bot, slot, a }) => (
                <tr key={bot.id}>
                  <td className="nowrap">
                    <i className={`swatch s${slot}`} />
                    <Link href={`/bots/${bot.id}${qs}`}>{bot.name}</Link>{" "}
                    <span className="muted persona">{bot.persona}</span>
                  </td>
                  <td className={`num group-start strong ${pnlClass(a.pnl)}`}>{fmtUsd(a.pnl)}</td>
                  <td className="num">{a.trades.fills}</td>
                  <td className="num">{winPct(a.trades.wins, a.trades.closed)}</td>
                  <td className={`num ${tClass(a.skill[T_HORIZON].tStat)}`}>{fmtNum(a.skill[T_HORIZON].tStat)}</td>
                  <td className={`num group-start strong ${pnlClass(a.inversePnl)}`}>{fmtUsd(a.inversePnl)}</td>
                  <td className="num">{winPct(a.inverseTrades.wins, a.inverseTrades.closed)}</td>
                  <td className={`num ${pnlClass(a.inverseMaxDd)}`}>{fmtUsd(a.inverseMaxDd)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>All bots</td>
                <td className={`num group-start ${pnlClass(total.pnl)}`}>{fmtUsd(total.pnl)}</td>
                <td className="num">{total.fills}</td>
                <td className="num">{winPct(total.wins, total.closed)}</td>
                <td className={`num ${tClass(total.t)}`}>{fmtNum(total.t)}</td>
                <td className={`num group-start ${pnlClass(total.inversePnl)}`}>{fmtUsd(total.inversePnl)}</td>
                <td className="num">{winPct(total.inverseWins, total.inverseClosed)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
        {/* Phones: same numbers, one compact card per bot. */}
        <div className="basic-cards">
          <div className="basic-card-row basic-cards-head">
            <span />
            <span>P&amp;L</span>
            <span>Trades</span>
            <span>Win %</span>
            <span>t / Max DD</span>
          </div>
          {[
            ...rows.map(({ bot, slot, a }) => ({
              key: String(bot.id),
              name: (
                <>
                  <i className={`swatch s${slot}`} />
                  <Link href={`/bots/${bot.id}${qs}`}>{bot.name}</Link> <span className="muted">{bot.persona}</span>
                </>
              ),
              pnl: a.pnl,
              fills: a.trades.fills,
              win: winPct(a.trades.wins, a.trades.closed),
              t: a.skill[T_HORIZON].tStat,
              inversePnl: a.inversePnl,
              inverseWin: winPct(a.inverseTrades.wins, a.inverseTrades.closed),
              inverseDd: a.inverseMaxDd as number | null,
            })),
            {
              key: "total",
              name: <>All bots</>,
              pnl: total.pnl,
              fills: total.fills,
              win: winPct(total.wins, total.closed),
              t: total.t,
              inversePnl: total.inversePnl,
              inverseWin: winPct(total.inverseWins, total.inverseClosed),
              inverseDd: null,
            },
          ].map((c) => (
            <div key={c.key} className={`basic-card${c.key === "total" ? " total" : ""}`}>
              <div className="basic-card-name">{c.name}</div>
              <div className="basic-card-row">
                <span className="label">Bot</span>
                <b className={pnlClass(c.pnl)}>{fmtUsd(c.pnl)}</b>
                <span>{c.fills}</span>
                <span>{c.win}</span>
                <span className={tClass(c.t)}>{fmtNum(c.t)}</span>
              </div>
              <div className="basic-card-row">
                <span className="label">Inverse</span>
                <b className={pnlClass(c.inversePnl)}>{fmtUsd(c.inversePnl)}</b>
                <span />
                <span>{c.inverseWin}</span>
                <span className={c.inverseDd === null ? "" : pnlClass(c.inverseDd)}>
                  {c.inverseDd === null ? "" : fmtUsd(c.inverseDd)}
                </span>
              </div>
            </div>
          ))}
        </div>
        <p className="note">
          Sorted by inverse P&amp;L, best first. P&amp;L includes open positions at the current price. Win % = profitable closed
          trades ÷ closed trades. t-stat: is price an hour after each entry consistently on the bot&apos;s side (positive) or
          against it (negative)? Below −2.9 sustained over 40+ trading days would be a real &ldquo;consistently wrong&rdquo; bot.
          Inverse = the opposite side of every trade at ×{inv.multiplier} size, paying its own spread
          {inv.extraCostPips ? ` plus ${inv.extraCostPips} pips per fill` : ""}.
        </p>
      </section>

      <section>
        <h2>Bot P&amp;L</h2>
        <LineChart
          label="Bot P&L over time"
          baseline={0}
          series={rows.map(({ bot, slot, a }) => ({
            name: bot.name,
            slot,
            points: a.equity.map((p) => ({ t: p.ts, v: p.equity - bot.starting_balance })),
          }))}
        />
      </section>
    </>
  );
}

const winPct = (wins: number, closed: number) => `${closed ? Math.round((wins / closed) * 100) : 0}%`;

function tClass(t: number) {
  return t <= -2 ? "neg" : t >= 2 ? "pos" : "";
}
