# Agent persona testing

A manual, on-demand harness that runs several independent "persona" agents in
parallel against the **real deployed app**, each creating a real plan, moving
along the plan's **real route geometry** with simulated geolocation, doing real
mid-plan edits, and recording what was expected against what actually happened.

The output is one markdown report listing **only the deviations**.

> **This is not part of the test suite.** It is not in `npm run check`, not in
> `npm run test:e2e` (the deterministic mock suite on `:3100`), and not in any
> CI path. It spends real money on real Google and OpenRouter calls every time
> it runs, and it creates real itineraries in the production store. Port 3000
> is never touched.

## Two persona sets

There are **two** independent persona sets in this harness, run by two entry
points that share all the machinery below:

| Set | Personas | Entry point | Intent |
|---|---|---|---|
| **Ordinary use** | 51 | `npm run test:agents` | Does a real, sensible day come back — and do plan, edit, movement, arrival and ending all work? |
| **Break** | 100, all **guest** | `npm run test:agents:break` | Try to *break* the app: hostile input, conflicting/concurrent operations, the exact edges of real guardrails, malformed API requests, bounded rate-limit probing, and re-validation of ownership. |

The two sets never run together and never touch each other's files. The ordinary
set is described from ["What each persona covers"](#what-each-persona-covers)
down; the break set has its own section, ["The break set"](#the-break-set),
immediately after "Running it". Everything else in this README — geolocation
simulation, output, cost, the concurrency pool, the file list — applies to both.

---

## Running it

```bash
npm run test:agents                 # prints the plan + cost warning, runs NOTHING
npm run test:agents -- --confirm    # actually runs it
```

Without `--confirm` the runner prints the persona list, the call counts and a
cost estimate, then exits having done nothing. That is the whole guard: an
accidental `npm run test:agents` cannot spend anything.

### Where it points

`AGENT_TEST_BASE_URL`, falling back to `https://itinerary-six.vercel.app` (the
URL documented in `README.md` and `CLAUDE.md`). A `localhost` URL is **refused**
unless you pass `--allow-local`: a run against a local server would produce a
report that looks real and proves nothing about production.

### Flags

| Flag | Default | What it does |
|---|---|---|
| `--confirm` | off | Required to run. Without it nothing happens. |
| `--only a,b` | all | Run just these personas. |
| `--timeout <min>` | 22 | Per-persona wall-clock ceiling. |
| `--concurrency <n>` | 8 | How many personas are in flight at once. See below. |
| `--speed <n>` | 20 | Divides real travel pace. `--speed 1` walks at true 5 km/h. |
| `--max-leg-ms <ms>` | 90000 | Hard cap on crawling any one leg. |
| `--fix-interval-ms <ms>` | 4000 | Gap between simulated position updates. |
| `--headed` | off | Watch it happen. |
| `--allow-local` | off | Permit a localhost target. |

---

## The break set

```bash
npm run test:agents:break                 # prints the plan + cost warning, runs NOTHING
npm run test:agents:break -- --confirm    # actually runs it
```

**100 personas, all guest**, whose explicit intent is to *break* the app rather
than use it normally. Same `--confirm` guard, same batching pool (default
concurrency **8** — do not raise it; every persona shares one client IP against
the app's own per-(route, IP) rate limits), same `--only`/`--timeout`/`--headed`
flags, same localhost refusal, same gitignored output. The report is the same
format, deviations-only, written to `output/break-run-<timestamp>/` and named
**`BREAK-REPORT-<timestamp>.md`** (vs the ordinary `REPORT-...`).

**Strictly guest throughout.** No break persona signs in, so this set needs no
saved session and sidesteps the Google-auth limitation entirely.

### How it differs in *intent* from the ordinary 51

The ordinary set asks "does the app *work*". The break set asks "can I make the
app *misbehave*" — and its bar is almost always **graceful degradation**, not
success: a refusal, a clean 4xx, a rate-limit message, a coherent recovery.
Nearly every break persona is designed to be *refused*, and a refused plan never
reaches Places or Routes, which is why the ~$16 estimate is a firm upper bound.
It is **not** a penetration test: the existing set's light injection smoke test
is the ceiling for exploitation, and the break set does not go further (its
injection/template/prompt-injection personas only confirm the text is *inert*).

### Two runner kinds

Break personas come in two shapes, both in one runnable list (`breakTypes.ts`):

- **Browser personas** are ordinary `Persona`s and go through the existing
  `runPersona` unchanged, reusing every action. Two additive actions were added
  for scenarios the existing ones couldn't express (`concurrentMutations`,
  `crossSessionAccessDenied`); the ordinary 51 use neither.
- **Direct-API personas** (`ApiPersona`, `kind: "api"`) go through a **new,
  lightweight fetch-based runner** (`lib/runApiPersona.ts`): no browser, no page,
  no navigation — just raw HTTP straight at the routes, testing that server-side
  validation rejects what it should independent of whatever a real browser would
  ever send. They **reuse the same `Recorder` and the same report** (a check
  record needs no page); only the per-persona interpreter differs, because an
  API persona has no plan on screen, no movement and no actions to interpret.
  The dispatcher picks the runner by `kind`; a browser is launched only if the
  selected set contains a browser persona.

### The six categories (~16-17 each, 100 total)

1. **Input-based attacks (17)** — multi-KB prompts, kilobyte-long addresses,
   emoji-only, right-to-left Arabic, zero-width characters, mixed scripts,
   combining-mark "Zalgo", control characters, a repeated vowel-less character,
   HTML/entity/template/JSON/prompt-injection text (each confirmed *inert*), a
   newline flood, rapid duplicate submissions, and a whitespace-only prompt
   (which the UI can't even submit, so it's proven at the API).
2. **State-machine abuse (17)** — conflicting/concurrent operations that timing
   alone can produce: two removes of the same stop at once, three swaps launched
   before any response returns, a swap racing a remove, four concurrent mode
   switches, a five-op storm, reloads at intermediate moments (mid-swap,
   after-create, after-mode-switch, after-swap), out-of-order sequences, and a
   double-end. The genuinely-concurrent ones use `concurrentMutations`, which
   fires raw HTTP with the owner's own captured auth (testing CAS/engine
   concurrency, never ownership) and asserts no 5xx + a coherent re-read.
3. **Boundary hammering (17)** — the exact edges of real guardrails, transcribed
   from the code, approached from **both sides**. The 75 km start cap is
   bracketed with real geocoded addresses (Guelph ~70.7 km inside; Kitchener /
   Barrie / London over; Buffalo cross-border trips the country test first;
   Mississauga and a Gatineau→Ottawa cross-region-but-near case inside
   `SAME_METRO_METERS`, Montreal→Ottawa over it). The numeric edges that *are*
   controllable are hit exactly: 2000 vs 2001 prompt chars, 25 vs 26 candidates
   per pool, 8 vs 9 categories, 8 vs 20 activities, 5-minute clamp to the
   15-minute floor, 8-hour clamp to the 360-minute ceiling, 13 days inside the
   14-day horizon, and the 700 m drive-to-walk relabel. An **exact-at** 75 km
   address isn't addressable with real geocoding, so that one edge is documented
   as bracketed rather than hit.
4. **Direct API calls (17)** — malformed bodies straight at the routes: missing
   required fields, wrong types, extra/`__proto__` fields, invalid JSON, an
   oversized body (>256 KB → 413), a 3000-deep nested body, invalid optionals,
   pool/category/total-candidate caps, malformed vs nonexistent itinerary ids,
   an invalid `?now=`, and wrong HTTP methods / unknown routes. Every one asserts
   a clean 4xx (or the specific code), **never a 5xx**, and the app's structured
   JSON error envelope rather than a raw crash page.
5. **Resource exhaustion — BOUNDED (16)** — confirms the app's rate-limiting
   *holds and degrades gracefully*, and nothing more. **No burst exceeds
   `MAX_BURST_REQUESTS` (45)** and **no persona creates more than
   `MAX_REAL_PLANS_PER_PERSONA` (5)** real plans (the bounded-plan personas
   actually create only 3). The rate bucket is incremented *before* body parsing
   or any provider call, so cheap malformed requests trip the limiter with **zero
   provider spend**. Every 429 is checked for the app's own "Too many requests"
   message and a `Retry-After` header; a bounded burst that doesn't trip the
   limit is *recorded, not failed*. This is not a DoS attempt and never resembles
   one. **The genuinely-tripping bursts target `/reroute` (30/min), which no
   other persona touches**, so they don't pollute another category's traffic;
   the mutation-route (30/min) and higher-limit bounded bursts share buckets with
   other personas' normal traffic in a full run, so **run category 5 with
   `--only` for a fully isolated read** if you care which bursts tripped.
6. **Guest-to-guest access (16)** — re-validates the R1 ownership work. A guest's
   plan is **owned** (guests are signed in anonymously), so half of these create
   a real owned plan and confirm a stranger — unauthenticated, a forged token,
   and (for some) a genuinely separate second anonymous guest — is denied every
   by-id route (GET/swap/remove/mode) with the same indistinguishable **404**. If
   a plan turns out unowned (the documented anonymous-sign-in race, or Firebase
   unconfigured) it's recorded as *not exercised* and **no unauthenticated
   mutation is fired against it**. The other half are cheap API probes of the
   indistinguishability contract: a nonexistent id, a forged token, a malformed
   auth header, the guest history/profile/resume reads, and the still-ungated
   (dev-only) `/reroute` — all confirmed to leak nothing about which ids exist.

Every threshold above is transcribed from the code (see the header comment in
`breakPersonas.ts` for the exact constants and their source files), never
guessed. **No persona asserts a venue name** — the same rule as the ordinary set.

### Cost and safety

A dry run (`npm run test:agents:break`, no `--confirm`) prints all 100 personas
grouped by category, the request counts, and a ~$16 upper-bound estimate, then
exits having spent nothing. Most of that estimate is the browser personas that
create real plans; the 40 direct-API personas and the rate-limit bursts are
rejected at validation or by the limiter *before any provider call*, so they cost
essentially nothing. A load-time guard throws if the set is not exactly 100
personas or a name repeats.

---

## What each persona covers

**Fifty-one personas**, in seven groups. Scenarios are **grouped** per persona
rather than one persona per requirement, so a run covers the whole matrix in
far fewer browser contexts than it has requirements.

**No persona asserts a venue name.** Venues change. Every expectation is a
shape (a plan exists, a refusal is graceful), a count, or a specific
documented guard.

### The core matrix (1-8)

The original set: plan variety, every mutation, movement and arrival, and both
ways a plan can end.

| Persona | Identity | Covers |
|---|---|---|
| `specific-diner` | guest | specific prompt · same-category venue swap · remove **last** stop · on-schedule movement + arrival detection · guest end |
| `vague-wanderer` | guest | **vague** prompt (the single-stop-fallback regression) · **category-changing** swap · remove **middle** stop · deliberately **late start** |
| `patio-constraint` | guest | hard constraint (patio + wheelchair accessible) · **lingering** past a stop's window |
| `indoor-only` | guest | indoor-only constraint must not self-contradict into a refusal · remove **first** stop |
| `vegan-dietary` | guest | dietary constraint, same provability question |
| `mode-switcher` | guest | mid-plan **transit → driving → transit**, every venue kept · driving movement |
| `transit-rider` | guest | cross-town **transit legs**: ride each one, screenshot the coloured ride lines / badges / board times |
| `signed-in-regular` | **signed in** | personalized planning · **discard-end must NOT archive** · **natural completion must** |

### 1. Ordinary variety (9-18)

Mundane-to-pleasant requests the core eight never covered. Each asks one
question: does a real, sensible day come back for this? No movement, so they
finish fast.

| Persona | Covers |
|---|---|
| `park-walk` | a daytime outdoor request, which is also the one ordinary prompt that can meet the weather gate |
| `rainy-day` | an indoor afternoon that names the weather, so "indoors" must not leak into `constraints` |
| `morning-coffee` | a small morning ask that should stay small |
| `birthday-celebration` | a group occasion with a stated vibe |
| `first-date` | a bare-meridiem `6:30pm`, which must resolve to the evening |
| `solo-museum` | a long stop beside a short one: two different durations, not one default twice |
| `family-afternoon` | somewhere child-appropriate, then an early dinner |
| `bar-crawl` | the **VARIETY caps releasing** when the request names several drinking stops |
| `errand-run` | the deliberately unglamorous case: groceries and a coffee, **not** an evening out |
| `weekend-brunch` | a **named weekday**, which is the deterministic `applyWeekdayFloor` path |

### 2. Adversarial (19-28)

Each tests that the app fails **gracefully**, not that it succeeds. They stop
at plan creation: dragging a broken plan through the swap and movement chain
would bury the one answer that matters under cascading skips.

| Persona | Covers |
|---|---|
| `bare-prompt` | `"plan something"` — a real day or a clarifying round, never an error |
| `french-prompt` | a non-English prompt (**there is no language gate in this codebase** — the model decides) |
| `spanish-prompt` | a second language, so the first result reads as behaviour rather than luck |
| `gibberish-prompt` | keyboard mash — **deterministic**: `degeneratePromptReason` refuses it pre-model |
| `impossible-request` | Mars and the moon: never a fabricated venue, since every venue has a real Places id |
| `contradiction-stack` | two contradictions — one the **code** catches (`vegan steakhouse`), one only the model can judge (`loud and quiet`) |
| `rambling-prompt` | several paragraphs with one small request buried in them |
| `injection-text` | a **light** smoke test that script- and SQL-shaped text is inert (see below) |
| `too-many-stops` | `"20 things to do tonight"` capped at the app's own `MAX_ACTIVITIES = 8` |
| `zero-duration` | an impossible duration, clamped to the 15-minute floor or refused |

The injection persona is a **smoke test for inert handling, not a penetration
test**. Its whole assertion is that the text behaves like text: no script runs
(the recorder captures and dismisses every JavaScript dialog, so one that fired
would be listed), no internal or database error reaches the screen.

### 3. Geography stress (29-35)

Every threshold here is **transcribed from the code**, not guessed:
`MAX_START_DISTANCE_FROM_CITY_METERS = 75_000` and `SAME_METRO_METERS = 25_000`
in `app/api/geocode/geocode.ts`, `DRIVING_SHORT_LEG_WALK_METERS = 700` in
`app/api/schedule/travel.ts`.

| Persona | Covers |
|---|---|
| `city-radius-edge` | **both sides** of the 75 km cap: Guelph at ~70.7 km should plan, Kitchener at ~92.2 km must hit `geocode_far_from_city` |
| `nonsense-start-address` | an unparseable start is refused, and **never** silently replaced with the Ossington default |
| `cross-border-start` | a US address for a Toronto plan: the country test is hard and runs first |
| `short-hop-driving` | the **700 m relabel**: no leg on a driving plan comes back `driving` under the threshold |
| `cross-town-transit` | a long journey with transfers, screenshotting each leg's ride lines and board times |
| `waterfront-detour` | a route that has to go around water, where the straight line and the real one differ |
| `second-city-timezone` | **Vancouver**: a different city in a different IANA zone, end to end — the gap mock e2e cannot reach |

The two distances are measured with the same haversine the app uses, from
Toronto's own geocoded centre.

### 4. Time edges (36-42)

Every prompt here states its own clock time or window, so the expectation is
correct **whenever the run happens**: a stated hour that has passed rolls
forward to the next day rather than becoming wrong. See "Time expressions"
below — this is the thing the first run got wrong.

| Persona | Covers |
|---|---|
| `early-morning` | 6 AM, where a refusal naming the **hour** is very likely the correct answer |
| `across-midnight` | a stated range must roll as **one unit**, decided by its end, never inverted |
| `future-dated` | `"next Saturday"` — **supported**: inside `MAX_PLAN_HORIZON_DAYS = 14`, with the weekday floor correcting the date |
| `impossible-window` | 8 stops in 30 minutes: trimmed and named, or refused, but never eight stops |
| `tiny-window` | 30 minutes buys one modest stop, still respecting the 15-minute floor |
| `long-window` | twelve hours, paced rather than padded |
| `airport-layover` | a hard ceiling with somewhere to be afterwards |

### 5. Account and session edges (43-46)

| Persona | Covers |
|---|---|
| `guest-signs-in-midsession` | the **structural** half: no sign-in control exists while a plan is on screen. The OAuth half is reported as not exercised — see below |
| `location-permission-denied` | "Use current location" refused: the field stays typeable and names the way out |
| `live-tracking-denied` | tracking refused: **no you-marker at all**, plus the app's own denied note |
| `second-device-resume` | the same session in a second browser context resumes the same plan |

`guest-signs-in-midsession` is the one persona whose headline scenario is
**deliberately not asserted**, and the report says so in its own words. The
code behaviour is unambiguous — `signIn()` calls `linkWithPopup` for an
anonymous user precisely because linking KEEPS the uid, so an in-progress plan
stays owned; a returning account instead hits `auth/credential-already-in-use`
and falls to `signInWithCredential`, which mints a different uid and leaves the
guest's plan with the guest. What is not reachable is the scenario: Google's
OAuth popup cannot be automated (the same wall behind `test:agents:login`), and
`page.tsx` mounts the account corner inside `if (!itinerary)`, so there is no
in-app path from a live plan to a sign-in at all. The persona proves that
second fact and hands the first to a human.

### 6. Interaction stress (47-51)

| Persona | Covers |
|---|---|
| `repeated-swaps` | the same stop swapped **three times** in a row |
| `remove-to-one` | remove down to one, then try the last: the **down-to-zero guard** must refuse |
| `mode-thrash` | four switches in a row, every venue surviving all four |
| `double-end` | End twice: the control is gone, and the server's end path is idempotent |
| `reload-mid-swap` | refresh before the swap's response returns, then recover to a consistent state |

## Time expressions, and the lesson from the first run

The first eight-persona run happened at about 2 AM local, and several
"deviations" in it were the app **correctly** refusing because real venues are
shut at that hour. The lesson is not "run it earlier"; it is that a persona's
expectation has to be right for whenever the run actually happens. So:

- **"right now" is used only where movement or arrival is being tested.** The
  immediacy floor is what makes a stop go active inside a test run at all, so
  those personas are the ones that legitimately care what time it is.
- **Everything else states an explicit clock time or window.** A stated hour
  that has already passed rolls forward to the next day, so "brunch at 11am" is
  a correct request at 2 AM and at 2 PM alike — it simply lands on a different
  day, which is the right answer both times.
- **Where the honest outcome genuinely depends on live data** (nothing is open
  at 6 AM), `refusalIsAcceptable` records *which* happened instead of calling
  one of them a bug. `refusalMustMention` still holds the refusal to the app's
  own documented wording, so an improvised error is a deviation either way.

Adding a scenario means adding a persona (or an action) in `personas.ts`. The
runner interprets the action list; its core loop does not change.

## Geolocation simulation

Each persona is its own `BrowserContext` with `permissions: ["geolocation"]`
granted programmatically, so no permission dialog is ever involved.

Movement uses `context.setGeolocation()`, which sets Chromium's geolocation
**override** at the browser level. The page's `navigator.geolocation` is the
real one, and the position it returns is the emulated one — so the app's own
`liveTracking.ts` → `REAL_LIVE_TRACKING_DEPS` → `navigator.geolocation.watchPosition`
runs **completely unmodified**. Its `handleFix` receives a genuine
`GeolocationPosition` with a real timestamp, so the stale-on-arrival guard, the
15s heartbeat, the `visibilitychange` handling, `computeYouMarker` and
`reduceArrival` all execute for real.

**Nothing in this harness stubs `navigator.geolocation`, injects state into the
page, patches a module, or calls an app function.** If a future edit is tempted
to do any of that, the harness has stopped testing the thing it exists for.

### The path walked is the plan's own

The app already fetches `GET /api/itinerary/<id>` after creating a plan and
after every mutation. `ItineraryProbe` listens to those responses, so the
harness reads exactly what the browser read: the same plan, same version, no
extra provider cost, no second source of truth.

From each leg it takes the provider's own geometry, preferring `pathSegments`
(the walk to the stop, the ride, the transfer walk, step by step) over the
seamless whole-leg `encodedPolyline`, decodes it with Google's standard
precision-5 polyline algorithm, and re-samples it evenly **by distance** so
every reported position sits on the real line.

A leg with no geometry (the documented `unknown` estimate, or a provider
response that drew no line) is **recorded as such** and the device is placed at
the stop's own coordinate. No route is ever invented.

### When to run it, if you care about arrival detection

Arrival is only ever marked on the **currently-active** stop, and `buildSchedule`
puts the home leg *before* the first stop, so "right now" means "leave now" and
stop 0 opens once you could plausibly have got there. Late at night that gap
grows: venue opening hours start dominating, and a first stop can land an hour
out, past `waitUntilStopActive`'s budget. The report says so explicitly when it
happens, and only the movement chain is skipped — the plan's swap, removal,
mode switch and ending still run.

**Run it in the earlier evening** (or raise each persona's `maxSeconds` and
`--timeout`) if the arrival and movement scenarios are what you are after.

### Pacing

Travel is derived from a real ground speed (walk ~5 km/h, drive ~35 km/h,
transit from the leg's own door-to-door minutes) and then divided by
`--speed` so a full run is minutes rather than hours. The *route* is unchanged
by that compression — the same real points in the same real order.

**Dwell time is never compressed.** The app's arrival requirement is 45 s of
real time and its staleness threshold is 45 s of real time, so a compressed
dwell would be testing a different app. Positions wobble a few metres per fix
during a dwell: a phone never reports the same coordinate twice, and Chromium
may not re-deliver an unchanged position to an active watch. The wobble is far
inside the app's own 75 m arrival radius, so it can neither manufacture nor
prevent an arrival.

---

## Signed-in personas

The app's only sign-in is Google's OAuth popup. Automating a real Google login
is unreliable by design, and there is no password path to script against. So:

```bash
npm run test:agents:login
```

opens a real browser window, you sign in by hand (and answer the taste survey
if it appears — the signed-in persona plans a bare prompt specifically to see
whether the stored profile shapes the day), press Enter, and the session is
saved with `storageState({ indexedDB: true })`. The `indexedDB` flag is
load-bearing: Firebase Auth keeps its session there, not in cookies.

If that file is missing, signed-in personas are **reported as skipped**, never
silently downgraded to a guest — a guest's plan is never archived at all, so a
downgraded persona's history checks would pass for the wrong reason.

The saved file is a real credential for that account. It lives in the gitignored
`output/` directory. Do not commit or share it.

### When Google blocks the automated login: export from your everyday Chrome

`npm run test:agents:login` drives a browser, and Google can refuse to sign in an
automated one ("Couldn't sign you in"; a real Chrome channel and then
fingerprint suppression were both tried and both refused). Signing in **by hand**
in your everyday Chrome is not refused, and the app's session then sits in that
browser's storage. `auth/export-chrome-session.ts` carries it across, writing the
**same file, in the same shape**, that `test:agents:login` writes and the
signed-in personas already read.

> **Status: written and mechanics-tested on a throwaway synthetic profile only.
> It has NOT been run against a real Chrome profile with a real login. That has to
> be you, once.** The steps below are how.

**Once, by hand**

1. In your everyday Chrome, open <https://itinerary-six.vercel.app>, click
   **Sign in**, and sign in with Google. Answer the taste survey if it appears.
   Wait until your **name** shows in the corner (a guest sees "Sign in").
2. **Close every Chrome window.** Then check the system tray and Task Manager:
   Chrome keeps running in the background unless *Settings > System > Continue
   running background apps when Google Chrome is closed* is off. The tool refuses
   to run while Chrome still holds the profile (a copy taken from a running Chrome
   is torn), so this step cannot be skipped by accident.

**Then, from the repo root**

```bash
# 3. see which profile is which (reads Chrome's profile list only)
npx tsx testing/agent-personas/auth/export-chrome-session.ts --list

# 4. rehearse: does everything except write the file
npx tsx testing/agent-personas/auth/export-chrome-session.ts --profile "Default" --dry-run

# 5. for real
npx tsx testing/agent-personas/auth/export-chrome-session.ts --profile "Default"
```

Use the profile name `--list` shows for the Chrome profile you signed in with. If
you have more than one profile the tool will not guess (capturing the wrong account
would make the run test the wrong user).

**What a good run prints** (no tokens, only facts):

```
Captured a signed-in session:
  account   y***@gmail.com
  provider  google.com
  the app recognised it as a real account: yes
  cookies: 0
  origin https://itinerary-six.vercel.app: localStorage 0, indexedDB firebase-heartbeat-database [...]; firebaseLocalStorageDb [firebaseLocalStorage: 1]

Saved testing\agent-personas\output\signed-in-state.json (... bytes).
It is gitignored. Treat it as a credential: do not commit or share it.
```

Check three things: the masked address is **your** account, `provider` is
`google.com`, and `firebaseLocalStorage: 1` (or more) is present. Any existing
`signed-in-state.json` is kept beside it as `signed-in-state.json.previous`.
The tool's own output above is the check: it only writes the file after the app
itself has recognised the account. The signed-in persona (`signed-in-regular`)
reports "skipped" at *run time* when this file is missing, so once it exists it is
picked up. The dry run (`npm run test:agents`) does not look at the file. The only
full confirmation is a real `npm run test:agents -- --only signed-in-regular
--confirm`, which spends real money, so that call is yours.

**What it does, and never does**

- It copies **only the app origin's IndexedDB folder** out of the chosen profile
  into a throwaway profile, opens the app in a browser on that copy so Firebase
  restores the session exactly as it would in your everyday browser, and lets
  Playwright write it with `storageState({ indexedDB: true })`.
- It **never copies cookies** (so your Google account session cannot end up in
  the file), saved passwords, history, extensions, or any other site's storage.
  The result is filtered to the app's own origin a second time before writing.
- It refuses, with a message saying what to do, when: Chrome still has the
  profile open; the profile has no saved session for the app; the session is an
  anonymous **guest** one (which would make a "signed-in" persona a guest); or the
  app does not recognise the account when loaded (an expired or revoked login).
- The throwaway profile is deleted on every exit path, including failures.
- Nothing is sent anywhere. It talks to the app you point it at (to let Firebase
  restore the session) and writes one local file.

**If it does not work**

| Symptom | Likely cause |
|---|---|
| "Chrome is still using this profile" | A Chrome process is still alive: tray icon, Task Manager, or "continue running background apps". `--ignore-lock` only for a stale lock. |
| "no saved data for <origin>" | You signed in in a different Chrome profile, or on a different URL. Use `--list` and `--origin`. |
| "holds only a GUEST session" | You never completed the Google sign-in in that profile. |
| "did not recognise it when loaded" | The login expired or was revoked. Sign in again in Chrome and retry. |
| Chrome will not launch for the copy | Try `--channel chromium` (Playwright's bundled browser) or `--headed` to watch it. |

The session file is a real credential (a refresh token for your account). It lives
in the gitignored `output/` directory; delete it when you are done with it. To
invalidate it at the source, remove the app's access in your Google Account
(Security > Third-party access), or have whoever administers the Firebase project
revoke that user's refresh tokens.

The pure helpers behind this (folder naming, profile list, session facts, output
filtering) have unit tests: `npx tsx testing/agent-personas/auth/chromeSession.test.ts`
(11 cases; not part of `npm run check`, like the rest of this harness).

---

## Natural completion

A real plan ends hours after it starts, so "let it finish on its own" cannot be
waited out. The app has one documented control for this and it is a real server
path, not a test hook: `?now=ISO` on `GET /api/itinerary/[id]`, described in
`CLAUDE.md` as "the dev time control and the backbone of reroute testing". The
conclusion lifecycle — `readItineraryWithLifecycle` → `withStatuses` →
`maybeArchive` → the owner's pointer clear — runs inside that same GET, so
asking for a future instant exercises the real completion and archive code.

The request is issued from the persona's own browser context carrying the same
`Authorization` header the app itself sent, captured off the wire. Ownership is
not bypassed: without that header an owned plan answers 404, exactly as it
would for anyone else. Every use of this is labelled in the report, so a reader
can tell which results came from a simulated instant and which from the wall
clock.

---

## Output

Everything lands in `testing/agent-personas/output/run-<timestamp>/`:

```
output/run-2026-09-09_21-40-00/
  REPORT-2026-09-09_21-40-00.md
  specific-diner/01-plan-created.png ...
  indoor-only/...
```

The whole `output/` directory is **gitignored** — these are point-in-time
artifacts containing screenshots of real venues, real addresses and, for a
signed-in run, real account data. The runner prints the report path when it
finishes.

The report contains a summary table, then **only the deviations**, grouped by
persona, each with expected / actual / a screenshot link. Passing checks are
counted, never enumerated: the report exists to find problems, and a wall of
green hides the one red line in it. Anything that could not be exercised at all
is listed separately under "Not exercised" — neither a pass nor a deviation.

---

## Cost

The estimate printed before a run comes from `config.ts`'s `COST_PER_CALL_USD`,
built from list prices for the SKUs this pipeline uses (Places Text Search Pro,
Routes, Geocoding, Weather, a Maps dynamic load, and OpenRouter completions at
the ~$0.002/planner-call figure `CLAUDE.md` records). A full eight-persona run
comes out around **$2**; the full fifty-one comes out around **$12**, and both
figures are upper bounds, because a plan the app REFUSES (a bad address, a
contradiction, a degenerate prompt) never reaches Places or Routes at all and
several personas exist precisely to be refused.

It is an estimate for a warning message, not an invoice: real spend depends on
how many activities each plan resolves to, whether a recovery widen runs, and
what volume pricing the account has.

---

## Rate limits, and why there is a concurrency pool

The app rate-limits per (route, client IP) over a 60-second window, and every
persona shares one IP. The tightest limits it touches are `/api/places/search`
and `/api/geocode` at 60/min and the three mutation routes at 30/min each. A
single plan spends two geocodes plus roughly one Places search per activity.

Eight personas sit well inside all of that — the movement pacing that makes the
run realistic is also what keeps it polite. **Fifty-one launched at once would
not**: several hundred calls inside one window, a pile of 429s, and a report
full of rate-limit failures that says nothing about the app.

So the runner keeps at most `--concurrency` personas in flight, defaulting to
**8** — deliberately the size of the original set, so a run of those eight is
still all-at-once and behaves exactly as it always did. A worker takes the next
persona the moment it finishes one, so a persona that ends in ninety seconds
does not hold a slot for the twenty minutes its neighbour needs. A full
fifty-one-persona run takes roughly **25–40 minutes** of wall clock on that
default.

Lower it if the deployment's limits are tighter; dropping `--speed` to 1 should
be done with the same arithmetic in mind.

---

## Files

| File | Job |
|---|---|
| `run-personas.ts` | ordinary-set CLI: cost guard, parallel launch, report handoff |
| `personas.ts` | the ordinary 51 persona configs — **edit this to add an ordinary scenario** |
| `run-break-personas.ts` | break-set CLI (`test:agents:break`), reusing the shared pool/report/cost |
| `breakPersonas.ts` | the 100 break personas + category mapping — **edit this to add a break scenario** |
| `breakTypes.ts` | the `ApiPersona`/`ApiStep` shapes, the break cost model, the bounded caps |
| `types.ts` | action / check / observed-plan shapes (shared by both sets) |
| `config.ts` | base URL resolution + validation, pacing defaults, the cost model |
| `lib/pool.ts` | the shared batching / concurrency pool (used by both entry points) |
| `lib/runPersona.ts` | the browser action interpreter; one browser persona start to finish |
| `lib/runApiPersona.ts` | the fetch-based runner for direct-API break personas (no browser) |
| `lib/app.ts` | real-UI interactions and the selector inventory |
| `lib/movement.ts` | the geolocation crawl and dwell |
| `lib/geo.ts` | polyline decoding, path resampling, jitter |
| `lib/itineraryProbe.ts` | reads the plan (and the auth header) off the wire |
| `lib/clock.ts` | the `?now=` natural-completion seam |
| `lib/recorder.ts` | the expected-vs-actual ledger, screenshots, console/network |
| `lib/report.ts` | markdown report, deviations only (both sets) |
| `auth/save-storage-state.ts` | one-time interactive sign-in capture (ordinary set only) |
| `auth/export-chrome-session.ts` | the fallback when Google blocks that capture: copies the app origin's session out of your everyday Chrome profile (needs you to run it once) |
| `auth/chromeSession.ts` | its pure helpers (folder naming, profile list, session facts, output filtering) |
| `auth/chromeSession.test.ts` | unit tests for those helpers (11 cases, run by hand) |
