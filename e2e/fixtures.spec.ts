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

  // The leg's two SCHEDULER instants are named for what they are: you
  // LEAVE at the dwell end, you ARRIVE at the next stop's start. "board"
  // used to label the first of those, which is the wrong moment entirely.
  const transitLeg = page.locator('.lstrip__leg[aria-label="transit leg"]').first();
  await expect(transitLeg.locator(".lstrip__legtimes")).toContainText(/^leave .* · arrive /);

  // The fixture ride carries the provider's own board/alight times (it
  // publishes them through the REAL parser), so the leg can expand into
  // the four real instants. This proves the plumbing end to end — the
  // visual itself, and any leg with a TRANSFER, stays live-verify-only.
  const toggle = transitLeg.getByRole("button", { name: "board times" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  const rows = transitLeg.locator(".lstrip__tlrow");
  await expect(rows).toHaveCount(4); // leave → board → alight → arrive
  await expect(rows.nth(1)).toContainText("505 Fixture");
  await expect(transitLeg.locator(".lstrip__tlnote")).toContainText("scheduled");
  await transitLeg.getByRole("button", { name: "hide times" }).click();
  await expect(rows).toHaveCount(0);

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
