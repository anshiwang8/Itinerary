// Guards the fixture seam itself (@mock — excluded from live runs): in
// mock mode the pipeline must be deterministic, so the picks are known in
// advance. If this fails, either E2E_MOCK isn't reaching the server or a
// fixture drifted — fix that before trusting any scenario test.
import { test, expect } from "@playwright/test";
import { planEvening } from "./helpers";

test("mock pipeline is active and deterministic @mock", async ({ page }) => {
  await planEvening(page, "dinner and drinks");

  const names = (await page.locator(".lstrip__stop .lstrip__name").allInnerTexts()).map((n) =>
    n.trim()
  );
  // highest-rated fixture per category, every run
  expect(names).toEqual(["Velvet Fig", "Ten O'Clock Curfew"]);

  // the cross-town home leg is the deterministic fixture transit line
  await expect(page.locator(".lstrip__legline").first()).toContainText("505 Fixture");

  // ambient weather chip shows the canned forecast
  await expect(page.locator(".weather")).toContainText("20°");
});
