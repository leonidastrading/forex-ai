# AI Trader Inversion Experiment

Five LLM "traders" with different bad habits paper-trade EUR/USD. Every decision is logged, and the
dashboard measures whether any of them is **consistently wrong on direction**. If one is, trading
its inverse could become a strategy.

**Paper only.** No broker orders are ever sent. Live OANDA practice prices are used only as a quote
feed, and all fills are simulated internally.

## How it works

```
Scheduler (every minute, Sun–Fri)
  └─ GET /api/cron/tick
       ├─ skip if FX market closed / OANDA says not tradeable
       ├─ fetch EUR/USD bid/ask from OANDA → price_snapshots
       ├─ pick bots whose decision interval (default 5 min) has elapsed
       ├─ reserve worst-case LLM cost against the daily budget; skip bots that don't fit
       ├─ for each bot (in parallel): price, 3h of M5 + 24h of H1 candles, its position and P&L,
       │    its last 6 decisions, and the EUR/USD economic calendar → Claude → JSON decision
       └─ apply desk rules, simulate the fill at bid/ask + slippage, record decision/trade/position
```

Price snapshots are recorded every minute even when no bot is due, so the +5m outcome is measured
at roughly 1-minute resolution.

### The bots (`lib/personas.ts`)

| Bot | Persona |
| --- | --- |
| Nico | Impulsive news-chaser |
| Fiona | Fearful, cuts winners and losers early |
| Stan | Stubborn averager-down |
| Maya | FOMO momentum chaser |
| Victor | Overconfident contrarian |

Each bot gets its own system prompt and a separate API call. None of them knows the others exist or
that it is being measured for inversion. Each returns `{action: buy|sell|close|hold, units, reason}`
through structured outputs.

### Desk rules (per bot, columns in the `bots` table)

- `max_trades_per_day` (default 12) caps **new entries**, meaning fills that open or increase
  exposure. Reducing and closing are always allowed. A flip after the cap is cut down to a close.
- `max_position_units` (default 100,000 EUR = 1 lot on a $10k account). Larger orders are clipped.
- Sizes are rounded down to 1,000 units. `decision_interval_min` defaults to 5.

### Fills

Buys fill at the ask and sells at the bid, each worsened by `SIM_SLIPPAGE_PIPS` (default 0.1).
The bot holds a single net position with an average price. P&L is in USD.

## Dashboard

- **Leaderboard** (`/`): bots ranked by how consistently wrong they are, meaning the most negative
  direction t-stat at the selected horizon (+5m / +1h / +1d).
- **Bot page** (`/bots/:id`): position, equity curve vs inverse curve, skill table, every trade and
  decision with its one-line reason, the exact prompt the bot last saw, and its system prompt.
- **Inverse bot**: takes the opposite side of every fill at a configurable **multiplier**. It pays
  the live spread on its own side of the book plus a configurable **extra cost per fill** in pips.
  A bot and its 1× inverse therefore lose two spreads per round trip between them, so the inverse
  needs real skill to clear costs.

### Gross direction skill

For every entry: `move = direction × (mid at entry+h − mid at entry) / pip`. This is mid to mid,
spread excluded. Each horizon reports `n`, hit rate, mean, SD and `t = mean / (sd / √n)`.

- **t (daily)** first averages entries within each UTC day, then takes the t-stat over days.
  Entries a few minutes apart overlap, which inflates the plain t-stat. The daily version is the
  one to trust.
- 5 bots × 3 horizons = 15 tests, so a |t| of about 2 will show up by luck. The page shows the
  Bonferroni bar (about 2.9).
- +5m and +1h must resolve within 5 and 30 minutes of the target time, so entries just before the
  weekend close drop out of those horizons. +1d resolves at the next available price within 3 days.

Expect 2–3 months of running before these numbers mean anything.

## Setup

You need: this repo on GitHub, a Vercel account, an Anthropic API key, and an OANDA practice
account (free; create a token under *Manage API Access*).

1. **Vercel project**: import this GitHub repo in Vercel (framework: Next.js; defaults are fine).
2. **Database**: Project → Storage → *Create Database* → **Neon (Postgres)** → connect it to the
   project. This sets `DATABASE_URL`. Tables and bots are created automatically on every deploy
   (`vercel-build` runs `scripts/migrate.ts`, which is idempotent).
3. **Environment variables** (Project → Settings → Environment Variables, see `.env.example`):
   - `OANDA_API_KEY`, `OANDA_ACCOUNT_ID` (practice account, e.g. `101-004-1234567-001`)
   - `ANTHROPIC_API_KEY`. If calls fail with "API key is not scoped to a workspace", either create the
     key inside a workspace in the Anthropic Console or also set `ANTHROPIC_WORKSPACE_ID`.
   - `CRON_SECRET`: a long random string. The scheduler sends it as a Bearer token.
   - `LLM_DAILY_BUDGET_USD` (default 3)
   - optional `DASHBOARD_PASSWORD`
4. **Redeploy** so the build picks up the variables and runs the migration.
5. Check a tick by hand (works outside FX hours with `force=1`):

   ```bash
   curl -H "Authorization: Bearer $CRON_SECRET" "https://<your-app>.vercel.app/api/cron/tick?force=1"
   ```
6. **Schedule it** (next section).

### Scheduling the tick

The engine runs when something calls `GET /api/cron/tick` with `Authorization: Bearer $CRON_SECRET`.
Vercel Hobby only allows daily crons, so use a free external scheduler:

1. Sign up at [cron-job.org](https://cron-job.org) (free, supports every-minute jobs).
2. Create a cronjob:
   - URL: `https://<your-app>.vercel.app/api/cron/tick`
   - Schedule: every minute
   - Advanced → Headers: `Authorization` = `Bearer <your CRON_SECRET>`
   - Optional: turn on failure notifications
3. Save. "History" should show HTTP 200 responses. Outside FX hours the body is `{"status":"market_closed"}`.

If the project's Deployment Protection blocks the production URL, the job gets a Vercel login page
(401). Turn off Vercel Authentication for production, or add a protection-bypass secret.

On a Vercel Pro plan you can use Vercel Cron instead. Add this to `vercel.json`:
`"crons": [{ "path": "/api/cron/tick", "schedule": "* * * * 0-5" }]`. Vercel sends the
`CRON_SECRET` header automatically.

Ticks must come at least every 5 minutes for +5m outcomes to resolve (see the 5-minute lag rule
above). Running every minute also keeps the Neon compute awake about 120 hours a week, so check
that this fits your Neon plan.

### Cost

Default model `claude-haiku-5-5` at low effort: 5 bots × one call per 5 minutes × 24h is about
1,440 calls per day, roughly $0.5–1.5 per day. The engine reserves the worst-case cost of each
call (`4000 input + LLM_MAX_TOKENS output` tokens) before calling, so spend never passes
`LLM_DAILY_BUDGET_USD`. `LLM_MAX_CALLS_PER_DAY` is a second hard cap. When a cap is hit, bots
pause until 00:00 UTC while price recording continues.

## Local development

```bash
npm install
cp .env.example .env.local          # fill in DATABASE_URL at least
PRICE_SOURCE=mock LLM_PROVIDER=mock npm run db:migrate
PRICE_SOURCE=mock LLM_PROVIDER=mock npm run tick -- --force   # one engine tick, no API spend
npm run dev
npm test                            # sim/accounting and stats unit tests
```

`npm run tick` uses the same code path as the cron endpoint. Drop the `mock` flags to hit OANDA
and Claude for real.

## Layout

```
app/api/cron/tick/route.ts   cron endpoint (CRON_SECRET-protected)
app/page.tsx                 leaderboard + all-bot P&L chart
app/bots/[id]/page.tsx       per-bot page, inverse controls
lib/engine.ts                one tick: prices → prompts → decisions → simulated fills
lib/sim.ts                   position accounting, equity replay, inverse fills (pure, tested)
lib/stats.ts                 direction-skill t-stats (pure, tested)
lib/market.ts                OANDA pricing + candles (and mock feed)
lib/llm.ts                   Claude call with structured output + cost accounting
lib/news.ts                  free EUR/USD economic calendar, cached hourly
lib/personas.ts              the five bots
db/schema.sql                tables: bots, decisions, trades, positions, price_snapshots, …
```
