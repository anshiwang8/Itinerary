import { defineConfig } from "@playwright/test";

const reporters: [string][] = [["list"]];
if (process.env.E2E_FORCE_EXIT_ON_END === "1") {
  reporters.push(["./scripts/playwrightExitReporter.ts"]);
}

const webServer =
  process.env.E2E_SERVER_PRESTARTED === "1"
    ? undefined
    : {
        // Launch Next directly. On Windows, the npm.cmd → cmd.exe wrapper
        // can survive Playwright's teardown after the assertions pass.
        command: "node node_modules/next/dist/bin/next dev -p 3100",
        url: "http://localhost:3100",
        reuseExistingServer: true,
        timeout: 60_000,
        stdout: "ignore" as const,
        stderr: "ignore" as const,
        env: {
          ...(process.env as Record<string, string>),
          E2E_MOCK: "1",
          // Deliberately fake: mock browsers block every non-local request.
          // Maps resilience specs intercept the script locally so they can
          // exercise reject → retry/remount → success without a real key.
          NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: "e2e-invalid-browser-key",
        },
      };

// DEFAULT = MOCK MODE. The npm test harness starts its own dev server on
// :3100 with E2E_MOCK=1; direct Playwright invocations retain this config's
// equivalent fallback. The fixture pipeline uses no Groq/Places/Routes/
// Weather quota. Port 3100 is reserved for mock e2e, so a manually-run live
// server on :3000 is never touched. For occasional real-world checks use
// playwright.live.config.ts (npm run test:e2e:live).
// - Serial (workers: 1): tests share one dev server + in-memory store.
// - NEVER runs `next build`.
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: reporters,
  use: {
    baseURL: "http://localhost:3100",
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
  },
  webServer,
});
