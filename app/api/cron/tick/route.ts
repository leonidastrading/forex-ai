import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { runTick } from "@/lib/engine";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Called every minute by an external scheduler (or Vercel Cron on Pro) with "Authorization: Bearer $CRON_SECRET".
// Add ?force=1 to run outside FX hours (manual testing).
export async function GET(req: Request) {
  if (!config.cronSecret || req.headers.get("authorization") !== `Bearer ${config.cronSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const force = new URL(req.url).searchParams.get("force") === "1";
  const summary = await runTick({ force });
  // Always 200 once authorized: the outcome is in the body and in engine_runs (shown on the dashboard).
  // Returning 5xx would make external schedulers like cron-job.org disable the job after a few failures.
  if (summary.error) console.error(`tick ${summary.status}: ${summary.error}`);
  return NextResponse.json(summary);
}
