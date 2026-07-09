import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// LIVE MODE — occasional real-world checks against the actual APIs on
// :3000 (reuses a running dev server; starts one WITHOUT E2E_MOCK if
// none). Burns real Groq/Places/Routes quota; results vary run to run.
// Fixture-only tests (tagged @mock) are excluded via grep in the npm
// script. Run: npm run test:e2e:live
export default defineConfig({
  ...base,
  timeout: 150_000,
  use: {
    ...base.use,
    baseURL: "http://localhost:3000",
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
