// Harness smoke test — proves Playwright can drive the real pipeline end
// to end and that the strip/map desync helper works. Feature scenarios
// come later; this is deliberately the only spec for now.
// Run: npm run test:e2e (headless) · npm run test:e2e:headed (headed)
import { test, expect } from "@playwright/test";
import { planEvening, expectStripMatchesPin } from "./helpers";

test("plans 'dinner and drinks' into two stops; strip and map pins agree", async ({ page }) => {
  await planEvening(page, "dinner and drinks");

  // two venue cards in the strip…
  const cards = page.locator(".lstrip__stop");
  await expect(cards).toHaveCount(2);

  // …each with a real venue name and a time range
  const names = (await page.locator(".lstrip__stop .lstrip__name").allInnerTexts()).map((n) =>
    n.trim()
  );
  expect(names).toHaveLength(2);
  for (const name of names) expect(name.length, "venue name should not be empty").toBeGreaterThan(0);
  await expect(cards.nth(0).locator(".lstrip__be")).toContainText(/\d{1,2}:\d{2} (AM|PM)/);
  await expect(cards.nth(1).locator(".lstrip__be")).toContainText(/\d{1,2}:\d{2} (AM|PM)/);

  // the desync check: every stop's strip time matches its map pin
  for (const name of names) {
    await expectStripMatchesPin(page, name);
  }
});
