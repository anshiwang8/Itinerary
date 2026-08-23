// Em-dash removal: the rendered-surface half of the guard. `emdashGuard
// .test.ts` proves no em-dash survives in SOURCE outside its explicit
// allowlist (prompts, regexes, dev-only logs, legitimate en-dash ranges);
// this proves no em-dash reaches the SCREEN across the app's major surfaces
// — the landing hero, a planned strip, a fail-loud message, a swap banner, a
// remove banner, and both recovery panels. Two different failure modes: a
// static string that slipped past the source guard's allowlist by mistake,
// or a MODEL response that ignored its "no em-dash" instruction and reached
// the UI unsanitized. Fixture-deterministic throughout, so this never flakes
// on live model output.
import { expect, test } from "./test";
import {
  dismissClarifyIfShown,
  planEvening,
  planExpectingProblem,
  removeOn,
  swapOn,
} from "./helpers";

const EM_DASH = "—";

async function bodyText(page: import("@playwright/test").Page): Promise<string> {
  return page.locator("body").innerText();
}

test("@mock the landing hero has no em-dash (the slogan swap and title fix)", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".empty__sub")).toHaveText("time to leave.");
  const text = await bodyText(page);
  expect(text).not.toContain(EM_DASH);
  expect(text).not.toContain("life moves simpler");
});

test("@mock a planned evening's strip, weather chip and legs carry no em-dash", async ({
  page,
}) => {
  await planEvening(page, "dinner and drinks tonight");
  const text = await bodyText(page);
  expect(text).not.toContain(EM_DASH);
});

test("@mock a fail-loud message carries no em-dash", async ({ page }) => {
  // CONTRADICTION_MESSAGE's trigger — the exact-text pin lives in
  // failloud.spec.ts; this only checks the dash.
  const message = await planExpectingProblem(page, "cheap fancy dinner");
  expect(message).not.toContain(EM_DASH);
});

test("@mock a swap banner carries no em-dash", async ({ page }) => {
  await planEvening(page, "dinner and drinks tonight");
  await swapOn(page, "Velvet Fig", "somewhere cheaper");
  const banner = page.locator(".banner");
  await expect(banner).toBeVisible();
  await expect(banner).not.toContainText(EM_DASH);
});

test("@mock a remove banner carries no em-dash", async ({ page }) => {
  await planEvening(page, "dinner and drinks tonight");
  await removeOn(page, "Velvet Fig");
  const banner = page.locator(".banner");
  await expect(banner).toBeVisible();
  await expect(banner).not.toContainText(EM_DASH);
});

test("@mock the empty-category recovery panel carries no em-dash", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(".prompt__input").fill("dumplings then a bar at 7pm in Ossington");
  await page.locator(".prompt__go").click();
  await dismissClarifyIfShown(page);
  await expect(page.locator(".recover")).toBeVisible({ timeout: 90_000 });
  const text = await bodyText(page);
  expect(text).not.toContain(EM_DASH);
});

test("@mock the weather-gate recovery panel carries no em-dash", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(".prompt__input").fill("dinner and a walk in the park at 3pm");
  await page.locator(".prompt__go").click();
  await dismissClarifyIfShown(page);
  await expect(page.locator(".recover--gate")).toBeVisible({ timeout: 30_000 });
  const text = await bodyText(page);
  expect(text).not.toContain(EM_DASH);
});
