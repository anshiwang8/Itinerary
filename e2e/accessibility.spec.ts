import { createRequire } from "node:module";
import type { Page } from "@playwright/test";
import { test, expect } from "./test";
import { planEvening, stripCard } from "./helpers";

const nodeRequire = createRequire(`${process.cwd()}/package.json`);
const AXE_PATH = nodeRequire.resolve("axe-core/axe.min.js");
const GOOGLE_FONT_HOSTS = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);

interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  helpUrl: string;
  nodes: { target: string[]; failureSummary?: string }[];
}

declare global {
  interface Window {
    axe: {
      run: (
        context: Document,
        options: {
          runOnly: { type: "tag"; values: string[] };
          resultTypes: ["violations"];
        }
      ) => Promise<{ violations: AxeViolation[] }>;
    };
  }
}

async function expectNoSeriousAxeViolations(
  page: Page,
  surface: string
): Promise<void> {
  const hasAxe = await page.evaluate(() => typeof window.axe?.run === "function");
  if (!hasAxe) await page.addScriptTag({ path: AXE_PATH });

  const blockers = await page.evaluate(async () => {
    const result = await window.axe.run(document, {
      runOnly: {
        type: "tag",
        values: [
          "wcag2a",
          "wcag2aa",
          "wcag21a",
          "wcag21aa",
          "wcag22a",
          "wcag22aa",
        ],
      },
      resultTypes: ["violations"],
    });
    return result.violations
      .filter(
        (violation) =>
          violation.impact === "serious" || violation.impact === "critical"
      )
      .map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        help: violation.help,
        helpUrl: violation.helpUrl,
        nodes: violation.nodes.map((node) => ({
          target: node.target,
          failureSummary: node.failureSummary,
        })),
      }));
  });

  expect(
    blockers,
    `${surface} has serious/critical WCAG A/AA violations:\n${JSON.stringify(
      blockers,
      null,
      2
    )}`
  ).toEqual([]);
}

function stopSelection(page: Page, venueName: string) {
  return stripCard(page, venueName).locator(".lstrip__select");
}

async function expectVisibleFocusIndicator(
  page: Page,
  selector: string
): Promise<void> {
  const presentation = await page.locator(selector).evaluate((element) => {
    const style = getComputedStyle(element);
    const card = element.closest(".lstrip__stop");
    const background = getComputedStyle(card ?? document.body).backgroundColor;
    const channels = (color: string): number[] =>
      (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const luminance = (color: string): number => {
      const [r = 0, g = 0, b = 0] = channels(color).map((channel) => {
        const value = channel / 255;
        return value <= 0.04045
          ? value / 12.92
          : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const foregroundLuminance = luminance(style.outlineColor);
    const backgroundLuminance = luminance(background);
    const contrast =
      (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
      (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);

    return {
      focusVisible: element.matches(":focus-visible"),
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
      outlineColor: style.outlineColor,
      contrast,
    };
  });

  expect(presentation.focusVisible).toBe(true);
  expect(presentation.outlineStyle).not.toBe("none");
  expect(presentation.outlineWidth).toBeGreaterThanOrEqual(2);
  expect(presentation.outlineColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(
    presentation.contrast,
    "the focus indicator must have at least 3:1 contrast against the card"
  ).toBeGreaterThanOrEqual(3);
}

test("empty, planned, and expanded-swap surfaces pass axe and load only self-hosted fonts @mock", async ({
  page,
}) => {
  const googleFontRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (GOOGLE_FONT_HOSTS.has(url.hostname)) googleFontRequests.push(request.url());
  });

  await page.goto("/");
  await page.evaluate(async () => {
    await document.fonts.ready;
  });

  const loadedFamilies = await page.evaluate(() =>
    Array.from(document.fonts)
      .filter((face) => face.status === "loaded")
      .map((face) => face.family.replace(/^["']|["']$/g, ""))
  );
  expect(loadedFamilies).toContain("Fraunces Variable");
  expect(loadedFamilies).toContain("Space Grotesk Variable");
  await expectNoSeriousAxeViolations(page, "empty planner");

  await planEvening(page, "dinner and drinks");
  await expectNoSeriousAxeViolations(page, "planned itinerary");

  const velvetSelection = stopSelection(page, "Velvet Fig");
  await expect(velvetSelection).toBeVisible();
  await expect(velvetSelection).toHaveAccessibleName(
    /View stop 1:.*dinner.*Velvet Fig/i
  );
  await expect(velvetSelection).toHaveAccessibleName(/7:16 PM/);
  await expect(velvetSelection).toHaveAccessibleName(/4\.8.*\$\$\$/);
  await expect(velvetSelection).toHaveAccessibleName(
    /Dim-lit modern bistro known for fig-glazed duck/i
  );
  await expect(
    velvetSelection.locator(
      'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]'
    ),
    "the stop selection button must not contain another interactive control"
  ).toHaveCount(0);
  await expect(
    page.locator('.lstrip > :not([role="listitem"])'),
    "every direct child of the itinerary list must expose listitem semantics"
  ).toHaveCount(0);

  await velvetSelection.focus();
  await page.keyboard.press("Enter");
  const swapForm = stripCard(page, "Velvet Fig").getByRole("form", {
    name: "Change Velvet Fig",
  });
  await expect(swapForm).toBeVisible();
  await expect(
    swapForm.evaluate((form) => form.closest("button") === null),
    "the swap form must be a sibling surface, not nested in the selection button"
  ).resolves.toBe(true);
  await expectNoSeriousAxeViolations(page, "expanded swap form");

  expect(googleFontRequests, "Google Fonts hosts must never be requested").toEqual(
    []
  );
});

test("keyboard-only swaps submit through the sibling form and restore focus after changed- and same-ID mutations @mock", async ({
  page,
}) => {
  await planEvening(page, "dinner and drinks");

  const velvetSelection = stopSelection(page, "Velvet Fig");
  await velvetSelection.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");

  const velvetInput = stripCard(page, "Velvet Fig").getByRole("textbox", {
    name: "Not quite right?",
  });
  await expect(velvetInput).toBeFocused();
  await expectVisibleFocusIndicator(page, ".lstrip__swapinput");
  await page.keyboard.type("cheaper");

  let releaseVenueSwap!: () => void;
  let markVenueSwapSeen!: () => void;
  const venueSwapGate = new Promise<void>((resolve) => {
    releaseVenueSwap = resolve;
  });
  const venueSwapSeen = new Promise<void>((resolve) => {
    markVenueSwapSeen = resolve;
  });
  await page.route(
    /\/api\/itinerary\/[^/]+\/swap$/,
    async (route) => {
      markVenueSwapSeen();
      await venueSwapGate;
      await route.continue();
    },
    { times: 1 }
  );

  const venueSwapResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/api\/itinerary\/[^/]+\/swap$/.test(response.url())
  );
  await page.keyboard.press("Enter");
  await venueSwapSeen;
  try {
    await expect(
      stripCard(page, "Velvet Fig").getByRole("status")
    ).toHaveText("Updating Velvet Fig…");
  } finally {
    releaseVenueSwap();
  }
  expect((await venueSwapResponse).ok()).toBe(true);

  const cornerSelection = stopSelection(page, "The Corner Table");
  await expect(cornerSelection).toBeVisible();
  await expect(
    cornerSelection,
    "a venue-ID replacement must focus the newly mounted stop button"
  ).toBeFocused();

  await page.keyboard.press("Tab");
  const cornerInput = stripCard(page, "The Corner Table").getByRole(
    "textbox",
    { name: "Not quite right?" }
  );
  await expect(cornerInput).toBeFocused();
  await page.keyboard.type("an hour later");

  const timeSwapResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/api\/itinerary\/[^/]+\/swap$/.test(response.url())
  );
  await page.keyboard.press("Enter");
  expect((await timeSwapResponse).ok()).toBe(true);

  await expect(
    cornerSelection,
    "a same-ID time mutation must issue a fresh nonce and refocus the stop"
  ).toBeFocused();
  await expect(page.getByRole("status").filter({ hasText: /Moved dinner/i })).toBeVisible();
});

test("planning progress is polite and a failed request becomes an accessible alert @mock", async ({
  page,
}) => {
  await page.goto("/");

  let releaseParse!: () => void;
  let markParseSeen!: () => void;
  const parseGate = new Promise<void>((resolve) => {
    releaseParse = resolve;
  });
  const parseSeen = new Promise<void>((resolve) => {
    markParseSeen = resolve;
  });
  await page.route(
    /\/api\/parse$/,
    async (route) => {
      markParseSeen();
      await parseGate;
      await route.abort("failed");
    },
    { times: 1 }
  );

  await page.getByLabel("Describe your evening").fill("dinner and drinks");
  await page.getByRole("button", { name: "Plan it" }).click();
  await parseSeen;
  try {
    await expect(page.getByRole("status")).toHaveText("Reading your evening…");
  } finally {
    releaseParse();
  }

  const alert = page.locator('.empty__err[role="alert"]');
  await expect(alert).toBeVisible();
  await expect(alert).not.toBeEmpty();
  await expect(page.locator(".lstrip")).toHaveCount(0);
});

test("clarification choices expose keyboard selection state @mock", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Describe your evening").fill("not sure what to do");
  const plan = page.getByRole("button", { name: "Plan it" });
  await plan.focus();
  await page.keyboard.press("Enter");

  const kindGroup = page.getByRole("group", {
    name: "What kind of thing?",
  });
  await expect(kindGroup).toBeVisible();
  const drinks = kindGroup.getByRole("button", {
    name: "drinks",
    exact: true,
  });
  const outdoors = kindGroup.getByRole("button", {
    name: "outdoors",
    exact: true,
  });
  await expect(drinks).toHaveAttribute("aria-pressed", "false");
  await drinks.focus();
  await page.keyboard.press("Space");
  await expect(drinks).toBeFocused();
  await expect(drinks).toHaveAttribute("aria-pressed", "true");
  await expect(outdoors).toHaveAttribute("aria-pressed", "false");
});

test("swap and reroute refusals return focus to the affected stop @mock", async ({
  page,
}) => {
  await planEvening(page, "dinner and drinks");

  const velvetSelection = stopSelection(page, "Velvet Fig");
  await velvetSelection.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  const swapInput = stripCard(page, "Velvet Fig").getByRole("textbox", {
    name: "Not quite right?",
  });
  await expect(swapInput).toBeFocused();
  await page.keyboard.type("cheaper");
  await page.route(
    /\/api\/itinerary\/[^/]+\/swap$/,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          swapped: false,
          reason: "No verified better option was found.",
        }),
      }),
    { times: 1 }
  );
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("status").filter({
      hasText: "No verified better option was found.",
    })
  ).toBeVisible();
  await expect(velvetSelection).toBeFocused();

  await page.route(
    /\/api\/itinerary\/[^/]+\/reroute$/,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          rerouted: false,
          reason: "nothing downstream can safely change",
        }),
      }),
    { times: 1 }
  );
  const cancel = page
    .getByRole("region", { name: "Development controls" })
    .getByRole("button", { name: "cancel" });
  await cancel.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("status").filter({
      hasText: "nothing downstream can safely change",
    })
  ).toBeVisible();
  await expect(stopSelection(page, "Ten O'Clock Curfew")).toBeFocused();
});

test("a keyboard-triggered reroute focuses the first stop changed by the server @mock", async ({
  page,
}) => {
  await planEvening(page, "dinner and drinks");

  let releaseReroute!: () => void;
  let markRerouteSeen!: () => void;
  const rerouteGate = new Promise<void>((resolve) => {
    releaseReroute = resolve;
  });
  const rerouteSeen = new Promise<void>((resolve) => {
    markRerouteSeen = resolve;
  });
  await page.route(
    /\/api\/itinerary\/[^/]+\/reroute$/,
    async (route) => {
      markRerouteSeen();
      await rerouteGate;
      await route.continue();
    },
    { times: 1 }
  );

  const cancel = page
    .getByRole("region", { name: "Development controls" })
    .getByRole("button", { name: "cancel" });
  await cancel.focus();
  const rerouteResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/api\/itinerary\/[^/]+\/reroute$/.test(response.url())
  );
  await page.keyboard.press("Enter");
  await rerouteSeen;
  try {
    await expect(page.locator(".loading[role='status']")).toHaveText(
      "Replanning the route…"
    );
  } finally {
    releaseReroute();
  }

  const response = await rerouteResponse;
  expect(response.ok()).toBe(true);
  const result = (await response.json()) as {
    rerouted: boolean;
    changed?: { after?: { name?: string | null } }[];
  };
  expect(result.rerouted).toBe(true);
  const firstChangedName = result.changed?.[0]?.after?.name;
  expect(firstChangedName).toBeTruthy();

  await expect(
    stopSelection(page, firstChangedName!),
    "focus must follow the first changed stop reported by the reroute"
  ).toBeFocused();
});
