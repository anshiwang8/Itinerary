import { defineConfig } from "@playwright/test";

// DEFAULT = MOCK MODE. Playwright starts its own dev server on :3100 with
// E2E_MOCK=1 (deterministic fixture pipeline — no Groq/Places/Routes/
// Weather quota). Port 3100 is reserved for mock e2e so a manually-run
// live server on :3000 is never touched. For occasional real-world
// checks use playwright.live.config.ts (npm run test:e2e:live).
// - Serial (workers: 1): tests share one dev server + in-memory store.
// - NEVER runs `next build`.
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3100",
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev -- -p 3100",
    url: "http://localhost:3100",
    reuseExistingServer: true,
    timeout: 60_000,
    env: { ...(process.env as Record<string, string>), E2E_MOCK: "1" },
  },
});
