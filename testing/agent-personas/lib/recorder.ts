// The expectation ledger.
//
// EVERY meaningful thing a persona does records what was EXPECTED and what
// ACTUALLY happened, with a screenshot beside it. A deviation is recorded and
// the persona CONTINUES — this is an exploratory report, not a pass/fail
// gate, and one early mismatch must not cut off the rest of that persona's
// coverage.

import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import type { CheckRecord } from "../types";

/** Playwright's call logs are ANSI-coloured and the report is markdown, so
 *  every recorded string is stripped once, here, rather than at each site
 *  that might quote an error. */
const ANSI = /\u001B\[[0-9;]*m/g;

function clean(value: string): string {
  return value.replace(ANSI, "").trim();
}

export class Recorder {
  readonly checks: CheckRecord[] = [];
  readonly consoleErrors: string[] = [];
  readonly networkErrors: string[] = [];
  /**
   * Every JavaScript dialog the page raised.
   *
   * Two reasons this exists. A dialog BLOCKS the browser's event loop, so an
   * unhandled one freezes the whole persona and every later step reports a
   * timeout that says nothing; dismissing it keeps the run honest. And a
   * dialog is itself the finding for the injection-text persona — if
   * `<script>alert(1)</script>` ever ran, this is where it shows up.
   * `expectGraceful` reads this list and fails on a non-empty one.
   */
  readonly dialogs: string[] = [];
  private shotIndex = 0;

  constructor(
    private readonly persona: string,
    private readonly screenshotDir: string,
    private readonly reportDir: string
  ) {}

  /** Wire console + network capture onto a page. Called once per page. */
  observe(page: Page): void {
    page.on("console", (message) => {
      const type = message.type();
      const text = message.text();
      // The app's own [live-tracking] transition lines are dev-gated and
      // genuinely useful evidence when present; keep them out of the error
      // bucket but keep them in the trail.
      if (type === "error") this.consoleErrors.push(text.slice(0, 500));
      else if (type === "warning" && /error|failed|denied/i.test(text)) {
        this.consoleErrors.push(`[warning] ${text.slice(0, 500)}`);
      }
    });
    page.on("pageerror", (error) => {
      this.consoleErrors.push(`[pageerror] ${String(error).slice(0, 500)}`);
    });
    page.on("dialog", (dialog) => {
      this.dialogs.push(`${dialog.type()}: ${dialog.message().slice(0, 200)}`);
      void dialog.dismiss().catch(() => undefined);
    });
    page.on("requestfailed", (request) => {
      const failure = request.failure()?.errorText ?? "unknown";
      // Third-party analytics/font noise is not this app's behaviour.
      if (!request.url().includes("vercel") && !request.url().startsWith("/")) {
        if (!/googleapis|gstatic|firebase|itinerary/i.test(request.url())) return;
      }
      this.networkErrors.push(`${request.method()} ${request.url()} — ${failure}`);
    });
    page.on("response", (response) => {
      if (response.status() >= 400 && /\/api\//.test(response.url())) {
        this.networkErrors.push(
          `${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`
        );
      }
    });
  }

  async screenshot(page: Page, label: string): Promise<string> {
    const slug = `${String(++this.shotIndex).padStart(2, "0")}-${label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")}.png`;
    const absolute = path.join(this.screenshotDir, slug);
    try {
      await fs.mkdir(this.screenshotDir, { recursive: true });
      await page.screenshot({ path: absolute, fullPage: false });
    } catch (error) {
      return `screenshot failed: ${String(error).slice(0, 120)}`;
    }
    return path.relative(this.reportDir, absolute).split(path.sep).join("/");
  }

  record(entry: {
    step: string;
    expected: string;
    actual: string;
    pass: boolean;
    skipped?: boolean;
    evidence?: string[];
  }): void {
    const expected = clean(entry.expected);
    const actual = clean(entry.actual);
    this.checks.push({
      persona: this.persona,
      step: entry.step,
      expected,
      actual,
      pass: entry.pass,
      skipped: entry.skipped,
      evidence: entry.evidence ?? [],
      at: new Date().toISOString(),
    });
    const mark = entry.skipped ? "SKIP" : entry.pass ? "pass" : "DEVIATION";
    process.stdout.write(`  [${this.persona}] ${mark}  ${entry.step}\n`);
    if (!entry.pass && !entry.skipped) {
      process.stdout.write(`      expected: ${expected}\n`);
      process.stdout.write(`      actual:   ${actual}\n`);
    }
  }

  /** Record a check whose subject is produced by a possibly-throwing probe.
   *  A thrown probe is itself a deviation, never a crashed run. */
  async check(
    page: Page | null,
    step: string,
    expected: string,
    probe: () => Promise<{ pass: boolean; actual: string; skipped?: boolean }>
  ): Promise<boolean> {
    let outcome: { pass: boolean; actual: string; skipped?: boolean };
    try {
      outcome = await probe();
    } catch (error) {
      outcome = { pass: false, actual: `probe threw: ${String(error).slice(0, 300)}` };
    }
    const evidence: string[] = [];
    if (page && !outcome.pass && !outcome.skipped) {
      evidence.push(await this.screenshot(page, `${step}-deviation`));
    }
    this.record({ step, expected, ...outcome, evidence });
    return outcome.pass;
  }
}
