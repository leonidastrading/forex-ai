import Link from "next/link";
import { LineChart } from "@/components/LineChart";
import { analyseBot, fmtNum, fmtUsd, parseHorizon, parseInverseParams, wrongnessOrder } from "@/lib/analysis";
import { config } from "@/lib/config";
import { getBots, getEngineStatus, getEntryOutcomes, getFills, getMarks } from "@/lib/queries";
import { HORIZONS } from "@/lib/stats";

export const dynamic = "force-dynamic";

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function Overview({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const h = parseHorizon(sp.h);
  const inv = parseInverseParams(sp);

  const [bots, status, outcomes, fills, marks] = await Promise.all([
    getBots(),
    getEngineStatus(),
    getEntryOutcomes(),
    getFills(),
    getMarks(),
  ]);

  const rows = wrongnessOrder(
    bots.map((b, i) => ({
      bot: b,
      slot: (i % 8) + 1,
      analysis: analyseBot(
        b.starting_balance,
        fills.filter((f) => f.botId === b.id),
        marks,
        outcomes.filter((o) => o.botId === b.id),
        inv,
      ),
    })),
    h,
  );
  const slotOf = new Map(bots.map((b, i) => [b.id, (i % 8) + 1]));
  const tests = bots.length * HORIZONS.length;
  const qs = (patch: Record<string, string>) =>
    "?" + new URLSearchParams({ h, mult: String(inv.multiplier), cost: String(inv.extraCostPips), ...patch }).toString();

  return (
    <>
      <section className="tiles">
        <div className="tile">
          <div className="tile-label">EUR/USD</div>
          <div className="tile-value">
            {status.latest ? `${status.latest.bid.toFixed(5)} / ${status.latest.ask.toFixed(5)}` : "–"}
          </div>
          <div className="tile-sub">
            {status.latest
              ? `${((status.latest.ask - status.latest.bid) / config.pip).toFixed(1)} pip spread · ${status.latest.ts.toISOString().slice(0, 16).replace("T", " ")} UTC`
              : "no prices yet"}
          </div>
        </div>
        <div className="tile">
          <div className="tile-label">LLM spend today</div>
          <div className="tile-value">${status.spentToday.toFixed(3)}</div>
          <div className="tile-sub">
            of ${config.dailyBudgetUsd.toFixed(2)} cap · {status.callsToday} calls
          </div>
        </div>
        <div className="tile">
          <div className="tile-label">Engine</div>
          <div className="tile-value">{status.lastRun?.status ?? "never run"}</div>
          <div className="tile-sub">
            {status.lastRun ? `last tick ${status.lastRun.started_at.toISOString().slice(0, 16).replace("T", " ")} UTC` : "waiting for cron"}
            {status.since ? ` · running since ${status.since.toISOString().slice(0, 10)}` : ""}
          </div>
        </div>
      </section>

      <section>
        <div className="section-head">
          <h2>Leaderboard: most consistently wrong first</h2>
          <nav className="segmented" aria-label="Horizon">
            {HORIZONS.map((x) => (
              <Link key={x} href={qs({ h: x })} className={x === h ? "on" : ""}>
                +{x}
              </Link>
            ))}
          </nav>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Bot</th>
                <th className="num">Entries</th>
                <th className="num">Hit rate</th>
                <th className="num">Mean move (pips)</th>
                <th className="num">t-stat</th>
                <th className="num">t (daily)</th>
                <th className="num">Days</th>
                {HORIZONS.filter((x) => x !== h).map((x) => (
                  <th key={x} className="num">t +{x}</th>
                ))}
                <th className="num">Bot P&amp;L</th>
                <th className="num">Inverse P&amp;L</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ bot, analysis: a }, i) => {
                const s = a.skill[h];
                return (
                  <tr key={bot.id}>
                    <td>{i + 1}</td>
                    <td>
                      <i className={`swatch s${slotOf.get(bot.id)}`} />
                      <Link href={`/bots/${bot.id}${qs({})}`}>{bot.name}</Link>{" "}
                      <span className="muted">{bot.persona}</span>
                    </td>
                    <td className="num">{s.n}</td>
                    <td className="num">{s.n ? `${(s.hitRate * 100).toFixed(0)}%` : "–"}</td>
                    <td className="num">{s.n ? fmtNum(s.meanPips, 2) : "–"}</td>
                    <td className={`num strong ${tClass(s.tStat, s.n)}`}>{s.n >= 2 ? fmtNum(s.tStat) : "–"}</td>
                    <td className={`num ${tClass(s.tStatDaily, s.days)}`}>{s.days >= 2 ? fmtNum(s.tStatDaily) : "–"}</td>
                    <td className="num">{s.days}</td>
                    {HORIZONS.filter((x) => x !== h).map((x) => (
                      <td key={x} className="num">{a.skill[x].n >= 2 ? fmtNum(a.skill[x].tStat) : "–"}</td>
                    ))}
                    <td className="num">{fmtUsd(a.pnl)}</td>
                    <td className="num">{fmtUsd(a.inversePnl)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="note">
          Direction skill = mid-price move from entry to entry +{h}, signed by the bot&apos;s direction, spread excluded.
          Negative t = consistently wrong. &ldquo;t (daily)&rdquo; averages each UTC day first, so it is not inflated by
          clusters of overlapping entries. With {tests} bot×horizon tests, |t| ≈ 2 will happen by chance. Treat |t| &gt;{" "}
          {bonferroniT(tests).toFixed(1)} on the daily t-stat (Bonferroni, 5%) across 40+ trading days as the bar.
          Inverse P&amp;L uses ×{inv.multiplier} size and +{inv.extraCostPips} pips extra cost per fill (
          <Link href={`/bots/${rows[0]?.bot.id ?? ""}${qs({})}`}>change on a bot page</Link>).
        </p>
      </section>

      <section>
        <h2>Bot P&amp;L</h2>
        <LineChart
          label="Bot P&L over time"
          baseline={0}
          series={rows.map(({ bot, analysis }) => ({
            name: bot.name,
            slot: slotOf.get(bot.id)!,
            points: analysis.equity.map((p) => ({ t: p.ts, v: p.equity - bot.starting_balance })),
          }))}
        />
      </section>
    </>
  );
}

function tClass(t: number, n: number) {
  if (n < 2) return "";
  if (t <= -2) return "neg";
  if (t >= 2) return "pos";
  return "";
}

// Two-sided normal critical value for alpha = 0.05 / tests.
function bonferroniT(tests: number) {
  const p = 0.05 / tests / 2;
  // Abramowitz & Stegun 26.2.23 approximation of the inverse normal tail.
  const t = Math.sqrt(-2 * Math.log(p));
  return t - (2.515517 + 0.802853 * t + 0.010328 * t * t) / (1 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t ** 3);
}
