import { config } from "./config";
import { getSql } from "./db";

// Free weekly economic calendar (Forex Factory export). It rate-limits aggressively, so it is
// fetched at most once an hour and cached in Postgres. Any failure just means "no news".
const FEED_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const CACHE_KEY = "ff_calendar_thisweek";

export interface NewsEvent {
  ts: string; // ISO
  country: string;
  title: string;
  impact: string;
  forecast: string;
  previous: string;
}

async function loadWeek(): Promise<NewsEvent[]> {
  const sql = getSql();
  const cached = await sql<{ value: NewsEvent[] }[]>`
    SELECT value FROM kv_cache WHERE key = ${CACHE_KEY} AND expires_at > now()`;
  if (cached.length) return cached[0].value;

  let events: NewsEvent[] = [];
  let ttl = "1 hour";
  try {
    const res = await fetch(FEED_URL, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(String(res.status));
    const raw = (await res.json()) as {
      title: string; country: string; date: string; impact: string; forecast?: string; previous?: string;
    }[];
    events = raw
      .filter((e) => (e.country === "USD" || e.country === "EUR") && (e.impact === "High" || e.impact === "Medium"))
      .map((e) => ({
        ts: new Date(e.date).toISOString(),
        country: e.country,
        title: e.title,
        impact: e.impact,
        forecast: e.forecast ?? "",
        previous: e.previous ?? "",
      }));
  } catch {
    ttl = "15 minutes"; // back off, retry later
  }
  await sql`
    INSERT INTO kv_cache (key, value, expires_at)
    VALUES (${CACHE_KEY}, ${sql.json(events as never)}, now() + ${ttl}::interval)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`;
  return events;
}

// Events from 3h ago to 12h ahead.
export async function relevantNews(now = new Date()): Promise<NewsEvent[]> {
  if (!config.newsFeed) return [];
  try {
    const events = await loadWeek();
    const from = now.getTime() - 3 * 3.6e6;
    const to = now.getTime() + 12 * 3.6e6;
    return events.filter((e) => {
      const t = Date.parse(e.ts);
      return t >= from && t <= to;
    });
  } catch {
    return [];
  }
}
