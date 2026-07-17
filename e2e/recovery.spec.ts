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
    const err = page.locator(".empty__err, .stage__err").first();
    await expect(err).toBeVisible({ timeout: 90_000 });
    await expect(err).toContainText(/Couldn't find any/i);
    // the recovery panel is for PARTIAL failures only
    await expect(page.locator(".recover")).toHaveCount(0);
    await expect(page.locator(".lstrip")).toHaveCount(0);
  });
});

// ── Batch 4b: the inferred-time gate ─────────────────────────────────────
// The user typed NO time and the app's own inferred slot fell outside a
// known category band (parks at ~11 PM) — that's now a CHOICE panel, not a
// refusal string. The client clock is frozen late via addInitScript (the
// gate is a client-side check); fixture determinism at any SERVER hour
// comes from the hours-less "Fixture … Three" (keep-on-missing survivor)
// and the deliberately-empty "beach" pool.
test.describe("@mock inferred-time gate", () => {
  async function planLate(page: Page, prompt: string): Promise<void> {
    await page.addInitScript(`{
      const RealDate = Date;
      const fixed = new RealDate('2026-07-16T22:54:00-04:00').getTime();
      function FakeDate(...a) { return a.length ? new RealDate(...a) : new RealDate(fixed); }
      FakeDate.now = () => fixed;
      FakeDate.parse = RealDate.parse;
      FakeDate.UTC = RealDate.UTC;
      FakeDate.prototype = RealDate.prototype;
      window.Date = FakeDate;
    }`);
    await page.goto("/");
    await page.locator(".prompt__input").fill(prompt);
    await page.locator(".prompt__go").click();
    // "sit in a park" has a category but no time → the WHEN clarify shows
    // first; skipping keeps the time unspecified, which is what arms the gate
    const skip = page.locator(".clarify__skip");
    await expect(page.locator(".clarify, .recover, .empty__err").first()).toBeVisible({ timeout: 30_000 });
    if (await skip.isVisible()) await skip.click();
  }

  test("inferred out-of-band → interactive gate panel, not a dead-end string @mock", async ({ page }) => {
    await planLate(page, "sit in a park");
    const gate = page.locator(".recover--gate");
    await expect(gate).toBeVisible({ timeout: 30_000 });
    // names the obstacle and the window — and asks as a REAL question
    await expect(gate).toContainText(/late for a typical park walk visit/i);
    await expect(gate).toContainText(/6 AM to 10 PM/);
    await expect(gate.getByRole("button", { name: "Still want it" })).toBeVisible();
    await expect(gate.getByRole("button", { name: "Something else" })).toBeVisible();
    // no plain-refusal surface, no plan behind it
    await expect(page.locator(".empty__err, .stage__err")).toHaveCount(0);
    await expect(page.locator(".lstrip")).toHaveCount(0);
  });

  test("'Still want it' overrides the gate and actually plans @mock", async ({ page }) => {
    await planLate(page, "sit in a park");
    await page.locator(".recover--gate").getByRole("button", { name: "Still want it" }).click();
    // the band gate is bypassed; the hours filter still runs for real and
    // the keep-on-missing fixture survives at any server hour
    await expect(page.locator(".lstrip")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".lstrip__stop .eyebrow").first()).toHaveText(/park/i);
    await expect(page.locator(".lstrip__stop .lstrip__name").first()).toHaveText(/Fixture Park walk/);
  });

  test("override finds NOTHING → lands in the recovery flow, not a new dead end @mock", async ({ page }) => {
    // "beach" shares the park band (gate fires) but its pool is empty
    await planLate(page, "sit by the beach");
    const gate = page.locator(".recover--gate");
    await expect(gate).toBeVisible({ timeout: 30_000 });
    await expect(gate).toContainText(/late for a typical beach visit/i);
    await gate.getByRole("button", { name: "Still want it" }).click();

    // the EXISTING recovery panel takes over — with the honest reason
    const recover = page.locator(".recover");
    await expect(recover).toBeVisible({ timeout: 30_000 });
    await expect(recover).toContainText(/Couldn't find any beach/i);
    // nothing else was picked, so "Plan without it" would be meaningless
    await expect(page.locator(".recover__skip")).toHaveCount(0);
    // widen honestly comes back empty for beach (still no fixtures)…
    await page.locator(".recover__widen").click();
    await expect(page.locator(".recover__note")).toContainText(/Still no beach city-wide/i);
    // …and the replace follow-up recovers to a real plan (any-hour fixture)
    await page.locator(".recover__input").fill("axe throwing");
    await page.locator(".recover__go").click();
    await expect(page.locator(".lstrip")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".lstrip__stop .lstrip__name").first()).toHaveText(/Fixture Axe throwing/);
  });

  test("'Something else' returns to the kind picker and continues cleanly @mock", async ({ page }) => {
    await planLate(page, "sit in a park");
    await page.locator(".recover--gate").getByRole("button", { name: "Something else" }).click();
    // back to batch 4's kind question — no error, no retyping
    const clarify = page.locator(".clarify");
    await expect(clarify).toBeVisible({ timeout: 30_000 });
    await expect(clarify).toContainText("What kind of thing?");
    await expect(page.locator(".empty__err, .stage__err")).toHaveCount(0);
    // picking a direction continues to a real plan (general pool has the
    // any-hour keep-on-missing fixture)
    await clarify.getByRole("button", { name: "something to do", exact: true }).click();
    await clarify.getByRole("button", { name: "Go", exact: true }).click();
    await expect(page.locator(".lstrip")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".lstrip__stop .lstrip__name").first()).toHaveText(/Fixture General/);
  });
});
