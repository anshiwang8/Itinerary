// Partial-failure recovery (Bug 1): when ONE requested category comes back
// empty but others resolve, the plan must NOT silently drop it. Instead it
// pauses with an honest reason and offers to widen (city-wide) or replace
// that one slot. Fixture trigger: a "dumplings" search in a neighbourhood
// returns only a permanently-closed spot (empty after the objective
// filter); widened city-wide it returns a real open venue. A fixed "7pm"
// pins the resolved time (deterministic filtering) and skips the clarify
// step. See app/api/_mock/fixtures.ts (DUMPLING_CLOSED / DUMPLING_OPEN).
import { test, expect, Page } from "@playwright/test";

// plan the dumplings prompt and land on the recovery panel (no clarify,
// since the prompt carries a time)
async function planToRecovery(page: Page): Promise<void> {
  await page.goto("/");
  await page.locator(".prompt__input").fill("dumplings then a bar at 7pm in Ossington");
  await page.locator(".prompt__go").click();
  await expect(page.locator(".recover")).toBeVisible({ timeout: 90_000 });
}

test.describe("@mock partial-failure recovery", () => {
  test("empty category → honest reason + widen offer, not a silent one-stop plan @mock", async ({ page }) => {
    await planToRecovery(page);
    const reason = page.locator(".recover__reason");
    await expect(reason).toContainText(/dumplings/i);
    await expect(reason).toContainText(/permanently closed/i); // the objective cause
    // widen offer scoped to the neighbourhood
    await expect(page.locator(".recover__widen")).toContainText(/Ossington/i);
    // the whole point: NOT a silent plan behind the panel
    await expect(page.locator(".lstrip")).toHaveCount(0);
  });

  test("accept widen → re-searches ONLY that category city-wide, recovers the slot @mock", async ({ page }) => {
    await planToRecovery(page);
    // prove the widen re-searches exactly the empty category, neighbourhood
    // dropped — and nothing else
    const widenReq = page.waitForRequest((r) => {
      if (!r.url().includes("/api/places/search") || r.method() !== "POST") return false;
      try {
        const b = JSON.parse(r.postData() || "{}");
        return (
          Array.isArray(b.categoriesOverride) &&
          b.categoriesOverride.length === 1 &&
          /dumpling/i.test(b.categoriesOverride[0]) &&
          (b.parsed?.location ?? "") === "" // widened = neighbourhood dropped
        );
      } catch {
        return false;
      }
    });
    await page.locator(".recover__widen").click();
    await widenReq;

    // the plan now completes: the recovered city-wide dumpling venue renders
    await expect(page.locator(".lstrip")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".lstrip__name", { hasText: "Citywide Dumpling Bar" })).toBeVisible();
    // and the untouched bar stop is still there → exactly two stops
    await expect(page.locator(".lstrip__stop")).toHaveCount(2);
  });

  test("decline widen → follow-up replace re-resolves that one slot @mock", async ({ page }) => {
    await planToRecovery(page);
    // instead of widening, name something else for that slot
    await page.locator(".recover__input").first().fill("dessert");
    await page.locator(".recover__go").first().click();

    await expect(page.locator(".lstrip")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".lstrip__stop")).toHaveCount(2);
    // the empty dumplings slot became a real dessert stop; no dumplings left
    await expect(page.locator(".lstrip")).not.toContainText(/dumpling/i);
  });

  test("ALL categories empty still uses the plain fail-loud message (no recovery panel) @mock", async ({ page }) => {
    await page.goto("/");
    // dumplings alone in a neighbourhood → the ONLY pool is empty → all-empty
    await page.locator(".prompt__input").fill("dumplings at 7pm in Ossington");
    await page.locator(".prompt__go").click();
    const err = page.locator(".empty__err, .stage__err").first();
    await expect(err).toBeVisible({ timeout: 90_000 });
    await expect(err).toContainText(/Couldn't find any/i);
    // the recovery panel is for PARTIAL failures only
    await expect(page.locator(".recover")).toHaveCount(0);
    await expect(page.locator(".lstrip")).toHaveCount(0);
  });
});
