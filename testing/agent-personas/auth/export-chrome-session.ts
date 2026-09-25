// Export the app's signed-in session from the owner's OWN everyday Chrome, for
// the signed-in personas.
//
//   npx tsx testing/agent-personas/auth/export-chrome-session.ts --list
//   npx tsx testing/agent-personas/auth/export-chrome-session.ts --profile "Default" --dry-run
//   npx tsx testing/agent-personas/auth/export-chrome-session.ts --profile "Default"
//
// WHY THIS EXISTS. `save-storage-state.ts` tries to sign in with an automated
// browser, and Google refuses (two approaches, a real Chrome channel and then
// fingerprint suppression, were both live-tested by the owner and both got
// "Couldn't sign you in"). A HUMAN signing in by hand in their everyday Chrome
// is not refused. So the sign-in happens there, once, by hand, and this tool
// carries the resulting session across.
//
// HOW. The app's session is Firebase Auth's record in the app origin's
// IndexedDB inside the everyday profile. This tool copies ONLY that origin's
// IndexedDB folder into a throwaway profile, opens the app in a browser on that
// copy so Firebase restores the session exactly as it would in the everyday
// browser, and lets Playwright write it with `storageState({ indexedDB: true })`.
// That is the SAME call, and so the SAME file shape, that `save-storage-state.ts`
// writes and the personas already read. Nothing here invents a format.
//
// WHAT IT NEVER COPIES: cookies (so the person's Google account session cannot
// end up in the file), saved passwords, history, extensions, or any other
// site's storage. The result is filtered to the app origin again before it is
// written. The throwaway copy is deleted on exit.
//
// THE OUTPUT IS A REAL CREDENTIAL for that account. It goes to the gitignored
// output directory, never to a log, and this tool prints only booleans, provider
// ids and a masked address.
//
// STATUS: written and smoke-tested against a throwaway synthetic profile only.
// It has NOT been run against a real Chrome profile with a real login. The
// person whose account it is has to do that (see README.md).

import { chromium, type BrowserContext } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { AUTH_STATE_PATH, DEFAULT_BASE_URL } from "../config";
import { SEL } from "../lib/app";
import {
  defaultChromeUserDataDir,
  describeState,
  exportProblems,
  filterStateToOrigin,
  indexedDbFolders,
  parseProfileList,
  sessionVerdict,
  summarizeFirebaseRecords,
  type ExportableState,
} from "./chromeSession";

/** The signed-in account control (AccountMenu.tsx). Its presence is the app
 *  itself saying "this is a real account"; the guest corner shows
 *  `SEL.signInPill` instead. */
const ACCOUNT_TRIGGER = ".acct__who";

interface Args {
  list: boolean;
  profile: string | null;
  userDataDir: string | null;
  origin: string;
  out: string;
  channel: "chrome" | "chromium";
  dryRun: boolean;
  keepCopy: boolean;
  headed: boolean;
  ignoreLock: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    list: false,
    profile: null,
    userDataDir: null,
    origin: (process.env.AGENT_TEST_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    out: AUTH_STATE_PATH,
    channel: "chrome",
    dryRun: false,
    keepCopy: false,
    headed: false,
    ignoreLock: false,
    help: false,
  };
  const value = (i: number, flag: string): string => {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) fail(`${flag} needs a value.`);
    return next;
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--list": args.list = true; break;
      case "--profile": args.profile = value(i++, "--profile"); break;
      case "--user-data-dir": args.userDataDir = value(i++, "--user-data-dir"); break;
      case "--origin": args.origin = value(i++, "--origin").replace(/\/+$/, ""); break;
      case "--out": args.out = path.resolve(value(i++, "--out")); break;
      case "--channel": {
        const channel = value(i++, "--channel");
        if (channel !== "chrome" && channel !== "chromium") fail("--channel must be chrome or chromium.");
        args.channel = channel;
        break;
      }
      case "--dry-run": args.dryRun = true; break;
      case "--keep-copy": args.keepCopy = true; break;
      case "--headed": args.headed = true; break;
      case "--ignore-lock": args.ignoreLock = true; break;
      case "--help": case "-h": args.help = true; break;
      default: fail(`Unknown option ${argv[i]}. Try --help.`);
    }
  }
  return args;
}

/** A failure the person can act on. Thrown, never `process.exit`ed, so the
 *  `finally` in `main` always runs and the throwaway profile (which holds a
 *  copy of a session) is deleted on every path. */
class ExportFailure extends Error {}

function fail(message: string): never {
  throw new ExportFailure(message);
}

const HELP = `
Export the app's signed-in session from your everyday Chrome.

  --list                 show the Chrome profiles found and exit (reads nothing else)
  --profile <dir>        which profile: "Default", "Profile 1", ... (see --list)
  --dry-run              do everything except write the session file
  --origin <url>         the app (default ${DEFAULT_BASE_URL})
  --user-data-dir <p>    Chrome's "User Data" directory (default: this OS's usual one)
  --out <file>           where to write (default testing/agent-personas/output/signed-in-state.json)
  --channel <c>          chrome (default) or chromium, for the throwaway browser
  --headed               show the throwaway browser while it works
  --keep-copy            keep the throwaway profile (it holds a session: delete it yourself)
  --ignore-lock          skip the "is Chrome still open" check (a stale lock only)

Close EVERY Chrome window first, including any still running in the tray.
`;

/**
 * Is Chrome using this "User Data" directory right now? Copying a live LevelDB
 * gives a torn snapshot, so this refuses instead of guessing. macOS/Linux: the
 * `SingletonLock` link Chrome creates. Windows: Chrome holds `lockfile` open
 * without write sharing for as long as it runs (and deletes it on exit), so an
 * attempt to open it for writing fails while Chrome is alive.
 */
async function profileInUse(userDataDir: string): Promise<boolean> {
  try {
    await fs.lstat(path.join(userDataDir, "SingletonLock"));
    return true;
  } catch {
    // not present: fall through to the Windows check
  }
  const lockfile = path.join(userDataDir, "lockfile");
  try {
    await fs.access(lockfile);
  } catch {
    return false;
  }
  try {
    const handle = await fs.open(lockfile, "r+");
    await handle.close();
    return false;
  } catch {
    return true;
  }
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** Read Firebase Auth's rows out of the page's own IndexedDB. The rows stay in
 *  this process's memory; only facts derived from them are ever printed. */
async function readFirebaseRows(context: BrowserContext): Promise<unknown[]> {
  const page = context.pages()[0];
  if (!page) return [];
  return page
    .evaluate(
      () =>
        new Promise<unknown[]>((resolve) => {
          const open = indexedDB.open("firebaseLocalStorageDb");
          open.onerror = () => resolve([]);
          open.onsuccess = () => {
            const db = open.result;
            if (!db.objectStoreNames.contains("firebaseLocalStorage")) {
              db.close();
              resolve([]);
              return;
            }
            const request = db
              .transaction("firebaseLocalStorage", "readonly")
              .objectStore("firebaseLocalStorage")
              .getAll();
            request.onsuccess = () => {
              db.close();
              resolve(request.result as unknown[]);
            };
            request.onerror = () => {
              db.close();
              resolve([]);
            };
          };
        })
    )
    .catch(() => []);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }

  const userDataDir =
    args.userDataDir ?? defaultChromeUserDataDir(process.platform, process.env, os.homedir());
  if (!userDataDir) fail("Could not work out Chrome's User Data directory. Pass --user-data-dir.");

  // ── which profile ─────────────────────────────────────────────────────
  let profiles: ReturnType<typeof parseProfileList> = [];
  try {
    profiles = parseProfileList(await readJson(path.join(userDataDir, "Local State")));
  } catch {
    // no readable Local State: --profile can still name a directory directly
  }
  if (args.list) {
    console.log("");
    console.log("Chrome profiles under " + userDataDir);
    if (profiles.length === 0) console.log("  (none found; is --user-data-dir right?)");
    for (const profile of profiles) {
      console.log(
        `  ${profile.dir.padEnd(12)} ${profile.name}${profile.email ? "  (" + profile.email + ")" : ""}`
      );
    }
    console.log("");
    console.log("Pass the left-hand name as --profile.");
    return;
  }

  let profileDir = args.profile;
  if (!profileDir) {
    if (profiles.length === 1) profileDir = profiles[0].dir;
    else {
      fail(
        "More than one Chrome profile exists (or none was readable), and guessing would capture the wrong account. " +
          "Run with --list, then pass --profile <name>."
      );
    }
  }
  const profilePath = path.join(userDataDir, profileDir);
  if (!(await exists(profilePath))) fail(`No such profile directory: ${profilePath}`);

  // ── is Chrome finished with it ────────────────────────────────────────
  if (!args.ignoreLock && (await profileInUse(userDataDir))) {
    fail(
      "Chrome is still using this profile. Close every Chrome window, then check the tray / Task Manager: " +
        "Chrome keeps running in the background unless 'Continue running background apps when Google Chrome is closed' " +
        "is off (Settings > System). Then run this again."
    );
  }

  // ── copy ONLY the app origin's IndexedDB ──────────────────────────────
  const folders = indexedDbFolders(args.origin);
  const sourceLevelDb = path.join(profilePath, "IndexedDB", folders.leveldb);
  const sourceBlob = path.join(profilePath, "IndexedDB", folders.blob);
  if (!(await exists(sourceLevelDb))) {
    let hint = "";
    try {
      const host = new URL(args.origin).hostname;
      const nearby = (await fs.readdir(path.join(profilePath, "IndexedDB"))).filter((name) =>
        name.includes(host.split(".")[0])
      );
      if (nearby.length > 0) hint = " Similar folders: " + nearby.join(", ") + ".";
    } catch {
      // no IndexedDB directory at all
    }
    fail(
      `This profile has no saved data for ${args.origin} (looked for ${folders.leveldb}). ` +
        "Sign in to the app with Google in THIS Chrome profile first, then close Chrome and retry." +
        hint
    );
  }

  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "itinerary-session-export-"));
  let cleanedUp = false;
  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (args.keepCopy) {
      console.log("Kept the throwaway profile (it contains a session; delete it): " + scratch);
      return;
    }
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  };
  process.once("SIGINT", () => {
    void cleanup().then(() => process.exit(130));
  });

  let context: BrowserContext | undefined;
  try {
    const destination = path.join(scratch, "Default", "IndexedDB");
    await fs.mkdir(destination, { recursive: true });
    // LOCK is skipped: it is Chrome's own lock file and is meaningless in a copy.
    const skipLock = { filter: (source: string) => path.basename(source) !== "LOCK" };
    try {
      await fs.cp(sourceLevelDb, path.join(destination, folders.leveldb), {
        recursive: true,
        ...skipLock,
      });
      if (await exists(sourceBlob)) {
        await fs.cp(sourceBlob, path.join(destination, folders.blob), { recursive: true });
      }
    } catch (error) {
      fail(
        "Could not copy the profile's app data (" +
          (error instanceof Error ? error.message : String(error)) +
          "). Chrome is probably still running: close every window and check the tray."
      );
    }

    // ── let Firebase restore the session in the copy ───────────────────
    context = await chromium.launchPersistentContext(scratch, {
      ...(args.channel === "chrome" ? { channel: "chrome" as const } : {}),
      headless: !args.headed,
      viewport: { width: 1440, height: 900 },
      locale: "en-CA",
      timezoneId: "America/Toronto",
    });
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(args.origin, { waitUntil: "domcontentloaded" });

    // Wait until the APP has decided who the user is: its corner shows either
    // the account control (a real account) or the Sign in pill (a guest).
    const decided = page.locator(`${ACCOUNT_TRIGGER}, ${SEL.signInPill}`).first();
    await decided.waitFor({ state: "visible", timeout: 45_000 }).catch(() => undefined);
    const appShowsAccount = await page.locator(ACCOUNT_TRIGGER).first().isVisible().catch(() => false);
    const appShowsGuest = await page.locator(SEL.signInPill).first().isVisible().catch(() => false);

    const facts = summarizeFirebaseRecords(await readFirebaseRows(context));
    const verdict = sessionVerdict(facts);
    if (verdict === "missing") {
      fail(
        "The copied profile has no Firebase session record for this app. Sign in with Google in this Chrome profile " +
          "(open the app, click Sign in), wait for your name to appear, close Chrome, and retry."
      );
    }
    if (verdict === "anonymous") {
      fail(
        "This profile holds only a GUEST session for the app, which would make a signed-in persona a guest. " +
          "Sign in with Google in this profile first, then close Chrome and retry."
      );
    }
    if (appShowsGuest || !appShowsAccount) {
      fail(
        "The session record is a real account, but the app did not recognise it when loaded (it showed " +
          (appShowsGuest ? "the Sign in button" : "neither account control nor Sign in button") +
          "). The login may have expired or been revoked. Sign in again in Chrome, then retry."
      );
    }

    // ── export, filtered again to the app's own origin ──────────────────
    const raw = (await context.storageState({ indexedDB: true })) as unknown as ExportableState;
    const { state, removedCookies, removedOrigins } = filterStateToOrigin(raw, args.origin);
    const problems = exportProblems(state, args.origin);
    if (problems.length > 0) {
      fail("The exported session is not usable: " + problems.join("; ") + ". Nothing was written.");
    }

    console.log("");
    console.log("Captured a signed-in session:");
    console.log("  account   " + (facts.emailMasked ?? "(no email recorded)"));
    console.log("  provider  " + (facts.providers.join(", ") || "(none recorded)"));
    console.log("  the app recognised it as a real account: yes");
    for (const line of describeState(state)) console.log("  " + line);
    if (removedCookies + removedOrigins > 0) {
      console.log(
        `  dropped ${removedCookies} unrelated cookie(s) and ${removedOrigins} other origin(s) (not written)`
      );
    }

    if (args.dryRun) {
      console.log("");
      console.log("DRY RUN: nothing was written. Run again without --dry-run to save it.");
      return;
    }

    await fs.mkdir(path.dirname(args.out), { recursive: true });
    const staging = args.out + ".tmp";
    await fs.writeFile(staging, JSON.stringify(state, null, 2), "utf8");
    if (await exists(args.out)) await fs.copyFile(args.out, args.out + ".previous");
    await fs.rename(staging, args.out);

    const size = (await fs.stat(args.out)).size;
    console.log("");
    console.log(
      "Saved " + path.relative(process.cwd(), args.out) + " (" + size + " bytes)." +
        ((await exists(args.out + ".previous")) ? " The old file is kept beside it as .previous." : "")
    );
    const ignored = spawnSync("git", ["check-ignore", "-q", args.out], { cwd: process.cwd() });
    if (ignored.status !== 0) {
      console.log("WARNING: git does not report that file as ignored. Do not commit it.");
    } else {
      console.log("It is gitignored. Treat it as a credential: do not commit or share it.");
    }
    console.log("Signed-in personas will now use it.");
    console.log("");
  } finally {
    await context?.close().catch(() => undefined);
    await cleanup();
  }
}

main().catch((error: unknown) => {
  console.error("");
  console.error(
    (error instanceof ExportFailure ? "ERROR: " : "UNEXPECTED ERROR: ") +
      (error instanceof Error ? error.message : String(error))
  );
  console.error("");
  process.exit(1);
});
