import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { runTick } from "@/lib/engine";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Called by Vercel Cron (GET with "Authorization: Bearer $CRON_SECRET").
// Add ?force=1 to run outside FX hours (manual testing).
export async function GET(req: Request) {
  if (!config.cronSecret || req.headers.get("authorization") !== `Bearer ${config.cronSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const force = new URL(req.url).searchParams.get("force") === "1";
  const summary = await runTick({ force });
  return NextResponse.json(summary, { status: summary.status === "error" ? 500 : 200 });
}
