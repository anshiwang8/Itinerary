// One-time helper: capture a signed-in browser session for the signed-in
// personas.
//
//   npm run test:agents:login
//
// WHY THIS IS INTERACTIVE, AND WHY IT HAS TO BE. The app's only sign-in is
// Google's OAuth popup. Automating a real Google login is unreliable by
// design (Google blocks automation-flagged browsers), and there is no
// password path in this app to script against. So the honest arrangement is:
// a person signs in ONCE by hand in a real browser window, and the resulting
// session is saved for later runs.
//
// Firebase Auth keeps its session in IndexedDB, not cookies, which is why
// `storageState({ indexedDB: true })` is used — without that flag the saved
// file would look fine and restore nothing.
//
// The saved file is a real credential for that account. It is written into
// the gitignored output directory and must never be committed or shared.

import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { AUTH_STATE_PATH, DEFAULT_BASE_URL, OUTPUT_DIR } from "../config";

const baseURL = (process.env.AGENT_TEST_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");

async function main(): Promise<void> {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  console.log("");
  console.log("Opening " + baseURL + " in a real browser window.");
  console.log("");
  console.log("  1. Click 'Sign in' in the top corner and complete Google sign-in.");
  console.log("  2. If the onboarding taste survey appears, ANSWER IT — the");
  console.log("     signed-in persona plans a bare prompt specifically to see");
  console.log("     whether the stored profile shapes the day.");
  console.log("  3. Come back to this terminal and press Enter.");
  console.log("");

  const browser = await chromium.launch({ headless: false, channel: "chrome"});
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "en-CA",
    timezoneId: "America/Toronto",
  });

  // `channel: "chrome"` alone isn't enough: Google's sign-in also fingerprints
  // the page for automation traces that persist under any Playwright-driven
  // browser, real Chrome binary or not. This runs before any page script
  // (Playwright wires it through CDP's Page.addScriptToEvaluateOnNewDocument),
  // overriding only the specific, well-documented signals Google's detection
  // is known to check. It is scoped to this context alone and has no effect
  // on the main persona runner.
  await context.addInitScript(applyLoginFingerprintOverrides);

  const page = await context.newPage();
  await page.goto(baseURL, { waitUntil: "domcontentloaded" });

  await waitForEnter();

  // indexedDB is the load-bearing option: Firebase Auth's session lives there.
  await context.storageState({ path: AUTH_STATE_PATH, indexedDB: true });
  await browser.close();

  const size = (await fs.stat(AUTH_STATE_PATH)).size;
  console.log("");
  console.log("Saved " + path.relative(process.cwd(), AUTH_STATE_PATH) + " (" + size + " bytes).");
  console.log("It is gitignored. Treat it as a credential: do not commit or share it.");
  console.log("Signed-in personas will now use it. Re-run this if it stops working.");
  console.log("");
}

// Runs INSIDE the page, before any of the page's own scripts, via
// context.addInitScript above. Must be self-contained (Playwright serializes
// it by source and evaluates it in the browser) — no closures over anything
// outside this function.
//
// Each override targets one specific, well-documented signal Google's
// sign-in is known to check for automation:
function applyLoginFingerprintOverrides(): void {
  // CDP sets navigator.webdriver to true unconditionally, on every
  // automation-driven browser regardless of binary. A real user's browser
  // never sets it. Redefine the getter so it reads as absent instead.
  Object.defineProperty(Navigator.prototype, "webdriver", {
    get: () => undefined,
    configurable: true,
  });

  // A real Chrome profile reports a handful of built-in plugins (PDF
  // viewers); Playwright's automated context reports an empty list, which
  // is itself a detectable signal. A small, plausible-looking shim is
  // enough — this doesn't need to be exhaustive.
  const pluginDescriptions = [
    { name: "PDF Viewer", filename: "internal-pdf-viewer" },
    { name: "Chrome PDF Viewer", filename: "internal-pdf-viewer" },
    { name: "Chromium PDF Viewer", filename: "internal-pdf-viewer" },
    { name: "Microsoft Edge PDF Viewer", filename: "internal-pdf-viewer" },
    { name: "WebKit built-in PDF", filename: "internal-pdf-viewer" },
  ];
  const fakePlugins = pluginDescriptions.map((entry) => ({
    name: entry.name,
    filename: entry.filename,
    description: "Portable Document Format",
    length: 1,
  }));
  Object.defineProperty(Navigator.prototype, "plugins", {
    get: () => fakePlugins,
    configurable: true,
  });
  Object.defineProperty(Navigator.prototype, "mimeTypes", {
    get: () => [{ type: "application/pdf", description: "Portable Document Format", suffixes: "pdf" }],
    configurable: true,
  });

  // A real Chrome build always exposes window.chrome (extension-API
  // plumbing, populated or not); some automated/headless configurations
  // omit it entirely, which detection scripts check for directly.
  const globalWithChrome = window as unknown as { chrome?: unknown };
  if (!globalWithChrome.chrome) {
    globalWithChrome.chrome = { runtime: {} };
  }

  // Automated Chrome answers a `notifications` permissions query with
  // "denied" even when nothing was ever actually requested/denied; real
  // Chrome reports the browser's real (usually "default") state, which
  // detection scripts compare against Notification.permission and flag the
  // mismatch on.
  const permissionsApi = window.navigator.permissions;
  const originalQuery = permissionsApi.query.bind(permissionsApi);
  permissionsApi.query = (descriptor: PermissionDescriptor) =>
    descriptor.name === "notifications"
      ? Promise.resolve({
          state: Notification.permission,
          name: descriptor.name,
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        } as unknown as PermissionStatus)
      : originalQuery(descriptor);
}

function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", () => {
      process.stdin.pause();
      resolve();
    });
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
