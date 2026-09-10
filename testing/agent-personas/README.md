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
| `--speed <n>` | 20 | Divides real travel pace. `--speed 1` walks at true 5 km/h. |
| `--max-leg-ms <ms>` | 90000 | Hard cap on crawling any one leg. |
| `--fix-interval-ms <ms>` | 4000 | Gap between simulated position updates. |
| `--headed` | off | Watch it happen. |
| `--allow-local` | off | Permit a localhost target. |

---

## What each persona covers

Scenarios are **grouped** per persona rather than one persona per requirement,
so eight browser contexts cover the whole matrix.

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

Adding a scenario means adding a persona (or an action) in `personas.ts`. The
runner interprets the action list; its core loop does not change.

---

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
comes out around **$2**, and takes roughly **12–18 minutes** of wall clock
because the personas run in parallel.

It is an estimate for a warning message, not an invoice: real spend depends on
how many activities each plan resolves to, whether a recovery widen runs, and
what volume pricing the account has.

---

## Rate limits and pacing

The app rate-limits per (route, client IP) over a 60-second window, and every
persona shares one IP. The tightest limits it touches are `/api/places/search`
and `/api/geocode` at 60/min and the three mutation routes at 30/min each. Eight
personas doing one plan and a couple of edits, spread across minutes of movement
simulation, sit well inside all of them — the movement pacing that makes the run
realistic is also what keeps it polite. Raising the persona count or dropping
`--speed` to 1 should be done with that in mind.

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
