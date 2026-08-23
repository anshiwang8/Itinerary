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
export async function planEvening(
  page: Page,
  prompt: string,
  /** The landing travel-mode toggle. Omitted = leave it on its default,
   *  which is Transit — so every existing spec is byte-identical. */
  travelMode?: "transit" | "driving"
): Promise<void> {
  await page.goto("/");
  await page.locator(".prompt__input").fill(prompt);
  if (travelMode) {
    await page
      .getByRole("radio", { name: travelMode === "driving" ? "Drive" : "Transit" })
      .click();
  }
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

/** If the clarify QUESTIONS appear, click "Skip, just plan it" so the
 *  pipeline continues. Targeted by accessible name, not by class: the
 *  recovery panel's "Plan without it" shares .clarify__skip, and clicking
 *  THAT here would silently drop a stop mid-test. */
export async function dismissClarifyIfShown(page: Page): Promise<void> {
  const outcome = page.locator(".clarify, .lstrip, .empty__err, .stage__err").first();
  await expect(outcome).toBeVisible({ timeout: 90_000 });
  const skip = page.getByRole("button", { name: "Skip, just plan it" });
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
  // Via selectStop, and both halves of that matter. It clicks the card's own
  // SELECT BUTTON rather than the card box: `.lstrip` is a flex row, so every
  // card stretches to the tallest one, and a click at a stretched card's centre
  // can land below its button entirely — which selects nothing. And it WAITS
  // for the selection to stick, closing the auto-select race.
  //
  // The input is then scoped to THIS card. It used to be page-wide, which is
  // what made a mis-aimed click silently dangerous rather than merely useless:
  // with the intended card unselected, `.lstrip__swapinput` resolved to
  // whichever card WAS open and the refinement was typed into someone else's
  // swap box, so the test swapped a stop it never named and asserted against
  // the result.
  await selectStop(page, venueName);
  const input = stripCard(page, venueName).locator(".lstrip__swapinput");
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
    stripCard(page, venueName).locator(".lstrip__swapgo").click(),
  ]);
}

/**
 * Switch a LIVE plan's travel mode from the topbar and wait for the re-route.
 *
 * Waits for the mutation response itself, like `swapOn` and `removeOn`: the
 * first switch in a fresh Next dev server cold-compiles the route, and a page
 * assertion racing that can cancel the request mid-compilation.
 *
 * The buttons are found by ROLE and accessible name rather than by class,
 * because the labels go visually-hidden at narrow widths and the name is the
 * half that has to survive that.
 */
export async function switchMode(
  page: Page,
  mode: "transit" | "driving"
): Promise<void> {
  const option = page.getByRole("radio", {
    name: mode === "driving" ? "Drive" : "Transit",
  });
  await expect(option, `the ${mode} option in the topbar`).toBeVisible();
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /\/api\/itinerary\/[^/]+\/mode$/.test(response.url()),
      { timeout: 45_000 }
    ),
    option.click(),
  ]);
  await expect(option).toHaveAttribute("aria-checked", "true");
}

/**
 * Select a stop card, and wait for the selection to actually stick.
 *
 * THE RACE THIS CLOSES: the pipeline auto-selects the FIRST stop as one of its
 * last acts (`setSelected(ms[0].id)`), and that can land AFTER the strip is
 * already on screen and `planEvening` has returned. A click on any other card
 * in that gap is silently undone a moment later, and the symptom is not "the
 * wrong card is selected" — it is the card's inline controls never appearing,
 * which reads exactly like a missing feature. Waiting for the initial
 * selection first, then asserting the new one took, removes both.
 */
export async function selectStop(page: Page, venueName: string): Promise<void> {
  await expect(page.locator(".lstrip__stop--sel")).toHaveCount(1);
  const card = stripCard(page, venueName);
  await card.locator(".lstrip__select").click();
  await expect(card, `card for "${venueName}" selected`).toHaveClass(/lstrip__stop--sel/);
}

/**
 * Drive the inline remove control on a stop card through BOTH of its beats:
 * select the card, press Remove to arm it, then press Confirm. The caller
 * asserts the outcome — this only performs the interaction.
 *
 * The two presses are the point, so they are two steps here as well: a helper
 * that removed in one call would pass just as happily against a build that had
 * lost the arming step entirely.
 */
export async function removeOn(page: Page, venueName: string): Promise<void> {
  await selectStop(page, venueName);
  const card = stripCard(page, venueName);
  const arm = card.locator(".lstrip__removearm");
  await expect(arm, `remove control under "${venueName}"`).toBeVisible();
  await arm.click();

  const confirm = card.locator(".lstrip__removego");
  await expect(confirm, `armed confirm under "${venueName}"`).toBeVisible();
  // Wait for the mutation itself, as swapOn does: the first remove in a fresh
  // dev server cold-compiles the route, and a page assertion racing that can
  // cancel the request midway through compilation.
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /\/api\/itinerary\/[^/]+\/remove$/.test(response.url()),
      { timeout: 45_000 }
    ),
    confirm.click(),
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
