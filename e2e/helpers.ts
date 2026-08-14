// Shared e2e helpers. Two jobs:
//  - planEvening: run the real pipeline from the empty state and land on
//    the map stage (or fail fast with the app's own error text).
//  - expectStripMatchesPin: THE desync check — a stop's start time on its
//    strip card must equal the time on its map pin. The strip renders from
//    React state, the pin from the map overlay; if the store, strip, and
//    map ever disagree, this is where it shows.
import { expect, Locator, Page } from "@playwright/test";

/**
 * Type a prompt into the empty state, plan it, and wait for the itinerary
 * to render (strip + map pins). Live pipeline — allow up to ~90s.
 * Throws with the interface's own message if the pipeline fails loud.
 */
export async function planEvening(page: Page, prompt: string): Promise<void> {
  await page.goto("/");
  await page.locator(".prompt__input").fill(prompt);
  await page.locator(".prompt__go").click();

  // a thin prompt may surface the clarify step first — skipping runs the
  // default pipeline (same behavior these specs always exercised)
  await dismissClarifyIfShown(page);

  // success renders the strip; failure renders an error block — wait for
  // whichever comes first so failures are fast and carry the real reason
  await expect(page.locator(".lstrip, .empty__err, .stage__err").first()).toBeVisible({
    timeout: 90_000,
  });
  const err = page.locator(".empty__err, .stage__err").first();
  if (await err.isVisible()) {
    throw new Error(`pipeline failed: ${(await err.innerText()).trim()}`);
  }

  // Pins remain present on the deterministic fallback projection when the
  // external Maps JavaScript provider is unavailable.
  await expect(page.locator(".chip").first()).toBeVisible({ timeout: 30_000 });
}

/** If the clarify QUESTIONS appear, click "Skip — just plan it" so the
 *  pipeline continues. Targeted by accessible name, not by class: the
 *  recovery panel's "Plan without it" shares .clarify__skip, and clicking
 *  THAT here would silently drop a stop mid-test. */
export async function dismissClarifyIfShown(page: Page): Promise<void> {
  const outcome = page.locator(".clarify, .lstrip, .empty__err, .stage__err").first();
  await expect(outcome).toBeVisible({ timeout: 90_000 });
  const skip = page.getByRole("button", { name: "Skip — just plan it" });
  if (await skip.isVisible()) await skip.click();
}

/**
 * The inverse of planEvening: plan a prompt that SHOULD fail loud, assert
 * the fail-loud surface renders (and no itinerary strip behind it), and
 * return the message so the spec can pin its exact text.
 */
export async function planExpectingProblem(page: Page, prompt: string): Promise<string> {
  await page.goto("/");
  await page.locator(".prompt__input").fill(prompt);
  await page.locator(".prompt__go").click();

  // some failures only surface after the clarify step (e.g. an unmet
  // constraint on a prompt with no stated time) — skip through it
  await dismissClarifyIfShown(page);

  const err = page.locator(".empty__err, .stage__err").first();
  await expect(err, "expected the fail-loud surface").toBeVisible({ timeout: 30_000 });
  // the whole point: an honest message, never an empty map
  await expect(page.locator(".lstrip")).toHaveCount(0);
  return (await err.innerText()).trim();
}

/**
 * Drive the inline swap prompt on a stop card: select the card, type the
 * refinement, submit. The caller asserts the outcome (new venue card,
 * banner text) — this only performs the interaction.
 */
export async function swapOn(page: Page, venueName: string, refinement: string): Promise<void> {
  await stripCard(page, venueName).click();
  const input = page.locator(".lstrip__swapinput");
  await expect(input, `swap input under "${venueName}"`).toBeVisible();
  await input.fill(refinement);
  // The first swap in a fresh Next dev server cold-compiles the large engine
  // route. Wait for the mutation response itself so a page assertion does not
  // cancel that request halfway through compilation on slower CI machines.
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /\/api\/itinerary\/[^/]+\/swap$/.test(response.url()),
      { timeout: 45_000 }
    ),
    page.locator(".lstrip__swapgo").click(),
  ]);
}

/**
 * A `datetime-local` value on the PLAN's own day, at the given wall-clock
 * time — what the dev time-sim input takes, and the deterministic way to
 * drive stop statuses (and which leg is underway) instead of waiting for a
 * real clock. Dinner anchors 19:00 and rolls forward past 19:00, the same
 * rule `resolveStartTime` uses, so the plan's day is decided the same way
 * here. Assumes the browser's zone is the plan's, which is true of every
 * mock run (fixed Chestnut/Toronto coordinates).
 */
export function simAt(hour: number, minute = 0): string {
  const d = new Date();
  d.setHours(19, 0, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  d.setHours(hour, minute, 0, 0);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(hour)}:${p(minute)}`;
}

/** The strip card whose venue name contains `venueName`. */
export function stripCard(page: Page, venueName: string): Locator {
  return page.locator(".lstrip__stop", {
    has: page.locator(".lstrip__name", { hasText: venueName }),
  });
}

/** The map pin chip whose venue name contains `venueName`. */
export function mapPin(page: Page, venueName: string): Locator {
  return page.locator(".chip", {
    has: page.locator(".chip__name", { hasText: venueName }),
  });
}

// Effective start-time label of a card/pin. Both surfaces render the start
// through formatStopTime (date prefix included), so the labels must be
// string-identical. After a swap/reroute both show old struck + new settled
// times — the settled `.new-time` is the effective one on both sides.
async function startLabel(scope: Locator, kind: "strip" | "pin"): Promise<string> {
  const settled = scope.locator(".new-time");
  if ((await settled.count()) > 0) return (await settled.innerText()).trim();

  if (kind === "pin") return (await scope.locator(".chip__time").innerText()).trim();

  // strip: "be here 8:29 PM – 10:14 PM" (or "be here tomorrow, 8:29 PM – …")
  const text = (await scope.locator(".lstrip__be").innerText()).trim();
  const m = text.match(/^be here\s+(.+?)\s+–/);
  if (!m) throw new Error(`couldn't parse a start time from strip text "${text}"`);
  return m[1];
}

/**
 * Assert a stop's start time in the strip card matches its map pin.
 * Reuse this after every mutation (swap, reroute, time travel) — it's the
 * strip/map/store agreement check.
 */
export async function expectStripMatchesPin(page: Page, venueName: string): Promise<void> {
  const card = stripCard(page, venueName);
  const pin = mapPin(page, venueName);
  await expect(card, `strip card for "${venueName}"`).toBeVisible();
  await expect(pin, `map pin for "${venueName}"`).toBeVisible();

  const stripStart = await startLabel(card, "strip");
  const pinStart = await startLabel(pin, "pin");
  expect(pinStart, `map pin time for "${venueName}" desynced from its strip card`).toBe(stripStart);
}
