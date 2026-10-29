import postgres from "postgres";

declare global {
  // eslint-disable-next-line no-var
  var __sql: postgres.Sql | undefined;
}

function connectionString(): string {
  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!url) throw new Error("DATABASE_URL (or POSTGRES_URL) is not set");
  return url;
}

// One small pool per serverless instance. prepare:false keeps it compatible with Neon's pgbouncer pooler.
export function getSql(): postgres.Sql {
  if (!globalThis.__sql) {
    globalThis.__sql = postgres(connectionString(), {
      max: 3,
      prepare: false,
      idle_timeout: 20,
      types: { numeric: { to: 1700, from: [1700], serialize: String, parse: Number } },
    } as postgres.Options<{}>);
  }
  return globalThis.__sql;
}
