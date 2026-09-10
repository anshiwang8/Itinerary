// Persona harness entry point.
//
//   npm run test:agents              -> prints the plan and the cost warning, runs nothing
//   npm run test:agents -- --confirm -> actually runs it against the REAL deployed app
//
// This is MANUAL, ON-DEMAND tooling. It is deliberately not part of
// `npm run check`, not part of `npm run test:e2e` (the deterministic mock
// suite), and not part of any CI path: it spends real money on real provider
// calls every time it runs.

import { chromium } from "@playwright/test";
import path from "node:path";
import fs from "node:fs/promises";
import {
  DEFAULT_BASE_URL,
  OUTPUT_DIR,
  estimatePersonaCostUSD,
  isLocalURL,
  parseArgs,
  type RunOptions,
} from "./config";
import { PERSONAS, personaActionCounts } from "./personas";
import { runPersona } from "./lib/runPersona";
import { writeReport } from "./lib/report";
import type { Persona, PersonaResult } from "./types";

async function main(): Promise<void> {
  const run = parseArgs(process.argv.slice(2));
  const personas = selectPersonas(run);

  if (personas.length === 0) {
    console.error("No personas matched --only. Known personas:");
    for (const persona of PERSONAS) console.error("  " + persona.name);
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
        "  npm run test:agents -- --confirm\n"
    );
    return;
  }

  const startedAt = new Date();
  const reportDir = path.join(
    OUTPUT_DIR,
    "run-" + startedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19)
  );
  await fs.mkdir(reportDir, { recursive: true });

  const browser = await chromium.launch({ headless: !run.headed });
  let results: PersonaResult[] = [];
  try {
    // DELIBERATE PARALLELISM: one isolated BrowserContext per persona, all
    // running at once. Isolated cookies, storage and geolocation mean one
    // persona's simulated position can never leak into another's.
    results = await Promise.all(
      personas.map((persona) => runPersona(browser, persona, run, reportDir))
    );
  } finally {
    await browser.close().catch(() => undefined);
  }

  const finishedAt = new Date();
  const file = await writeReport(reportDir, results, {
    baseURL: run.baseURL,
    startedAt,
    finishedAt,
    speedMultiplier: run.speedMultiplier,
    estimatedCostUSD: estimatePersonaCostUSD(personaActionCounts(personas)),
  });

  const deviations = results
    .flatMap((result) => result.checks)
    .filter((check) => !check.pass && !check.skipped).length;

  console.log("");
  console.log("─".repeat(72));
  console.log(
    "Done. " +
      results.length +
      " personas, " +
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

function selectPersonas(run: RunOptions): Persona[] {
  if (!run.personaFilter) return PERSONAS;
  return PERSONAS.filter((persona) => run.personaFilter!.includes(persona.name));
}

function validateBaseURL(run: RunOptions): string | null {
  if (!/^https?:\/\//.test(run.baseURL)) {
    return (
      "AGENT_TEST_BASE_URL is not a URL: " +
      JSON.stringify(run.baseURL) +
      "\nSet it to the deployed app, or leave it unset to use " +
      DEFAULT_BASE_URL +
      "."
    );
  }
  if (isLocalURL(run.baseURL) && !run.allowLocal) {
    return (
      "REFUSING to run against " +
      run.baseURL +
      ".\n" +
      "This harness exists to exercise the REAL deployed app: the live planner,\n" +
      "real Places results, real route geometry and the real Maps key. A run\n" +
      "against localhost would produce a report that looks real and proves\n" +
      "nothing about production.\n\n" +
      "Either unset AGENT_TEST_BASE_URL (defaults to " +
      DEFAULT_BASE_URL +
      "),\n" +
      "or pass --allow-local if you genuinely mean to point it at a local server."
    );
  }
  return null;
}

function printPlan(personas: Persona[], run: RunOptions): void {
  const counts = personaActionCounts(personas);
  const cost = estimatePersonaCostUSD(counts);

  console.log("");
  console.log("═".repeat(72));
  console.log("  AGENT PERSONA RUN — against the REAL deployed app");
  console.log("═".repeat(72));
  console.log("");
  console.log("  Target        " + run.baseURL);
  console.log("  Personas      " + personas.length + " (running in parallel)");
  console.log("  Travel speed  " + run.speedMultiplier + "x real pace");
  console.log(
    "  Per-persona   " + Math.round(run.personaTimeoutMs / 60_000) + " min ceiling"
  );
  console.log("");
  for (const persona of personas) {
    console.log(
      "    - " +
        persona.name.padEnd(20) +
        (persona.signedIn ? "[signed in] " : "[guest]     ") +
        persona.intent
    );
  }
  console.log("");
  console.log("  This will make REAL API CALLS and INCUR REAL COST:");
  console.log(
    "    " +
      counts.plans +
      " plan(s), " +
      counts.swaps +
      " swap(s), " +
      counts.removes +
      " removal(s), " +
      counts.modeSwitches +
      " mode switch(es)"
  );
  console.log(
    "    against Google Places / Routes / Geocoding / Weather / Maps and OpenRouter."
  );
  console.log("");
  console.log("  Rough estimate: ~$" + cost.toFixed(2) + " for this run.");
  console.log(
    "  (An ESTIMATE from list prices, not an invoice. Real spend depends on how"
  );
  console.log(
    "   many activities each plan resolves to and whether any recovery search runs.)"
  );
  console.log("");
  console.log("  It also creates real itineraries in the production store, and — for");
  console.log("  a signed-in persona — real history documents on that account.");
  console.log("");
  console.log("═".repeat(72));
  console.log("");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
