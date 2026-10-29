import { config } from "./config";

export interface Quote {
  ts: Date;
  bid: number;
  ask: number;
  tradeable: boolean;
  source: string;
}

export interface Candle {
  ts: Date;
  o: number;
  h: number;
  l: number;
  c: number;
  volume: number;
  complete: boolean;
}

// Spot FX trades Sunday ~21:00/22:00 UTC to Friday ~21:00/22:00 UTC (depends on US DST).
// Use the widest closed window here; OANDA's `tradeable` flag handles the edges.
export function fxMarketOpen(now = new Date()): boolean {
  const day = now.getUTCDay();
  const h = now.getUTCHours();
  if (day === 6) return false;
  if (day === 5 && h >= 22) return false;
  if (day === 0 && h < 21) return false;
  return true;
}

async function oanda<T>(path: string): Promise<T> {
  if (!config.oandaApiKey) throw new Error("OANDA_API_KEY is not set");
  const res = await fetch(`${config.oandaBaseUrl}${path}`, {
    headers: { Authorization: `Bearer ${config.oandaApiKey}`, "Accept-Datetime-Format": "RFC3339" },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`OANDA ${path.split("?")[0]} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

export async function getQuote(): Promise<Quote> {
  if (config.priceSource === "mock") return mockQuote(new Date());
  if (!config.oandaAccountId) throw new Error("OANDA_ACCOUNT_ID is not set");
  const data = await oanda<{
    prices: { time: string; tradeable: boolean; bids: { price: string }[]; asks: { price: string }[] }[];
  }>(`/v3/accounts/${config.oandaAccountId}/pricing?instruments=${config.instrument}`);
  const p = data.prices[0];
  if (!p?.bids?.length || !p?.asks?.length) throw new Error("OANDA returned no EUR_USD price");
  return {
    ts: new Date(p.time),
    bid: Number(p.bids[0].price),
    ask: Number(p.asks[0].price),
    tradeable: p.tradeable,
    source: "oanda",
  };
}

export async function getCandles(granularity: "M5" | "H1", count: number): Promise<Candle[]> {
  if (config.priceSource === "mock") return mockCandles(granularity, count);
  const data = await oanda<{
    candles: { time: string; complete: boolean; volume: number; mid: { o: string; h: string; l: string; c: string } }[];
  }>(`/v3/instruments/${config.instrument}/candles?granularity=${granularity}&count=${count}&price=M`);
  return data.candles.map((c) => ({
    ts: new Date(c.time),
    o: Number(c.mid.o),
    h: Number(c.mid.h),
    l: Number(c.mid.l),
    c: Number(c.mid.c),
    volume: c.volume,
    complete: c.complete,
  }));
}

// ---- Mock feed (PRICE_SOURCE=mock): deterministic wiggle + noise, for local testing only ----

function mockMid(t: number): number {
  const hours = t / 3.6e6;
  return 1.085 + 0.004 * Math.sin(hours / 7) + 0.0015 * Math.sin(hours * 1.3) + 0.0003 * Math.sin(hours * 17);
}

function mockQuote(ts: Date): Quote {
  const mid = mockMid(ts.getTime()) + (Math.random() - 0.5) * 0.0001;
  const half = 0.00006;
  return { ts, bid: +(mid - half).toFixed(5), ask: +(mid + half).toFixed(5), tradeable: true, source: "mock" };
}

function mockCandles(granularity: "M5" | "H1", count: number): Candle[] {
  const step = granularity === "M5" ? 5 * 60e3 : 3.6e6;
  const end = Math.floor(Date.now() / step) * step;
  return Array.from({ length: count }, (_, i) => {
    const t0 = end - (count - 1 - i) * step;
    const pts = [0, 0.25, 0.5, 0.75, 1].map((f) => mockMid(t0 + f * step));
    return {
      ts: new Date(t0),
      o: pts[0],
      h: Math.max(...pts),
      l: Math.min(...pts),
      c: pts[4],
      volume: 100,
      complete: i < count - 1,
    };
  });
}
