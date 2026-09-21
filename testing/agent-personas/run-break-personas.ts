// BREAK persona set entry point.
//
//   npm run test:agents:break              -> prints the plan and cost warning, runs nothing
//   npm run test:agents:break -- --confirm -> actually runs it against the REAL deployed app
//
// A SEPARATE, parallel entry point to `run-personas.ts` (the ordinary
// 51-persona set), reusing its shared infrastructure rather than duplicating
// it: the same `parseArgs`/`validateBaseURL`/cost model (config.ts), the same
// batching pool (lib/pool.ts), the same report writer (lib/report.ts), the
// same per-persona browser runner (lib/runPersona.ts) for browser-driven break
// personas, and the new fetch-based runner (lib/runApiPersona.ts) for the
// direct-API ones. Running THIS set never touches the ordinary set, and vice
// versa.
//
// STRICTLY GUEST. No persona in this set is signed in, so it needs no saved
// session and sidesteps the harness's Google-auth limitation entirely.

import { chromium } from "@playwright/test";
import path from "node:path";
import fs from "node:fs/promises";
import {
  OUTPUT_DIR,
  parseArgs,
  validateBaseURL,
  type RunOptions,
} from "./config";
import { runPool } from "./lib/pool";
import { runPersona } from "./lib/runPersona";
import { runApiPersona } from "./lib/runApiPersona";
import { writeReport } from "./lib/report";
import {
  BREAK_PERSONAS,
  CATEGORY_ORDER,
  categoryOf,
} from "./breakPersonas";
import {
  breakActionCounts,
  estimateBreakCostUSD,
  isApiPersona,
  MAX_BURST_REQUESTS,
  MAX_REAL_PLANS_PER_PERSONA,
  type BreakPersona,
} from "./breakTypes";
import type { PersonaResult } from "./types";

async function main(): Promise<void> {
  const run = parseArgs(process.argv.slice(2));
  const personas = selectPersonas(run);

  if (personas.length === 0) {
    console.error("No break personas matched --only. Known break personas:");
    for (const persona of BREAK_PERSONAS) console.error("  " + persona.name);
    process.exitCode = 1;
    return;
  }

  const baseError = validateBaseURL(run);
  if (baseError) {
    console.error("\n" + baseError + "\n");
    process.exitCode = 1;
    return;
  }

  printPlan(personas, run);

  if (!run.confirmed) {
    console.log(
      "Nothing has run. Re-run with --confirm to spend real API calls:\n" +
        "  npm run test:agents:break -- --confirm\n"
    );
    return;
  }

  const startedAt = new Date();
  const reportDir = path.join(
    OUTPUT_DIR,
    "break-run-" + startedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19)
  );
  await fs.mkdir(reportDir, { recursive: true });

  // A browser is launched only because SOME break personas are browser-driven.
  // API personas ignore it entirely and run on Node's fetch.
  const needsBrowser = personas.some((persona) => !isApiPersona(persona));
  const browser = needsBrowser ? await chromium.launch({ headless: !run.headed }) : null;

  let results: PersonaResult[] = [];
  try {
    results = await runPool(personas, run.concurrency, (persona) =>
      isApiPersona(persona)
        ? runApiPersona(persona, run, reportDir)
        : runPersona(browser!, persona, run, reportDir)
    );
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }

  const finishedAt = new Date();
  const file = await writeReport(reportDir, results, {
    baseURL: run.baseURL,
    startedAt,
    finishedAt,
    speedMultiplier: run.speedMultiplier,
    estimatedCostUSD: estimateBreakCostUSD(personas),
    filePrefix: "BREAK-REPORT",
    title: "Break persona run report — deliberate abuse of the deployed app",
  });

  const deviations = results
    .flatMap((result) => result.checks)
    .filter((check) => !check.pass && !check.skipped).length;

  console.log("");
  console.log("─".repeat(72));
  console.log(
    "Done. " +
      results.length +
      " break personas, " +
      deviations +
      " deviation" +
      (deviations === 1 ? "" : "s") +
      " in ~" +
      Math.round((finishedAt.getTime() - startedAt.getTime()) / 60_000) +
      " min."
  );
  console.log("Report:      " + file);
  console.log("Screenshots: " + reportDir);
  console.log(
    "Both are gitignored. Nothing from this run is committed; open the report locally."
  );
  console.log("─".repeat(72));
}

function selectPersonas(run: RunOptions): BreakPersona[] {
  if (!run.personaFilter) return BREAK_PERSONAS;
  return BREAK_PERSONAS.filter((persona) => run.personaFilter!.includes(persona.name));
}

function printPlan(personas: BreakPersona[], run: RunOptions): void {
  const counts = breakActionCounts(personas);
  const cost = estimateBreakCostUSD(personas);

  console.log("");
  console.log("═".repeat(72));
  console.log("  BREAK PERSONA RUN — deliberate abuse of the REAL deployed app");
  console.log("═".repeat(72));
  console.log("");
  const inFlight = Math.min(run.concurrency, personas.length);
  console.log("  Target        " + run.baseURL);
  console.log(
    "  Personas      " +
      personas.length +
      " (" +
      counts.browserPersonas +
      " browser, " +
      counts.apiPersonas +
      " direct-API; all GUEST) — " +
      inFlight +
      " in flight at a time" +
      (inFlight < personas.length ? ", the rest queued behind them" : "")
  );
  console.log("  Travel speed  " + run.speedMultiplier + "x real pace");
  console.log(
    "  Per-persona   " + Math.round(run.personaTimeoutMs / 60_000) + " min ceiling"
  );
  console.log("");

  // Grouped by category so the six intents are legible at a glance.
  const width =
    personas.reduce((widest, persona) => Math.max(widest, persona.name.length), 0) + 2;
  for (const category of CATEGORY_ORDER) {
    const inCategory = personas.filter((persona) => categoryOf(persona.name) === category);
    if (inCategory.length === 0) continue;
    console.log("  " + category + " (" + inCategory.length + ")");
    for (const persona of inCategory) {
      console.log(
        "    - " +
          persona.name.padEnd(width) +
          (isApiPersona(persona) ? "[api]   " : "[browser]") +
          " " +
          persona.intent
      );
    }
    console.log("");
  }

  console.log("  This will make REAL API CALLS, though most are designed to be REFUSED:");
  console.log(
    "    " +
      counts.plans +
      " plan attempt(s), " +
      counts.swaps +
      " swap(s), " +
      counts.removes +
      " removal(s), " +
      counts.modeSwitches +
      " mode switch(es), " +
      counts.concurrentOps +
      " concurrent op(s)"
  );
  console.log(
    "    " +
      counts.apiRequests +
      " direct-API request(s) (malformed or rate-limit probes; rejected BEFORE any"
  );
  console.log("     provider call, so they spend essentially nothing).");
  console.log("");
  console.log(
    "  BOUNDED BY DESIGN: no burst exceeds " +
      MAX_BURST_REQUESTS +
      " requests, and no persona creates more than " +
      MAX_REAL_PLANS_PER_PERSONA
  );
  console.log(
    "  real plans. The rate-limit personas confirm graceful degradation EXISTS; they"
  );
  console.log("  do not try to exhaust anything, and never resemble a denial-of-service run.");
  console.log("");
  console.log("  Rough estimate: ~$" + cost.toFixed(2) + " for this run.");
  console.log(
    "  (An upper bound from list prices, not an invoice. A refused plan never reaches"
  );
  console.log("   Places or Routes, and most break personas exist precisely to be refused.)");
  console.log("");
  console.log("═".repeat(72));
  console.log("");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
