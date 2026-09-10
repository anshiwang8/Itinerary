// The report.
//
// It lists ONLY deviations. Passing checks are counted, never enumerated:
// the report exists to find problems, not to prove thoroughness, and a wall
// of green hides the one red line in it.

import fs from "node:fs/promises";
import path from "node:path";
import type { PersonaResult } from "../types";

export interface ReportContext {
  baseURL: string;
  startedAt: Date;
  finishedAt: Date;
  speedMultiplier: number;
  estimatedCostUSD: number;
}

export async function writeReport(
  reportDir: string,
  results: PersonaResult[],
  context: ReportContext
): Promise<string> {
  const stamp = context.startedAt
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);
  const file = path.join(reportDir, "REPORT-" + stamp + ".md");
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(file, render(results, context), "utf8");
  return file;
}

function render(results: PersonaResult[], context: ReportContext): string {
  const all = results.flatMap((result) => result.checks);
  const deviations = all.filter((check) => !check.pass && !check.skipped);
  const skipped = all.filter((check) => check.skipped);
  const passed = all.filter((check) => check.pass);
  const minutes = Math.round(
    (context.finishedAt.getTime() - context.startedAt.getTime()) / 60_000
  );

  const lines: string[] = [];
  lines.push("# Persona run report");
  lines.push("");
  lines.push("| | |");
  lines.push("|---|---|");
  lines.push("| Target | `" + context.baseURL + "` |");
  lines.push("| Started | " + context.startedAt.toISOString() + " |");
  lines.push("| Finished | " + context.finishedAt.toISOString() + " |");
  lines.push("| Wall clock | ~" + minutes + " min |");
  lines.push("| Personas | " + results.length + " (run in parallel) |");
  lines.push("| Checks | " + all.length + " |");
  lines.push("| **Deviations** | **" + deviations.length + "** |");
  lines.push("| Skipped (not exercised) | " + skipped.length + " |");
  lines.push("| Passed | " + passed.length + " |");
  lines.push(
    "| Travel speed | " +
      context.speedMultiplier +
      "x real pace (dwell times are real, never compressed) |"
  );
  lines.push(
    "| Rough cost | ~$" + context.estimatedCostUSD.toFixed(2) + " (estimate, see README) |"
  );
  lines.push("");

  const timedOut = results.filter((r) => r.timedOut);
  const crashed = results.filter((r) => r.harnessError);
  if (timedOut.length > 0) {
    lines.push(
      "> **" +
        timedOut.length +
        " persona(s) hit the per-persona timeout:** " +
        timedOut.map((r) => "`" + r.persona + "`").join(", ") +
        ". Their remaining actions did not run."
    );
    lines.push("");
  }
  if (crashed.length > 0) {
    lines.push("> **Harness errors (not app deviations):**");
    for (const result of crashed) {
      lines.push("> - `" + result.persona + "`: " + result.harnessError);
    }
    lines.push("");
  }

  lines.push("## Deviations");
  lines.push("");
  if (deviations.length === 0) {
    lines.push("None. Every check that ran matched its expectation.");
    lines.push("");
  } else {
    for (const result of results) {
      const own = result.checks.filter((check) => !check.pass && !check.skipped);
      if (own.length === 0) continue;
      lines.push(
        "### `" +
          result.persona +
          "` " +
          (result.signedIn ? "(signed in)" : "(guest)") +
          " — " +
          own.length +
          " deviation" +
          (own.length === 1 ? "" : "s")
      );
      lines.push("");
      lines.push("_" + result.intent + "_");
      lines.push("");
      for (const check of own) {
        lines.push("#### " + check.step);
        lines.push("");
        lines.push("- **Expected:** " + check.expected);
        lines.push("- **Actual:** " + check.actual);
        if (check.evidence.length > 0) {
          lines.push(
            "- **Evidence:** " +
              check.evidence.map((path) => "[`" + path + "`](" + path + ")").join(", ")
          );
        }
        lines.push("- **At:** " + check.at);
        lines.push("");
      }
    }
  }

  if (skipped.length > 0) {
    lines.push("## Not exercised");
    lines.push("");
    lines.push(
      "These scenarios could not run in this environment. They are neither passes nor deviations."
    );
    lines.push("");
    for (const check of skipped) {
      lines.push("- `" + check.persona + "` / **" + check.step + "**: " + check.actual);
    }
    lines.push("");
  }

  lines.push("## Everything else");
  lines.push("");
  lines.push(
    passed.length +
      " check" +
      (passed.length === 1 ? "" : "s") +
      " passed as expected and are not listed individually."
  );
  lines.push("");

  const consoleErrors = results.filter((r) => r.consoleErrors.length > 0);
  const networkErrors = results.filter((r) => r.networkErrors.length > 0);
  if (consoleErrors.length > 0 || networkErrors.length > 0) {
    lines.push("## Console and network noise");
    lines.push("");
    lines.push(
      "Recorded for context. Not counted as deviations: a third-party script or a single retried request is not the app misbehaving."
    );
    lines.push("");
    for (const result of results) {
      if (result.consoleErrors.length === 0 && result.networkErrors.length === 0) continue;
      lines.push("- **`" + result.persona + "`**");
      for (const message of dedupe(result.consoleErrors).slice(0, 8)) {
        lines.push("  - console: `" + message.replace(/`/g, "'") + "`");
      }
      for (const message of dedupe(result.networkErrors).slice(0, 8)) {
        lines.push("  - network: `" + message.replace(/`/g, "'") + "`");
      }
    }
    lines.push("");
  }

  lines.push("## Personas that ran");
  lines.push("");
  lines.push("| Persona | Identity | Checks | Deviations | Plans created |");
  lines.push("|---|---|---|---|---|");
  for (const result of results) {
    const own = result.checks.filter((c) => !c.pass && !c.skipped).length;
    lines.push(
      "| `" +
        result.persona +
        "` | " +
        (result.signedIn ? "signed in" : "guest") +
        " | " +
        result.checks.length +
        " | " +
        own +
        " | " +
        (result.planIds.length > 0 ? result.planIds.map((id) => "`" + id + "`").join(", ") : "none") +
        " |"
    );
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(
    "Screenshots sit beside this file, one folder per persona. This report and its screenshots are gitignored: they are a point-in-time artifact of real data and are not committed."
  );
  lines.push("");

  return lines.join("\n");
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
