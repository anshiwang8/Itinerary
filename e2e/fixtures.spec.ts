// Guards the fixture seam itself (@mock — excluded from live runs): in
// mock mode the pipeline must be deterministic, so the picks are known in
// advance. If this fails, either E2E_MOCK isn't reaching the server or a
// fixture drifted — fix that before trusting any scenario test.
import { test, expect } from "./test";
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

  // Google requires a caution for every displayed WALK route. It is
  // visible in each walking leg card and exposed as an accessible note.
  const walkingLegs = page.locator('.lstrip__leg[aria-label="walking leg"]');
  const walkingCount = await walkingLegs.count();
  expect(walkingCount).toBeGreaterThan(0);
  await expect(walkingLegs.locator(".lstrip__walkwarning")).toHaveCount(walkingCount);
  for (let i = 0; i < walkingCount; i++) {
    const warning = walkingLegs
      .nth(i)
      .getByRole("note", { name: /^Walking route caution:/ });
    await expect(warning).toBeVisible();
    await expect(warning).toContainText(
      /walking routes are in beta.*sidewalks or pedestrian paths.*use caution/i
    );
  }
  const warningPresentation = await walkingLegs
    .first()
    .locator(".lstrip__walkwarning")
    .evaluate((element) => {
      const warningStyle = getComputedStyle(element);
      const strip = element.closest(".lstrip");
      return {
        fontSize: Number.parseFloat(warningStyle.fontSize),
        color: warningStyle.color,
        stripOpacity: strip ? getComputedStyle(strip).opacity : "missing",
      };
    });
  expect(warningPresentation.fontSize).toBeGreaterThanOrEqual(11);
  expect(warningPresentation.color).not.toBe("rgba(0, 0, 0, 0)");
  expect(warningPresentation.stripOpacity).toBe("1");

  // ambient weather chip shows the canned forecast
  await expect(page.locator(".weather")).toContainText("20°");
});
