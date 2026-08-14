// Guards the fixture seam itself (@mock — excluded from live runs): in
// mock mode the pipeline must be deterministic, so the picks are known in
// advance. If this fails, either E2E_MOCK isn't reaching the server or a
// fixture drifted — fix that before trusting any scenario test.
import { test, expect } from "./test";
import { planEvening, simAt } from "./helpers";

test("mock pipeline is active and deterministic @mock", async ({ page }) => {
  await planEvening(page, "dinner and drinks");

  const names = (await page.locator(".lstrip__stop .lstrip__name").allInnerTexts()).map((n) =>
    n.trim()
  );
  // highest-rated fixture per category, every run
  expect(names).toEqual(["Velvet Fig", "Ten O'Clock Curfew"]);

  // The cross-town home leg is the deterministic fixture transit line, and
  // its identity is now a BADGE where the route is referenced plus the
  // place beside it: the circle says 505, the text says Fixture, and the
  // number is not spelled out a second time. The published name still
  // travels for a screen reader, which is why the line's own text (which
  // includes the sr-only span) still reads "505 Fixture".
  const homeLegLine = page.locator(".lstrip__legline").first();
  await expect(homeLegLine).toContainText("505 Fixture");
  await expect(homeLegLine.locator(".lstrip__bubble")).toHaveText("505");
  await expect(homeLegLine.locator(".lstrip__lineplace")).toHaveText("Fixture");
  // ...and the stack the badges came from is gone from every card
  await expect(page.locator(".lstrip__bubbles")).toHaveCount(0);

  // Park the clock well before the plan so the leg's visibility is decided
  // by the TAP alone: a leg whose window contains "now" shows its times
  // unasked, and the home leg's window is the half hour before the first
  // stop — which a real-clock run could sit inside.
  const clock = page.locator('.dev input[type="datetime-local"]');
  await clock.fill(simAt(12));

  // The leg's two SCHEDULER instants are named for what they are: you
  // LEAVE at the dwell end, you ARRIVE at the next stop's start. "board"
  // used to label the first of those, which is the wrong moment entirely.
  const transitLeg = page.locator('.lstrip__leg[aria-label="transit leg"]').first();
  await expect(transitLeg.locator(".lstrip__legtimes")).toContainText(/^leave .* · arrive /);
  // the time summary is the TOTAL and nothing else — no transfer count, no
  // buffer arithmetic the traveller cannot act on
  await expect(transitLeg.locator(".lstrip__legmeta")).toHaveText(/^\d+ min$/);

  // The fixture ride carries the provider's own board/alight times (it
  // publishes them through the REAL parser), so the leg can open into the
  // four real instants. This proves the plumbing end to end — the visual
  // itself, and any leg with a TRANSFER, stays live-verify-only.
  const legSelect = transitLeg.locator(".lstrip__legselect");
  const rows = transitLeg.locator(".lstrip__tlrow");
  await expect(legSelect).toHaveAttribute("aria-expanded", "false");
  await expect(rows).toHaveCount(0);
  await legSelect.click();
  await expect(rows).toHaveCount(4); // leave → board → alight → arrive
  await expect(rows.nth(1)).toContainText("505 Fixture");
  // the route's badge rides with the instant you get ON it, and only that
  // one: leave, alight and arrive are not places you board a route
  await expect(transitLeg.locator(".lstrip__tlrow .lstrip__bubble")).toHaveCount(1);
  await expect(transitLeg.locator(".lstrip__tlrow--board .lstrip__bubble")).toHaveText("505");
  await expect(transitLeg.locator(".lstrip__tlnote")).toContainText("scheduled");
  await legSelect.click();
  await expect(rows).toHaveCount(0);

  // ...and the OTHER half of the rule: the leg you are ON shows its times
  // with no tap at all. The home leg departs AT the plan's 19:00 anchor
  // (that is what "leave by" means) and any transit leg runs at least the
  // 8-minute floor plus its 5-minute margin, so five past is inside this
  // leg's window by construction — and the first stop is still upcoming.
  await clock.fill(simAt(19, 5));
  await expect(rows).toHaveCount(4);
  await expect(legSelect).toHaveAttribute("aria-expanded", "true");
  // back to a quiet hour and it closes again — nothing latched
  await clock.fill(simAt(12));
  await expect(rows).toHaveCount(0);

  // Google requires a caution for every displayed WALK route. It is
  // visible in each walking leg card and exposed as an accessible note.
  const walkingLegs = page.locator('.lstrip__leg[aria-label="walking leg"]');
  const walkingCount = await walkingLegs.count();
  expect(walkingCount).toBeGreaterThan(0);
  await expect(walkingLegs.locator(".lstrip__walkwarning")).toHaveCount(walkingCount);
  // a walk has no route, so it gets no badge — it keeps its mode glyph
  await expect(walkingLegs.locator(".lstrip__bubble")).toHaveCount(0);
  await expect(walkingLegs.first().locator(".lstrip__legicon")).toBeVisible();
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
