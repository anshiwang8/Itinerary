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
| `run-personas.ts` | CLI, cost guard, parallel launch, report handoff |
| `personas.ts` | the persona configs — **the file you edit to add a scenario** |
| `types.ts` | action / check / observed-plan shapes |
| `config.ts` | base URL resolution, pacing defaults, the cost model |
| `lib/runPersona.ts` | the action interpreter; one persona start to finish |
| `lib/app.ts` | real-UI interactions and the selector inventory |
| `lib/movement.ts` | the geolocation crawl and dwell |
| `lib/geo.ts` | polyline decoding, path resampling, jitter |
| `lib/itineraryProbe.ts` | reads the plan (and the auth header) off the wire |
| `lib/clock.ts` | the `?now=` natural-completion seam |
| `lib/recorder.ts` | the expected-vs-actual ledger, screenshots, console/network |
| `lib/report.ts` | markdown report, deviations only |
| `auth/save-storage-state.ts` | one-time interactive sign-in capture |
