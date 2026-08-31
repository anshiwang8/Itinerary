import type { Page, Route } from "@playwright/test";
import { test, expect } from "./test";
import {
  dismissClarifyIfShown,
  planEvening,
  stripCard,
  swapOn,
  expectStripMatchesPin,
} from "./helpers";

test("@mock D7 End is disabled throughout an in-flight swap and enabled after it settles", async ({ page }) => {
  await planEvening(page, "dinner and drinks at 7pm");
  await expect(page.locator(".topbar__go")).toBeEnabled();
  let release!: () => void;
  let received!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const requested = new Promise<void>((resolve) => { received = resolve; });
  await page.route(/\/api\/itinerary\/[^/]+\/swap$/, async (route) => {
    received();
    await held;
    await route.continue();
  });
  const swapping = swapOn(page, "Velvet Fig", "somewhere cheaper");
  try {
    await requested;
    await expect(page.locator(".topbar__stop")).toBeDisabled();
    // A real disabled control cannot open the dialog, including a native
    // click initiated without Playwright waiting for it to become enabled.
    await page.locator(".topbar__stop").evaluate((button: HTMLButtonElement) => button.click());
    await expect(page.locator(".stopdlg")).toHaveCount(0);
  } finally {
    release();
    await swapping;
  }
  await expectStripMatchesPin(page, "The Corner Table");
  await expect(page.locator(".topbar__stop")).toBeEnabled();
});

const INITIAL_PROMPT = "dinner and drinks at 7pm";

async function submitPlan(page: Page): Promise<void> {
  await page.goto("/");
  await page.locator(".prompt__input").fill(INITIAL_PROMPT);
  await page.locator(".prompt__go").click();
  await dismissClarifyIfShown(page);
}

async function expectInitialFailureClearsBusy(page: Page): Promise<void> {
  const error = page.locator(".empty__err");
  await expect(error).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".empty__status")).toHaveCount(0);
  await expect(page.locator(".prompt__go")).toBeEnabled();
  await expect(page.locator(".lstrip")).toHaveCount(0);
}

async function abort(route: Route): Promise<void> {
  await route.abort("internetdisconnected");
}

async function planToEmptyRecovery(page: Page): Promise<void> {
  await page.goto("/");
  await page
    .locator(".prompt__input")
    .fill("dumplings then a bar at 7pm in Ossington");
  await page.locator(".prompt__go").click();
  await dismissClarifyIfShown(page);
  await expect(page.locator(".recover")).toBeVisible({ timeout: 30_000 });
}

async function dispatchEnter(page: Page, selector: string): Promise<void> {
  await page.locator(selector).evaluate((element) => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
      })
    );
  });
}

test.describe("@mock typed client transport", () => {
  const rejectedStages: Array<{
    name: string;
    url: RegExp;
    method?: string;
    handle?: (route: Route) => Promise<void>;
  }> = [
    {
      name: "parse",
      url: /\/api\/parse$/,
    },
    {
      name: "geocode non-JSON",
      url: /\/api\/geocode$/,
      handle: async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<html>private proxy diagnostic</html>",
        });
      },
    },
    {
      name: "places search",
      url: /\/api\/places\/search$/,
    },
    {
      name: "selection invalid shape",
      url: /\/api\/select$/,
      handle: async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ selections: "not-an-array" }),
        });
      },
    },
    {
      name: "travel",
      url: /\/api\/schedule\/travel$/,
    },
    {
      name: "store non-JSON error",
      url: /\/api\/itinerary$/,
      method: "POST",
      handle: async (route) => {
        await route.fulfill({
          status: 502,
          contentType: "text/html",
          body: "<html>private database diagnostic</html>",
        });
      },
    },
    {
      name: "post-store follow-up read",
      url: /\/api\/itinerary\/[^/?]+(?:\?.*)?$/,
      method: "GET",
      handle: async (route) => {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({
            code: "store_read_failed",
            error: "The saved plan could not be read back.",
          }),
        });
      },
    },
  ];

  for (const stage of rejectedStages) {
    test(`${stage.name} failure is contained and clears planning busy state @mock`, async ({
      page,
    }) => {
      await page.route(
        stage.url,
        async (route) => {
          if (stage.method && route.request().method() !== stage.method) {
            await route.continue();
            return;
          }
          await (stage.handle ?? abort)(route);
        },
        { times: 1 }
      );

      await submitPlan(page);
      await expectInitialFailureClearsBusy(page);
      const text = await page.locator(".empty__err").innerText();
      expect(text).not.toContain("private proxy diagnostic");
      expect(text).not.toContain("private database diagnostic");
    });
  }

  test("a failed weather read clears prior weather and remains fail-soft @mock", async ({
    page,
  }) => {
    await planEvening(page, INITIAL_PROMPT);
    await expect(page.locator(".weather")).toBeVisible();

    await page.route(/\/api\/weather(?:\?.*)?$/, abort, { times: 1 });
    await page.locator(".topbar__input").fill("dinner and drinks at 8pm");
    await page.locator(".topbar__go").click();

    // runPipeline clears the old forecast synchronously; the failed new
    // weather read must never let that Toronto chip leak into the new plan.
    await expect(page.locator(".weather")).toHaveCount(0);
    await expect(page.locator(".loading")).toHaveCount(0, { timeout: 30_000 });
    await expect(page.locator(".topbar__go")).toBeEnabled();
    await expect(page.locator(".lstrip")).toBeVisible();
  });

  test("recovery search rejection clears its row busy state for retry @mock", async ({
    page,
  }) => {
    await planToEmptyRecovery(page);

    await page.route(/\/api\/places\/search$/, abort, { times: 1 });
    await page.locator(".recover__widen").click();

    await expect(page.locator(".recover__note")).toContainText(
      "could not be reached",
      { timeout: 30_000 }
    );
    await expect(page.locator(".recover__widen")).toBeEnabled();
    await expect(page.locator(".recover__skip")).toBeEnabled();
  });

  test("an in-flight empty recovery blocks Enter and a competing new plan @mock", async ({
    page,
  }) => {
    await planToEmptyRecovery(page);
    await page.locator(".prompt__input").fill("coffee tomorrow at 10am");

    let releaseRecovery!: () => void;
    const recoveryReleased = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    let competingParses = 0;
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        /\/api\/parse$/.test(request.url())
      ) {
        competingParses += 1;
      }
    });
    await page.route(
      /\/api\/places\/search$/,
      async (route) => {
        await recoveryReleased;
        await route.continue();
      },
      { times: 1 }
    );

    const recoveryRequest = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        /\/api\/places\/search$/.test(request.url())
    );
    await page.locator(".recover__widen").click();
    await recoveryRequest;

    try {
      await expect(page.locator(".prompt__go")).toBeDisabled();
      await dispatchEnter(page, ".prompt__input");
      await page.waitForTimeout(250);
      expect(competingParses).toBe(0);
      await expect(page.locator(".recover")).toBeVisible();
    } finally {
      releaseRecovery();
    }

    await expect(
      page.locator(".lstrip__name", { hasText: "Citywide Dumpling Bar" })
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".lstrip")).not.toContainText(/coffee/i);
  });

  test("an in-flight empty recovery blocks Enter and a competing replan @mock", async ({
    page,
  }) => {
    await planEvening(page, INITIAL_PROMPT);
    await page
      .locator(".topbar__input")
      .fill("dumplings then a bar at 7pm in Ossington");
    await page.locator(".topbar__go").click();
    // The old itinerary strip remains visible while a replan asks its
    // narrowing question, so the generic helper's "strip or clarify"
    // race would resolve on stale UI. This prompt deterministically asks
    // what kind of bar; wait for that new panel before continuing.
    const skipClarify = page.getByRole("button", {
      name: /Skip.*just plan it/i,
    });
    await expect(skipClarify).toBeVisible({ timeout: 30_000 });
    await skipClarify.click();
    await expect(page.locator(".recover")).toBeVisible({ timeout: 30_000 });
    await page.locator(".topbar__input").fill("coffee tomorrow at 10am");

    let releaseRecovery!: () => void;
    const recoveryReleased = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    let competingParses = 0;
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        /\/api\/parse$/.test(request.url())
      ) {
        competingParses += 1;
      }
    });
    await page.route(
      /\/api\/places\/search$/,
      async (route) => {
        await recoveryReleased;
        await route.continue();
      },
      { times: 1 }
    );

    const recoveryRequest = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        /\/api\/places\/search$/.test(request.url())
    );
    await page.locator(".recover__widen").click();
    await recoveryRequest;

    try {
      await expect(page.locator(".topbar__go")).toBeDisabled();
      await dispatchEnter(page, ".topbar__input");
      await page.waitForTimeout(250);
      expect(competingParses).toBe(0);
      await expect(page.locator(".recover")).toBeVisible();
    } finally {
      releaseRecovery();
    }

    await expect(
      page.locator(".lstrip__name", { hasText: "Citywide Dumpling Bar" })
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".lstrip")).not.toContainText(/coffee/i);
  });
});

test.describe("@mock mutation transport", () => {
  test("reroute rejection clears global busy state @mock", async ({ page }) => {
    await planEvening(page, "dinner and drinks");
    await page.route(/\/api\/itinerary\/[^/]+\/reroute$/, abort, { times: 1 });

    await page.locator(".dev").getByRole("button", { name: "cancel" }).click();

    await expect(page.locator(".stage__err")).toContainText(
      "could not be reached",
      { timeout: 30_000 }
    );
    await expect(page.locator(".loading")).toHaveCount(0);
    await expect(page.locator(".topbar__go")).toBeEnabled();
    await expect(
      stripCard(page, "Ten O'Clock Curfew").locator(".lstrip__select")
    ).toBeFocused();
  });

  test("reroute follow-up 500 clears busy and warns that the view is stale @mock", async ({
    page,
  }) => {
    await planEvening(page, "dinner and drinks");
    await page
      .locator('.dev input[type="datetime-local"]')
      .fill(planDayAt(20));
    await expect(stripCard(page, "Velvet Fig").locator(".lstrip__now")).toBeVisible();

    await page.route(
      /\/api\/itinerary\/[^/?]+(?:\?.*)?$/,
      async (route) => {
        if (route.request().method() !== "GET") {
          await route.continue();
          return;
        }
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({
            code: "store_read_failed",
            error: "The replanned itinerary could not be read.",
          }),
        });
      },
      { times: 1 }
    );
    await page.locator(".dev").getByRole("button", { name: "cancel" }).click();

    await expect(page.locator(".stage__err")).toContainText(
      "may be out of date",
      { timeout: 45_000 }
    );
    await expect(page.locator(".loading")).toHaveCount(0);
    await expect(page.locator(".topbar__go")).toBeEnabled();
    await expect(
      stripCard(page, "Ten O'Clock Curfew").locator(".lstrip__select")
    ).toBeFocused();
  });

  test("a committed reroute with an interrupted response reads back saved state @mock", async ({
    page,
  }) => {
    await planEvening(page, "dinner and drinks");
    await page
      .locator('.dev input[type="datetime-local"]')
      .fill(planDayAt(20));
    await expect(
      stripCard(page, "Velvet Fig").locator(".lstrip__now")
    ).toBeVisible();

    let readBacks = 0;
    let mutationCommitted = false;
    await page.route(
      /\/api\/itinerary\/[^/?]+(?:\?.*)?$/,
      async (route) => {
        if (route.request().method() === "GET") readBacks += 1;
        await route.continue();
      }
    );
    await page.route(
      /\/api\/itinerary\/[^/]+\/reroute$/,
      async (route) => {
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        mutationCommitted = true;
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<html>response lost after commit</html>",
        });
      },
      { times: 1 }
    );

    await page.locator(".dev").getByRole("button", { name: "cancel" }).click();

    await expect(page.locator(".stage__err")).toContainText(
      "response was interrupted",
      { timeout: 45_000 }
    );
    await expect(page.locator(".stage__err")).toContainText(
      "latest saved plan was refreshed"
    );
    expect(mutationCommitted).toBe(true);
    await expect.poll(() => readBacks).toBeGreaterThan(0);
    await expect(page.locator(".loading")).toHaveCount(0);
    await expect(page.locator(".topbar__go")).toBeEnabled();
    await expect(
      page.locator(".dev").getByRole("button", { name: "cancel" })
    ).toBeEnabled();
    await expect(
      page.locator(".lstrip__stop").nth(1).locator(".lstrip__select"),
      "the interrupted-response readback must focus its refreshed downstream stop"
    ).toBeFocused();
  });

  test("swap rejection clears the inline busy state @mock", async ({ page }) => {
    await planEvening(page, "dinner and drinks");
    await stripCard(page, "Velvet Fig").click();
    await page.locator(".lstrip__swapinput").fill("cheaper");
    await page.route(/\/api\/itinerary\/[^/]+\/swap$/, abort, { times: 1 });

    await page.locator(".lstrip__swapgo").click();

    await expect(page.locator(".lstrip__swaperr")).toContainText(
      "could not be reached",
      { timeout: 30_000 }
    );
    await expect(page.locator(".lstrip__swapgo")).toBeEnabled();
    await expect(
      stripCard(page, "Velvet Fig").locator(".lstrip__select")
    ).toBeFocused();
  });

  test("swap follow-up 500 clears busy and reports possible stale state @mock", async ({
    page,
  }) => {
    await planEvening(page, "dinner and drinks");
    await stripCard(page, "Velvet Fig").click();
    await page.locator(".lstrip__swapinput").fill("cheaper");
    await page.route(
      /\/api\/itinerary\/[^/?]+(?:\?.*)?$/,
      async (route) => {
        if (route.request().method() !== "GET") {
          await route.continue();
          return;
        }
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({
            code: "store_read_failed",
            error: "The swapped itinerary could not be read.",
          }),
        });
      },
      { times: 1 }
    );

    await page.locator(".lstrip__swapgo").click();

    await expect(page.locator(".lstrip__swaperr")).toContainText(
      "follow-up refresh failed",
      { timeout: 45_000 }
    );
    await expect(page.locator(".lstrip__swapgo")).toBeEnabled();
    await expect(
      stripCard(page, "Velvet Fig").locator(".lstrip__select")
    ).toBeFocused();
  });

  test("a committed swap with an interrupted response reads back saved state @mock", async ({
    page,
  }) => {
    await planEvening(page, "dinner and drinks");
    await stripCard(page, "Velvet Fig").click();
    await page.locator(".lstrip__swapinput").fill("cheaper");

    let readBacks = 0;
    let mutationCommitted = false;
    await page.route(
      /\/api\/itinerary\/[^/?]+(?:\?.*)?$/,
      async (route) => {
        if (route.request().method() === "GET") readBacks += 1;
        await route.continue();
      }
    );
    await page.route(
      /\/api\/itinerary\/[^/]+\/swap$/,
      async (route) => {
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        mutationCommitted = true;
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<html>response lost after commit</html>",
        });
      },
      { times: 1 }
    );

    await page.locator(".lstrip__swapgo").click();

    await expect(page.locator(".lstrip__swaperr")).toContainText(
      "response was interrupted",
      { timeout: 45_000 }
    );
    await expect(page.locator(".lstrip__swaperr")).toContainText(
      "latest saved plan was refreshed"
    );
    expect(mutationCommitted).toBe(true);
    await expect.poll(() => readBacks).toBeGreaterThan(0);
    await expect(page.locator(".lstrip__swapgo")).toBeEnabled();
    await expect(page.locator(".topbar__go")).toBeEnabled();
    await expect(
      stripCard(page, "The Corner Table").locator(".lstrip__select"),
      "the interrupted-response readback must focus the refreshed replacement id"
    ).toBeFocused();
  });
});

function planDayAt(hour: number): string {
  const date = new Date();
  date.setHours(19, 0, 0, 0);
  if (date.getTime() <= Date.now()) date.setDate(date.getDate() + 1);
  date.setHours(hour, 0, 0, 0);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate()
  )}T${pad(hour)}:00`;
}
