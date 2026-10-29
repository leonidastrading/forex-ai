// Applies db/schema.sql and upserts the bot personas. Safe to run repeatedly.
import { readFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { PERSONAS } from "../lib/personas";

async function main() {
  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!url) {
    if (process.env.VERCEL) {
      console.warn("migrate: no DATABASE_URL, skipping (connect a Neon database to this project)");
      return;
    }
    throw new Error("DATABASE_URL is not set");
  }
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await sql.unsafe(readFileSync(path.join(process.cwd(), "db/schema.sql"), "utf8"));
    for (const p of PERSONAS) {
      await sql`
        INSERT INTO bots (slug, name, persona, system_prompt)
        VALUES (${p.slug}, ${p.name}, ${p.persona}, ${p.systemPrompt})
        ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, persona = EXCLUDED.persona,
                                         system_prompt = EXCLUDED.system_prompt`;
    }
    console.log(`migrate: schema applied, ${PERSONAS.length} bots upserted`);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
