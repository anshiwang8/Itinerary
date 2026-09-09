import type { CDPSession, Locator, Page } from "@playwright/test";
import { expect, test } from "./test";
import { planEvening } from "./helpers";

const PLAN = "dinner and drinks then dessert then coffee at 7pm";
const POSITION_TOLERANCE = 2;

type Point = { x: number; y: number };
type StartSample = {
  before: { top: number; opacity: number };
  after: { top: number; opacity: number };
  trusted: boolean;
  label: string | null;
};
type TouchObservations = { cancellations: number; starts: StartSample[]; clicks: boolean[] };

async function box(locator: Locator) {
  const value = await locator.boundingBox();
  expect(value, "expected a rendered interaction target").not.toBeNull();
  return value!;
}

async function nextPaint(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

/** Wait for actual motion to finish, not merely for a destination attribute.
 *  This helper is used before starting a gesture, never to hide a discontinuity. */
async function settled(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const sheet = document.querySelector<HTMLElement>(".msheet")!;
    const deadline = performance.now() + 3000;
    let previous = sheet.getBoundingClientRect().top;
    let stable = 0;
    const tick = () => {
      const current = sheet.getBoundingClientRect().top;
      const animations = sheet.getAnimations().some((animation) => animation.playState === "running");
      stable = Math.abs(current - previous) < 0.05 && !animations && sheet.dataset.moving !== "true" ? stable + 1 : 0;
      previous = current;
      if (stable >= 4) resolve();
      else if (performance.now() > deadline) reject(new Error("sheet did not settle"));
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
}

/** Native Chromium input runs browser hit testing and gesture arbitration.
 *  No synthetic events or production handlers are used by this driver. */
class Finger {
  private point: Point | null = null;
  constructor(private readonly page: Page, private readonly session: CDPSession) {}

  async start(point: Point): Promise<void> {
    this.point = point;
    await this.session.send("Input.dispatchTouchEvent", {
      type: "touchStart", touchPoints: [{ ...point, id: 1 }],
    });
  }

  async startOn(locator: Locator): Promise<Point> {
    const target = await box(locator);
    const point = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
    await this.start(point);
    return point;
  }

  async move(point: Point): Promise<void> {
    this.point = point;
    await this.session.send("Input.dispatchTouchEvent", {
      type: "touchMove", touchPoints: [{ ...point, id: 1 }],
    });
    await nextPaint(this.page);
  }

  async moveBy(dy: number, steps = 10): Promise<void> {
    if (!this.point) throw new Error("start a finger before moving it");
    const from = this.point;
    for (let step = 1; step <= steps; step += 1) {
      await this.move({ x: from.x, y: from.y + dy * step / steps });
    }
  }

  async end(holdMs = 0): Promise<void> {
    if (holdMs) await this.page.waitForTimeout(holdMs);
    await this.session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    this.point = null;
  }

  async close(): Promise<void> {
    if (this.point) await this.session.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    await this.session.detach();
  }
}

async function observeStarts(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state: TouchObservations = { cancellations: 0, starts: [], clicks: [] };
    (window as Window & { __sheetTouchObservations?: TouchObservations }).__sheetTouchObservations = state;
    document.addEventListener("touchcancel", () => { state.cancellations += 1; }, { capture: true });
    document.addEventListener("click", (event) => {
      if (event.target instanceof Element && event.target.closest(".msheet__draghandle")) state.clicks.push(event.isTrusted);
    }, { capture: true });
    document.addEventListener("touchstart", (event) => {
      if (!(event.target instanceof Element) || !event.target.closest(".msheet__draghandle, .msheet__heading")) return;
      const sheet = document.querySelector<HTMLElement>(".msheet")!;
      const read = () => ({
        top: sheet.getBoundingClientRect().top,
        opacity: Number(getComputedStyle(sheet.querySelector(".msheet__bg--opaque")!).opacity),
      });
      const before = read();
      const label = sheet.querySelector(".msheet__draghandle")!.getAttribute("aria-label");
      // The finger stays still. Capture before application listeners run,
      // then allow their paint to land; IPC timing cannot mimic a jump.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        state.starts.push({ before, after: read(), trusted: event.isTrusted, label });
      }));
    }, { capture: true });
  });
}

async function observations(page: Page): Promise<TouchObservations> {
  return page.evaluate(() => (window as Window & { __sheetTouchObservations?: TouchObservations }).__sheetTouchObservations!);
}

async function openPlan(page: Page, prompt = "dinner and drinks at 7pm"): Promise<void> {
  await planEvening(page, prompt);
  await expect(page.locator(".mapwrap")).toHaveAttribute("data-map-state", "failed");
  const warning = page.getByRole("button", { name: "Dismiss map warning" });
  if (await warning.isVisible()) await warning.click();
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator(".msheet")).toHaveAttribute("data-state", "peek");
  await settled(page);
  await observeStarts(page);
}

test.describe("trusted mobile sheet gestures", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });

  test.beforeEach(async ({ browserName }) => {
    test.skip(browserName !== "chromium", "these regressions require trusted CDP touch input");
  });

  test("peek expansion follows the finger and shows content before release @mock", async ({ page }) => {
    await openPlan(page);
    const sheet = page.locator(".msheet");
    const before = await box(sheet);
    const finger = new Finger(page, await page.context().newCDPSession(page));
    try {
      await finger.startOn(sheet.locator(".msheet__draghandle"));
      await finger.moveBy(-200);
      const held = await box(sheet);
      expect(Math.abs(held.y - (before.y - 200))).toBeLessThanOrEqual(POSITION_TOLERANCE);
      await expect(sheet).toHaveAttribute("data-dragging", "true");
      const body = sheet.locator(".msheet__body");
      await expect(body).toBeVisible();
      const visibleEntry = body.locator(".msheet__page:visible, .msheet__row:visible").first();
      await expect(visibleEntry).toBeVisible();
      const content = await box(visibleEntry);
      expect(Math.min(content.y + content.height, 844) - Math.max(content.y, held.y))
        .toBeGreaterThan(40);
      await finger.end(150);
      await settled(page);
      await expect(sheet).toHaveAttribute("data-state", "half");
      expect((await observations(page)).starts[0].trusted).toBe(true);
    } finally { await finger.close(); }
  });

  for (const perturbation of ["toolbar", "viewport"] as const) {
    test(`a held drag survives a ${perturbation} geometry change @mock`, async ({ page }) => {
      await openPlan(page);
      const sheet = page.locator(".msheet");
      const finger = new Finger(page, await page.context().newCDPSession(page));
      try {
        await finger.startOn(sheet.locator(".msheet__draghandle"));
        await finger.moveBy(-130);
        const heldTop = (await box(sheet)).y;
        if (perturbation === "toolbar") {
          await page.locator(".topbar").evaluate((element) => {
            element.style.height = `${element.getBoundingClientRect().height + 8}px`;
          });
        } else await page.setViewportSize({ width: 390, height: 804 });
        // Sample after observers and paints have run, while the same finger
        // remains down. Polling only a final snap would miss the original bug.
        await nextPaint(page);
        await page.waitForTimeout(80);
        await expect(sheet).toHaveAttribute("data-dragging", "true");
        expect(Math.abs((await box(sheet)).y - heldTop)).toBeLessThanOrEqual(POSITION_TOLERANCE);
        await finger.moveBy(-90);
        expect(Math.abs((await box(sheet)).y - (heldTop - 90))).toBeLessThanOrEqual(POSITION_TOLERANCE);
        expect((await observations(page)).cancellations).toBe(0);
        await finger.end(150);
        await settled(page);
        await expect(sheet).toHaveAttribute("data-dragging", "false");
      } finally { await finger.close(); }
    });
  }

  test("re-grabbing a settling sheet preserves position and background @mock", async ({ page }) => {
    await openPlan(page);
    const sheet = page.locator(".msheet");
    const grip = sheet.locator(".msheet__draghandle");
    await grip.press("ArrowUp");
    await settled(page);
    await expect(sheet).toHaveAttribute("data-state", "half");
    await grip.press("ArrowUp");
    await page.waitForTimeout(100);
    const finger = new Finger(page, await page.context().newCDPSession(page));
    try {
      const count = (await observations(page)).starts.length;
      await finger.startOn(grip);
      await expect(sheet).toHaveAttribute("data-dragging", "true");
      await nextPaint(page);
      const sample = (await observations(page)).starts[count];
      expect(sample, "trusted re-grab must hit the moving grip").toBeDefined();
      expect(sample.trusted).toBe(true);
      expect(Math.abs(sample.after.top - sample.before.top)).toBeLessThanOrEqual(POSITION_TOLERANCE);
      expect(Math.abs(sample.after.opacity - sample.before.opacity), "re-grab must not flash the background").toBeLessThanOrEqual(0.03);
      await finger.end(150);
      await settled(page);
    } finally { await finger.close(); }
  });

  test("the first move after re-grabbing overscroll does not apply resistance twice @mock", async ({ page }) => {
    await openPlan(page);
    const sheet = page.locator(".msheet");
    const grip = sheet.locator(".msheet__draghandle");
    const peekTop = (await box(sheet)).y;
    const finger = new Finger(page, await page.context().newCDPSession(page));
    try {
      await finger.startOn(grip);
      await finger.moveBy(60);
      expect((await box(sheet)).y - peekTop).toBeGreaterThan(5);
      await finger.end();
      // Re-grab before the overscroll has returned to its endpoint.
      await finger.startOn(grip);
      await expect(sheet).toHaveAttribute("data-dragging", "true");
      await nextPaint(page);
      const regrabTop = (await box(sheet)).y;
      expect(regrabTop - peekTop, "exercise an actually resisted position").toBeGreaterThan(3);
      await finger.moveBy(-1, 1);
      expect(Math.abs((await box(sheet)).y - regrabTop), "1px of finger motion cannot cause a second resistance jump")
        .toBeLessThanOrEqual(POSITION_TOLERANCE);
      // Continue beyond the tap threshold before releasing. The 1px probe
      // above checks continuity; by itself it is an intentional button tap.
      await finger.moveBy(-12, 3);
      await finger.end(150);
      await settled(page);
      expect(Math.abs((await box(sheet)).y - peekTop)).toBeLessThanOrEqual(POSITION_TOLERANCE);
    } finally { await finger.close(); }
  });

  test("a trusted grip tap during opening toggles the announced destination @mock", async ({ page }) => {
    await page.clock.install();
    await openPlan(page);
    const sheet = page.locator(".msheet");
    const grip = sheet.locator(".msheet__draghandle");
    // Measure real endpoints before the interrupted run. The touchstart
    // capture below proves the tap happens while half is still nearest.
    await grip.press("End");
    await settled(page);
    const fullTop = (await box(sheet)).y;
    await grip.press("ArrowDown");
    await settled(page);
    const halfTop = (await box(sheet)).y;
    const finger = new Finger(page, await page.context().newCDPSession(page));
    try {
      const count = (await observations(page)).starts.length;
      // Hold the first animation frame so test transport latency cannot
      // move a 44px grip away from a real browser touch. Only time is
      // controlled: native hit testing, touchend and click remain intact.
      await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100));
      await grip.press("ArrowUp");
      await page.clock.runFor(16);
      await finger.startOn(grip);
      await finger.end();
      await page.clock.runFor(32);
      const observed = await observations(page);
      const sample = observed.starts[count];
      expect(sample, "the trusted tap must hit the opening grip").toBeDefined();
      expect(sample.trusted).toBe(true);
      expect(sample.label).toBe("Collapse itinerary");
      expect(sample.before.top, "exercise a tap before the half/full midpoint")
        .toBeGreaterThan((halfTop + fullTop) / 2);
      expect(observed.clicks, "touchend must synthesize a real button click").toContain(true);
      await page.clock.runFor(400);
      await page.clock.resume();
      await settled(page);
      await expect(sheet).toHaveAttribute("data-state", "half");
      expect(Math.abs((await box(sheet)).y - halfTop)).toBeLessThanOrEqual(POSITION_TOLERANCE);
    } finally { await page.clock.resume(); await finger.close(); }
  });

  test("the non-interactive header drags the sheet without selecting a stop @mock", async ({ page }) => {
    await openPlan(page);
    const sheet = page.locator(".msheet");
    await sheet.locator(".msheet__draghandle").press("ArrowUp");
    await settled(page);
    const selected = await sheet.locator('.msheet__pageselect[aria-pressed="true"] .msheet__pagename').textContent();
    const before = (await box(sheet)).y;
    const finger = new Finger(page, await page.context().newCDPSession(page));
    try {
      await finger.startOn(sheet.locator(".msheet__heading h2"));
      await finger.moveBy(-180);
      await expect(sheet).toHaveAttribute("data-dragging", "true");
      expect(Math.abs((await box(sheet)).y - (before - 180))).toBeLessThanOrEqual(POSITION_TOLERANCE);
      await finger.end(150);
      await settled(page);
      expect(await sheet.locator('.msheet__pageselect[aria-pressed="true"] .msheet__pagename').textContent()).toBe(selected);
    } finally { await finger.close(); }
  });

  test("half cards stay horizontal and full details retain native vertical scrolling @mock", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 740 });
    await openPlan(page, PLAN);
    const sheet = page.locator(".msheet");
    await sheet.locator(".msheet__draghandle").press("ArrowUp");
    await settled(page);
    const track = sheet.locator(".msheet__track");
    expect(await track.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
    const finger = new Finger(page, await page.context().newCDPSession(page));
    try {
      const trackBox = await box(track);
      await finger.start({ x: trackBox.x + trackBox.width / 2, y: trackBox.y + trackBox.height - 15 });
      await finger.moveBy(-100);
      await finger.end();
      await nextPaint(page);
      expect(await track.evaluate((element) => element.scrollTop)).toBe(0);
      await expect(sheet).toHaveAttribute("data-state", "half");

      const details = sheet.getByRole("button", { name: "Show walking route caution and full itinerary" }).first();
      await details.scrollIntoViewIfNeeded();
      await details.click();
      await settled(page);
      await expect(sheet).toHaveAttribute("data-state", "full");
      const list = sheet.locator(".msheet__full");
      await expect(list.getByRole("note", { name: /^Walking route caution:/ }).first()).toBeVisible();
      await expect(list.getByRole("note", { name: /^Walking route caution:/ }).first()).toBeInViewport();
      const bounds = await box(list);
      expect(await list.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(200);
      const top = (await box(sheet)).y;
      await finger.start({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height - 20 });
      await finger.moveBy(-180);
      await finger.end(150);
      await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
      expect(Math.abs((await box(sheet)).y - top)).toBeLessThanOrEqual(POSITION_TOLERANCE);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
    } finally { await finger.close(); }
  });

  for (const scale of [1.25, 2]) {
  test(`search controls stay visible and separate when a ${scale}x visual viewport pans @mock`, async ({ page }) => {
    await openPlan(page);
    const session = await page.context().newCDPSession(page);
    const finger = new Finger(page, session);
    try {
      await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: scale });
      await nextPaint(page);
      const visibleArea = await page.evaluate(() => ({ width: visualViewport!.width, height: visualViewport!.height }));
      await finger.start({ x: visibleArea.width * 0.75, y: visibleArea.height * 0.62 });
      await finger.moveBy(-Math.min(150, visibleArea.height * 0.25));
      await finger.end();
      await page.waitForTimeout(200);
      const geometry = await page.locator(".topbar input, .topbar button").evaluateAll((controls) => {
        const viewport = window.visualViewport!;
        return {
          scale: viewport.scale,
          width: viewport.width * viewport.scale,
          height: viewport.height * viewport.scale,
          scrollY: window.scrollY,
          controls: controls.map((control) => {
            const bounds = control.getBoundingClientRect();
            return {
              label: control.getAttribute("aria-label") || control.textContent?.trim() || "search input",
              layoutWidth: bounds.width,
              layoutHeight: bounds.height,
              top: (bounds.top - viewport.offsetTop) * viewport.scale,
              bottom: (bounds.bottom - viewport.offsetTop) * viewport.scale,
              left: (bounds.left - viewport.offsetLeft) * viewport.scale,
              right: (bounds.right - viewport.offsetLeft) * viewport.scale,
            };
          }),
        };
      });
      expect(geometry.scale, "the fix must preserve user zoom").toBeCloseTo(scale, 2);
      expect(geometry.scrollY).toBe(0);
      expect(geometry.controls.length).toBeGreaterThanOrEqual(5);
      for (const bounds of geometry.controls) {
        expect(bounds.layoutWidth, `${bounds.label} target width in CSS pixels`).toBeGreaterThanOrEqual(44);
        expect(bounds.layoutHeight, `${bounds.label} target height in CSS pixels`).toBeGreaterThanOrEqual(44);
        expect(bounds.top).toBeGreaterThanOrEqual(-1);
        expect(bounds.bottom).toBeLessThanOrEqual(geometry.height + 1);
        expect(bounds.left).toBeGreaterThanOrEqual(-1);
        expect(bounds.right).toBeLessThanOrEqual(geometry.width + 1);
      }
      // Bounds alone miss overlapping grid items. Their centres can also
      // remain hit-testable through a tiny gap while most of a button is
      // covered, so require the complete control rectangles to separate.
      for (let first = 0; first < geometry.controls.length; first += 1) {
        for (let second = first + 1; second < geometry.controls.length; second += 1) {
          const a = geometry.controls[first];
          const b = geometry.controls[second];
          const overlapWidth = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const overlapHeight = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          expect(overlapWidth <= 1 || overlapHeight <= 1, `${a.label} and ${b.label} must not overlap`).toBe(true);
        }
      }
    } finally { await finger.close(); }
  });
  }
});
