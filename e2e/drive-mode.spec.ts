// Drive-vs-transit mode, Stage 1, end to end on the fixtures (@mock).
//
// WHAT THE FIXTURE GEOGRAPHY MAKES THIS PROVE, and it is the right thing:
// every fixture venue sits on the Ossington strip, ~200-400 m apart, while
// home (Chestnut) is ~2.8 km away. So a DRIVING plan here is exactly the
// shape the invariant describes — the HOME leg is a real drive and the
// inter-stop hops fall under DRIVING_SHORT_LEG_WALK_METERS and relabel to
// WALK. `travelMode: "driving"` is a plan-level INTENT, never a per-leg
// promise, and this spec pins both halves on screen.
//
// The critical case is the last two: a swap and a removal re-price the home
// leg, and it has to come back a DRIVE. That is the whole reason the mode is
// stored on the itinerary rather than held in the browser.
//
// NO NEW MOCK SEAM was added for the toggle itself — the mode threads through
// the existing travel/swap/reroute fixtures. What DID have to change is
// `mockLeg`, which now takes the plan mode: without that a driving e2e would
// pass while every fixture leg was silently routed as transit.
import { expect, test } from "./test";
import {
  planEvening,
  removeOn,
  stripCard,
  swapOn,
  expectStripMatchesPin,
} from "./helpers";

/** The leg card leaving home — the one fixture leg long enough to be a drive. */
const homeLeg = (page: import("@playwright/test").Page) =>
  page.locator(".lstrip__leg").first();

test("@mock the Drive toggle builds a driving plan: the home leg is a Drive", async ({
  page,
}) => {
  await planEvening(page, "dinner and drinks tonight", "driving");

  const leg = homeLeg(page);
  await expect(leg).toHaveAttribute("aria-label", "driving leg");
  await expect(leg.locator(".lstrip__legline")).toHaveText("Drive");
  // Drive time plus the labelled DRIVING_MARGIN_MIN park/approach allowance.
  await expect(leg.locator(".lstrip__legmeta")).toContainText("min");
  // Never the walk arm: a driving leg must not carry the pedestrian caution.
  await expect(leg.locator(".lstrip__walkwarning")).toHaveCount(0);
  // Never the transit arm: no route badges on a road.
  await expect(leg.locator(".lstrip__bubble")).toHaveCount(0);

  // THE INVARIANT, on screen: the short strip-to-strip hops are WALKS inside
  // a driving plan, and that reads correctly rather than as a bug.
  await expect(page.locator('[aria-label="walking leg"]').first()).toBeVisible();
});

test("@mock the default is Transit, and a transit plan is unchanged", async ({ page }) => {
  await planEvening(page, "dinner and drinks tonight");

  // The toggle's own state: Transit selected, Drive not.
  await page.goto("/");
  await expect(page.getByRole("radio", { name: "Transit" })).toHaveAttribute(
    "aria-checked",
    "true"
  );
  await expect(page.getByRole("radio", { name: "Drive" })).toHaveAttribute(
    "aria-checked",
    "false"
  );

  await planEvening(page, "dinner and drinks tonight");
  const leg = homeLeg(page);
  await expect(leg).toHaveAttribute("aria-label", "transit leg");
  await expect(leg.locator(".lstrip__legline")).not.toHaveText("Drive");
});

test("@mock a driving leg is selectable and reports its pressed state", async ({ page }) => {
  await planEvening(page, "dinner and drinks tonight", "driving");

  const button = homeLeg(page).locator("button.lstrip__legselect");
  await expect(button).toHaveCount(1);
  await expect(button).toHaveAttribute("aria-pressed", "false");
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  // Nothing to expand — a driving leg publishes no board/alight timeline.
  await expect(homeLeg(page).locator(".lstrip__timeline")).toHaveCount(0);
});

test("@mock swapping a stop on a DRIVING plan keeps the new leg DRIVING", async ({
  page,
}) => {
  await planEvening(page, "dinner and drinks tonight", "driving");

  // The first stop, so the swap re-prices the HOME leg — the one leg in this
  // fixture geography whose mode is actually discriminating.
  const cards = page.locator(".lstrip__stop");
  const firstName = (await cards.nth(0).locator(".lstrip__name").innerText()).trim();
  await swapOn(page, firstName, "somewhere else");

  const leg = homeLeg(page);
  await expect(leg).toHaveAttribute("aria-label", "driving leg");
  await expect(leg.locator(".lstrip__legline")).toHaveText("Drive");
  await expect(leg.locator(".lstrip__walkwarning")).toHaveCount(0);

  await expect(stripCard(page, firstName)).toHaveCount(0);
  const swapped = (await cards.nth(0).locator(".lstrip__name").innerText()).trim();
  await expectStripMatchesPin(page, swapped);
});

test("@mock removing a stop on a DRIVING plan keeps the bridging leg DRIVING", async ({
  page,
}) => {
  await planEvening(page, "dinner and drinks tonight", "driving");

  const cards = page.locator(".lstrip__stop");
  await expect(cards).toHaveCount(2);
  // Remove the FIRST venue, so the HOME leg is the one rebuilt — in this
  // fixture geography it is the only leg long enough for the mode to show.
  const first = (await cards.nth(0).locator(".lstrip__name").innerText()).trim();
  await removeOn(page, first);
  // the splice has landed before anything is read off the settled strip
  await expect(cards).toHaveCount(1);
  await expect(stripCard(page, first)).toHaveCount(0);

  const leg = homeLeg(page);
  await expect(leg).toHaveAttribute("aria-label", "driving leg");
  await expect(leg.locator(".lstrip__legline")).toHaveText("Drive");
  await expect(leg.locator(".lstrip__walkwarning")).toHaveCount(0);

  const remaining = (await cards.nth(0).locator(".lstrip__name").innerText()).trim();
  await expectStripMatchesPin(page, remaining);
});
