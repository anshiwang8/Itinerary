import { test as base, expect } from "@playwright/test";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Mock E2E is browser-offline by construction: every non-local HTTP(S)
 * request is aborted. Live config opts out explicitly because it exercises
 * the real browser Maps provider.
 */
export const test = base.extend({
  page: async ({ page }, provide) => {
    if (process.env.E2E_ALLOW_EXTERNAL_BROWSER !== "1") {
      await page.route(/^https?:\/\//, async (route) => {
        const host = new URL(route.request().url()).hostname;
        if (LOCAL_HOSTS.has(host)) await route.continue();
        else await route.abort("internetdisconnected");
      });
    }
    await provide(page);
  },
});

export { expect };
