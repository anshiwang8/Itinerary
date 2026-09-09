import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./test";
import { expectStripMatchesPin, planEvening, selectStop, stripCard, swapOn } from "./helpers";

const LONG_STOP_NAME = "The Extraordinary Neighbourhood Kitchen and Late Evening Gathering Place";
const LONG_PLAN = "dinner and drinks then dessert then coffee at 7pm";

/** Optional local visual QA, written only to the already-ignored output
 *  directory. Ordinary regression runs do not capture or alter animations. */
async function captureReview(page: Page, name: string): Promise<void> {
  if (process.env.UI_FIXTURE_REVIEW !== "1") return;
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: `test-results/ui-fixture-review/${name}.png`,
    fullPage: true,
    animations: "disabled",
  });
}

async function dismissMapWarning(page: Page): Promise<void> {
  const dismiss = page.getByRole("button", { name: "Dismiss map warning" });
  if (await dismiss.isVisible()) await dismiss.click();
}

/** Only a display label changes. IDs, times, routes and the real pipeline
 *  remain intact, giving the production sheet a realistic long venue name. */
async function useLongVenueLabel(page: Page): Promise<void> {
  await page.route(/\/api\/itinerary\/[^/?]+$/, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    if (Array.isArray(body.stops) && body.stops[0]) body.stops[0].name = LONG_STOP_NAME;
    await route.fulfill({ response, json: body });
  });
}

async function rect(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

async function expectVerticalJourney(page: Page): Promise<void> {
  const rows = await page.locator(".lstrip > [role='listitem']").evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { top: box.y, bottom: box.bottom, width: box.width };
    })
  );
  expect(rows.length).toBeGreaterThanOrEqual(5);
  for (let index = 0; index < rows.length; index += 1) {
    expect(rows[index].width, `journey row ${index + 1} has useful width`).toBeGreaterThan(150);
    if (index > 0) {
      expect(rows[index].top, `journey row ${index + 1} follows the previous row vertically`)
        .toBeGreaterThanOrEqual(rows[index - 1].bottom - 1);
    }
  }
  const widths = await page.locator(".itinerary-dock, .lstrip").evaluateAll((elements) =>
    elements.map((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }))
  );
  for (const width of widths) expect(width.scroll).toBeLessThanOrEqual(width.client + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(page.viewportSize()!.width + 1);
}

async function expectPointerTarget(control: Locator): Promise<void> {
  const target = await control.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return {
      width: box.width,
      height: box.height,
      hit: hit === element || (hit instanceof Node && element.contains(hit)),
    };
  });
  expect(target.width).toBeGreaterThanOrEqual(44);
  expect(target.height).toBeGreaterThanOrEqual(44);
  expect(target.hit, "the control should receive a pointer at its visible centre").toBe(true);
}

async function expectBoundedIcons(scope: Locator): Promise<void> {
  const sizes = await scope.locator("svg:visible").evaluateAll((icons) =>
    icons.map((icon) => {
      const box = icon.getBoundingClientRect();
      return { width: box.width, height: box.height };
    })
  );
  expect(sizes.length, "the content should actually include travel icons").toBeGreaterThan(0);
  for (const size of sizes) {
    expect(size.width).toBeGreaterThan(0);
    expect(size.height).toBeGreaterThan(0);
    expect(size.width, "travel icons must not take their intrinsic 300px SVG size").toBeLessThanOrEqual(32);
    expect(size.height).toBeLessThanOrEqual(32);
  }
}

/** Trusted Chromium touch input exercises browser scrolling and hit testing.
 *  This proves containment, not an iPhone's compositor or gesture feel. */
async function touchSwipe(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  holdMs = 0
): Promise<void> {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart", touchPoints: [{ ...from, id: 1 }],
    });
    if (holdMs > 0) await page.waitForTimeout(holdMs);
    for (let step = 1; step <= 10; step += 1) {
      const fraction = step / 10;
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{
          x: from.x + (to.x - from.x) * fraction,
          y: from.y + (to.y - from.y) * fraction,
          id: 1,
        }],
      });
      // A real gesture has elapsed time between samples; sending all moves
      // in one event-loop task would test a teleport, not browser panning.
      await page.waitForTimeout(16);
    }
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await session.detach();
  }
}

for (const width of [769, 1280, 1440]) {
  test(`desktop sidebar stays anchored and widens rightward at ${width}px @mock`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    if (width === 1440 && process.env.UI_FIXTURE_REVIEW === "1") {
      await page.goto("/");
      await captureReview(page, "desktop-landing");
    }
    await planEvening(page, "dinner and drinks at 7pm", undefined, { expandDesktop: false });
    await dismissMapWarning(page);
    await page.mouse.move(width - 80, 120);
    const dock = page.locator(".itinerary-dock");
    const summary = dock.locator(".itinerary-dock__summary");
    const strip = page.locator(".lstrip");
    const firstStop = stripCard(page, "Velvet Fig");
    await expect(summary).toHaveAttribute("aria-expanded", "false");
    await expect.poll(async () => (await rect(dock)).width).toBeCloseTo(288, 0);
    const compact = await rect(dock);
    expect(compact.x).toBeCloseTo(16, 0);
    expect(compact.y).toBeCloseTo(16, 0);
    expect(compact.height).toBeCloseTo(768, 0);
    await expect(strip).toBeVisible();
    await expect(firstStop).toHaveClass(/lstrip__stop--sel/);
    await expect(firstStop.locator(".lstrip__details")).not.toBeVisible();
    await expect(firstStop.locator(".lstrip__details")).toHaveAttribute("inert", "");
    await expect(firstStop.locator(".lstrip__desc")).toHaveCount(0);
    await expectVerticalJourney(page);

    const toolbar = page.locator(".topbar");
    await expect(toolbar).toHaveCount(1);
    await expect(dock.locator(".topbar")).toHaveCount(1);
    const toolbarBox = await rect(toolbar);
    expect(toolbarBox.x).toBeGreaterThanOrEqual(compact.x);
    expect(toolbarBox.x + toolbarBox.width).toBeLessThanOrEqual(compact.x + compact.width);
    expect(toolbarBox.y + toolbarBox.height).toBeLessThanOrEqual((await rect(summary)).y + 1);
    const controls = toolbar.locator("input, button");
    for (let index = 0; index < await controls.count(); index += 1) {
      await expectPointerTarget(controls.nth(index));
    }
    await expectPointerTarget(page.locator(".mapctl--fit"));
    await expectPointerTarget(page.locator(".mapctl--live"));
    const mapBefore = await rect(page.locator(".mapwrap"));
    expect(mapBefore.x).toBeCloseTo(320, 0);
    expect(mapBefore.width).toBeCloseTo(width - 320, 0);
    if (width === 1440) await captureReview(page, "desktop-compact");

    await summary.hover();
    await expect(summary).toHaveAttribute("aria-expanded", "true");
    await expect.poll(async () => (await rect(dock)).width).toBeCloseTo(420, 0);
    const expanded = await rect(dock);
    expect(expanded.x).toBeCloseTo(compact.x, 0);
    expect(expanded.y).toBeCloseTo(compact.y, 0);
    expect(expanded.height).toBeCloseTo(compact.height, 0);
    expect(await rect(page.locator(".mapwrap"))).toEqual(mapBefore);
    await expectVerticalJourney(page);
    await expect(firstStop.locator(".lstrip__details")).toBeVisible();
    if (width === 1440) await captureReview(page, "desktop-expanded");
    await page.mouse.move(width - 80, 120);
    await expect(summary).toHaveAttribute("aria-expanded", "false");

    await summary.focus();
    await expect(summary).toHaveAttribute("aria-expanded", "true");
    await page.locator(".mapctl--fit").focus();
    await expect(summary).toHaveAttribute("aria-expanded", "false");
    await summary.click();
    await page.locator(".mapctl--fit").click();
    // An explicit pin survives the delayed close used by ordinary hover/blur.
    await page.waitForTimeout(250);
    await expect(summary).toHaveAttribute("aria-expanded", "true");
    await summary.press("Escape");
    await expect(summary).toHaveAttribute("aria-expanded", "false");
    await expect(summary).toBeFocused();
    await summary.press("Tab");
    await expect(summary).toHaveAttribute("aria-expanded", "true");
    expect(await strip.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(summary).toHaveAttribute("aria-expanded", "false");
    await expect(summary).toBeFocused();
    await summary.press("Shift+Tab");
    await expect(summary).toHaveAttribute("aria-expanded", "true");
    expect(await toolbar.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await expect(strip).toBeVisible();
  });
}

test("desktop editing survives pointer exit and a successful swap stays synchronized @mock", async ({ page }) => {
  await planEvening(page, "dinner and drinks at 7pm");
  await selectStop(page, "Velvet Fig");
  const draft = stripCard(page, "Velvet Fig").locator(".lstrip__swapinput");
  await draft.fill("somewhere quieter");
  await page.mouse.move(page.viewportSize()!.width - 80, 120);
  await page.locator(".mapctl--fit").focus();
  await expect(page.locator(".itinerary-dock")).toHaveAttribute("data-held-open", "true");
  await expect(draft).toBeVisible();
  await expect(draft).toHaveValue("somewhere quieter");
  await page.keyboard.press("Escape");
  await expect(draft).toHaveValue("somewhere quieter");

  await swapOn(page, "Velvet Fig", "cheaper");
  await expect(stripCard(page, "The Corner Table")).toBeVisible();
  await expectStripMatchesPin(page, "The Corner Table");
});

test("desktop sidebar scrolls its vertical journey while its controls stay reachable @mock", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await useLongVenueLabel(page);
  await planEvening(page, LONG_PLAN);
  await dismissMapWarning(page);
  const dock = page.locator(".itinerary-dock");
  const strip = page.locator(".lstrip");
  await expect.poll(async () => (await rect(dock)).width).toBeCloseTo(420, 0);
  await expectVerticalJourney(page);
  expect(await strip.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(200);
  const toolbarBefore = await rect(page.locator(".topbar"));
  const mapBefore = await rect(page.locator(".mapwrap"));
  const stripBox = await rect(strip);
  await page.mouse.move(stripBox.x + stripBox.width / 2, stripBox.y + stripBox.height / 2);
  await page.mouse.wheel(0, 700);
  await expect.poll(() => strip.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
  expect(await rect(page.locator(".topbar"))).toEqual(toolbarBefore);
  expect(await rect(page.locator(".mapwrap"))).toEqual(mapBefore);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  const lastCard = strip.locator(".lstrip__stop").last();
  await lastCard.locator(".lstrip__select").click();
  await expect(lastCard).toHaveClass(/lstrip__stop--sel/);
  const remove = lastCard.locator(".lstrip__removearm");
  await remove.scrollIntoViewIfNeeded();
  await expectPointerTarget(remove);
  await expectPointerTarget(page.locator(".topbar__go"));
  await expectPointerTarget(page.locator(".topbar__stop"));
  await expectPointerTarget(page.locator(".mapctl--fit"));
  await expectVerticalJourney(page);
});

test.describe("mobile itinerary controls", () => {
  test.use({ hasTouch: true, isMobile: true });

  for (const width of [320, 390, 768]) {
    test(`sheet has explicit states, wrapped names and bounded travel icons at ${width}px @mock`, async ({ page }) => {
      await page.setViewportSize({ width, height: 740 });
      await useLongVenueLabel(page);
      await planEvening(page, LONG_PLAN);
      const sheet = page.locator(".msheet");
      const handle = sheet.locator(".msheet__draghandle");
      await expect(page.locator(".itinerary-dock__summary")).not.toBeVisible();
      await expect(page.locator(".lstrip")).not.toBeVisible();
      await expect(page.locator(".topbar")).toBeVisible();
      await expect(sheet).toHaveAttribute("data-state", "peek");
      await expect(handle).toHaveRole("button");
      await expect(handle).toHaveAccessibleName("Expand itinerary");
      await handle.click();
      await expect(sheet).toHaveAttribute("data-state", "half");
      await expectBoundedIcons(sheet.locator(".msheet__half"));
      const name = sheet.locator(".msheet__pagename", { hasText: LONG_STOP_NAME });
      await expect(name).toHaveText(LONG_STOP_NAME);
      const textLayout = await name.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          height: element.getBoundingClientRect().height,
          lineHeight: Number.parseFloat(style.lineHeight),
          clipped: element.scrollWidth > element.clientWidth + 1,
        };
      });
      expect(textLayout.height, "long venue names should wrap onto multiple lines").toBeGreaterThan(textLayout.lineHeight * 1.5);
      expect(textLayout.clipped, "a long venue name must not overflow horizontally").toBe(false);
      await handle.click();
      await expect(sheet).toHaveAttribute("data-state", "full");
      await expect(handle).toHaveAccessibleName("Collapse itinerary");
      await expectBoundedIcons(sheet.locator(".msheet__full"));
      const topbar = await rect(page.locator(".topbar"));
      const full = await rect(sheet);
      expect(full.y, "the full sheet must leave the toolbar reachable").toBeGreaterThanOrEqual(topbar.y + topbar.height - 1);
      await handle.click();
      await expect(sheet).toHaveAttribute("data-state", "half");
      await handle.press("Home");
      await expect(sheet).toHaveAttribute("data-state", "peek");
    });
  }

  test("holding and dragging a map pin cannot scroll the toolbar away @mock", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 740 });
    await planEvening(page, "dinner and drinks at 7pm");
    await dismissMapWarning(page);
    const topbar = page.locator(".topbar");
    const before = await rect(topbar);
    const chip = await rect(page.locator(".chip").first());
    const from = { x: chip.x + chip.width / 2, y: chip.y + chip.height / 2 };
    await touchSwipe(page, from, { x: from.x, y: Math.max(before.y + before.height + 12, from.y - 180) }, 300);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    const after = await rect(topbar);
    expect(after.y).toBeCloseTo(before.y, 0);
    expect(after.x).toBeCloseTo(before.x, 0);
    const pageSize = await page.evaluate(() => ({
      scroll: document.documentElement.scrollHeight,
      visible: window.innerHeight,
    }));
    expect(pageSize.scroll).toBeLessThanOrEqual(pageSize.visible + 1);
    await expect(page.locator(".msheet")).toHaveAttribute("data-state", "peek");
    if (process.env.UI_FIXTURE_REVIEW === "1") {
      await captureReview(page, "mobile-peek-390");
      const handle = page.locator(".msheet__draghandle");
      await handle.click();
      await expect(page.locator(".msheet")).toHaveAttribute("data-state", "half");
      await captureReview(page, "mobile-half-390");
      await handle.click();
      await expect(page.locator(".msheet")).toHaveAttribute("data-state", "full");
      await captureReview(page, "mobile-full-390");
    }
  });

  test("short landscape half summaries keep full details reachable without vertical scrolling @mock", async ({ page }) => {
    await page.setViewportSize({ width: 740, height: 390 });
    await useLongVenueLabel(page);
    await planEvening(page, "dinner and drinks at 7pm");
    await dismissMapWarning(page);
    const sheet = page.locator(".msheet");
    const handle = sheet.locator(".msheet__draghandle");
    await handle.click();
    await expect(sheet).toHaveAttribute("data-state", "half");
    const track = sheet.locator(".msheet__track");
    const card = track.locator(".msheet__page", { hasText: LONG_STOP_NAME });
    await card.evaluate((element) => {
      const scroller = element.closest(".msheet__track")!;
      const cardBox = element.getBoundingClientRect();
      const trackBox = scroller.getBoundingClientRect();
      scroller.scrollTo({
        left: scroller.scrollLeft + cardBox.x - trackBox.x - (trackBox.width - cardBox.width) / 2,
        top: 0,
        behavior: "instant",
      });
    });
    const overflow = await track.evaluate((element) => element.scrollHeight - element.clientHeight);
    expect(overflow, "half summaries must not create a second vertical scroller").toBeLessThanOrEqual(1);
    const details = card.locator(".msheet__details");
    await expectPointerTarget(details);
    const viewport = await rect(track);
    const detailsBox = await rect(details);
    expect(detailsBox.y).toBeGreaterThanOrEqual(viewport.y - 1);
    expect(detailsBox.y + detailsBox.height).toBeLessThanOrEqual(viewport.y + viewport.height + 1);
    await touchSwipe(
      page,
      { x: viewport.x + viewport.width / 2, y: viewport.y + viewport.height - 10 },
      { x: viewport.x + viewport.width / 2, y: viewport.y + 10 }
    );
    expect(await track.evaluate((element) => element.scrollTop)).toBe(0);
    await expect(sheet).toHaveAttribute("data-state", "half");
    await expect(sheet).toHaveAttribute("data-dragging", "false");
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await details.click();
    await expect(sheet).toHaveAttribute("data-state", "full");
    const row = sheet.locator(".msheet__row", { hasText: LONG_STOP_NAME });
    await row.scrollIntoViewIfNeeded();
    await expect(row.locator(".msheet__rowname")).toHaveText(LONG_STOP_NAME);
    await expect(row.locator(".msheet__facts")).toBeVisible();
  });

  test("full list scrolls independently and both sheet panes retain their position @mock", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 640 });
    await useLongVenueLabel(page);
    await planEvening(page, LONG_PLAN);
    const sheet = page.locator(".msheet");
    const handle = sheet.locator(".msheet__draghandle");
    await handle.click();
    await expect(sheet).toHaveAttribute("data-state", "half");
    const track = sheet.locator(".msheet__track");
    await track.evaluate((element) => element.scrollTo({ left: element.scrollWidth / 2, behavior: "instant" }));
    await expect.poll(() => track.evaluate((element) => element.scrollLeft)).toBeGreaterThan(100);
    const trackPosition = await track.evaluate((element) => element.scrollLeft);
    await sheet.locator(".msheet__view").click();
    await expect(sheet).toHaveAttribute("data-state", "full");
    const list = sheet.locator(".msheet__full");
    const listBox = await rect(list);
    await touchSwipe(
      page,
      { x: listBox.x + listBox.width / 2, y: listBox.y + listBox.height - 30 },
      { x: listBox.x + listBox.width / 2, y: listBox.y + 35 }
    );
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(50);
    // Stop inertial scrolling at an exact native offset before hiding the
    // pane, so preservation is compared to a settled position.
    await list.evaluate((element) => element.scrollTo({ top: 120, behavior: "instant" }));
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeCloseTo(120, 0);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await sheet.locator(".msheet__view").click();
    await expect(sheet).toHaveAttribute("data-state", "half");
    expect(await track.evaluate((element) => element.scrollLeft)).toBeCloseTo(trackPosition, 0);
    await sheet.locator(".msheet__view").click();
    await expect(sheet).toHaveAttribute("data-state", "full");
    expect(await list.evaluate((element) => element.scrollTop)).toBeCloseTo(120, 0);
  });

  test("an unrelated touch ending cannot cancel the active handle drag @mock", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 740 });
    await planEvening(page, "dinner and drinks at 7pm");
    const sheet = page.locator(".msheet");
    const handle = sheet.locator(".msheet__draghandle");
    // Native listeners receive controlled touch identifiers. This is a
    // binding/lifecycle regression, not a claim about device drag physics.
    await handle.evaluate((element) => {
      const active = new Touch({ identifier: 11, target: element, clientX: 180, clientY: 680 });
      element.dispatchEvent(new TouchEvent("touchstart", {
        bubbles: true, touches: [active], changedTouches: [active],
      }));
    });
    await expect(sheet).toHaveAttribute("data-dragging", "true");
    await handle.evaluate((element) => {
      const active = new Touch({ identifier: 11, target: element, clientX: 180, clientY: 680 });
      const other = new Touch({ identifier: 22, target: element, clientX: 220, clientY: 680 });
      element.dispatchEvent(new TouchEvent("touchend", {
        bubbles: true, touches: [active], changedTouches: [other],
      }));
    });
    await expect(sheet).toHaveAttribute("data-dragging", "true");
    await handle.evaluate((element) => {
      const active = new Touch({ identifier: 11, target: element, clientX: 180, clientY: 680 });
      element.dispatchEvent(new TouchEvent("touchcancel", {
        bubbles: true, touches: [], changedTouches: [active],
      }));
    });
    await expect(sheet).toHaveAttribute("data-dragging", "false");
    await expect(sheet).toHaveAttribute("data-state", "peek");
  });
});
