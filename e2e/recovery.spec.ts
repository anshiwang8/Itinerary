// Partial-failure recovery (Bug 1): when ONE requested category comes back
// empty but others resolve, the plan must NOT silently drop it. Instead it
// pauses with an honest reason and offers to widen (city-wide) or replace
// that one slot. Fixture trigger: a "dumplings" search in a neighbourhood
// returns only a permanently-closed spot (empty after the objective
// filter); widened city-wide it returns a real open venue. A fixed "7pm"
// pins the resolved time (deterministic filtering) and skips the clarify
// step. See app/api/_mock/fixtures.ts (DUMPLING_CLOSED / DUMPLING_OPEN).
import type { Page } from "@playwright/test";
import { test, expect } from "./test";
import { stripCard, dismissClarifyIfShown } from "./helpers";

function torontoClock(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Toronto",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const hour = parts.find((part) => part.type === "hour")?.value;
  const minute = parts.find((part) => part.type === "minute")?.value;
  return `${hour}:${minute}`;
}

// plan the dumplings prompt and land on the recovery panel (no clarify,
// since the prompt carries a time)
async function planToRecovery(page: Page): Promise<void> {
  await page.goto("/");
  await page.locator(".prompt__input").fill("dumplings then a bar at 7pm in Ossington");
  await page.locator(".prompt__go").click();
    await dismissClarifyIfShown(page);
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
    // ORDER: the user asked "dumplings then a bar" — the recovered dumplings
    // must land back in FIRST position, not appended after the bar (scope to
    // stop cards; the first .lstrip__name overall is the home card)
    await expect(page.locator(".lstrip__stop .lstrip__name").first()).toHaveText(
      "Citywide Dumpling Bar"
    );
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

  test("TWO empty categories → both surface; plan finishes only after BOTH resolve @mock", async ({ page }) => {
    // "dumplings" AND "bao" are both neighbourhood-sensitive recovery
    // fixtures (closed nearby / open city-wide); the bar resolves normally.
    // The panel must list both empties, resolving one must NOT finish the
    // plan, and the plan completes only once the second is resolved too —
    // one via widen, one via the replace follow-up (both paths exercised).
    await page.goto("/");
    await page.locator(".prompt__input").fill("dumplings and bao then a bar at 7pm in Ossington");
    await page.locator(".prompt__go").click();
    await dismissClarifyIfShown(page);
    await expect(page.locator(".recover")).toBeVisible({ timeout: 90_000 });
    await expect(page.locator(".recover__reason")).toHaveCount(2);
    await expect(page.locator(".lstrip")).toHaveCount(0);

    // resolve #1 — widen dumplings city-wide
    const dumplingRow = page.locator(".clarify__q", { hasText: "dumplings" });
    await expect(dumplingRow.locator(".recover__reason")).toContainText(/permanently closed/i);
    await dumplingRow.locator(".recover__widen").click();

    // panel stays for bao; the plan must NOT have finished on one resolve
    await expect(page.locator(".recover__reason")).toHaveCount(1);
    await expect(page.locator(".recover__reason")).toContainText(/bao/i);
    await expect(page.locator(".lstrip")).toHaveCount(0);

    // resolve #2 — decline widening for bao, name a replacement instead
    await page.locator(".recover__input").fill("dessert");
    await page.locator(".recover__go").click();

    // NOW the plan completes: bar + recovered dumplings + replacement dessert
    await expect(page.locator(".lstrip")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".lstrip__stop")).toHaveCount(3);
    await expect(page.locator(".lstrip__name", { hasText: "Citywide Dumpling Bar" })).toBeVisible();
    await expect(page.locator(".lstrip")).not.toContainText(/bao/i);
    // ORDER: "dumplings and bao then a bar" — dumplings back in FIRST slot,
    // the dessert REPLACEMENT inherits bao's middle slot, bar stays last
    // (scope to stop cards; the first .lstrip__name overall is the home card)
    const stopNames = page.locator(".lstrip__stop .lstrip__name");
    await expect(stopNames.nth(0)).toHaveText("Citywide Dumpling Bar");
    await expect(stopNames.nth(2)).toContainText(/Curfew|Standing Room|Paper Lantern/);
  });

  test("ALL categories empty still uses the plain fail-loud message (no recovery panel) @mock", async ({ page }) => {
    // NOTE: this pins the NORMAL path. After a time-gate OVERRIDE the same
    // all-empty outcome deliberately routes into the recovery panel instead
    // (see the time-gate suite below) — the user just chose to push past
    // one dead end; handing them another would defeat the point.
    await page.goto("/");
    // dumplings alone in a neighbourhood → the ONLY pool is empty → all-empty
    await page.locator(".prompt__input").fill("dumplings at 7pm in Ossington");
    await page.locator(".prompt__go").click();
    await dismissClarifyIfShown(page);
    const err = page.locator(".empty__err, .stage__err").first();
    await expect(err).toBeVisible({ timeout: 90_000 });
    await expect(err).toContainText(/Couldn't find any/i);
    // the recovery panel is for PARTIAL failures only
    await expect(page.locator(".recover")).toHaveCount(0);
    await expect(page.locator(".lstrip")).toHaveCount(0);
  });
});

test.describe("@mock per-slot recovery targeting", () => {
  async function planPrompt(page: Page, prompt: string): Promise<void> {
    await page.goto("/");
    await page.locator(".prompt__input").fill(prompt);
    await page.locator(".prompt__go").click();
    await dismissClarifyIfShown(page);
    await expect(page.locator(".recover")).toBeVisible({ timeout: 90_000 });
  }

  test("later-opening candidate is retried at the target slot's own arrival @mock", async ({ page }) => {
    await planPrompt(page, "dinner then a late gallery at 7pm in Ossington");
    const galleryRow = page.locator(".clarify__q", { hasText: "late gallery" });
    await expect(galleryRow.locator(".recover__reason")).toContainText(/closed at that hour/i);

    const retryRequest = page.waitForRequest((request) => {
      if (!request.url().includes("/api/places/search") || request.method() !== "POST") {
        return false;
      }
      try {
        const body = JSON.parse(request.postData() ?? "{}");
        return body.categoriesOverride?.[0] === "late gallery";
      } catch {
        return false;
      }
    });
    await galleryRow.locator(".recover__widen").click();
    const request = await retryRequest;
    const body = JSON.parse(request.postData() ?? "{}");

    // Dinner occupies 90 + 15 minutes, so slot 1 starts at 8:45 PM.
    // The fixture gallery opens at 8 PM and was closed at the 7 PM anchor.
    expect(torontoClock(body.targetTime)).toBe("20:45");
    await expect(page.locator(".lstrip")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".lstrip__stop")).toHaveCount(2);
    await expect(page.locator(".lstrip__stop .lstrip__name").nth(1)).toHaveText(
      "After Eight Gallery"
    );
  });

  test("later-slot replacement applies weather at that slot, not the plan anchor @mock", async ({ page }) => {
    // The 1:15 PM anchor is dry. Dinner's 105-minute dwell puts slot 1 at
    // exactly 3 PM, the mock forecast's deterministic rain hour.
    await planPrompt(page, "dinner then a late gallery at 1:15pm in Ossington");
    await page.locator(".recover__input").fill("park walk");

    const retryResponse = page.waitForResponse((response) => {
      const request = response.request();
      if (!request.url().includes("/api/places/search") || request.method() !== "POST") {
        return false;
      }
      try {
        const body = JSON.parse(request.postData() ?? "{}");
        return body.categoriesOverride?.[0] === "park walk";
      } catch {
        return false;
      }
    });
    await page.locator(".recover__go").click();
    const response = await retryResponse;
    const requestBody = JSON.parse(response.request().postData() ?? "{}");
    const responseBody = await response.json();

    expect(torontoClock(requestBody.targetTime)).toBe("15:00");
    expect(responseBody._weatherBlocked).toEqual([
      expect.objectContaining({
        category: "park walk",
        reason: "rain likely at 3pm",
      }),
    ]);
    // Had recovery reused the dry 1:15 PM anchor, this would have silently
    // completed with a park. At the real slot hour it stays unresolved.
    await expect(page.locator(".recover")).toBeVisible();
    await expect(page.locator(".recover__note")).toContainText(/park walk/i);
    await expect(page.locator(".lstrip")).toHaveCount(0);
  });

  test("repeated category slots stay distinct and an occupied-only retry never duplicates @mock", async ({
    page,
  }) => {
    await page.goto("/");
    await page
      .locator(".prompt__input")
      .fill("tiny bar then another tiny bar at 7pm in Ossington");
    const initialSelect = page.waitForRequest(
      (request) =>
        request.url().includes("/api/select") && request.method() === "POST"
    );
    await page.locator(".prompt__go").click();
    await dismissClarifyIfShown(page);
    const selectBody = JSON.parse((await initialSelect).postData() ?? "{}");
    expect(selectBody.slots).toEqual(["tiny bar", "tiny bar"]);

    const recover = page.locator(".recover");
    await expect(recover).toBeVisible({ timeout: 90_000 });
    await expect(recover.locator(".recover__reason")).toContainText(
      /asked for more than one tiny bar/i
    );

    // Widening returns the same single provider candidate. It is already
    // occupied by slot 0, so slot 1 must stay open instead of reusing it.
    await recover.locator(".recover__widen").click();
    await expect(recover.locator(".recover__note")).toContainText(
      /asked for more than one tiny bar.*could only find one/i
    );
    await expect(page.locator(".lstrip")).toHaveCount(0);

    // A genuinely different replacement fills only slot 1. Slot 0 remains
    // the original tiny bar and the final plan has two distinct venues.
    await recover.locator(".recover__input").fill("dessert");
    await recover.locator(".recover__go").click();
    await expect(page.locator(".lstrip")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".lstrip__stop")).toHaveCount(2);
    const names = page.locator(".lstrip__stop .lstrip__name");
    await expect(names.nth(0)).toHaveText("The One-Seat Bar");
    const renderedNames = await names.allTextContents();
    expect(new Set(renderedNames).size).toBe(2);
  });
});

// ── Weather-gate: a PARTIALLY weather-blocked plan gets a real choice ────
// mockWeather rains (precip 80) at 3 PM local daily, so "… at 3pm" blocks
// outdoor categories deterministically (today or rolled to tomorrow — both
// inside the mock 48h horizon), while dinner survives (Noodle Letterpress
// is open at 15:00). No clock freeze needed: the stated time makes server
// and client agree. The ALL-blocked case stays on weatherBlockedReason —
// pinned unchanged in failloud.spec.ts.
test.describe("@mock weather-gate", () => {
  async function planRainy(page: Page, prompt: string): Promise<void> {
    await page.goto("/");
    await page.locator(".prompt__input").fill(prompt);
    await page.locator(".prompt__go").click();
    await dismissClarifyIfShown(page);
  }

  test("weather-blocked category → gate with the REAL weather reason, no widen offer @mock", async ({ page }) => {
    await planRainy(page, "dinner and a walk in the park at 3pm");
    const gate = page.locator(".recover--gate");
    await expect(gate).toBeVisible({ timeout: 30_000 });
    // the actual weather reason, not the generic empty-pool copy
    await expect(gate).toContainText(/Rain likely at 3pm/i);
    await expect(gate).toContainText(/park walk might not be great right now/i);
    await expect(gate.getByRole("button", { name: "Still want it" })).toBeVisible();
    await expect(gate.getByRole("button", { name: "Something else" })).toBeVisible();
    // the useless offer is gone: weather isn't a radius problem
    await expect(page.locator(".recover__widen")).toHaveCount(0);
    await expect(page.locator(".lstrip")).toHaveCount(0);
  });

  test("'Still want it' skips ONLY the weather gate and plans both stops @mock", async ({ page }) => {
    await planRainy(page, "dinner and a walk in the park at 3pm");
    await page.locator(".recover--gate").getByRole("button", { name: "Still want it" }).click();
    await expect(page.locator(".lstrip")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".lstrip__stop")).toHaveCount(2);
    // the dinner pick proves the hours filter ran for real (Velvet Fig,
    // 4.8 but closed at 3 PM, must lose to the open Noodle Letterpress)
    await expect(stripCard(page, "Noodle Letterpress")).toBeVisible();
    await expect(page.locator(".lstrip")).toContainText(/Fixture Park walk/);
    // the stale "Skipped the park walk" weather note must be gone — the
    // stop is planned now, not skipped
    await expect(page.locator("main")).not.toContainText(/Skipped the park walk/i);
  });

  test("override still finds NOTHING → the EXISTING generic recovery, then replace recovers @mock", async ({ page }) => {
    // "beach" is outdoor (gate fires in the rain) AND deliberately empty —
    // ignoring weather can't conjure venues, so this lands in the normal
    // empty-slot flow, never a third dead end
    await planRainy(page, "dinner and the beach at 3pm");
    const gate = page.locator(".recover--gate");
    await expect(gate).toBeVisible({ timeout: 30_000 });
    await expect(gate).toContainText(/beach might not be great right now/i);
    await gate.getByRole("button", { name: "Still want it" }).click();

    const recover = page.locator(".recover");
    await expect(recover).toBeVisible({ timeout: 30_000 });
    await expect(recover).toContainText(/Couldn't find any beach/i);
    // replace the slot → a full two-stop plan
    await page.locator(".recover__input").fill("dessert");
    await page.locator(".recover__go").click();
    await expect(page.locator(".lstrip")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".lstrip__stop")).toHaveCount(2);
    await expect(stripCard(page, "Sundown Scoops")).toBeVisible();
  });

  test("'Something else' → replace-the-slot rows, widen suppressed, skip still offered @mock", async ({ page }) => {
    await planRainy(page, "dinner and a walk in the park at 3pm");
    await page.locator(".recover--gate").getByRole("button", { name: "Something else" }).click();
    const recover = page.locator(".recover");
    await expect(recover).toBeVisible({ timeout: 30_000 });
    // the weather reason travels onto the replace row; widen stays gone
    await expect(recover).toContainText(/Rain likely at 3pm — pick something else for this stop/i);
    await expect(page.locator(".recover__widen")).toHaveCount(0);
    // dinner survived, so "Plan without it" is a real third option here
    await expect(page.locator(".recover__skip")).toBeVisible();
    // and replacing the slot completes the plan
    await page.locator(".recover__input").fill("dessert");
    await page.locator(".recover__go").click();
    await expect(page.locator(".lstrip")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".lstrip__stop")).toHaveCount(2);
    await expect(stripCard(page, "Sundown Scoops")).toBeVisible();
  });
});

// ── Batch 4b's inferred-time gate suite was DELETED (2026-07-27) ──────────
// Four scenarios lived here: the gate panel appearing for "sit in a park"
// late at night, "Still want it" overriding it, an override that found
// nothing falling into the recovery flow, and "Something else" re-opening
// the kind picker. All four pinned the PLAUSIBILITY GATE, which is gone —
// an hour is no longer refused because a hardcoded band disliked it, so
// there is no verdict left to override and no panel to render.
//
// What replaced them: a late-night park prompt now simply plans, and if
// nothing is genuinely open the objective hours filter empties the pools
// and noVenuesReason says so. The resolver side of that change is pinned in
// app/api/schedule/schedule.test.ts ("park prompts anchor immediately at
// ANY hour"); the empty-pool recovery path those tests also exercised is
// still covered by the dumplings/bao scenarios above.
