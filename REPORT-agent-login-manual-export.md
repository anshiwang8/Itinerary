# Report: the persona harness's manual session export

Branch `agent-login-manual-export`, 2026-09-25. Scope: `testing/agent-personas/`
only, plus this report, the DEVLOG entry and a CLAUDE.md bullet. **No application
code changed.**

## Read this first: what is and is not verified

| | Status |
|---|---|
| Script written, type-checks, lints clean | Yes |
| Pure helpers unit-tested (11 cases) | Yes |
| Mechanics exercised end to end on a **throwaway synthetic profile** | Yes, see below |
| Run against **your real Chrome profile with a real Google login** | **NO. This needs your hands, once.** |
| Signed-in personas actually running with the exported file | **NO** (that spends real money) |

The synthetic exercise was done only to shake bugs out of a script that had never
been run; it is not verification and must not be read as such. It used a
Playwright-created profile in a scratch folder holding a **fake** Firebase record
(`SYNTHETIC_NOT_A_TOKEN`) and a tiny local stand-in page for the app, and never
touched your Chrome profile or your real `signed-in-state.json`.

## The approach, and why

Google refuses the automated sign-in (a real Chrome channel, then fingerprint
suppression: both live-tested by you, both refused). A human signing in by hand in
their everyday Chrome is not refused, and the app's session then sits in that
browser's IndexedDB for the app's origin (Firebase Auth's `firebaseLocalStorageDb`).

The tool copies **only that origin's IndexedDB folder** out of the chosen profile
into a throwaway profile, opens the app in a browser on that copy so Firebase
restores the session the way it would in your everyday browser, and lets
Playwright write it with `storageState({ indexedDB: true })`. That is the *same
call* `save-storage-state.ts` uses, so the output has exactly the shape the
personas already read; nothing was invented. (The existing file confirms the
shape: `cookies` plus `origins[].indexedDB[firebaseLocalStorageDb]`, with each
record stored in Playwright's own `valueEncoded` serialization, which is exactly
why hand-writing that encoding was rejected.)

Least privilege was the design constraint. An everyday profile also holds your
Google account cookies, saved passwords, history and every other site's storage.
None of that is copied: no cookie store is copied at all, and the exported state
is filtered to the app's origin a second time before writing. (Notably the *old*
capture wrote your `.google.com` / `accounts.google.com` cookies into the file;
this one cannot.)

Alternatives considered and not built: reading Chrome's IndexedDB LevelDB
directly (its format is a custom comparator plus V8-serialized values; no
reliable library); attaching to your running Chrome over remote debugging
(Chrome 136+ ignores that switch for the default profile directory); a
DevTools-console snippet you paste while signed in (works with Chrome open and
copies nothing, but is manual, prompts Chrome's paste warning, and would need a
converter to Playwright's encoded format). The snippet is the sensible fallback
if the profile copy proves awkward on your machine.

## What was exercised on the synthetic profile

Real Chromium and real (headed) Chrome, a scratch profile, a stand-in page:

- `--list` reads a profile list and prints it (parsed from `Local State`'s
  `profile.info_cache`; real Chrome writes that layout, checked against the
  `Local State` a real Chrome instance produced for the scratch profile).
- The copy plus restore plus export path: the stand-in recognised the account,
  exactly one record was exported, **the decoy cookie was not carried across**,
  and the dry run wrote nothing.
- The write path, including an atomic write and `.previous` backup on overwrite.
- The exported file loaded through `newContext({ storageState })` exactly as
  `runPersona` loads it, and the stand-in showed the account (format
  consumability, with synthetic content).
- Refusals, each with an actionable message and **no scratch copy left behind**:
  anonymous-only session, no session record, wrong profile name, origin never
  visited in that profile.
- The "Chrome is still using this profile" guard, tested against **real headed
  Chrome** holding the scratch profile (`lockfile` appears while it runs and is
  removed on exit). Headless Chromium does not create that lock, so the guard is
  specifically for real Chrome, which is what matters.

## What only you can verify (the run sheet)

The exact commands are in `testing/agent-personas/README.md`, "When Google blocks
the automated login". In short:

1. In your everyday Chrome, sign in at <https://itinerary-six.vercel.app> with
   Google; wait for your name to appear.
2. Close every Chrome window, then check the tray and Task Manager.
3. `npx tsx testing/agent-personas/auth/export-chrome-session.ts --list`
4. `... --profile "<name>" --dry-run`, check the masked address is yours.
5. `... --profile "<name>"`.

Things I could not test and would look at first if it misbehaves:

- **Chrome's folder layout for `https` on the default port.** The scratch profile
  proved the pattern `<scheme>_<host>_<port>` (`http_localhost_3300`), and
  `https_<host>_0` is the long-standing convention for the default port, but I
  only observed the non-default-port form. If step 5 says "no saved data for
  https://itinerary-six.vercel.app", the message lists similarly named folders.
- **A real Firebase session restoring inside the copy.** The stand-in reads the
  IndexedDB record; the real app additionally refreshes the token over the
  network. The tool waits for the app's own account control and refuses if the app
  shows "Sign in" instead.
- **Chrome versions.** Copying only IndexedDB (no cookies, no `Local State`) was
  chosen to sidestep app-bound cookie encryption and the Chrome 136+
  remote-debugging restriction, but neither was tested against your Chrome.
- The **expired-login** case (refresh token revoked or stale) is detected by the
  app not recognising the account; only exercised with a stand-in.

## Deliberately not done

- No `package.json` script (out of scope; the command is documented). A one-liner
  `"test:agents:login:export": "tsx testing/agent-personas/auth/export-chrome-session.ts"`
  would be a nice follow-up.
- Signed-in personas were **not** run (spends real money).
- The old `save-storage-state.ts` was left as it is.
- No fake "verification" artifacts committed: the synthetic profile, stand-in and
  smoke scripts stayed in the session scratchpad.
