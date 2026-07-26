import type { Locator, Page, TestInfo } from "@playwright/test";
import { expect, test } from "./test";
import { planEvening } from "./helpers";

const VIEWPORT_WIDTHS = [320, 375, 390, 768] as const;
const VIEWPORT_HEIGHT = 900;
const MIN_TARGET_PX = 44;
const MIN_USEFUL_INPUT_WIDTH_PX = 88;
const EDGE_TOLERANCE_PX = 1;

type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
};

async function rect(locator: Locator): Promise<Rect> {
  const box = await locator.boundingBox();
  expect(box, "expected a rendered bounding box").not.toBeNull();
  return {
    x: box!.x,
    y: box!.y,
    width: box!.width,
    height: box!.height,
    right: box!.x + box!.width,
    bottom: box!.y + box!.height,
  };
}

function intersectionArea(a: Rect, b: Rect): number {
  const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y));
  return width * height;
}

async function expectTargetSize(locator: Locator, label: string): Promise<Rect> {
  const box = await rect(locator);
  expect(box.width, `${label} width`).toBeGreaterThanOrEqual(MIN_TARGET_PX);
  expect(box.height, `${label} height`).toBeGreaterThanOrEqual(MIN_TARGET_PX);
  return box;
}

async function expectCenterHitsControl(locator: Locator, label: string): Promise<void> {
  const hitResult = await locator.evaluate((control) => {
    const box = control.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return {
      receivesHit:
        hit === control || (hit instanceof Node && control.contains(hit)),
      hit:
        hit instanceof HTMLElement
          ? `${hit.tagName.toLowerCase()}.${hit.className} "${
              hit.getAttribute("aria-label") ??
              hit.textContent?.replace(/\s+/g, " ").trim() ??
              ""
            }"`
          : String(hit),
    };
  });
  expect(
    hitResult.receivesHit,
    `${label} should receive a pointer hit at its visual centre; hit ${hitResult.hit}`
  ).toBe(true);
}

async function attachScreenshot(
  page: Page,
  testInfo: TestInfo,
  name: string
): Promise<void> {
  await testInfo.attach(name, {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
}

async function expectWithinViewport(
  locator: Locator,
  viewport: { width: number; height: number },
  label: string
): Promise<void> {
  const box = await rect(locator);
  expect(box.x, `${label} left edge`).toBeGreaterThanOrEqual(-EDGE_TOLERANCE_PX);
  expect(box.y, `${label} top edge`).toBeGreaterThanOrEqual(-EDGE_TOLERANCE_PX);
  expect(box.right, `${label} right edge`).toBeLessThanOrEqual(
    viewport.width + EDGE_TOLERANCE_PX
  );
  expect(box.bottom, `${label} bottom edge`).toBeLessThanOrEqual(
    viewport.height + EDGE_TOLERANCE_PX
  );
}

for (const width of VIEWPORT_WIDTHS) {
  test(`mobile layout keeps controls usable at ${width}px @mock`, async ({
    page,
  }, testInfo) => {
    const viewport = { width, height: VIEWPORT_HEIGHT };
    await page.setViewportSize(viewport);
    await page.goto("/");

    const search = page.locator("#q-search");
    const city = page.locator("#q-city");
    const address = page.locator("#q-start");
    const inputs = [
      { locator: search, label: "outing prompt", value: "Ramen, then a quiet cocktail bar near Ossington" },
      { locator: city, label: "city", value: "Toronto, Ontario" },
      { locator: address, label: "starting address", value: "89 Chestnut Street, Toronto" },
    ];

    for (const input of inputs) {
      await expect(input.locator, input.label).toBeVisible();
      await expect(input.locator, input.label).toBeEditable();
      await input.locator.fill(input.value);
      await expect(input.locator, input.label).toHaveValue(input.value);

      const box = await expectTargetSize(input.locator, input.label);
      expect(box.width, `${input.label} should have useful editing width`).toBeGreaterThanOrEqual(
        MIN_USEFUL_INPUT_WIDTH_PX
      );
      await expectCenterHitsControl(input.locator, input.label);
    }

    const inputRects = await Promise.all(inputs.map((input) => rect(input.locator)));
    for (let left = 0; left < inputRects.length; left += 1) {
      for (let right = left + 1; right < inputRects.length; right += 1) {
        expect(
          intersectionArea(inputRects[left], inputRects[right]),
          `${inputs[left].label} and ${inputs[right].label} must not overlap`
        ).toBeLessThanOrEqual(EDGE_TOLERANCE_PX);
      }
    }

    if (width <= 390) {
      expect(
        inputRects[1].y,
        "city should be arranged below the outing prompt at narrow widths"
      ).toBeGreaterThanOrEqual(inputRects[0].bottom);
      expect(
        inputRects[2].y,
        "starting address should be arranged below the city at narrow widths"
      ).toBeGreaterThanOrEqual(inputRects[1].bottom);

      const dividerGeometry = await page.locator(".prompt__sec").nth(1).evaluate((section) => {
        const style = getComputedStyle(section, "::before");
        return {
          width: Number.parseFloat(style.width),
          height: Number.parseFloat(style.height),
          sectionWidth: section.getBoundingClientRect().width,
        };
      });
      expect(dividerGeometry.width, "narrow divider should span the section").toBeGreaterThan(
        dividerGeometry.sectionWidth * 0.6
      );
      expect(dividerGeometry.height, "narrow divider should be horizontal").toBeLessThanOrEqual(2);
      expect(dividerGeometry.width, "narrow divider should be horizontal").toBeGreaterThan(
        dividerGeometry.height * 20
      );
    } else {
      expect(inputRects[0].right, "outing prompt should precede city in the tablet row")
        .toBeLessThanOrEqual(inputRects[1].x + EDGE_TOLERANCE_PX);
      expect(inputRects[1].right, "city should precede address in the tablet row")
        .toBeLessThanOrEqual(inputRects[2].x + EDGE_TOLERANCE_PX);
      const inputTops = inputRects.map((box) => box.y);
      expect(
        Math.max(...inputTops) - Math.min(...inputTops),
        "tablet-row inputs should remain vertically aligned"
      ).toBeLessThanOrEqual(4);
    }

    await attachScreenshot(page, testInfo, `mobile-empty-${width}px`);

    // Start from the normal deterministic mock defaults for the stage checks.
    // planEvening performs a fresh navigation, preserving this viewport.
    await planEvening(page, "dinner and drinks at 7pm");

    const pageWidth = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(
      pageWidth.scroll,
      "the page itself must not hide or introduce horizontal overflow"
    ).toBeLessThanOrEqual(pageWidth.client + EDGE_TOLERANCE_PX);

    const topbar = page.locator(".topbar");
    const weather = page.locator(".weather");
    await expect(topbar).toBeVisible();
    await expect(weather).toBeVisible();
    expect(
      intersectionArea(await rect(topbar), await rect(weather)),
      "weather and the primary replan bar must not overlap"
    ).toBeLessThanOrEqual(EDGE_TOLERANCE_PX);

    const strip = page.locator(".lstrip");
    await expect(strip).toBeVisible();
    const stripOverflow = await strip.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(
      stripOverflow.scrollWidth,
      "the itinerary should retain its intentional horizontal strip"
    ).toBeGreaterThan(stripOverflow.clientWidth + EDGE_TOLERANCE_PX);

    await strip.evaluate((element) => {
      element.scrollLeft = 0;
    });
    await strip.hover();
    await page.mouse.wheel(400, 0);
    await expect
      .poll(() => strip.evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(0);

    // These are the visible primary actions on the planned stage. Dev-only
    // controls are intentionally excluded: Batch I gates them separately.
    // Strip descendants may sit outside the viewport inside the deliberate
    // horizontal scroller, but their actual hit targets must still be 44px.
    const primaryTargets = page.locator(
      [
        ".topbar input",
        ".topbar button",
        ".mapfallback button",
        '.lstrip button:not([aria-hidden="true"])',
        '.lstrip [role="button"]',
      ].join(", ")
    );
    const targetCount = await primaryTargets.count();
    expect(targetCount, "expected primary planned-stage controls").toBeGreaterThan(0);
    for (let index = 0; index < targetCount; index += 1) {
      const target = primaryTargets.nth(index);
      if (!(await target.isVisible())) continue;
      const identity = await target.evaluate((element) => {
        const name =
          element.getAttribute("aria-label") ??
          element.textContent?.replace(/\s+/g, " ").trim() ??
          "";
        return `${element.tagName.toLowerCase()}.${element.className} "${name}"`;
      });
      const label = `planned-stage control ${index + 1} (${identity})`;
      await expectTargetSize(target, label);
      const centerIsInViewport = await target.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const x = box.left + box.width / 2;
        const y = box.top + box.height / 2;
        return x >= 0 && x <= innerWidth && y >= 0 && y <= innerHeight;
      });
      if (centerIsInViewport) await expectCenterHitsControl(target, label);
    }

    const retry = page.locator(".mapfallback__retry");
    const dismissMapWarning = page.getByRole("button", {
      name: "Dismiss map warning",
    });
    if (await dismissMapWarning.isVisible()) {
      if (await retry.isVisible()) {
        await expectWithinViewport(retry, viewport, "map retry button");
      }
      await expectWithinViewport(
        dismissMapWarning,
        viewport,
        "dismiss map warning button"
      );
      await attachScreenshot(page, testInfo, `mobile-stage-warning-${width}px`);
      await dismissMapWarning.click();
      await expect(page.locator(".mapfallback")).toHaveCount(0);
    }

    // Unlike strip cards, map chips are not inside an intentional scroller:
    // every interactive chip must be fully reachable and hit-testable once
    // the explicitly dismissible provider warning has been cleared.
    const mapChips = page.locator("button.chip");
    await expect(mapChips.first()).toBeVisible();
    for (let index = 0; index < (await mapChips.count()); index += 1) {
      const chip = mapChips.nth(index);
      if (!(await chip.isVisible())) continue;
      const label = `map chip ${index + 1}`;
      await expectTargetSize(chip, label);
      await expectWithinViewport(chip, viewport, label);
      await expectCenterHitsControl(chip, label);
    }
    await expectWithinViewport(page.locator(".topbar__go"), viewport, "replan button");

    await attachScreenshot(page, testInfo, `mobile-stage-${width}px`);
  });
}
