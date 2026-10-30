import Link from "next/link";
import { notFound } from "next/navigation";
import { LineChart } from "@/components/LineChart";
import { analyseBot, fmtNum, fmtUsd, parseInverseParams } from "@/lib/analysis";
import { config } from "@/lib/config";
import { getBot, getBots, getDecisions, getEntryOutcomes, getFills, getMarks, getPrompt, getTrades } from "@/lib/queries";
import { HORIZONS } from "@/lib/stats";

export const dynamic = "force-dynamic";

type SP = Promise<Record<string, string | string[] | undefined>>;

const ts = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ");

export default async function BotPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();
  const sp = await searchParams;
  const inv = parseInverseParams(sp);

  const [bot, allBots, fills, marks, outcomes, decisions, trades] = await Promise.all([
    getBot(id),
    getBots(),
    getFills(id),
    getMarks(),
    getEntryOutcomes(id),
    getDecisions(id, 150),
    getTrades(id, 150),
  ]);
  if (!bot) notFound();
  const slot = (allBots.findIndex((b) => b.id === id) % 8) + 1;
  const a = analyseBot(bot.starting_balance, fills, marks, outcomes, inv);
  const lastPrompt = decisions[0] ? await getPrompt(decisions[0].id) : null;

  return (
    <>
      <p className="crumbs">
        <Link href={`/?mult=${inv.multiplier}&cost=${inv.extraCostPips}`}>← Leaderboard</Link>
      </p>
      <h1>
        <i className={`swatch s${slot}`} /> {bot.name} <span className="muted">· {bot.persona}</span>
      </h1>

      <section className="tiles">
        <div className="tile">
          <div className="tile-label">Position</div>
          <div className="tile-value">
            {bot.units === 0 ? "Flat" : `${bot.units > 0 ? "Long" : "Short"} ${Math.abs(bot.units).toLocaleString("en-US")}`}
          </div>
          <div className="tile-sub">{bot.units !== 0 ? `avg ${bot.avg_price.toFixed(5)}` : " "}</div>
        </div>
        <div className="tile">
          <div className="tile-label">Bot P&amp;L</div>
          <div className="tile-value">{fmtUsd(a.pnl)}</div>
          <div className="tile-sub">realized {fmtUsd(bot.realized_pnl)} · start ${bot.starting_balance.toLocaleString("en-US")}</div>
        </div>
        <div className="tile">
          <div className="tile-label">Inverse P&amp;L</div>
          <div className="tile-value">{fmtUsd(a.inversePnl)}</div>
          <div className="tile-sub">max drawdown {fmtUsd(a.inverseMaxDd)}</div>
        </div>
        <div className="tile">
          <div className="tile-label">Rules</div>
          <div className="tile-value">{bot.max_trades_per_day}/day</div>
          <div className="tile-sub">
            max {bot.max_position_units.toLocaleString("en-US")} units · every {bot.decision_interval_min} min
          </div>
        </div>
      </section>

      <section>
        <div className="section-head">
          <h2>Bot vs inverse bot</h2>
          <form className="inline-form" method="get">
            <label>
              Multiplier <input name="mult" type="number" step="0.1" min="0.01" defaultValue={inv.multiplier} />
            </label>
            <label>
              Extra cost / fill (pips) <input name="cost" type="number" step="0.1" min="0" defaultValue={inv.extraCostPips} />
            </label>
            <button type="submit">Apply</button>
          </form>
        </div>
        <LineChart
          label="Bot and inverse P&L"
          baseline={0}
          series={[
            { name: bot.name, slot, points: a.equity.map((p) => ({ t: p.ts, v: p.equity - bot.starting_balance })) },
            { name: "Inverse", slot: 8, dashed: true, points: a.inverse.map((p) => ({ t: p.ts, v: p.equity - bot.starting_balance })) },
          ]}
        />
        <p className="note">
          The inverse bot takes the opposite side of every fill at ×{inv.multiplier} size. It pays the live spread on its own
          side of the book plus {inv.extraCostPips} pips per fill (and the engine&apos;s {config.slippagePips} pip simulated
          slippage is not applied to it unless you add it here).
        </p>
      </section>

      <section>
        <h2>Gross direction skill</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Horizon</th>
                <th className="num">Entries</th>
                <th className="num">Hit rate</th>
                <th className="num">Mean (pips)</th>
                <th className="num">SD (pips)</th>
                <th className="num">t-stat</th>
                <th className="num">Days</th>
                <th className="num">t (daily)</th>
              </tr>
            </thead>
            <tbody>
              {HORIZONS.map((h) => {
                const s = a.skill[h];
                return (
                  <tr key={h}>
                    <td>+{h}</td>
                    <td className="num">
                      {s.n}
                      {s.pending > 0 && <span className="muted"> +{s.pending} pending</span>}
                    </td>
                    <td className="num">{s.n ? `${(s.hitRate * 100).toFixed(0)}%` : "–"}</td>
                    <td className="num">{s.n ? fmtNum(s.meanPips) : "–"}</td>
                    <td className="num">{s.n >= 2 ? fmtNum(s.sdPips) : "–"}</td>
                    <td className="num strong">{s.n >= 2 ? fmtNum(s.tStat) : "–"}</td>
                    <td className="num">{s.days}</td>
                    <td className="num">{s.days >= 2 ? fmtNum(s.tStatDaily) : "–"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2>Trades</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time (UTC)</th>
                <th>Side</th>
                <th className="num">Units</th>
                <th className="num">Fill</th>
                <th>Kind</th>
                <th className="num">Realized</th>
                <th className="num">Position after</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => (
                <tr key={t.id}>
                  <td className="nowrap">{ts(t.ts)}</td>
                  <td>{t.side}</td>
                  <td className="num">{t.units.toLocaleString("en-US")}</td>
                  <td className="num">{t.price.toFixed(5)}</td>
                  <td>{t.kind}</td>
                  <td className="num">{t.realized_pnl ? fmtUsd(t.realized_pnl) : ""}</td>
                  <td className="num">{t.position_after.toLocaleString("en-US")}</td>
                  <td className="reason">{t.reason}</td>
                </tr>
              ))}
              {!trades.length && (
                <tr>
                  <td colSpan={8} className="muted">No trades yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2>Decisions</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time (UTC)</th>
                <th>Action</th>
                <th className="num">Units</th>
                <th className="num">Mid</th>
                <th>Outcome</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {decisions.map((d) => (
                <tr key={d.id}>
                  <td className="nowrap">{ts(d.ts)}</td>
                  <td>{d.action}</td>
                  <td className="num">{d.requested_units ? d.requested_units.toLocaleString("en-US") : ""}</td>
                  <td className="num">{d.mid ? d.mid.toFixed(5) : ""}</td>
                  <td className={d.status === "error" || d.status === "rejected" ? "warn" : ""}>
                    {d.status}
                    {d.status_detail ? <span className="muted">: {d.status_detail}</span> : null}
                  </td>
                  <td className="reason">{d.reason}</td>
                </tr>
              ))}
              {!decisions.length && (
                <tr>
                  <td colSpan={6} className="muted">No decisions yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {lastPrompt && (
          <details>
            <summary>What {bot.name} saw at the last decision</summary>
            <pre>{lastPrompt}</pre>
          </details>
        )}
        <details>
          <summary>System prompt</summary>
          <pre>{bot.system_prompt}</pre>
        </details>
      </section>
    </>
  );
}
