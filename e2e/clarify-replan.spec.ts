// The mobile-Replan bug: two independent defects that combined into "press
// Replan while a question is open, answers vanish, same questions reappear,
// no explanation." See CLAUDE.md's "REPLAN MUST NEVER SILENTLY DISCARD AN
// OPEN, ANSWERABLE QUESTION ROUND" bullet for the full write-up.
//
//  1. LAYOUT: uiLayout.css's mobile `.clarify--stage` rule caps the panel at
//     max-height: 30dvh with no sticky action row, so a 2+ question round's
//     Go/Skip row can render past the scrollport with no visual hint the
//     panel scrolls.
//  2. FLOW (both desktop and mobile — the SAME runPipeline() handles both
//     the landing form and the topbar's mid-plan Replan form): Replan used
//     to unconditionally clear the open clarify round and start fresh with
//     no answers, discarding whatever was filled in.
//
// The "not sure what to do" prompt is the codebase's own deterministic
// vague-prompt fixture (see scenarios.spec.ts's "vague-but-sincere prompt"
// test): no signal regex matches it, so the mock planner falls to the
// general pool and asks all three of "What kind of thing?" / "When?" /
// vibe — a real 2+ question round, not a synthetic one built for this test.
import type { Locator } from "@playwright/test";
import { expect, test } from "./test";
import { expandDesktopItinerary, planEvening, stripCard } from "./helpers";

const EDGE_TOLERANCE_PX = 1;

async function box(locator: Locator) {
  const rect = await locator.boundingBox();
  expect(rect, "expected a rendered bounding box").not.toBeNull();
  return rect!;
}

/**
 * Open a clarify round from the TOPBAR (mid-plan Replan), the exact path
 * the bug requires: `.clarify--stage`'s mobile 30dvh cap only applies once
 * an itinerary already exists, and the flow bug is specifically about the
 * topbar's Replan submit, not the landing "Plan it" form.
 */
async function openMidPlanClarify(page: Parameters<typeof planEvening>[0]): Promise<void> {
  await planEvening(page, "dinner and drinks");
  await page.locator(".topbar__input").fill("not sure what to do");
  await page.locator(".topbar__go").click();
  const clarify = page.locator(".clarify--stage");
  await expect(clarify).toBeVisible({ timeout: 30_000 });
  await expect(clarify).toContainText("What kind of thing?");
  await expect(clarify).toContainText("When?");
  await expect(clarify).toContainText("vibe");
}

test("mobile: the clarify Go/Skip row stays within its own scrollport, not just the page @mock", async ({
  page,
}) => {
  // A viewport under the 768px breakpoint, tall enough that the bug is not
  // simply "the panel doesn't fit the screen" — 844px comfortably exceeds
  // any reasonable panel height; the failure is specifically that the
  // action row renders PAST the container's own 30dvh-capped scrollport.
  await page.setViewportSize({ width: 390, height: 844 });
  await openMidPlanClarify(page);

  const container = page.locator(".clarify--stage");
  const goButton = page.locator(".clarify__go");
  const skipButton = page.locator(".clarify__skip");

  // Deliberately NOT `.click()` or `.tap()` first: Playwright auto-scrolls a
  // target into view before acting on it, which is exactly how the original
  // bug shipped past a passing test suite — every existing clarify e2e case
  // clicks "Go" directly and would auto-scroll straight past this. Reading
  // `boundingBox()` reports the element's real rendered position with NO
  // scroll performed, so this proves reachability, not just clickability.
  const containerBox = await box(container);
  const goBox = await box(goButton);
  const skipBox = await box(skipButton);

  // The container's OWN box height is what the 30dvh max-height actually
  // caps — comparing against the PAGE viewport instead would miss the bug
  // entirely, because a child clipped by its ancestor's `overflow: auto`
  // can still sit well inside the page's overall viewport bounds while
  // being genuinely unreachable without scrolling that ancestor.
  for (const [label, target] of [
    ["Go", goBox],
    ["Skip", skipBox],
  ] as const) {
    expect(target.y, `${label} row top vs. the panel's own scrollport`).toBeGreaterThanOrEqual(
      containerBox.y - EDGE_TOLERANCE_PX
    );
    expect(
      target.y + target.height,
      `${label} row bottom vs. the panel's own scrollport`
    ).toBeLessThanOrEqual(containerBox.y + containerBox.height + EDGE_TOLERANCE_PX);
  }
});

for (const viewport of [
  { label: "desktop", width: 1280, height: 900 },
  { label: "mobile", width: 390, height: 844 },
] as const) {
  test(`${viewport.label}: Replan with the prompt UNCHANGED sends the open round's answers, not null @mock`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openMidPlanClarify(page);

    const clarify = page.locator(".clarify--stage");
    // Answer "When?" only — kind and vibe stay blank, deliberately, to
    // prove the PARTIAL-round path (the same one "Go" already uses via
    // submitClarify's own `.filter((a) => a.answer !== "")`) rather than
    // requiring every question answered.
    await clarify.getByRole("button", { name: "this evening" }).click();

    const secondParse = page.waitForRequest(
      (request) => request.url().includes("/api/parse") && request.method() === "POST"
    );
    // REPLAN — the topbar's own submit, never the clarify panel's "Go" —
    // with the prompt text left exactly as it was. This is the regression
    // itself: before the fix, this unconditionally cleared `clarify` and
    // replanned from scratch with no answers.
    await page.locator(".topbar__go").click();
    const request = await secondParse;
    const body = JSON.parse(request.postData() ?? "{}") as { answers?: unknown };

    expect(body.answers, "the open round's answers must ride on the Replan request").toEqual([
      { question: "When?", answer: "this evening" },
    ]);

    // And the actual user-visible symptom: the SAME questions must not
    // silently reappear empty. Checked surface-agnostically (map chips,
    // never `.lstrip__stop`) because the desktop list is CSS-hidden at the
    // mobile width this test also runs at — see mobile.spec.ts's own note
    // that `.lstrip` is mounted-but-not-visible there.
    await expect(page.locator(".clarify")).toHaveCount(0, { timeout: 30_000 });
    await expect(page.locator(".chip").first()).toBeVisible({ timeout: 30_000 });
  });
}

test("Replan with the prompt EDITED starts fresh, today's behavior, on both engines @mock", async ({
  page,
}) => {
  await openMidPlanClarify(page);
  const clarify = page.locator(".clarify--stage");
  await clarify.getByRole("button", { name: "this evening" }).click();

  // A DIFFERENT vague prompt — still triggers the same three-question shape
  // (no signal regex matches either phrase, and neither states a time, so
  // both fall to the general pool and both ask "When?"), but it is a
  // different REQUEST, and the answer just given belongs to the old one.
  // ("tonight" was deliberately avoided here: mockTime resolves it to a
  // concrete hour, which would suppress the "When?" question entirely and
  // prove nothing about this test's actual claim.)
  await page.locator(".topbar__input").fill("no idea what to do");

  const secondParse = page.waitForRequest(
    (request) => request.url().includes("/api/parse") && request.method() === "POST"
  );
  await page.locator(".topbar__go").click();
  const request = await secondParse;
  const body = JSON.parse(request.postData() ?? "{}") as { answers?: unknown };

  // No `answers` key at all — planFrom only sends one when a non-empty
  // array is passed, and an edited prompt takes the normal fresh-start path
  // (no `answers` argument), exactly as before this fix.
  expect(body.answers, "an edited prompt must start fresh, carrying no stale answers").toBeUndefined();

  // The new round is genuinely unanswered — clarifyAnswers was reset, not
  // merely re-rendered with the old selection still applied.
  const freshClarify = page.locator(".clarify--stage");
  await expect(freshClarify).toBeVisible({ timeout: 30_000 });
  await expect(freshClarify).toContainText("When?");
  await expect(freshClarify.getByRole("button", { name: "this evening" })).not.toHaveClass(
    /chipbtn--on/
  );
});

test("Return in the clarify answer input submits like Go @mock", async ({ page }) => {
  await page.goto("/");
  await page.locator(".prompt__input").fill("not sure what to do");
  await page.locator(".prompt__go").click();

  const clarify = page.locator(".clarify");
  await expect(clarify).toBeVisible({ timeout: 30_000 });
  const whenQuestion = clarify.locator(".clarify__q", { hasText: "When?" });
  // Free text, not a chip tap — the input this fix wires up — and typed to
  // match a chip's own value exactly, so the deterministic mock resolves it
  // identically to clicking "this evening" rather than falling through to a
  // less predictable free-text time parse.
  await whenQuestion.locator(".clarify__input").fill("this evening");
  await whenQuestion.locator(".clarify__input").press("Enter");

  // Same outcome as scenarios.spec.ts's "vague-but-sincere" test, which
  // reaches this exact plan by clicking "Go" — Return must land identically.
  await expandDesktopItinerary(page, { waitForDock: true });
  await expect(page.locator(".lstrip")).toBeVisible({ timeout: 30_000 });
  await expect(stripCard(page, "Fixture General One")).toBeVisible();
});
