// The transient success/info banner auto-dismisses on its own; a refusal or
// error banner does not — it holds until the next action, because a user who
// just hit a wall needs to be able to read why. `bannerDismiss.test.ts`
// proves the timer/cleanup arithmetic in isolation; this is the one thing
// only the real component wiring can prove — that a REFUSAL never arms the
// timer in the first place.
//
// Both tests reuse remove's own success/refusal paths from remove.spec.ts
// rather than inventing a new trigger, since they are already the
// well-exercised way to get one banner of each kind deterministically.
import { test, expect } from "./test";
import { planEvening, removeOn, stripCard, expectStripMatchesPin } from "./helpers";

test("a success banner disappears on its own @mock", async ({ page }) => {
  await planEvening(page, "dinner and drinks");
  // Removing one of two stops succeeds outright (the survivor is not the
  // plan's last stop), which banners "Removed <venue>...".
  await removeOn(page, "Ten O'Clock Curfew");
  const banner = page.locator(".banner--show");
  await expect(banner).toBeVisible();
  await expect(banner).not.toHaveClass(/banner--flat/);
  await expect(banner).toContainText(/^Removed/);
  // ~7s visible + a ~300ms fade. Poll for the element to disappear rather
  // than asserting after a fixed sleep, so this only flakes if the timer
  // itself is broken, never on ordinary scheduling jitter.
  await expect(banner).toHaveCount(0, { timeout: 9_000 });
});

test("a refusal banner stays until the next action @mock", async ({ page }) => {
  await planEvening(page, "dinner and drinks");
  await removeOn(page, "Ten O'Clock Curfew");
  // Let the first removal's own success banner and reflow settle (mirroring
  // remove.spec.ts's "down to one" scenario) before firing a second mutation
  // — a fresh dev server is still lazily compiling routes/pages the first
  // time each spec touches them, and racing that is a harness quirk, not
  // something this feature should paper over.
  await expect(stripCard(page, "Ten O'Clock Curfew")).toHaveCount(0);
  await expect(stripCard(page, "Velvet Fig")).toBeVisible();
  await expectStripMatchesPin(page, "Velvet Fig");
  // Now the plan is down to one stop. Removing it is refused: deleting the
  // last stop would leave an empty itinerary, which reads as completed.
  await removeOn(page, "Velvet Fig");
  const banner = page.locator(".banner--show");
  await expect(banner).toBeVisible();
  await expect(banner).toHaveClass(/banner--flat/);
  await expect(banner).toContainText(/only stop left/i);
  // If this were also auto-dismissing it would be long gone by now — the
  // success case above proves ~7-8s is enough for that to have happened.
  await page.waitForTimeout(8_000);
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(/only stop left/i);
});
