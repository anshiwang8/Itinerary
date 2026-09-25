// Unit tests for the pure helpers behind export-chrome-session.ts.
// Not part of `npm run check` (the harness lives outside app/, like the rest of
// testing/agent-personas); run with:
//   npx tsx testing/agent-personas/auth/chromeSession.test.ts
//
// Every value below is a made-up placeholder. No real profile, cookie or token
// is read, and none is needed: the helpers are pure.
import assert from "node:assert";
import {
  defaultChromeUserDataDir,
  describeState,
  exportProblems,
  filterStateToOrigin,
  indexedDbFolders,
  maskEmail,
  parseProfileList,
  sessionVerdict,
  summarizeFirebaseRecords,
  type ExportableState,
} from "./chromeSession";

const APP = "https://itinerary-six.vercel.app";

const authUser = (overrides: Record<string, unknown> = {}) => ({
  fbase_key: "firebase:authUser:PLACEHOLDER_API_KEY:[DEFAULT]",
  value: {
    uid: "placeholder-uid",
    email: "someone@example.test",
    isAnonymous: false,
    providerData: [{ providerId: "google.com" }],
    stsTokenManager: { refreshToken: "PLACEHOLDER" },
    ...overrides,
  },
});

const cases: Array<[string, () => void]> = [
  [
    "default Chrome user-data dir per platform, and null when it cannot be derived",
    () => {
      assert.strictEqual(
        defaultChromeUserDataDir("win32", { LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" }, "C:\\Users\\x"),
        "C:\\Users\\x\\AppData\\Local\\Google\\Chrome\\User Data"
      );
      assert.strictEqual(defaultChromeUserDataDir("win32", {}, "C:\\Users\\x"), null);
      assert.strictEqual(
        defaultChromeUserDataDir("darwin", {}, "/Users/x"),
        "/Users/x/Library/Application Support/Google/Chrome"
      );
      assert.strictEqual(defaultChromeUserDataDir("linux", {}, "/home/x"), "/home/x/.config/google-chrome");
    },
  ],
  [
    "IndexedDB folder names follow Chrome's <scheme>_<host>_<port> layout, port 0 for the default",
    () => {
      assert.deepStrictEqual(indexedDbFolders(APP), {
        leveldb: "https_itinerary-six.vercel.app_0.indexeddb.leveldb",
        blob: "https_itinerary-six.vercel.app_0.indexeddb.blob",
      });
      assert.strictEqual(indexedDbFolders("https://itinerary-six.vercel.app:443").leveldb, indexedDbFolders(APP).leveldb);
      assert.strictEqual(indexedDbFolders("http://localhost:3200").leveldb, "http_localhost_3200.indexeddb.leveldb");
      // a trailing slash or path must not change which folder is meant
      assert.strictEqual(indexedDbFolders(`${APP}/some/path?x=1`).leveldb, indexedDbFolders(APP).leveldb);
      assert.throws(() => indexedDbFolders("not a url"));
    },
  ],
  [
    "the profile list reads Local State's info_cache, sorted naturally, tolerant of junk",
    () => {
      const profiles = parseProfileList({
        profile: {
          info_cache: {
            "Profile 10": { name: "Ten" },
            Default: { name: "Person 1", user_name: "me@example.test" },
            "Profile 2": { name: "Work", user_name: "work@example.test" },
            Broken: null,
            Empty: {},
          },
        },
      });
      assert.deepStrictEqual(
        profiles.map((p) => p.dir),
        ["Default", "Empty", "Profile 2", "Profile 10"]
      );
      assert.deepStrictEqual(profiles[0], { dir: "Default", name: "Person 1", email: "me@example.test" });
      assert.deepStrictEqual(profiles[1], { dir: "Empty", name: "Empty", email: null });
      assert.deepStrictEqual(parseProfileList(null), []);
      assert.deepStrictEqual(parseProfileList({}), []);
      assert.deepStrictEqual(parseProfileList({ profile: { info_cache: "nope" } }), []);
    },
  ],
  [
    "an email is masked to its first letter and domain, never shown whole",
    () => {
      assert.strictEqual(maskEmail("someone@example.test"), "s***@example.test");
      assert.strictEqual(maskEmail("@example.test"), "***");
      assert.strictEqual(maskEmail("nodomain"), "***");
    },
  ],
  [
    "a signed-in Google session is recognised, and only booleans and provider ids come out",
    () => {
      const facts = summarizeFirebaseRecords([
        { fbase_key: "firebase:heartbeat", value: { anything: true } },
        authUser(),
      ]);
      assert.deepStrictEqual(facts, {
        users: 1,
        signedIn: true,
        providers: ["google.com"],
        emailMasked: "s***@example.test",
      });
      assert.strictEqual(sessionVerdict(facts), "ok");
      // no token or uid value can appear in what the export prints
      assert.ok(!JSON.stringify(facts).includes("PLACEHOLDER"));
      assert.ok(!JSON.stringify(facts).includes("placeholder-uid"));
    },
  ],
  [
    "an anonymous guest session is NOT accepted as signed in (it would make a signed-in persona a guest)",
    () => {
      const facts = summarizeFirebaseRecords([authUser({ isAnonymous: true, email: null, providerData: [] })]);
      assert.strictEqual(facts.users, 1);
      assert.strictEqual(facts.signedIn, false);
      assert.strictEqual(sessionVerdict(facts), "anonymous");
    },
  ],
  [
    "no auth record at all is 'missing', and junk rows never throw",
    () => {
      assert.strictEqual(sessionVerdict(summarizeFirebaseRecords([])), "missing");
      const junk = summarizeFirebaseRecords([
        null,
        undefined,
        7,
        "x",
        {},
        { fbase_key: 5, value: {} },
        { fbase_key: "firebase:authUser:k:[DEFAULT]", value: null },
        { fbase_key: "somethingElse", value: authUser().value },
      ]);
      assert.strictEqual(junk.users, 0);
      assert.strictEqual(sessionVerdict(junk), "missing");
    },
  ],
  [
    "when a guest and a real account both exist, the real account wins",
    () => {
      const facts = summarizeFirebaseRecords([
        authUser({ isAnonymous: true, providerData: [] }),
        authUser(),
      ]);
      assert.strictEqual(facts.users, 2);
      assert.strictEqual(sessionVerdict(facts), "ok");
    },
  ],
  [
    "the exported state keeps ONLY the app origin and its own cookies",
    () => {
      const state: ExportableState = {
        cookies: [
          { domain: "itinerary-six.vercel.app" },
          { domain: ".vercel.app" },
          { domain: ".google.com" },
          { domain: "accounts.google.com" },
          { domain: "www.evil-itinerary-six.vercel.app.example" },
        ],
        origins: [
          { origin: APP, localStorage: [], indexedDB: [] },
          { origin: "https://accounts.google.com", localStorage: [{}] },
          { origin: "https://www.google.com", localStorage: [{}, {}] },
        ],
      };
      const filtered = filterStateToOrigin(state, APP);
      // .vercel.app is a parent of the host, so a cookie scoped to it does apply to the app
      assert.deepStrictEqual(
        filtered.state.cookies.map((c) => c.domain),
        ["itinerary-six.vercel.app", ".vercel.app"]
      );
      assert.deepStrictEqual(filtered.state.origins.map((o) => o.origin), [APP]);
      assert.strictEqual(filtered.removedCookies, 3);
      assert.strictEqual(filtered.removedOrigins, 2);
      // the input is not mutated
      assert.strictEqual(state.cookies.length, 5);
      assert.strictEqual(state.origins.length, 3);
    },
  ],
  [
    "the shape check demands the Firebase session store with at least one record",
    () => {
      const good: ExportableState = {
        cookies: [],
        origins: [
          {
            origin: APP,
            indexedDB: [{ name: "firebaseLocalStorageDb", stores: [{ name: "firebaseLocalStorage", records: [{}] }] }],
          },
        ],
      };
      assert.deepStrictEqual(exportProblems(good, APP), []);
      assert.ok(exportProblems({ cookies: [], origins: [] }, APP)[0].includes("origin"));
      assert.ok(
        exportProblems({ cookies: [], origins: [{ origin: APP, indexedDB: [] }] }, APP)[0].includes("firebaseLocalStorageDb")
      );
      const empty: ExportableState = {
        cookies: [],
        origins: [
          {
            origin: APP,
            indexedDB: [{ name: "firebaseLocalStorageDb", stores: [{ name: "firebaseLocalStorage", records: [] }] }],
          },
        ],
      };
      assert.ok(exportProblems(empty, APP)[0].includes("no records"));
    },
  ],
  [
    "describeState prints counts and names only, never a stored value",
    () => {
      const lines = describeState({
        cookies: [{ domain: "x" }],
        origins: [
          {
            origin: APP,
            localStorage: [{ name: "SECRET_KEY", value: "SECRET_VALUE" }],
            indexedDB: [
              {
                name: "firebaseLocalStorageDb",
                stores: [{ name: "firebaseLocalStorage", records: [{ valueEncoded: "SECRET_TOKEN" }] }],
              },
            ],
          },
        ],
      });
      const text = lines.join("\n");
      assert.ok(text.includes("cookies: 1"));
      assert.ok(text.includes("firebaseLocalStorage: 1"));
      assert.ok(!text.includes("SECRET"));
    },
  ],
];

let failed = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err instanceof Error ? err.message : err}`);
  }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
if (failed > 0) process.exit(1);
