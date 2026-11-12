import Link from "next/link";
import { LineChart } from "@/components/LineChart";
import { analyseBot, fmtNum, fmtUsd, parseHorizon, pnlClass, parseInverseParams, wrongnessOrder } from "@/lib/analysis";
import { config } from "@/lib/config";
import { getBots, getEngineStatus, getEntryOutcomes, getFills, getMarks } from "@/lib/queries";
import { HORIZONS, skillStats, type Horizon, type SkillStats } from "@/lib/stats";

export const dynamic = "force-dynamic";

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function Overview({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  // "all" shows every horizon side by side; ranking then uses +1h.
  const view: Horizon | "all" = sp.h === "all" ? "all" : parseHorizon(sp.h);
  const h: Horizon = view === "all" ? "1h" : view;
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
  // Totals row: entry counts and P&L summed; hit rate and mean move pooled over every resolved entry.
  // t-stats are per bot only, since pooling bots with opposite biases would cancel them out.
  // Totals: P&L summed; every skill number computed over all bots' entries pooled together.
  const totals = {
    pnl: rows.reduce((t, r) => t + r.analysis.pnl, 0),
    inversePnl: rows.reduce((t, r) => t + r.analysis.inversePnl, 0),
    skill: Object.fromEntries(HORIZONS.map((x) => [x, skillStats(outcomes.filter((o) => o.horizon === x))])) as Record<
      Horizon,
      SkillStats
    >,
  };
  const slotOf = new Map(bots.map((b, i) => [b.id, (i % 8) + 1]));
  const tests = bots.length * HORIZONS.length;
  const qs = (patch: Record<string, string>) =>
    "?" + new URLSearchParams({ h: view, mult: String(inv.multiplier), cost: String(inv.extraCostPips), ...patch }).toString();

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
            of ${config.dailyBudgetUsd.toFixed(2)} cap · {status.callsToday.toLocaleString("en-US")} calls
            <br />
            Total ${status.spentTotal.toFixed(2)} · {status.callsTotal.toLocaleString("en-US")} calls
          </div>
        </div>
        <div className="tile">
          <div className="tile-label">Engine</div>
          <div className="tile-value">{status.lastRun ? (ENGINE_STATUS[status.lastRun.status] ?? status.lastRun.status) : "Waiting for first tick"}</div>
          <div className="tile-sub">
            {status.lastRun ? `last tick ${status.lastRun.started_at.toISOString().slice(0, 16).replace("T", " ")} UTC` : "waiting for cron"}
            {status.since ? ` · running since ${status.since.toISOString().slice(0, 10)}` : ""}
          </div>
          {status.lastError && Date.now() - status.lastError.started_at.getTime() < 24 * 3.6e6 && (
            <div className="tile-sub warn">
              Last error {status.lastError.started_at.toISOString().slice(11, 16)} UTC: {status.lastError.error ?? status.lastError.status}
            </div>
          )}
        </div>
      </section>

      <section>
        <div className="section-head">
          <h2>Leaderboard: most consistently wrong first</h2>
          <nav className="segmented" aria-label="Horizon">
            {HORIZONS.map((x) => (
              <Link key={x} href={qs({ h: x })} className={x === view ? "on" : ""}>
                +{x}
              </Link>
            ))}
            <Link href={qs({ h: "all" })} className={view === "all" ? "on" : ""}>
              All
            </Link>
          </nav>
        </div>
        {view === "all" ? (
          <div className="table-wrap leaderboard-table">
            <table className="all-table">
              <thead>
                <tr>
                  <th rowSpan={2}>#</th>
                  <th rowSpan={2}>Bot</th>
                  <th rowSpan={2} className="num">Bot P&amp;L</th>
                  <th rowSpan={2} className="num">Inverse P&amp;L</th>
                  <th rowSpan={2} className="num">Inverse max DD</th>
                  {HORIZONS.map((x) => (
                    <th key={x} colSpan={SKILL_COLS.length} className="group">+{x}</th>
                  ))}
                </tr>
                <tr>
                  {HORIZONS.map((x) =>
                    SKILL_COLS.map((c, j) => (
                      <th key={x + c.label} className={`num${j === 0 ? " group-start" : ""}`}>{c.label}</th>
                    )),
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map(({ bot, analysis: a }, i) => (
                  <tr key={bot.id}>
                    <td>{i + 1}</td>
                    <td className="nowrap">
                      <i className={`swatch s${slotOf.get(bot.id)}`} />
                      <Link href={`/bots/${bot.id}${qs({})}`}>{bot.name}</Link>
                    </td>
                    <td className={`num ${pnlClass(a.pnl)}`}>{fmtUsd(a.pnl)}</td>
                    <td className={`num ${pnlClass(a.inversePnl)}`}>{fmtUsd(a.inversePnl)}</td>
                    <td className={`num ${pnlClass(a.inverseMaxDd)}`}>{fmtUsd(a.inverseMaxDd)}</td>
                    {HORIZONS.map((x) => (
                      <SkillCells key={x} s={a.skill[x]} />
                    ))}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td />
                  <td>All bots</td>
                  <td className={`num ${pnlClass(totals.pnl)}`}>{fmtUsd(totals.pnl)}</td>
                  <td className={`num ${pnlClass(totals.inversePnl)}`}>{fmtUsd(totals.inversePnl)}</td>
                  <td />
                  {HORIZONS.map((x) => (
                    <SkillCells key={x} s={totals.skill[x]} />
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>
        ) : (
          <div className="table-wrap leaderboard-table">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Bot</th>
                  <th className="num">Entries</th>
                  <th className="num">Pending</th>
                  <th className="num">Hit rate</th>
                  <th className="num">Mean move (pips)</th>
                  <th className="num">SD (pips)</th>
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
                {rows.map(({ bot, analysis: a }, i) => (
                  <tr key={bot.id}>
                    <td>{i + 1}</td>
                    <td>
                      <i className={`swatch s${slotOf.get(bot.id)}`} />
                      <Link href={`/bots/${bot.id}${qs({})}`}>{bot.name}</Link>{" "}
                      <span className="muted">{bot.persona}</span>
                    </td>
                    <SkillCells s={a.skill[h]} withPending strongT />
                    {HORIZONS.filter((x) => x !== h).map((x) => (
                      <td key={x} className="num">{fmtNum(a.skill[x].tStat)}</td>
                    ))}
                    <td className={`num ${pnlClass(a.pnl)}`}>{fmtUsd(a.pnl)}</td>
                    <td className={`num ${pnlClass(a.inversePnl)}`}>{fmtUsd(a.inversePnl)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td />
                  <td>All bots</td>
                  <SkillCells s={totals.skill[h]} withPending strongT />
                  {HORIZONS.filter((x) => x !== h).map((x) => (
                    <td key={x} className="num">{fmtNum(totals.skill[x].tStat)}</td>
                  ))}
                  <td className={`num ${pnlClass(totals.pnl)}`}>{fmtUsd(totals.pnl)}</td>
                  <td className={`num ${pnlClass(totals.inversePnl)}`}>{fmtUsd(totals.inversePnl)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        {/* Phones: one card per bot with every number for every horizon. */}
        <div className="bot-cards">
          {[
            ...rows.map(({ bot, analysis: a }, i) => ({
              key: String(bot.id),
              head: (
                <>
                  <span className="muted">#{i + 1}</span>
                  <i className={`swatch s${slotOf.get(bot.id)}`} />
                  <Link href={`/bots/${bot.id}${qs({})}`}>{bot.name}</Link>
                  <span className="muted">{bot.persona}</span>
                </>
              ),
              pnl: a.pnl,
              inversePnl: a.inversePnl,
              skill: a.skill,
            })),
            { key: "total", head: <>All bots</>, pnl: totals.pnl, inversePnl: totals.inversePnl, skill: totals.skill },
          ].map((c) => (
            <div key={c.key} className={`bot-card${c.key === "total" ? " total" : ""}`}>
              <div className="bot-card-head">{c.head}</div>
              <div className="bot-card-pnl">
                <span>
                  Bot P&amp;L <b className={pnlClass(c.pnl)}>{fmtUsd(c.pnl)}</b>
                </span>
                <span>
                  Inverse <b className={pnlClass(c.inversePnl)}>{fmtUsd(c.inversePnl)}</b>
                </span>
              </div>
              <table className="card-skill">
                <thead>
                  <tr>
                    <th />
                    <th className="num">n</th>
                    <th className="num">Hit</th>
                    <th className="num">Mean</th>
                    <th className="num">t</th>
                    <th className="num">t daily</th>
                    <th className="num">Days</th>
                  </tr>
                </thead>
                <tbody>
                  {HORIZONS.map((x) => {
                    const s = c.skill[x];
                    return (
                      <tr key={x} className={x === h && view !== "all" ? "current" : ""}>
                        <td>+{x}</td>
                        <td className="num">{s.n}</td>
                        <td className="num">{pct(s.hitRate)}</td>
                        <td className="num">{fmtNum(s.meanPips, 1)}</td>
                        <td className={`num strong ${tClass(s.tStat, s.n)}`}>{fmtNum(s.tStat)}</td>
                        <td className={`num ${tClass(s.tStatDaily, s.days)}`}>{fmtNum(s.tStatDaily)}</td>
                        <td className="num">{s.days}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
        </div>
        <p className="download">
          Download all data (CSV): <a href="/api/export?what=summary">summary</a> ·{" "}
          <a href="/api/export?what=entries">entries with outcomes</a> · <a href="/api/export?what=trades">trades</a> ·{" "}
          <a href="/api/export?what=decisions">decisions</a>
        </p>
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

const pct = (v: number) => `${(v * 100).toFixed(0)}%`;

const SKILL_COLS = [
  { label: "Entries" },
  { label: "Hit" },
  { label: "Mean" },
  { label: "SD" },
  { label: "t" },
  { label: "t daily" },
  { label: "Days" },
];

// Skill numbers for one horizon. With no resolved entries every value is 0 (shown as such),
// so each cell always holds a number.
function SkillCells({ s, withPending, strongT }: { s: SkillStats; withPending?: boolean; strongT?: boolean }) {
  return (
    <>
      <td className="num group-start">{s.n}</td>
      {withPending && <td className="num">{s.pending}</td>}
      <td className="num">{pct(s.hitRate)}</td>
      <td className="num">{fmtNum(s.meanPips)}</td>
      <td className="num">{fmtNum(s.sdPips)}</td>
      <td className={`num ${strongT ? "strong " : ""}${tClass(s.tStat, s.n)}`}>{fmtNum(s.tStat)}</td>
      <td className={`num ${tClass(s.tStatDaily, s.days)}`}>{fmtNum(s.tStatDaily)}</td>
      <td className="num">{s.days}</td>
    </>
  );
}

// Plain-English labels for engine_runs.status.
const ENGINE_STATUS: Record<string, string> = {
  ok: "Running · bots decided",
  no_bots_due: "Running · price recorded",
  market_closed: "Market closed",
  not_tradeable: "Market paused (OANDA)",
  budget_exhausted: "Daily LLM budget reached",
  locked: "Running · previous tick busy",
  running: "Tick in progress",
  error: "Error on last tick",
  price_unavailable: "Price feed unavailable",
};

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
