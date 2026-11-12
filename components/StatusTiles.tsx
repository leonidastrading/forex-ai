import { config } from "@/lib/config";
import type { getEngineStatus } from "@/lib/queries";

type Status = Awaited<ReturnType<typeof getEngineStatus>>;

export function StatusTiles({ status }: { status: Status }) {
  return (
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

