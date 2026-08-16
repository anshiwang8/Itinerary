// Removing a stop, end to end on the fixtures (@mock).
//
// NO NEW MOCK SEAM WAS NEEDED, and that is a fact about the design rather than
// a convenience: `removeStop` takes `SwapDeps` and builds them from swap's own
// `realDeps()`, so mock mode's existing `mockSwapDeps` already answers every
// question a removal asks (routes, availability, weather, and the search/select
// pair it only reaches when a downstream venue genuinely shuts). A removal that
// needed its own fixtures would have meant it was not reusing the cascade.
//
// WHAT THIS CANNOT PIN is the open-time clamp specifically. Firing it needs the
// gap to pull a stop back across its venue's opening hour, and whether that
// happens depends on where the plan's own anchor lands — most fixture venues
// open early (Sundown Scoops 12–21, Ten O'Clock Curfew 16–22), so on many runs
// nothing is clamped at all. Adding a late-opening fixture to force it would
// risk displacing picks other specs pin, the exact hazard e2e/README.md warns
// about. So the assertion here is the PROPERTY the clamp exists to protect —
// the surviving venues are unchanged — which holds whether or not the clamp
// fired. The clamp's own arithmetic is pinned exactly in removeStop.test.ts,
// with a revert-run proving the substitution it prevents.
import { test, expect } from "./test";
import {
  planEvening,
  selectStop,
  simAt,
  stripCard,
  removeOn,
  expectStripMatchesPin,
} from "./helpers";

// NOTE ON PROMPTS. None of these state a time, which is deliberate. A prompt
// like "…at 5pm" resolves to a window that has PASSED whenever the suite runs
// late enough, and past stops offer no edit control at all — so the spec would
// fail for the reason CLAUDE.md already documents for three scenario tests
// rather than for anything about removal. Unstated times anchor at the
// category default and roll forward, which is the pattern the swap specs use.
test("remove closes the gap: the later stop slides earlier and keeps its venue @mock", async ({
  page,
}) => {
  await planEvening(page, "dinner and drinks and dessert");
  const cards = page.locator(".lstrip__stop");
  await expect(cards).toHaveCount(3);

  // Read the plan as it actually landed rather than pinning venue names. The
  // third pick legitimately differs with the hour (a late evening adapts
  // dessert away from Sundown Scoops), and the property under test is not
  // WHICH venue is there — it is that removing one stop does not change it.
  const first = await cards.nth(0).locator(".lstrip__name").innerText();
  const middle = await cards.nth(1).locator(".lstrip__name").innerText();
  const last = await cards.nth(2).locator(".lstrip__name").innerText();
  const lastTimeBefore = await cards.nth(2).locator(".lstrip__be").innerText();

  await removeOn(page, middle);

  // gone from the strip AND from the map, not merely hidden
  await expect(page.locator(".lstrip__stop")).toHaveCount(2);
  await expect(stripCard(page, middle)).toHaveCount(0);
  await expect(
    page.locator(".chip", { has: page.locator(".chip__name", { hasText: middle }) })
  ).toHaveCount(0);

  // THE LOAD-BEARING ASSERTION: removing the middle stop changed the last
  // stop's TIME, never its VENUE. A substitution here is the clamp failing.
  const survivors = page.locator(".lstrip__stop");
  await expect(survivors.nth(0).locator(".lstrip__name")).toHaveText(first);
  await expect(survivors.nth(1).locator(".lstrip__name")).toHaveText(last);

  // the gap closed, and the reflow shows what the moved stop used to say
  const moved = stripCard(page, last);
  await expect(moved.locator(".lstrip__be")).not.toHaveText(lastTimeBefore);
  await expect(moved.locator(".old-time")).toBeVisible();
  await expect(moved.locator(".new-time")).toBeVisible();

  // strip/map/store agreement after the mutation
  await expectStripMatchesPin(page, first);
  await expectStripMatchesPin(page, last);
});

test("Keep disarms without removing, and so does Escape @mock", async ({ page }) => {
  await planEvening(page, "dinner and drinks");
  await selectStop(page, "Ten O'Clock Curfew");
  const card = stripCard(page, "Ten O'Clock Curfew");

  // ARM — the card takes the danger state and the question appears
  await card.locator(".lstrip__removearm").click();
  await expect(card.locator(".lstrip__removeask")).toBeVisible();
  await expect(card).toHaveClass(/lstrip__stop--arming/);
  // the SAFE option holds focus, so a stray Return never deletes anything
  await expect(card.locator(".lstrip__removekeep")).toBeFocused();

  // KEEP — back to the quiet control, stop untouched
  await card.locator(".lstrip__removekeep").click();
  await expect(card.locator(".lstrip__removeask")).toHaveCount(0);
  await expect(card).not.toHaveClass(/lstrip__stop--arming/);
  await expect(card.locator(".lstrip__removearm")).toBeVisible();

  // ESCAPE — the same step back, from the keyboard
  await card.locator(".lstrip__removearm").click();
  await expect(card.locator(".lstrip__removeask")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(card.locator(".lstrip__removeask")).toHaveCount(0);

  // nothing was ever sent: both stops are still here
  await expect(stripCard(page, "Ten O'Clock Curfew")).toBeVisible();
  await expect(stripCard(page, "Velvet Fig")).toBeVisible();
  await expectStripMatchesPin(page, "Ten O'Clock Curfew");
});

test("down to one is allowed; removing the last stop is REFUSED @mock", async ({ page }) => {
  await planEvening(page, "dinner and drinks");

  // Removing the LAST stop ends the day earlier. The dangling leg is the thing
  // to watch: the survivor must not be followed by a travel card to nothing.
  await removeOn(page, "Ten O'Clock Curfew");
  await expect(stripCard(page, "Ten O'Clock Curfew")).toHaveCount(0);
  await expect(stripCard(page, "Velvet Fig")).toBeVisible();
  // home leg in, and nothing out: one leg card in the whole strip
  await expect(page.locator(".lstrip__leg")).toHaveCount(1);
  await expectStripMatchesPin(page, "Velvet Fig");

  // ...and now the plan is down to one. Removing it would leave an empty
  // stops array, which reads as a COMPLETED outing — archived, unresumable.
  // It has to refuse, and say what to use instead.
  await removeOn(page, "Velvet Fig");
  const banner = page.locator(".banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(/only stop left/i);
  await expect(banner).toContainText(/End/);
  // the plan is untouched
  await expect(stripCard(page, "Velvet Fig")).toBeVisible();
  await expectStripMatchesPin(page, "Velvet Fig");
});

test("an ACTIVE stop offers no remove control at all @mock", async ({ page }) => {
  await planEvening(page, "dinner and drinks");
  // Drive the clock into the dinner stop, the same way the swap spec proves an
  // active stop can't be swapped. A past stop is history; deleting is an edit,
  // and the control simply is not there to press.
  await page.locator('.dev input[type="datetime-local"]').fill(simAt(20));

  const dinner = stripCard(page, "Velvet Fig");
  await expect(dinner.locator(".lstrip__now")).toBeVisible();
  await selectStop(page, "Velvet Fig");
  // card-scoped, not page-wide: a page-wide count would be satisfied by some
  // OTHER card's control and would pass against a build with no gate at all
  await expect(dinner.locator(".lstrip__removearm")).toHaveCount(0);

  // the upcoming drinks stop still offers it
  const drinks = stripCard(page, "Ten O'Clock Curfew");
  await selectStop(page, "Ten O'Clock Curfew");
  await expect(drinks.locator(".lstrip__removearm")).toBeVisible();
});
