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

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "en-CA",
    timezoneId: "America/Toronto",
  });
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
