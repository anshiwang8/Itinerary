// History (Stage 2) — the guest path, which is the only one mock e2e can
// honestly reach.
//
// WHY ONLY THE GUEST PATH: mock mode replaces DATA SOURCES, never logic, and
// there is no way to become a real signed-in account without completing a
// Google popup. Faking that would fork product logic under test — the same
// reason the login screen is an entry point rather than an arrival gate. The
// signed-in list and detail are verified live instead.
//
// What this DOES pin is the promise that costs the most if it breaks: opening
// history without an account is a completely ordinary thing to do, and it must
// produce a nudge rather than an error, a spinner, or a 401.
import { test, expect } from "./test";

test.describe("@mock history (view-only)", () => {
  test("a guest gets the sign-in nudge, and no request is made for it @mock", async ({
    page,
  }) => {
    // A guest's plans were never archived, so asking the server about them is
    // a round trip with a known answer. Counting is the only way to prove the
    // panel actually skips it.
    let historyCalls = 0;
    await page.route("**/api/history**", async (route) => {
      historyCalls += 1;
      await route.continue();
    });

    await page.goto("/");
    const openHistory = page.getByRole("button", { name: "History" });
    await expect(openHistory).toBeVisible();
    await openHistory.click();

    const panel = page.getByRole("dialog", { name: "Your history" });
    await expect(panel).toBeVisible();
    await expect(panel.getByText("Sign in to save your plans")).toBeVisible();

    // A nudge, not a list and not an error.
    await expect(panel.locator(".hist__list")).toHaveCount(0);
    await expect(panel.locator(".hist__err")).toHaveCount(0);

    // Either the way in, or an honest note that sign-in is unavailable —
    // never a dead button.
    await expect(
      panel.locator(".hist__cta, .hist__note")
    ).toHaveCount(1);

    expect(historyCalls, "a guest's history is never fetched").toBe(0);
  });

  test("escape closes it, and the planning screen is untouched underneath @mock", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "History" }).click();
    const panel = page.getByRole("dialog", { name: "Your history" });
    await expect(panel).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);

    // The whole point of an overlay: nothing behind it moved.
    await expect(page.locator(".prompt__input")).toBeVisible();
    await expect(page.locator(".prompt__input")).toBeEditable();
  });

  test("the nudge leads into the login card @mock", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "History" }).click();
    const cta = page.locator(".hist__cta");
    // Skipped rather than failed when Firebase is unconfigured: that is a
    // real deployment state, and the previous test already covers it.
    test.skip((await cta.count()) === 0, "sign-in unavailable in this environment");

    await cta.click();
    // History gives way to the login card — never both at once.
    await expect(page.getByRole("dialog", { name: "Welcome" })).toBeVisible();
    await expect(page.locator(".hist")).toHaveCount(0);
  });

  test("history borrows no acid green — that colour means 'now' @mock", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "History" }).click();
    await expect(page.locator(".hist")).toBeVisible();

    const borrowed = await page.evaluate(() => {
      const live = getComputedStyle(document.documentElement)
        .getPropertyValue("--live")
        .trim();
      // Compare as a resolved colour: the token is a hex, computed styles are
      // rgb(), so matching on the literal string would silently pass.
      const probe = document.createElement("span");
      probe.style.color = live;
      document.body.appendChild(probe);
      const resolved = getComputedStyle(probe).color;
      probe.remove();

      return [...document.querySelectorAll(".hist, .hist *")].filter((element) => {
        const style = getComputedStyle(element);
        return [
          style.color,
          style.backgroundColor,
          style.borderTopColor,
          style.borderLeftColor,
          style.outlineColor,
        ].includes(resolved);
      }).length;
    });
    expect(borrowed, "--live is reserved for happening-now").toBe(0);
  });
});
