// Driving the REAL app through its REAL UI.
//
// Selector policy, matching the repo's existing accessibility-first e2e
// style: prefer role + accessible name for anything a person operates (the
// travel-mode radios, the End dialog's buttons, the live-location toggle),
// because those names are contractual and survive restyling. Structural
// classes are used only where the app has no accessible handle for the thing
// being located (which card is which, whether a card carries the arrival
// wash), and every such use is named once in SEL below so a rename is one
// edit rather than a sweep.
//
// The one hard rule inherited from CLAUDE.md: NEVER click a stop card's BOX.
// `.lstrip` is a flex row, cards stretch to the tallest, and a click at a
// card's centre can land outside its own select button, selecting nothing,
// silently. Always go through `selectStopByIndex`.

import type { Page } from "@playwright/test";

export const SEL = {
  promptInput: ".prompt__input",
  cityInput: "#q-city",
  startInput: "#q-start",
  planGo: ".prompt__go",
  landingError: ".empty__err",
  stageError: ".stage__err",
  dock: ".itinerary-dock",
  dockSummary: ".itinerary-dock__summary",
  strip: ".lstrip",
  sheet: ".msheet",
  stopCard: ".lstrip__stop",
  stopName: ".lstrip__name",
  stopSelect: ".lstrip__select",
  stopSelected: ".lstrip__stop--sel",
  stopArrived: ".lstrip__stop--arrived",
  stopLive: ".lstrip__stop--live",
  stopDone: ".lstrip__stop--done",
  beHere: ".lstrip__be",
  swapInput: ".lstrip__swapinput",
  swapGo: ".lstrip__swapgo",
  swapError: ".lstrip__swaperr",
  removeArm: ".lstrip__removearm",
  removeGo: ".lstrip__removego",
  legSelect: ".lstrip__legselect",
  legLine: ".lstrip__legline",
  timeline: ".lstrip__timeline",
  routeBadge: ".lstrip__tlbadge",
  banner: ".banner",
  chip: ".chip",
  mapWrap: ".mapwrap",
  youMarker: ".mk--you",
  youMarkerStale: ".mk--you-stale",
  liveToggle: ".mapctl--live",
  endButton: ".topbar__stop",
  endDialog: ".stopdlg",
  historyPill: ".acct__hist",
  historyPanel: ".hist",
  clarifySkip: "Skip, just plan it",
  recoveryPanel: ".recover",
  recoveryReason: ".recover__reason",
  recoverySkip: ".recover__skip",
  recoveryWiden: ".recover__widen",
  recoveryOverride: ".recover__override",
  recoveryGeocode: ".recover__geocode",
} as const;

export interface PlanRequest {
  prompt: string;
  city?: string;
  startAddress?: string;
  travelMode?: "transit" | "driving";
}

export interface PlanOutcome {
  ok: boolean;
  /** The app's own fail-loud text, when it refused. */
  failure: string | null;
  /** A clarifying-question round appeared and was skipped. */
  clarified: boolean;
  /** The interactive recovery panel appeared, and how it was answered. */
  recovered: string | null;
  elapsedMs: number;
}

/** Type the landing form and plan. Never throws on a refusal: a refusal is an
 *  outcome this harness reports, not a crash. */
export async function planFromLanding(
  page: Page,
  request: PlanRequest,
  timeoutMs = 120_000
): Promise<PlanOutcome> {
  const started = Date.now();
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator(SEL.promptInput).waitFor({ state: "visible", timeout: 30_000 });
  await fillLandingForm(page, request);
  if (request.travelMode) {
    await page
      .getByRole("radio", { name: request.travelMode === "driving" ? "Drive" : "Transit" })
      .first()
      .click();
  }
  await page.locator(SEL.planGo).click();

  const clarified = await skipClarifyIfShown(page, timeoutMs);
  const recovered = await resolveRecoveryIfShown(page, timeoutMs);

  const outcome = page
    .locator(
      SEL.dock + ":visible, " + SEL.strip + ":visible, " + SEL.sheet + ":visible, " +
        SEL.landingError + ", " + SEL.stageError
    )
    .first();
  try {
    await outcome.waitFor({ state: "visible", timeout: timeoutMs });
  } catch {
    return {
      ok: false,
      failure: "timed out waiting for a plan or an error",
      clarified,
      recovered,
      elapsedMs: Date.now() - started,
    };
  }

  const error = page.locator(SEL.landingError + ", " + SEL.stageError).first();
  if (await error.isVisible().catch(() => false)) {
    return {
      ok: false,
      failure: (await error.innerText()).trim(),
      clarified,
      recovered,
      elapsedMs: Date.now() - started,
    };
  }
  await expandDesktopItinerary(page);
  return { ok: true, failure: null, clarified, recovered, elapsedMs: Date.now() - started };
}

/**
 * Fill the three landing fields and wait until the app AGREES they are filled.
 *
 * THE RACE THIS CLOSES: the landing page is server-rendered, so the inputs are
 * on screen and typeable before React has hydrated. A `fill` in that window
 * writes the DOM value, hydration then re-renders from the component's own
 * (empty) state, and the submit button stays `disabled` on `!prompt.trim() ||
 * !city.trim()` forever. The symptom is a 30s click timeout on an
 * `aria-label="Plan it"` button, which reads exactly like a broken selector
 * rather than a timing problem. The submit button's own enabled state is
 * derived from React state, so it is the honest signal that the typing landed.
 */
async function fillLandingForm(page: Page, request: PlanRequest): Promise<void> {
  const go = page.locator(SEL.planGo);
  const deadline = Date.now() + 30_000;
  for (let attempt = 0; ; attempt++) {
    await page.locator(SEL.promptInput).fill(request.prompt);
    if (request.city !== undefined) await page.locator(SEL.cityInput).fill(request.city);
    if (request.startAddress !== undefined) {
      await page.locator(SEL.startInput).fill(request.startAddress);
      // The starting-location dropdown opens on focus. Escape closes it
      // without touching what was typed, so it cannot cover the submit button.
      await page.keyboard.press("Escape");
    }
    if (await go.isEnabled().catch(() => false)) return;
    if (Date.now() > deadline) return; // let the click report the real state
    await page.waitForTimeout(Math.min(1_000, 200 * (attempt + 1)));
  }
}

/** A thin prompt may raise the clarifying round first. Skipping it runs the
 *  default pipeline. Targeted by accessible NAME, because the recovery
 *  panel's "Plan without it" shares the same class and clicking that would
 *  silently drop a stop. */
export async function skipClarifyIfShown(page: Page, timeoutMs: number): Promise<boolean> {
  const anything = page
    .locator(
      ".clarify:visible, " + SEL.dock + ":visible, " + SEL.strip + ":visible, " +
        SEL.sheet + ":visible, " + SEL.landingError + ", " + SEL.stageError
    )
    .first();
  try {
    await anything.waitFor({ state: "visible", timeout: timeoutMs });
  } catch {
    return false;
  }
  const skip = page.getByRole("button", { name: SEL.clarifySkip });
  if (await skip.isVisible().catch(() => false)) {
    await skip.click();
    return true;
  }
  return false;
}

/**
 * Answer the interactive recovery panel the way an ordinary user would.
 *
 * The panel is a legitimate, frequently-reached outcome, not an error: a
 * geocode with more than one valid match, a category whose pool came back
 * empty, or one emptied specifically by the weather gate. It is neither the
 * itinerary nor the fail-loud surface, so a harness that waits only for those
 * two sits there until it times out and then reports "no plan" — which reads
 * as a planning failure when the app was in fact asking a question.
 *
 * The answers chosen are the least destructive one available at each mode, in
 * this order:
 *   geocode      -> the FIRST candidate. Never index zero of the provider's
 *                   own list (the app already refuses to do that); this is a
 *                   deliberate pick from the candidates the app validated and
 *                   offered, and the choice is recorded in the report.
 *   empty        -> "Plan without it", which keeps every stop that DID
 *                   resolve. Offered only when something else resolved, so
 *                   when it is absent the widen offer is taken instead.
 *   weather-gate -> "Still want it", which re-searches that one category with
 *                   only the weather gate skipped.
 *
 * Returns a description of what was answered, or null if no panel appeared.
 */
export async function resolveRecoveryIfShown(
  page: Page,
  timeoutMs: number
): Promise<string | null> {
  const panel = page.locator(SEL.recoveryPanel).first();
  const settled = page
    .locator(
      SEL.recoveryPanel + ":visible, " + SEL.dock + ":visible, " + SEL.strip +
        ":visible, " + SEL.sheet + ":visible, " + SEL.landingError + ", " + SEL.stageError
    )
    .first();
  try {
    await settled.waitFor({ state: "visible", timeout: timeoutMs });
  } catch {
    return null;
  }
  if (!(await panel.isVisible().catch(() => false))) return null;

  const reason = (await page.locator(SEL.recoveryReason).first().innerText().catch(() => ""))
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 200);

  const attempts: Array<{ locator: string; label: string }> = [
    { locator: SEL.recoveryGeocode, label: "chose the first offered address candidate" },
    { locator: SEL.recoverySkip, label: 'chose "Plan without it"' },
    { locator: SEL.recoveryOverride, label: 'chose "Still want it"' },
    { locator: SEL.recoveryWiden, label: "widened the search for the empty category" },
  ];
  for (const attempt of attempts) {
    const button = page.locator(attempt.locator).first();
    if (!(await button.isVisible().catch(() => false))) continue;
    await button.click();
    await page.waitForTimeout(1_500);
    // Widening or overriding can land back on the panel with a new question.
    // One more pass answers that; a third would be a loop, so it stops there
    // and lets the caller report whatever state it ended in.
    if (await panel.isVisible().catch(() => false)) {
      for (const second of attempts) {
        const next = page.locator(second.locator).first();
        if (!(await next.isVisible().catch(() => false))) continue;
        await next.click();
        await page.waitForTimeout(1_500);
        return "recovery panel (" + reason + "): " + attempt.label + ", then " + second.label;
      }
    }
    return "recovery panel (" + reason + "): " + attempt.label;
  }
  return "recovery panel (" + reason + "): no answerable control was offered";
}

/** The desktop sidebar is compact until interaction. Open it through its own
 *  disclosure control, never by faking a hover. */
export async function expandDesktopItinerary(page: Page): Promise<void> {
  const summary = page.locator(SEL.dockSummary);
  if (!(await summary.isVisible().catch(() => false))) return;
  if ((await summary.getAttribute("aria-expanded")) !== "true") {
    await summary.focus();
    await summary.press("Enter");
  }
  const inDock = await page
    .locator(SEL.dock)
    .evaluate((element) => element.contains(document.activeElement))
    .catch(() => false);
  if (!inDock) await summary.focus().catch(() => undefined);
  await page
    .locator(SEL.strip)
    .waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => undefined);
}

export async function stopCardNames(page: Page): Promise<string[]> {
  await expandDesktopItinerary(page);
  const names = await page.locator(SEL.stopCard + " " + SEL.stopName).allInnerTexts();
  return names.map((name) => name.trim());
}

export function cardByIndex(page: Page, index: number) {
  return page.locator(SEL.stopCard).nth(index);
}

/** Select a card and wait for the selection to stick, closing the app's own
 *  auto-select-stop-0 race, which otherwise silently undoes the click. */
export async function selectStopByIndex(page: Page, index: number): Promise<void> {
  await expandDesktopItinerary(page);
  await page
    .locator(SEL.stopSelected)
    .first()
    .waitFor({ state: "visible", timeout: 20_000 })
    .catch(() => undefined);
  const card = cardByIndex(page, index);
  await card.locator(SEL.stopSelect).click();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const cls = (await card.getAttribute("class")) ?? "";
    if (cls.includes("lstrip__stop--sel")) return;
    await page.waitForTimeout(200);
  }
  throw new Error("stop card " + index + " would not take selection");
}

export interface MutationOutcome {
  status: number | null;
  body: unknown;
  banner: string | null;
  inlineError: string | null;
}

async function withMutation(
  page: Page,
  route: RegExp,
  act: () => Promise<void>,
  timeoutMs = 90_000
): Promise<MutationOutcome> {
  const wait = page.waitForResponse(
    (response) => response.request().method() === "POST" && route.test(response.url()),
    { timeout: timeoutMs }
  );
  await act();
  let status: number | null = null;
  let body: unknown = null;
  try {
    const response = await wait;
    status = response.status();
    body = await response.json().catch(() => null);
  } catch {
    status = null;
  }
  // Let the banner appear. A success banner auto-dismisses after ~7s, so read
  // it promptly; a refusal banner persists and is always readable.
  await page.waitForTimeout(900);
  const banner = await readBanner(page);
  const inline = page.locator(SEL.swapError).first();
  const inlineError = (await inline.isVisible().catch(() => false))
    ? (await inline.innerText()).trim()
    : null;
  return { status, body, banner, inlineError };
}

export async function readBanner(page: Page): Promise<string | null> {
  const banner = page.locator(SEL.banner).first();
  if (!(await banner.isVisible().catch(() => false))) return null;
  return (await banner.innerText()).trim();
}

export async function swapStopByIndex(
  page: Page,
  index: number,
  refinement: string
): Promise<MutationOutcome> {
  await selectStopByIndex(page, index);
  const card = cardByIndex(page, index);
  const input = card.locator(SEL.swapInput);
  await input.waitFor({ state: "visible", timeout: 20_000 });
  await input.fill(refinement);
  return withMutation(page, /\/api\/itinerary\/[^/]+\/swap$/, async () => {
    await card.locator(SEL.swapGo).click();
  });
}

export async function removeStopByIndex(page: Page, index: number): Promise<MutationOutcome> {
  await selectStopByIndex(page, index);
  const card = cardByIndex(page, index);
  const arm = card.locator(SEL.removeArm);
  await arm.waitFor({ state: "visible", timeout: 20_000 });
  await arm.click();
  const confirm = card.locator(SEL.removeGo);
  await confirm.waitFor({ state: "visible", timeout: 10_000 });
  return withMutation(page, /\/api\/itinerary\/[^/]+\/remove$/, async () => {
    await confirm.click();
  });
}

export async function switchMode(
  page: Page,
  mode: "transit" | "driving"
): Promise<MutationOutcome> {
  const option = page
    .locator(".topbar__mode")
    .getByRole("radio", { name: mode === "driving" ? "Drive" : "Transit" });
  await option.waitFor({ state: "visible", timeout: 20_000 });
  const outcome = await withMutation(page, /\/api\/itinerary\/[^/]+\/mode$/, async () => {
    await option.click();
  });
  await expandDesktopItinerary(page);
  return outcome;
}

/** Turn the map's live-location control on. Found by role + accessible name
 *  (`liveControlLabel`'s wording), with the class as the fallback. */
export async function enableLiveTracking(page: Page): Promise<boolean> {
  const byName = page.getByRole("button", { name: /live location/i }).first();
  const control = (await byName.isVisible().catch(() => false))
    ? byName
    : page.locator(SEL.liveToggle).first();
  if (!(await control.isVisible().catch(() => false))) return false;
  if ((await control.getAttribute("aria-pressed")) === "true") return true;
  await control.click();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await control.getAttribute("aria-pressed")) === "true") return true;
    await page.waitForTimeout(200);
  }
  return false;
}

export async function mapState(page: Page): Promise<string | null> {
  return page
    .locator(SEL.mapWrap)
    .first()
    .getAttribute("data-map-state")
    .catch(() => null);
}

export async function endPlan(
  page: Page,
  choice: "save-end" | "discard-end"
): Promise<{ opened: boolean; clicked: string | null }> {
  const end = page.locator(SEL.endButton).first();
  if (!(await end.isVisible().catch(() => false))) return { opened: false, clicked: null };
  await end.click();
  const dialog = page.locator(SEL.endDialog);
  await dialog.waitFor({ state: "visible", timeout: 15_000 });
  // A guest is offered only "End itinerary" + "Cancel"; a real account also
  // gets "Save & end". Match the labels the dialog actually publishes.
  const names =
    choice === "save-end" ? [/^Save & end$/] : [/^Discard & end$/, /^End itinerary$/];
  for (const name of names) {
    const button = dialog.getByRole("button", { name });
    if (await button.isVisible().catch(() => false)) {
      const label = (await button.innerText()).trim();
      await button.click();
      await dialog.waitFor({ state: "hidden", timeout: 45_000 }).catch(() => undefined);
      return { opened: true, clicked: label };
    }
  }
  return { opened: true, clicked: null };
}

/** Open the history panel from wherever this session's identity puts it: the
 *  guest pill, or the account menu's History item. Landing-only by design, so
 *  the plan must already be over. */
export async function openHistory(page: Page): Promise<boolean> {
  const guestPill = page.locator(SEL.historyPill).first();
  if (await guestPill.isVisible().catch(() => false)) {
    await guestPill.click();
  } else {
    const trigger = page.locator(".acct button[aria-haspopup='menu']").first();
    if (!(await trigger.isVisible().catch(() => false))) return false;
    await trigger.click();
    const item = page.getByRole("menuitem", { name: /history/i }).first();
    if (!(await item.isVisible().catch(() => false))) return false;
    await item.click();
  }
  const panel = page.locator(SEL.historyPanel).first();
  await panel.waitFor({ state: "visible", timeout: 20_000 }).catch(() => undefined);
  return panel.isVisible().catch(() => false);
}

export async function historyText(page: Page): Promise<string> {
  const panel = page.locator(SEL.historyPanel).first();
  if (!(await panel.isVisible().catch(() => false))) return "";
  return (await panel.innerText()).trim();
}
