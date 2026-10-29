// All tunables come from environment variables (set them in Vercel → Project → Settings → Environment Variables).

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Env ${name} must be a number, got "${raw}"`);
  return n;
}

export const config = {
  instrument: "EUR_USD",
  pip: 0.0001,

  // Price feed: "oanda" (default) or "mock" (random walk, for local testing only).
  priceSource: (process.env.PRICE_SOURCE ?? "oanda") as "oanda" | "mock",
  oandaApiKey: process.env.OANDA_API_KEY ?? "",
  oandaAccountId: process.env.OANDA_ACCOUNT_ID ?? "",
  oandaBaseUrl: process.env.OANDA_BASE_URL ?? "https://api-fxpractice.oanda.com",

  // LLM: "anthropic" (default) or "mock" (random decisions, no API cost).
  llmProvider: (process.env.LLM_PROVIDER ?? "anthropic") as "anthropic" | "mock",
  llmModel: process.env.LLM_MODEL ?? "claude-haiku-5-5",
  llmEffort: (process.env.LLM_EFFORT ?? "low") as "low" | "medium" | "high",
  llmMaxTokens: num("LLM_MAX_TOKENS", 2000),
  // USD per million tokens, used for the daily budget. Defaults match claude-haiku-5-5.
  llmInputPricePerMTok: num("LLM_INPUT_PRICE_PER_MTOK", 0.1),
  llmOutputPricePerMTok: num("LLM_OUTPUT_PRICE_PER_MTOK", 0.5),

  // Hard daily caps (UTC day). When hit, bots stop being asked until midnight UTC; prices keep being recorded.
  dailyBudgetUsd: num("LLM_DAILY_BUDGET_USD", 3),
  maxLlmCallsPerDay: num("LLM_MAX_CALLS_PER_DAY", 2000),

  // Extra simulated slippage on every fill, in pips, on top of the live bid/ask spread.
  slippagePips: num("SIM_SLIPPAGE_PIPS", 0.1),

  newsFeed: (process.env.NEWS_FEED ?? "on") !== "off",
  cronSecret: process.env.CRON_SECRET ?? "",
};

export function llmCost(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens * config.llmInputPricePerMTok + outputTokens * config.llmOutputPricePerMTok) / 1e6
  );
}

// Worst-case cost of one call, used to reserve budget before calling.
export function maxCallCost(): number {
  return llmCost(4000, config.llmMaxTokens);
}
