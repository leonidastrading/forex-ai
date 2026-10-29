-- Idempotent schema. Applied by `npm run db:migrate` (also runs on every Vercel build).

CREATE TABLE IF NOT EXISTS bots (
  id                    serial PRIMARY KEY,
  slug                  text UNIQUE NOT NULL,
  name                  text NOT NULL,
  persona               text NOT NULL,           -- short label shown on the dashboard
  system_prompt         text NOT NULL,
  model                 text,                    -- NULL = use LLM_MODEL
  active                boolean NOT NULL DEFAULT true,
  starting_balance      numeric NOT NULL DEFAULT 10000,
  max_trades_per_day    int NOT NULL DEFAULT 12,
  max_position_units    int NOT NULL DEFAULT 100000,
  decision_interval_min int NOT NULL DEFAULT 5,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS price_snapshots (
  id         bigserial PRIMARY KEY,
  ts         timestamptz NOT NULL,
  instrument text NOT NULL DEFAULT 'EUR_USD',
  bid        numeric NOT NULL,
  ask        numeric NOT NULL,
  source     text NOT NULL
);
CREATE INDEX IF NOT EXISTS price_snapshots_instrument_ts ON price_snapshots (instrument, ts);

CREATE TABLE IF NOT EXISTS decisions (
  id              bigserial PRIMARY KEY,
  bot_id          int NOT NULL REFERENCES bots(id),
  ts              timestamptz NOT NULL DEFAULT now(),
  snapshot_id     bigint REFERENCES price_snapshots(id),
  action          text NOT NULL,                 -- buy | sell | close | hold
  requested_units int NOT NULL DEFAULT 0,
  reason          text,
  status          text NOT NULL,                 -- executed | hold | rejected | error
  status_detail   text,
  model           text,
  input_tokens    int NOT NULL DEFAULT 0,
  output_tokens   int NOT NULL DEFAULT 0,
  cost_usd        numeric NOT NULL DEFAULT 0,
  latency_ms      int,
  prompt          text,                          -- the user message the bot saw
  raw_response    jsonb
);
CREATE INDEX IF NOT EXISTS decisions_bot_ts ON decisions (bot_id, ts DESC);
CREATE INDEX IF NOT EXISTS decisions_ts ON decisions (ts);

CREATE TABLE IF NOT EXISTS trades (
  id             bigserial PRIMARY KEY,
  bot_id         int NOT NULL REFERENCES bots(id),
  decision_id    bigint REFERENCES decisions(id),
  ts             timestamptz NOT NULL DEFAULT now(),
  side           text NOT NULL,                  -- buy | sell
  units          int NOT NULL,                   -- always positive, EUR
  price          numeric NOT NULL,               -- fill price incl. spread + slippage
  bid            numeric NOT NULL,               -- quote at fill time
  ask            numeric NOT NULL,
  kind           text NOT NULL,                  -- open | add | reduce | close | flip
  opening_units  int NOT NULL,                   -- part of the fill that increased exposure (entries)
  realized_pnl   numeric NOT NULL DEFAULT 0,     -- USD
  position_after int NOT NULL
);
CREATE INDEX IF NOT EXISTS trades_bot_ts ON trades (bot_id, ts);

CREATE TABLE IF NOT EXISTS positions (
  bot_id       int PRIMARY KEY REFERENCES bots(id),
  units        int NOT NULL DEFAULT 0,           -- signed: + long EUR, - short EUR
  avg_price    numeric NOT NULL DEFAULT 0,
  realized_pnl numeric NOT NULL DEFAULT 0,       -- cumulative USD
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS engine_runs (
  id          bigserial PRIMARY KEY,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status      text NOT NULL,
  detail      jsonb
);

CREATE TABLE IF NOT EXISTS engine_lock (
  id           int PRIMARY KEY,
  locked_until timestamptz NOT NULL
);
INSERT INTO engine_lock (id, locked_until) VALUES (1, 'epoch') ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS kv_cache (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);
