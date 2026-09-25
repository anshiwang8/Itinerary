// Pure helpers for `export-chrome-session.ts`. No Playwright, no filesystem:
// everything here is a function of its arguments, so it can be tested without a
// browser, and (the point of the split) without ever touching a real Chrome
// profile or a real credential.
//
// WHAT THE EXPORT IS FOR. Google blocks the automated sign-in the persona
// harness used to attempt (two approaches were live-tested and both refused).
// A HUMAN signing in by hand in their everyday Chrome is not blocked, and the
// app keeps its session in that browser's IndexedDB for the app's own origin.
// So the export reads that one origin's IndexedDB out of the everyday profile
// and writes it in the SAME Playwright storage-state shape `save-storage-state.ts`
// produces, which is exactly what the signed-in personas already read.
//
// LEAST PRIVILEGE IS THE DESIGN CONSTRAINT. The app's session is one origin's
// IndexedDB. An everyday Chrome profile also holds the person's Google account
// cookies, saved passwords, history and every other site's storage, and none
// of that may end up in the harness's file. So: only the app origin's IndexedDB
// folder is copied, no cookie store is copied at all, and the exported state is
// filtered again to that one origin before it is written.

import path from "node:path";

// ── where Chrome keeps things ────────────────────────────────────────────

/** Chrome's default "User Data" directory for a platform, or null when it
 *  cannot be derived (a Windows session with no LOCALAPPDATA). Uses the
 *  platform's own path flavour so it can be tested on any OS. */
export function defaultChromeUserDataDir(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  home: string
): string | null {
  if (platform === "win32") {
    return env.LOCALAPPDATA
      ? path.win32.join(env.LOCALAPPDATA, "Google", "Chrome", "User Data")
      : null;
  }
  if (platform === "darwin") {
    return path.posix.join(home, "Library", "Application Support", "Google", "Chrome");
  }
  return path.posix.join(home, ".config", "google-chrome");
}

export interface ChromeStorageFolders {
  /** `<profile>/IndexedDB/<this>` */
  leveldb: string;
  /** `<profile>/IndexedDB/<this>`, may not exist (small values live inline) */
  blob: string;
}

/**
 * The two folder names Chrome uses for an origin's IndexedDB:
 * `https_itinerary-six.vercel.app_0.indexeddb.leveldb` (port 0 = the scheme's
 * default) and `http_localhost_3200.indexeddb.leveldb`.
 */
export function indexedDbFolders(origin: string): ChromeStorageFolders {
  const url = new URL(origin);
  const scheme = url.protocol.replace(/:$/, "");
  const port = url.port === "" ? 0 : Number(url.port);
  const base = `${scheme}_${url.hostname}_${port}`;
  return { leveldb: `${base}.indexeddb.leveldb`, blob: `${base}.indexeddb.blob` };
}

export interface ChromeProfile {
  /** the directory name under "User Data": "Default", "Profile 1", ... */
  dir: string;
  /** the name shown in Chrome's profile picker */
  name: string;
  /** the Google account the PROFILE is signed into, when Chrome recorded one */
  email: string | null;
}

/** Profiles listed in Chrome's `Local State` (`profile.info_cache`), sorted by
 *  directory. Tolerates any missing or malformed piece: an unreadable entry is
 *  skipped rather than failing the listing. */
export function parseProfileList(localState: unknown): ChromeProfile[] {
  const cache = (
    (localState as { profile?: { info_cache?: unknown } } | null)?.profile?.info_cache
  ) as Record<string, unknown> | undefined;
  if (!cache || typeof cache !== "object") return [];
  const profiles: ChromeProfile[] = [];
  for (const [dir, raw] of Object.entries(cache)) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as { name?: unknown; user_name?: unknown };
    profiles.push({
      dir,
      name: typeof entry.name === "string" && entry.name ? entry.name : dir,
      email: typeof entry.user_name === "string" && entry.user_name ? entry.user_name : null,
    });
  }
  return profiles.sort((a, b) => a.dir.localeCompare(b.dir, "en", { numeric: true }));
}

// ── what the app's session record says ───────────────────────────────────

/** `a***@gmail.com`. The address is only ever shown so the person can confirm
 *  which account was captured; it is never logged whole. */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at < 1) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

export interface SessionFacts {
  /** Firebase auth-user records found */
  users: number;
  /** at least one is a real (non-anonymous) account */
  signedIn: boolean;
  providers: string[];
  emailMasked: string | null;
}

/**
 * Reduce the raw rows of Firebase Auth's `firebaseLocalStorageDb` /
 * `firebaseLocalStorage` store to the few facts the export needs. Auth-user
 * rows are `{ fbase_key: "firebase:authUser:<apiKey>:[DEFAULT]", value: {...} }`;
 * every other row (persistence probes, heartbeat data) is ignored. Nothing here
 * copies a token anywhere: the output is booleans, provider ids and a masked
 * address.
 */
export function summarizeFirebaseRecords(records: unknown[]): SessionFacts {
  let users = 0;
  let signedIn = false;
  const providers = new Set<string>();
  let emailMasked: string | null = null;

  for (const row of records) {
    if (!row || typeof row !== "object") continue;
    const { fbase_key: key, value } = row as { fbase_key?: unknown; value?: unknown };
    if (typeof key !== "string" || !key.startsWith("firebase:authUser:")) continue;
    if (!value || typeof value !== "object") continue;
    users++;
    const user = value as {
      isAnonymous?: unknown;
      email?: unknown;
      providerData?: unknown;
    };
    if (user.isAnonymous === false) {
      signedIn = true;
      if (typeof user.email === "string" && user.email) emailMasked = maskEmail(user.email);
      if (Array.isArray(user.providerData)) {
        for (const provider of user.providerData) {
          const id = (provider as { providerId?: unknown } | null)?.providerId;
          if (typeof id === "string" && id) providers.add(id);
        }
      }
    }
  }
  return { users, signedIn, providers: [...providers].sort(), emailMasked };
}

export type SessionVerdict = "ok" | "anonymous" | "missing";

/** `missing`: no session record for this origin in the profile. `anonymous`:
 *  only a guest session, which would make a "signed-in" persona a guest. */
export function sessionVerdict(facts: SessionFacts): SessionVerdict {
  if (facts.users === 0) return "missing";
  return facts.signedIn ? "ok" : "anonymous";
}

// ── the exported file ────────────────────────────────────────────────────

/** The parts of a Playwright storage state this module reads. Playwright's own
 *  type is not imported so these helpers stay dependency-free. */
export interface ExportableState {
  cookies: Array<{ domain: string }>;
  origins: Array<{
    origin: string;
    localStorage?: unknown[];
    indexedDB?: Array<{
      name: string;
      stores?: Array<{ name: string; records?: unknown[] }>;
    }>;
  }>;
}

function hostMatchesCookieDomain(host: string, domain: string): boolean {
  const bare = domain.replace(/^\./, "").toLowerCase();
  const h = host.toLowerCase();
  return h === bare || h.endsWith(`.${bare}`);
}

/**
 * Keep only the app's own origin and the cookies that belong to its host.
 * Playwright's `storageState()` reports every origin the context touched and
 * every cookie it holds; anything else (a Google origin a page happened to
 * load, a tracking cookie) is not this tool's business and must not be written.
 */
export function filterStateToOrigin<T extends ExportableState>(
  state: T,
  origin: string
): { state: T; removedCookies: number; removedOrigins: number } {
  const wanted = new URL(origin);
  const cookies = state.cookies.filter((cookie) =>
    hostMatchesCookieDomain(wanted.hostname, cookie.domain)
  );
  const origins = state.origins.filter((entry) => entry.origin === wanted.origin);
  return {
    state: { ...state, cookies, origins },
    removedCookies: state.cookies.length - cookies.length,
    removedOrigins: state.origins.length - origins.length,
  };
}

/** Is this the shape the signed-in personas need? Returns the problems, empty
 *  when fine. Checks structure only: a real session's VALUES are checked
 *  separately (`sessionVerdict`), and never here. */
export function exportProblems(state: ExportableState, origin: string): string[] {
  const problems: string[] = [];
  const entry = state.origins.find((o) => o.origin === new URL(origin).origin);
  if (!entry) return [`no ${new URL(origin).origin} origin in the exported state`];
  const db = entry.indexedDB?.find((d) => d.name === "firebaseLocalStorageDb");
  if (!db) return ["the origin has no firebaseLocalStorageDb (Firebase Auth's session store)"];
  const store = db.stores?.find((s) => s.name === "firebaseLocalStorage");
  if (!store) problems.push("firebaseLocalStorageDb has no firebaseLocalStorage store");
  else if (!store.records || store.records.length === 0) {
    problems.push("firebaseLocalStorage holds no records, so there is no session to restore");
  }
  return problems;
}

/** One-line-per-fact description of a state with NO values in it, safe to print. */
export function describeState(state: ExportableState): string[] {
  const lines = [`cookies: ${state.cookies.length}`];
  for (const entry of state.origins) {
    const dbs = (entry.indexedDB ?? []).map(
      (db) =>
        `${db.name} [${(db.stores ?? [])
          .map((store) => `${store.name}: ${store.records?.length ?? 0}`)
          .join(", ")}]`
    );
    lines.push(
      `origin ${entry.origin}: localStorage ${entry.localStorage?.length ?? 0}, indexedDB ${
        dbs.length > 0 ? dbs.join("; ") : "none"
      }`
    );
  }
  return lines;
}
