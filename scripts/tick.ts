// Runs one engine tick from the command line (uses the same env vars as the deployed app).
// npm run tick -- --force   → ignore FX market hours
import { getSql } from "../lib/db";
import { runTick } from "../lib/engine";

runTick({ force: process.argv.includes("--force") })
  .then((s) => console.log(JSON.stringify(s, null, 2)))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => getSql().end());
