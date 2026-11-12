import Link from "next/link";
import { Fragment } from "react";
import { LineChart } from "@/components/LineChart";
import { analyseBot, fmtNum, fmtUsd, parseHorizon, pnlClass, parseInverseParams, wrongnessOrder } from "@/lib/analysis";
import { getBots, getEntryOutcomes, getFills, getMarks, getTradeTotals } from "@/lib/queries";
import { maxDrawdown, type EquityPoint } from "@/lib/sim";
import { HORIZONS, skillStats, type Horizon, type SkillStats } from "@/lib/stats";

export const dynamic = "force-dynamic";

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function AllStats({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  // "all" shows every horizon side by side; ranking then uses +1h.
  const view: Horizon | "all" = sp.h === "all" ? "all" : parseHorizon(sp.h);
  const h: Horizon = view === "all" ? "1h" : view;
  const inv = parseInverseParams(sp);

  const [bots, outcomes, fills, marks, tradeTotals] = await Promise.all([
    getBots(),
    getEntryOutcomes(),
    getFills(),
    getMarks(),
    getTradeTotals(),
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
  const totalsByBot = new Map(tradeTotals.map((t) => [t.bot_id, t]));
  const simpleRows: SimpleRow[] = [...rows]
    .sort((x, y) => y.analysis.inversePnl - x.analysis.inversePnl)
    .map(({ bot, analysis: a }) => {
      const t = totalsByBot.get(bot.id);
      return {
        id: bot.id,
        name: bot.name,
        persona: bot.persona,
        slot: bots.findIndex((b) => b.id === bot.id) % 8 + 1,
        href: `/bots/${bot.id}`,
        fills: t?.fills ?? 0,
        closed: t?.closed ?? 0,
        wins: t?.wins ?? 0,
        losses: t?.losses ?? 0,
        avgWin: t?.avg_win ?? 0,
        avgLoss: t?.avg_loss ?? 0,
        best: t?.best ?? 0,
        worst: t?.worst ?? 0,
        volume: t?.volume ?? 0,
        firstTrade: t?.first_trade ?? null,
        position: bot.units,
        realized: bot.realized_pnl,
        pnl: a.pnl,
        maxDd: maxDrawdown(a.equity),
        inversePnl: a.inversePnl,
        inverseMaxDd: a.inverseMaxDd,
      };
    });
  const sumOf = (k: keyof SimpleRow) => simpleRows.reduce((t, r) => t + (r[k] as number), 0);
  simpleRows.push({
    id: 0,
    name: "All bots",
    persona: "",
    slot: 0,
    href: "",
    fills: sumOf("fills"),
    closed: sumOf("closed"),
    wins: sumOf("wins"),
    losses: sumOf("losses"),
    avgWin: weighted(simpleRows, "avgWin", "wins"),
    avgLoss: weighted(simpleRows, "avgLoss", "losses"),
    best: Math.max(0, ...simpleRows.map((r) => r.best)),
    worst: Math.min(0, ...simpleRows.map((r) => r.worst)),
    volume: sumOf("volume"),
    firstTrade: simpleRows.reduce<Date | null>((d, r) => (r.firstTrade && (!d || r.firstTrade < d) ? r.firstTrade : d), null),
    position: sumOf("position"),
    realized: sumOf("realized"),
    pnl: sumOf("pnl"),
    // Drawdown of all five bots run together: sum the equity curves (they share one price timeline).
    maxDd: maxDrawdown(sumCurves(rows.map((r) => r.analysis.equity))),
    inversePnl: sumOf("inversePnl"),
    inverseMaxDd: maxDrawdown(sumCurves(rows.map((r) => r.analysis.inverse))),
  });
  const slotOf = new Map(bots.map((b, i) => [b.id, (i % 8) + 1]));
  const tests = bots.length * HORIZONS.length;
  const qs = (patch: Record<string, string>) =>
    "?" + new URLSearchParams({ h: view, mult: String(inv.multiplier), cost: String(inv.extraCostPips), ...patch }).toString();

  return (
    <>
      <p className="crumbs">
        <Link href="/">← Overview</Link>
      </p>
      <section>
        <h2>Totals since start</h2>
        <SimpleTotals rows={simpleRows} />
        <p className="note">
          Sorted by inverse P&amp;L, best first. P&amp;L includes open positions at the current price. A closed trade is any
          fill that took profit or loss; win rate = winning closed trades ÷ all closed trades. Inverse = taking the opposite
          side of every trade (×{inv.multiplier} size, +{inv.extraCostPips} pips extra cost).
        </p>
      </section>

      <details className="advanced">
        <summary>Advanced: direction skill by time horizon</summary>
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

      </details>

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

interface SimpleRow {
  id: number;
  name: string;
  persona: string;
  slot: number;
  href: string;
  fills: number;
  closed: number;
  wins: number;
  losses: number;
  avgWin: number;
  avgLoss: number;
  best: number;
  worst: number;
  volume: number;
  firstTrade: Date | null;
  position: number;
  realized: number;
  pnl: number;
  maxDd: number;
  inversePnl: number;
  inverseMaxDd: number;
}

function sumCurves(curves: EquityPoint[][]): EquityPoint[] {
  const n = Math.max(0, ...curves.map((c) => c.length));
  return Array.from({ length: n }, (_, i) => ({
    ts: curves[0]?.[i]?.ts ?? 0,
    equity: curves.reduce((t, c) => t + (c[i]?.equity ?? 0), 0),
  }));
}

function weighted(rows: SimpleRow[], k: "avgWin" | "avgLoss", w: "wins" | "losses") {
  const n = rows.reduce((t, r) => t + r[w], 0);
  return n ? rows.reduce((t, r) => t + r[k] * r[w], 0) / n : 0;
}

const SIMPLE_COLS: { label: string; cell: (r: SimpleRow) => React.ReactNode; cls?: (r: SimpleRow) => string }[] = [
  { label: "Bot P&L", cell: (r) => fmtUsd(r.pnl), cls: (r) => pnlClass(r.pnl) },
  { label: "Inverse P&L", cell: (r) => fmtUsd(r.inversePnl), cls: (r) => pnlClass(r.inversePnl) },
  { label: "Trades", cell: (r) => r.fills.toLocaleString("en-US") },
  { label: "Closed trades", cell: (r) => r.closed.toLocaleString("en-US") },
  { label: "Wins", cell: (r) => r.wins.toLocaleString("en-US") },
  { label: "Losses", cell: (r) => r.losses.toLocaleString("en-US") },
  { label: "Win rate", cell: (r) => (r.closed ? pct(r.wins / r.closed) : "0%") },
  { label: "Avg win", cell: (r) => fmtUsd(r.avgWin), cls: (r) => pnlClass(r.avgWin) },
  { label: "Avg loss", cell: (r) => fmtUsd(r.avgLoss), cls: (r) => pnlClass(r.avgLoss) },
  { label: "Best trade", cell: (r) => fmtUsd(r.best), cls: (r) => pnlClass(r.best) },
  { label: "Worst trade", cell: (r) => fmtUsd(r.worst), cls: (r) => pnlClass(r.worst) },
  { label: "Realized P&L", cell: (r) => fmtUsd(r.realized), cls: (r) => pnlClass(r.realized) },
  { label: "Open P&L", cell: (r) => fmtUsd(r.pnl - r.realized), cls: (r) => pnlClass(r.pnl - r.realized) },
  { label: "Open position", cell: (r) => (r.position === 0 ? "Flat" : `${r.position > 0 ? "Long" : "Short"} ${Math.abs(r.position).toLocaleString("en-US")}`) },
  { label: "Max drawdown", cell: (r) => fmtUsd(r.maxDd), cls: (r) => pnlClass(r.maxDd) },
  { label: "Inverse max DD", cell: (r) => fmtUsd(r.inverseMaxDd), cls: (r) => pnlClass(r.inverseMaxDd) },
  { label: "Volume (EUR)", cell: (r) => Math.round(r.volume).toLocaleString("en-US") },
  { label: "First trade", cell: (r) => (r.firstTrade ? r.firstTrade.toISOString().slice(0, 10) : "") },
];

function SimpleTotals({ rows }: { rows: SimpleRow[] }) {
  const name = (r: SimpleRow) =>
    r.href ? (
      <>
        <i className={`swatch s${r.slot}`} />
        <Link href={r.href}>{r.name}</Link> <span className="muted">{r.persona}</span>
      </>
    ) : (
      r.name
    );
  return (
    <>
      <div className="simple-cards">
        {rows.map((r) => (
          <div key={r.id} className={`bot-card${r.href ? "" : " total"}`}>
            <div className="bot-card-head">{name(r)}</div>
            <dl>
              {SIMPLE_COLS.map((c) => (
                <Fragment key={c.label}>
                  <dt>{c.label}</dt>
                  <dd className={c.cls?.(r) ?? ""}>{c.cell(r)}</dd>
                </Fragment>
              ))}
            </dl>
          </div>
        ))}
      </div>
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
