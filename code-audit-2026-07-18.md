# Code audit — 2026-07-18

Logic-only audit of the Itinerary codebase. **Report only — no code was changed.** Style,
naming, and formatting are out of scope; everything below is something that could produce a
wrong plan, a wrong time, a wrong price, a silently-dropped venue, or a failure that lands
somewhere other than the fail-loud surface.

Scope: all of `app/` (routes, engines, lib, UI), excluding `*.test.ts` and `e2e/` except where
test coverage is the finding.

Every finding carries a **test-coverage note**. Where a suite exists that *should* have caught
the problem but structurally cannot, that's called out — it's its own signal.

**Severity key**
- **high** — can produce a visibly wrong plan (wrong venue, wrong time, dropped stop) in
  ordinary use, or on the deployed multi-city configuration.
- **medium** — wrong or unhelpful behaviour in a plausible-but-narrower situation, or a latent
  trap a future change would step on.
- **low** — real but hard to reach, cosmetic, or already contained by something downstream.

**Count:** 27 findings — 3 high, 13 medium, 11 low.

---

## Summary — the four that matter most

1. **§1.1** The swap engine's availability check reads the *server's* wall clock, not the
   plan's timezone. On Vercel (UTC) this misjudges "is it open" for every plan, including
   Toronto ones. No test can catch it — every test injects a substitute.
2. **§1.4** The hours filter and weather gate judge *every* category at the **first** stop's
   instant. In "dinner at 7 then a bar", bars are filtered on whether they're open at 7 PM,
   not on arrival. This silently drops correct venues and admits venues that close before you
   arrive.
3. **§7.1** Duplicate category signals collapse silently — a two-stop request becomes a
   one-stop plan (and in reroute, the *same venue twice*) with no message. This is exactly the
   silent-drop class the recovery panel was built to eliminate.
4. **§1.3** The mock availability fixture reproduces §1.1's bug faithfully, so the mock e2e
   suite agrees with broken behaviour. Same fixture-fidelity trap as the `mockSelect` ordering
   bug found earlier.

---

## 1. Timezone / scheduling correctness

### 1.1 — `usableByHours` uses the server's wall clock, not the plan's zone — **high**
`app/api/itinerary/swap.ts:414-421`

```ts
function usableByHours(place: Place, when: Date): boolean {
  const verdict = isOpenAt(place.currentOpeningHours, {
    day: when.getDay(),      // ← server-local
    hour: when.getHours(),   // ← server-local
    minute: when.getMinutes(),
  });
```

`Date.prototype.getDay/getHours/getMinutes` return components in the **server process's**
timezone. Every other hours check in the pipeline goes through
`wallClockParts(instant, timeZone)` (`filter.ts:165`) precisely so the venue's *own* local
clock is used. This one doesn't, and it has no `timeZone` parameter to pass one through —
`SwapDeps.isUsableAt` (`swap.ts:123`) is typed `(place, when, category) => boolean`.

**Why it matters.** This is the ONE "can we use this venue then" check
(`CLAUDE.md`: the availability seam), consumed by `timeChange` (`swap.ts:741`),
`resettleTail` (`swap.ts:871`) and `findReplacement` (`swap.ts:926`). On Vercel, functions run
in **UTC**: a 7 PM Toronto stop is evaluated as 23:00, and a 9 PM one as 01:00 *the next
weekday* — wrong hour and wrong day-of-week, so venues open at the real time get judged closed
and the swap engine "adapts" to a replacement that wasn't needed, or refuses with
"Nothing similar to X is open around 9:00 PM" when X is open. For a Vancouver plan on a
Toronto server the error is a flat 3 hours. `DEPLOY.md` prescribes `TZ=America/Toronto`, which
masks this for Toronto plans only — and its stated rationale (scheduler date math) is itself
stale, since scheduling is per-plan zone-aware now. This finding is the *real* reason that
`TZ` line still matters.

**Fix shape.** Thread the plan's zone into the seam (`isUsableAt(place, when, category, tz)`,
or close over `tz` in `realDeps()`), and implement the body with `wallClockParts` so there is
one zone-aware hours computation instead of two (see §5.2).

**Test coverage: no test can currently catch this.** `swap.test.ts` *does* have multi-city
zone tests (`swap.test.ts:802`, "an absolute time-swap lands 6pm in the PLAN's zone") — but
every test injects its own stub, `isUsableAt: (place) => !(opts.unusableIds ?? []).includes(place.id)`
(`swap.test.ts:154`), so the production default is never executed. Mock e2e substitutes
`mockIsUsableAt`, which has the same flaw (§1.3). The function has **zero** effective
coverage.

---

### 1.2 — `parseTargetTime`'s `day` field: confirmed dead, and a live trap — **low**
`app/api/places/search/hours.ts:61`

```ts
let day = now.getDay();                        // server-local
if (tw.includes("tomorrow")) day = (day + 1) % 7;
return { day, hour, minute };
```

**Your prior belief is correct — the field is dead.** Full trace of every consumer:

| Call site | What it reads |
| --- | --- |
| `schedule.ts:239` (`resolveStartTimeChecked`) | null-check only (`!== null`) — no field access |
| `schedule.ts:299-301` (`resolveStartTime`) | `target.hour`, `target.minute` only; the day comes from `dayOffset` + `instantAtWallClock`, which is zone-aware |
| `filter.ts:166` | builds its **own** `TargetTime` from `wallClockParts` — never calls `parseTargetTime` |
| `swap.ts:415`, `fixtures.ts:461` | build their own target objects (see §1.1, §1.3) |

No code path reads `.day`. `grep` for `\.day` across `app/` confirms the only reads are of
locally-constructed targets. So it is genuinely inert today.

**Why it still matters.** It is a correctly-shaped, wrongly-computed value sitting on a type
(`TargetTime`) whose *other* consumer (`isOpenAt`) treats `day` as load-bearing. The two
functions are in the same file, and `TargetTime` is exported. Anyone wiring
`parseTargetTime` → `isOpenAt` — the most natural-looking composition in the module — silently
reintroduces a server-local day bug. It also takes a `now` parameter that exists *only* to
compute this dead field.

**Fix shape.** Either drop `day` from the return (and the `now` parameter with it), making the
function purely a clock-time extractor, or compute it zone-aware and pass a zone in. Dropping
is the smaller change and matches actual usage.

**Test coverage:** `schedule.test.ts:499` exercises the clock-time path
("'tomorrow, 6am' → Saturday 06:00") but asserts the resolved *instant*, which comes from
`instantAtWallClock` — so it passes regardless of what `day` holds. No test asserts `day`.

---

### 1.3 — `mockIsUsableAt` reproduces §1.1's bug, so mock e2e ratifies it — **medium**
`app/api/_mock/fixtures.ts:458-466`

```ts
export function mockIsUsableAt(place: Place, when: Date): boolean {
  return isOpenAt(hours, { day: when.getDay(), hour: when.getHours(), minute: when.getMinutes() }) !== false;
```

Identical server-local component extraction. The fixture layer is supposed to swap the *data
source* while the real logic runs — but here the fixture reimplements the logic, and
reimplements it with the same defect as production.

**Why it matters.** It means a mock e2e run cannot fail on §1.1 even in principle; if §1.1 is
fixed in `swap.ts` and not here, the mock suite would then disagree with production in the
opposite direction. This is the same class as the `mockSelect` empties-ordering bug found in
an earlier batch: *the seam swapped the contract shape, not just the data.*

**Fix shape.** Fix §1.1 first, then have `mockIsUsableAt` delegate to the same zone-aware
helper, keeping only the fixture *lookup* (`fixtureHoursById`) as mock-specific.

**Test coverage:** by construction, no mock test can catch this — it *is* the test
infrastructure.

---

### 1.4 — Hours filter and weather gate judge every category at the FIRST stop's instant — **high**
`app/api/places/search/filter.ts:158-170`, applied at `:224` and `:174-201`

```ts
const startInstant = targetOverride ?? resolveStartTime(parsed.time_window ?? "", now, Object.keys(pools), timeZone);
const { weekday, hour, minute } = wallClockParts(startInstant, timeZone);
const target: TargetTime = { day: weekday, hour, minute };
const forecast = weather && weather.length > 0 ? forecastAt(weather, startInstant) : null;

for (const [category, places] of Object.entries(pools)) {   // ← same `target` for all
```

One instant is resolved for the whole plan, then used to filter **every** category and to
evaluate the weather for **every** outdoor category.

**Why it matters.** For "dinner at 7 then a bar", the bar pool is filtered on *open at 19:00*,
though you arrive around 21:00–21:30 after a 90-minute dinner plus travel:
- A bar that opens at 20:00 is **dropped** as closed, though it's open when you get there — a
  correct venue silently removed (drop reason logged as "closed at target Sat 19:00").
- A bar that closes at 20:00 **survives** and gets scheduled, though it's shut on arrival — a
  plan that cannot be executed.
- Same for weather: a 3-stop plan whose park walk is at 21:00 is gated on the 19:00 forecast.

Nothing downstream re-validates: `buildSchedule` (`schedule.ts:369`) assigns times but never
re-checks hours, and `finishPipeline` (`page.tsx:573`) stores the result as-is. The swap and
reroute engines *do* re-check per-stop via `isUsableAt`, so the machinery for arrival-time
validation exists — the initial plan just doesn't use it.

Note this is not a violation of the "one resolved `startInstant`" policy in `CLAUDE.md` — that
rule is about the *anchor* not diverging between scheduling, hours, and weather, and it holds.
The gap is that per-stop arrival times are only known later, and no second pass exists.

**Fix shape.** Two-phase: keep the current pass as a cheap pre-filter, then after
`buildSchedule` re-check each stop's own venue at its own `start_time` (the `isUsableAt` seam
already does exactly this) and route failures into the existing recovery panel. Cheaper
interim: offset each category's target by the cumulative duration of preceding categories.

**Test coverage: not covered.** `filter.test.ts` has no test with two categories whose
correct verdicts differ at different instants (grep for a second-category/differing-hours case
returns nothing). Existing hours tests use a single category, where the bug is invisible.
The `Ten O'Clock Curfew` fixture exists to exercise the *swap* engine's adapt path, which is a
different code path.

---

### 1.5 — All travel legs are routed with the same departure time — **medium**
`app/api/schedule/travel.ts:307-321`

```ts
export async function getTravelLegs(apiKey, points, departureTime?) {
  return Promise.all(points.slice(0, -1).map((origin, i) =>
    getSingleLeg(apiKey, origin, points[i + 1], i, departureTime)   // ← same for every leg
  ));
}
```

`departureTime` is the outing's *start* (`page.tsx:595` passes `startISO`), so the leg from
stop 2 → stop 3 at 22:30 is priced with a 19:00 departure.

**Why it matters.** Transit routing is schedule-dependent — that's why the parameter exists.
Late legs get frequencies and services that don't run at the real hour; a leg routed at 7 PM
peak may return a 20-minute trip that is 45 minutes at 11 PM, or route via a line that has
stopped running. The schedule is then built on a travel estimate that doesn't apply, so every
subsequent stop time is optimistic. It also interacts with §1.4: both assume "the plan happens
at t₀".

**Fix shape.** Legs can't be priced before durations are known, and durations are known before
travel — so accumulate an estimated departure per leg (start + Σ preceding durations + Σ
preceding legs) and pass leg *i*'s own estimate. `getSingleLeg` already takes a per-leg
`departureTime`; only the caller needs to change.

**Test coverage: not covered.** `travel.test.ts` tests `buildLeg` (pure, from canned
responses) and mode-selection logic. `mockLeg` ignores `_departureTime` entirely
(`fixtures.ts:505`), so no e2e can observe it.

---

### 1.6 — `buildSchedule` advances the clock with server-local field arithmetic — **low**
`app/api/schedule/schedule.ts:385, 397, 409`

```ts
cursor.setMinutes(cursor.getMinutes() + total);
```

`setMinutes`/`getMinutes` operate on the **server's** local wall clock, so this is
local-field arithmetic inside a function whose entire contract is per-plan zone correctness.

**Why it matters.** It's equivalent to millisecond addition *except* across a DST transition
in the server's zone, where the local field normalization shifts the result by an hour. So a
plan crossing 02:00 on a changeover night gets stop times an hour off — and the transition
that matters is the **server's**, not the plan's, so a Vancouver plan could shift on Toronto's
changeover date. Reachable roughly twice a year, in a ~1–2 hour window, for plans that span
it. Low because it's rare and self-consistent within a run; real because it's precisely the
class of hand-rolled date math `zoneTime.ts` exists to eliminate.

**Fix shape.** `new Date(cursor.getTime() + total * 60_000)`, or `DateTime.plus({minutes})` in
the plan's zone. Millisecond addition is correct here because stop durations are elapsed time,
not wall-clock time.

**Test coverage: not covered.** `schedule.test.ts` has zone tests but none crossing a DST
boundary in the *server's* zone.

---

### 1.7 — A recovered slot is filtered at a different instant than the plan it joins — **medium**
`app/page.tsx:626-651` (`searchSlot`) → `app/api/places/search/route.ts:55-58` → `filter.ts:160`

`searchSlot` posts `categoriesOverride: [searchCategory]`, and the places route resolves the
start time from **that single category**:

```ts
const cats = (categoriesOverride ?? parsed.category_signals ?? []).filter(...);
const resolved = resolveStartTime(parsed.time_window ?? "", new Date(), cats, timeZone);
```

`filterPools` then resolves from `Object.keys(pools)` — again just that one category.

**Why it matters.** The original plan for "ramen then a bar" (no stated time) anchors on the
**earliest** category default — dinner's 19:00 (`schedule.ts:315-322`). Recovering the empty
bar slot re-resolves from `["bar"]` alone → 20:00. So the replacement is filtered for
openness at a *different* time than the slot it drops into, and the stop is then scheduled at
the original plan's time anyway. The widen path, the replace path, and the weather-gate
override all route through here, so every recovery is affected. Practical effect: a venue
that's open at 20:00 but not 19:00 can be recovered into a 19:00-anchored plan.

**Fix shape.** Pass the plan's already-resolved start instant into `searchSlot` and on to the
places route as an explicit target — `filterPools` already accepts exactly this as
`targetOverride` (that's how reroute anchors at `floor`), it just isn't exposed over HTTP.

**Test coverage: not covered.** `recovery.spec.ts` scenarios use stated clock times ("3pm",
"7pm") specifically so server and client agree — which makes both resolutions identical and
hides the divergence. The bug needs a *time-less* multi-category prompt.

---

## 2. Invariant violations / bypasses

### 2.1 — `createItinerary` writes straight to the Map, bypassing `saveItinerary` — **low (today)**
`app/api/itinerary/store.ts:153-179`, specifically `:177`

```ts
store.set(itinerary.id, itinerary);
return itinerary;
```

**Confirmed: it still writes directly.** Full caller trace:

| Caller | Safe? |
| --- | --- |
| `app/api/itinerary/route.ts:42` (the only production caller) | **Yes** — immediately followed by `await saveItinerary(itinerary)` at `:44`, inside a try/catch that 500s on failure |
| `itinerary.test.ts` (5 sites), `reroute.test.ts:54`, `swap.test.ts:63/694/810`, `store.kv.test.ts` (4 sites) | Yes — tests use memory mode deliberately |

So it is **harmless today**, and no newer caller has crept in.

**Why it still matters.** Two latent effects: (a) in KV mode the Map write is a shadow copy
that is never read (`loadItinerary` always hits Redis when configured, `:113-116`) and never
expires — unbounded growth in a long-lived process; (b) `createItinerary` does not call
`requirePersistenceOnServerless()`, so it is the one store entry point that succeeds on Vercel
without KV. Any future caller that creates without saving gets a plan that exists in memory and
404s on the next request — precisely the failure `DEPLOY.md` documents as already-fixed.

**Fix shape.** Make `createItinerary` a pure factory (build and return, no `store.set`) and let
the route's existing `saveItinerary` be the only write. That is a one-line deletion plus
memory-mode test updates.

**Test coverage:** `store.kv.test.ts` covers the load/save seam well, but no test asserts that
creation alone does *not* persist — the direct write is what several tests implicitly rely on.

---

### 2.2 — `getItinerary` is an unused export that bypasses KV entirely — **medium (latent)**
`app/api/itinerary/store.ts:181-183`

```ts
export function getItinerary(id: string): Itinerary | undefined {
  return store.get(id);
}
```

`grep` confirms **no callers** anywhere in `app/` or `e2e/` — production or test.

**Why it matters.** It is an exported, plausibly-named, synchronous alternative to
`loadItinerary` that reads the in-memory Map directly. `CLAUDE.md` states routes access the
store ONLY via `loadItinerary`/`saveItinerary`; this function is a ready-made way to violate
that, and it would work perfectly in dev and mock e2e while returning `undefined` for every
request in production. Its signature is also *more* convenient than the correct one (no
`await`), which is what makes it dangerous.

**Fix shape.** Delete it, or rename to `__getItineraryFromMemoryForTests` and confine it.

**Test coverage:** n/a — nothing uses it. Its absence from tests is the point.

---

### 2.3 — `finalize` skips past locked stops instead of stopping at them — **low/medium**
`app/api/itinerary/swap.ts:1073-1079`

```ts
for (let k = tp + 1; k < timedIdx.length; k++) {
  const s = itinerary.stops[timedIdx[k]];
  if (s.locked || !s.start_time || new Date(s.start_time).getTime() <= floor.getTime()) continue;  // ← continue
  s.start_time = toZonedISO(new Date(new Date(s.start_time).getTime() + deltaMs), tz);
```

The equivalent loop in `resettleTail` uses **`break`** for the same condition
(`swap.ts:861`), with the comment "never move locked/past stops — stop reflowing at the first
one".

**Why it matters.** The `locked` ratchet guarantees a locked stop never changes, and `continue`
honours that literally — but it keeps shifting stops *after* it. If a locked stop sits between
the swapped stop and a later one, the later stop moves while the locked one doesn't, so the
gap between them silently changes and the earlier stops shifted before the locked one can be
pushed **into** the locked stop's slot (an overlap the `break` version cannot produce). The
guarantee "locked stops never change" holds; the weaker one — "the plan stays a consistent
chain" — does not.

**Honest caveat on reachability:** stop times are ordered, so a locked (active/completed) stop
downstream of an upcoming one is not a normal state. It requires backwards dev time-travel or
a prior time-swap that moved a stop across another. That's why this is low/medium rather than
high — but the two loops encoding the same invariant differently is a real inconsistency, and
`resettleTail`'s version is the correct one.

**Test coverage: not covered.** `swap.test.ts` covers the locked ratchet and floor guarantees,
but no test places a locked stop *between* the swapped stop and a downstream one.

---

### 2.4 — `GET /api/itinerary/[id]` writes on every read — **low**
`app/api/itinerary/[id]/route.ts:32-35`

```ts
const result = withStatuses(itinerary, t);
await saveItinerary(result);   // every GET
```

The comment justifies it correctly (the lock ratchet mutates, and must survive). But it makes
every read a read-modify-write with no concurrency control.

**Why it matters.** Two overlapping requests with different `?now=` values (the dev time picker
fires a GET on every change — `page.tsx:1491`) can interleave so the later write carries the
earlier `now`'s statuses. Under KV that's also a Redis write per poll, and it refreshes the
7-day TTL on every read, so an actively-viewed plan never expires. Low impact given the demo
scale and the ratchet's monotonicity (the `locked` flag can't be un-set by a lost update).

**Fix shape.** Only write when `withStatuses` actually changed something — it can return a
dirty flag cheaply.

**Test coverage:** `itinerary.test.ts` covers status derivation and the ratchet; concurrency
is untested (and hard to test meaningfully here).

---

## 3. Stale / hardcoded pre-multi-city defaults

### 3.1 — `FALLBACK_PARSED` still hardcodes Ossington, in two files, with no city — **medium**
`app/api/itinerary/reroute.ts:87-96` **and** `app/api/itinerary/swap.ts:434-438`

```ts
const FALLBACK_PARSED: ParsedPrompt = {
  time_window: "unspecified", stop_count: null, aesthetic: "unspecified",
  category_signals: [], group_context: "unspecified", budget: null,
  constraints: [], location: "Ossington",       // ← and no `city`
};
```

**Confirmed: the old Ossington default is still there — and it's duplicated verbatim** across
both engines (see §5.1).

**Why it matters.** Used when `itinerary.parsed` is absent (`reroute.ts:172`,
`swap.ts:476`). `buildQuery` (`searchPlaces.ts:36`) falls back to `parsed.city?.trim() || "Toronto"`,
so a fallback search becomes *"<category> Ossington Toronto"* — for a **Vancouver** plan, a
swap or reroute would search Toronto's west end and return venues 3,000 km away, then compute
travel legs to them. The distance guard in select (`kmFromHome`) would flag it, but nothing
refuses. Reachable for any itinerary stored without `parsed`: pre-multi-city plans, and any
future writer of `POST /api/itinerary` that omits the optional field (`route.ts:20-21` treats
it as optional).

**Fix shape.** The fallback shouldn't invent a location at all — `location: ""` with the city
carried from the itinerary's own `home`/`timeZone`, or refuse the swap/reroute honestly when
`parsed` is missing (the fail-loud posture). Then de-duplicate to one shared constant.

**Test coverage: not covered.** Both engines' tests always construct itineraries *with*
`parsed` (`swap.test.ts:63` passes a parsed object), so the fallback branch is never taken.

---

### 3.2 — Weather route's default coordinates are the old Ossington anchor — **low**
`app/api/weather/route.ts:10`

```ts
const DEFAULT_LOC = { latitude: 43.6479, longitude: -79.4197 }; // Ossington
```

Used when `lat`/`lng` are absent or invalid.

**Why it matters.** Correctly scoped and documented — the pipeline always passes the plan's
real coordinates (`page.tsx:432-434`), so this only serves the ambient chip fetched on mount
(`page.tsx:182`) before any city is known. The residual issue is cosmetic: the chip shows
Toronto weather on first paint, and `page.tsx:1401` labels the chip with
`city.trim() || "Toronto"`, so a user who typed "Vancouver" but hasn't planned yet sees a
Vancouver-labelled Toronto forecast. It self-corrects once a plan runs (`:438`).

**Fix shape.** Skip the ambient fetch until a city is geocoded, or label it "—" until then.

**Test coverage:** n/a (presentation).

---

### 3.3 — `HOME` (Chestnut Residence) — correctly scoped, no action — **informational**
`app/api/schedule/home.ts:16-19`

Verified as *correct*: every consumer reads `itinerary.home ?? HOME`
(`swap.ts:655`, `:780`, `:1030`; `page.tsx:1059`, `:1140`), so the prototype anchor is a
genuine legacy fallback rather than a live assumption. Listed only to record that it was
checked and is not a stale-default finding.

---

### 3.4 — `DEPLOY.md`'s `TZ` rationale is stale (docs, but load-bearing) — **low**
`DEPLOY.md`, "The serverless store problem" section

> the scheduler's date math is server-local (documented Toronto assumption in `schedule.ts`),
> and Vercel functions run in UTC — evening plans would compute 4–5 hours off.

That rationale no longer holds: `schedule.ts` is per-plan zone-aware. But the *conclusion*
(set `TZ`) is still correct for a reason the doc doesn't state — §1.1 and §1.6.

**Why it matters.** Someone who verifies the stated reason will find it false and may remove
the `TZ` setting, activating §1.1's full severity. `CLAUDE.md` has been updated in this pass to
name the real reason; `DEPLOY.md` has not (it was out of scope for the docs refresh).

---

## 4. Weak typing — every remaining `any` in production code

**Confirmed: still exactly four, all pre-existing. No new ones have crept in.**
(`grep -n ": any\b|as any\b|<any>|any\[\]"` over `app/`, excluding `*.test.ts`; the two other
hits are the words "any" inside comments at `fixtures.test.ts:31` and `[id]/route.ts:6`.)

| # | Location | Current | What it should be | Severity |
| --- | --- | --- | --- | --- |
| 4.1 | `app/api/weather/route.ts:62` | `.map((h: any): WeatherHour => ...)` | A local `interface RawForecastHour { interval?: { startTime?: string }; temperature?: { degrees?: number }; precipitation?: { probability?: { percent?: number } }; weatherCondition?: { description?: { text?: string }; type?: string } }`. Same pattern `travel.ts:52` already uses for `ComputeRoutesResponse` — an explicit "the parts we read" shape for an external payload. | low |
| 4.2 | `app/page.tsx:63` | `PlanCtx.parseData: any` | `ParsedPrompt & { city?: string; home?: LatLng }` — both app-injected fields are already declared optional on `ParsedPrompt` (`filter.ts:35, 40`), so plain `ParsedPrompt` is very close to sufficient. | medium |
| 4.3 | `app/page.tsx:233` | `recovery.time-gate.parsed: any` | Same as 4.2 — it holds the same object, forwarded to `continuePipeline`. | low |
| 4.4 | `app/page.tsx:339` | `continuePipeline(parseData: any, ...)` | Same as 4.2. | medium |

**Why 4.2/4.4 matter more than the others.** `parseData` is mutated in place at
`page.tsx:281` (`parseData.city = city.trim()`) and `:393` (`parseData.home = hp.location`),
then threaded through the entire tail of the pipeline — geocode, time check, places, select,
store. It is the single most-travelled object in the client, and it is untyped for all of it.
Typing it would have caught a real class of bug at compile time (e.g. a misspelled
`category_signals`, which currently degrades silently to `?? []`). All four are one coherent
change: define the type once, apply to `PlanCtx`, the union arm, and the parameter.

**Test coverage:** typing gaps are a `tsc` concern, and `tsc --noEmit` passes — because `any`
disables exactly the checks that would fail.

---

## 5. Duplicated logic

### 5.1 — `FALLBACK_PARSED` defined twice, verbatim — **medium**
`app/api/itinerary/reroute.ts:87-96`, `app/api/itinerary/swap.ts:434-438`

Same eight fields, same `location: "Ossington"`. Two copies means the fix for §3.1 must land
in both, and a partial fix leaves one engine wrong. `CLAUDE.md`'s "reuse, don't fork" rule
applies directly. **Fix:** one exported constant (`store.ts` or a shared module).

**Test coverage:** neither copy is exercised (see §3.1).

---

### 5.2 — "Is this venue open at instant X" implemented twice, divergently — **high (as §1.1)**
`app/api/places/search/filter.ts:165-166` (zone-aware, via `wallClockParts`) vs
`app/api/itinerary/swap.ts:415-419` (server-local)

Both build a `TargetTime` and call `isOpenAt`. One is correct, one is not — and the divergence
*is* finding §1.1. Recorded here because the duplication is the root cause: had there been one
`isOpenAtInstant(place, instant, zone)` helper, the zone fix in Phase 5 would have covered both.
A third near-copy lives in `fixtures.ts:461` (§1.3).

**Fix:** one exported helper in `hours.ts` taking `(hours, instant, timeZone)`; all three call
it.

---

### 5.3 — Four different park/outdoor regexes with different membership — **medium**
| File / line | Constant | Notably includes | Notably omits |
| --- | --- | --- | --- |
| `filter.ts:78-79` | `OUTDOOR_PATTERN` | `patio`, `market`, `picnic`, `outdoor` | `bench`, `green space` |
| `searchPlaces.ts:50` | `PARK_PATTERN` | `bench`, `green space`, `greenspace` | `patio`, `market`, `picnic` |
| `durations.ts:33` | park resolver rule | `walk`, `trail`, `garden`, `beach`, `hike`, `stroll` | `bench`, `green space`, `patio`, `market` |
| `schedule.ts:74` | park `PLAUSIBLE_BANDS` entry | `park`, `garden`, `trail`, `stroll`, `hike`, `beach`, `walk` | `bench`, `green space`, `patio`, `market`, `picnic` |

**Why it matters.** A category's treatment is incoherent across the pipeline depending on which
words it contains. Concretely, a category containing **"patio"** is weather-gated as outdoor
(so rain can empty its pool and open the weather-gate panel), but gets no `includedType: "park"`
search filter, a 60-minute *default* duration rather than the park's 40, and the generic 8 AM–1 AM
plausible band rather than the park's 6 AM–10 PM. A category containing **"bench"** is the
inverse: it gets a hard `park` type filter in search, but is *not* weather-gated, so a bench sit
is planned in a thunderstorm. (Feature words like "patio" normally land in `constraints`, not
`category_signals` — that's the batch-2 parse rule — which is what keeps this from being
higher severity, but `categoriesForKindAnswer` free text and swap's `interp.category` can both
put arbitrary strings into the category slot.)

**Fix:** one exported `isOutdoorish(category)` predicate (or a small category-traits table
returning `{ outdoor, typeFilter, durationKey, band }`) consumed by all four sites. This also
subsumes §5.4's smaller version.

**Test coverage: not covered.** Each constant has tests in its own module; nothing asserts
*consistency* across them.

---

### 5.4 — Timed-index and legs-rebuild boilerplate repeated — **low**
Timed-index construction appears 4× — `swap.ts:567-570`, `:725-728`, `:1019-1022`,
`reroute.ts:124-126`:
```ts
const timedIdx: number[] = [];
itinerary.stops.forEach((s, i) => { if (s.start_time) timedIdx.push(i); });
```
Legs rebuild appears 4× — `swap.ts:582`, `:804`, `:1083-1085`, `reroute.ts:287-289`:
```ts
itinerary.legs = itinerary.stops.filter((s) => s.start_time && s.travelToNext).map((s) => s.travelToNext!);
```
Both are mechanical and currently consistent, so this is low. Worth two tiny helpers
(`timedIndexes(itinerary)`, `rebuildLegs(itinerary)`) — the definition of "which stops are
timed" is a real domain concept that four copies could drift on.

---

### 5.5 — Stop construction and duration-preservation duplicated — **low**
`app/api/itinerary/swap.ts:938-971` (`buildStop`) vs `:1042-1058` (`finalize`'s inline object)

`finalize` builds an `ItineraryStop` literal with the same 15 fields `buildStop` produces, and
re-derives the same "keep the customized total unless the category changed" rule
(`:1010-1015`) that `buildStop` handles via `durationOverride`. The buffer-clamping expression
(`Math.min(def.bufferMinutes, total)`) is written out in both.

**Why it matters.** A future field on `ItineraryStop` must be added in both places; forgetting
`finalize` means venue-swaps silently lose it. The `priceLevel`/`description`-on-the-stop rule
in `CLAUDE.md` exists because of an earlier bug of exactly this shape.

**Fix:** have `finalize` call `buildStop` with `{ pick, sel }` and a `durationOverride`.

---

## 6. Error-handling gaps

### 6.1 — One category's Places failure kills the entire search — **medium**
`app/api/places/search/searchPlaces.ts:137-141` (and `:131-134` for the general pool)

```ts
const results = await Promise.all(categories.map((category) => searchText(...)));
```

`searchText` throws on any non-OK response (`:77-81`). `Promise.all` rejects on the first
failure, so the route's catch returns a 500 (`route.ts:84-92`), and `page.tsx:451` throws →
the raw `"Places search failed."` string lands in `setError`.

**Why it matters.** A transient failure, rate-limit, or quota exhaustion on **one** category
("ramen") discards the perfectly good results already returned for the others ("bar"), and the
user gets a technical error instead of a plan. This is precisely the partial-failure shape the
recovery panel was built for — an empty pool for one category already has an honest,
interactive path (`partialEmptyCategories` → the panel). The pipeline just never gets the
chance, because the failure happens one layer too early.

**Fix shape.** `Promise.allSettled`; rejected categories become empty pools with a drop entry
explaining the failure, which routes them into the existing recovery flow. Only fail the whole
request when *every* category failed.

**Test coverage: not covered.** `searchPlaces.test.ts` tests query construction and pool
keying; there's no test for a partially-failing search.

---

### 6.2 — A Routes outage silently becomes a 0-minute leg — **medium**
`app/api/schedule/travel.ts:248-275` → `:220-228`

`computeRoute` catches everything and returns `null` (correctly logging). But when **both**
modes fail, `buildLeg` returns:
```ts
{ fromIndex, mode: "unknown", rawMinutes: 0, marginMinutes: 0, totalMinutes: 0, ... }
```
and `buildSchedule` adds `leg?.totalMinutes ?? 0` between stops.

**Why it matters.** "We don't know the travel time" is rendered as "the travel time is zero" —
stops get scheduled back-to-back, so the user is told to be at stop 2 the instant stop 1 ends,
across any distance. That's a *wrong time*, not a missing one, and it violates the spirit of
keep-on-missing (which is about not *dropping* things, not about asserting zero). It's also
mislabelled in the UI: `ItineraryStrip.tsx:71-98` branches only on `mode === "transit"`, so an
`unknown` leg renders through the walk branch as **"walk · 0 min"** — a confident, wrong claim.

**Fix shape.** Either surface `unknown` honestly in the strip ("travel time unavailable") and
pad with a conservative estimate from `haversineMeters`, or fail the plan loudly if no leg can
be priced. The distance helper needed for an estimate already exists (`travel.ts:39`).

**Test coverage: partially covered.** `travel.test.ts` asserts `buildLeg` returns the
`unknown` shape when both routes fail — so the *shape* is pinned, but nothing asserts how the
schedule or the UI treats it.

---

### 6.3 — A schema-valid-but-wrong LLM parse surfaces a developer error string — **medium**
`app/api/parse/route.ts:88-90` → `app/api/places/search/route.ts:43-48` → `app/page.tsx:451`

The parse route validates that Groq returned **JSON**, but never that the JSON matches the
schema. The first thing that notices is the places route:
```ts
if (!parsed || typeof parsed !== "object" || typeof parsed.location !== "string") {
  return NextResponse.json({ error: "`parsed` (the /api/parse output object) is required in the body." }, { status: 400 });
```
which `page.tsx` re-throws into `setError` verbatim.

**Why it matters.** If the model omits `location` (or returns `null` for it), the user sees
**"`parsed` (the /api/parse output object) is required in the body."** — a backend
contract message with backticks, in the UI, for an input that was perfectly reasonable. That
is exactly what `planGuards.ts` exists to prevent ("an empty map or a borrowed error from
another branch is the bug"). Every other field degrades gracefully via `?? []` / `?? ""`, so
`location` is the one that hard-fails. The same shape applies to `SelectParseError`
(`selectVenues.ts:44-52`), whose message reaches the user as
"Failed to parse Groq selection response as JSON."

**Fix shape.** Normalize the parse output in the route before returning it — coerce missing
fields to their documented empty values (`location: ""`, `category_signals: []`, etc.), so a
shape miss becomes a vague-but-plannable prompt instead of an error. Then any *remaining*
failure gets a `planGuards` message rather than a route contract string.

**Test coverage: not covered.** `planGuards.test.ts` and `failloud.spec.ts` pin the messages
for bad *user input*; there is no test for a malformed *model* response reaching the UI.
`mockParse` always returns a well-formed object, so mock e2e cannot produce this.

---

### 6.4 — A failed itinerary refresh leaves the UI silently stale — **low**
`app/page.tsx:895-904`

```ts
const res = await fetch(url);
const data: Itinerary = await res.json();
if (!res.ok) return;      // ← silent
```

`refreshItinerary` is called after storing (`:892`) and on every dev time-picker change
(`:1491`). On a non-OK response it returns with no state change and no message, so the strip
and map keep showing the previous state — including, after a reroute or swap, times that no
longer match the store. Related: `storeItinerary` (`:888-891`) sets an error if the POST fails,
but `finishPipeline` has already rendered the plan by then, so the user sees a plan on the map
plus an error, with swaps/reroute silently non-functional (no `itinerary.id`).

**Fix shape.** Surface the failure (`setError`) and, for the store case, either render only
after a successful store or mark the plan explicitly as not-live.

**Test coverage: not covered** — no test forces a failing GET mid-session.

---

## 7. Other real bugs

### 7.1 — Duplicate category signals silently collapse (and reroute reuses one venue twice) — **medium**
`app/api/places/search/searchPlaces.ts:142-146`; `app/api/select/selectVenues.ts:235`;
`app/api/itinerary/reroute.ts:172-201`

```ts
const pools: Record<string, Place[]> = {};
categories.forEach((category, i) => { pools[category] = results[i]; });   // ← duplicate keys overwrite
```

Pools are keyed by category **string**. Two identical categories collapse to one key.

**Why it matters — main pipeline.** `category_signals: ["bar", "bar"]` (a real LLM output for
"a drink, then another drink somewhere else", and reachable via
`categoriesForKindAnswer` free text) yields one pool → `selectVenues` iterates
`Object.entries(pools)` and returns **one** selection → `buildSchedule` produces **one** stop.
The user asked for two places and gets one, with **no message anywhere** — not a fail-loud
guard, not the recovery panel. `partialEmptyCategories` can't see it, because nothing came back
empty; the second stop simply never existed. This is the exact silently-dropped-venue class the
recovery work was meant to eliminate.

**Why it matters — reroute.** Worse: `reroute.ts:193-201` builds
`byCategory` from the selections, then maps the affected categories back through it —
```ts
const ordered: Selection[] = categories.map((c) => byCategory.get(c) ?? { ... });
```
Two affected stops sharing a category both resolve to the **same `Selection` object**, so the
reroute plans the *same venue twice* in one evening, at two different times. The `keptIds`
exclusion (`:181-189`) doesn't help — it only excludes venues on *kept* stops.

**Fix shape.** Key pools positionally rather than by category string (e.g. `"bar#0"`, `"bar#1"`,
carrying a display category alongside), or de-duplicate categories early and tell the user the
plan was narrowed. The positional fix is the honest one — the request genuinely was two stops.

**Test coverage: not covered anywhere.** A grep across `app/` and `e2e/` for any test using a
repeated category returns nothing; every fixture and test uses distinct categories.

---

### 7.2 — Stop identity is the category string throughout the UI — **low**
`app/page.tsx:981` (`doSwap`), `:1048`, `:1055`, `:1096-1130`; `ItineraryStrip.tsx:253`

```ts
const stopIndex = itinerary.stops.findIndex((s) => s.category === selected);
```

`selected` is a category, and stop→map→strip correlation is all by category
(`styledStops`, `selectedStop`, `onSelect`). With duplicate categories (§7.1) selection always
resolves to the **first** matching stop, so clicking the second "bar" card selects and swaps
the first. Same root cause as §7.1 and fixed by the same positional-key change; recorded
separately because it's a distinct user-visible symptom (clicking one card acts on another).

**Test coverage:** not covered — same reason as §7.1.

---

### 7.3 — Meridiem-less swap times always assume PM, including for morning categories — **low/medium**
`app/api/itinerary/swap.ts:153-164`

```ts
else if (!ap && h >= 1 && h <= 11) h += 12;   // "at 7" → 19:00
```

Documented as an outing-planner heuristic, and right for most stops.

**Why it matters.** It's applied without reference to the stop's **category**, so on a brunch
or breakfast stop, "make it 10" becomes 22:00 → `isPlausibleAt` rejects against the brunch band
(8–15) → the user gets *"A 10:00 PM brunch won't work — nothing's really open then."* for a
request that plainly meant 10 AM. The refusal is honest about what the engine decided, but the
decision was wrong, and the message gives no hint that the hour was reinterpreted.

**Fix shape.** Bias the meridiem by the stop's category band: if the category's plausible band
(already available via `bandForCategories`) contains the AM reading but not the PM one, keep
AM. Cheap, and uses a table that already exists.

**Test coverage: partially covered.** `swap.test.ts` pins the PM assumption for evening
categories (correct behaviour); no test applies a bare hour to a morning-banded category.

---

### 7.4 — `withStatuses` can never yield `"planning"` — **low**
`app/api/itinerary/store.ts:211-215`

```ts
itinerary.status = itinerary.stops.every((s) => s.status === "completed" || s.status === "skipped")
  ? "completed" : "active";
```

`createItinerary` sets `status: "planning"` (`:164`), but the first GET overwrites it — so a
plan for tomorrow evening reports `"active"` all day today. The `"planning"` state of the
`ItineraryStatus` union is effectively unreachable after creation.

**Why it matters.** Latent only: no UI reads `itinerary.status` today (the strip and map use
per-*stop* status). It becomes real the moment anything keys off it — a "plan hasn't started
yet" affordance would be wrong for every future plan.

**Fix shape.** Return `"planning"` when no stop is active or completed and `t` precedes the
first start.

**Test coverage:** `itinerary.test.ts` asserts stop statuses and the completed rollup; no test
pins the pre-start itinerary status.

---

### 7.5 — `parseTargetTime` silently ignores a clock time that isn't first — **low**
`app/api/places/search/hours.ts:46-55`

```ts
const m = tw.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);   // first number wins
if (!meridiem && !m[2]) return null;                        // bare number → give up entirely
```

The regex takes the **first** number in the string, and if that number turns out to be a bare
duration the function returns `null` outright rather than looking further.

**Why it matters.** A `time_window` of `"2 hours, 7pm"` resolves to *no clock time* — the 7pm
is never seen — so the plan falls through to the category default (dinner → 19:00) or the next
full hour. It happens to be harmless for `"7pm, 2 hours"`, which is the order the parse prompt
specifies (`parse/route.ts:15`), and that instruction is what keeps this low. But the ordering
is an LLM instruction, not a guarantee, and the failure is silent — the user's stated time is
dropped with no signal.

**Fix shape.** Match all candidates and take the first with a meridiem or a colon, rather than
bailing on the first token.

**Test coverage: partially covered.** `schedule.test.ts:499` covers the documented
`"tomorrow, 6am"` order; no test uses the reversed order.

---

### 7.6 — Swap and reroute never consult the weather — **low (known gap, scope-corrected)**
`app/api/itinerary/reroute.ts:176-178` (explicit TODO), `app/api/itinerary/swap.ts:628`,
`:924`

All three `filterPools` calls pass `weather: null`, which skips the weather gate by
keep-on-missing.

**Why it's here.** `CLAUDE.md`'s Open gaps listed this as *reroute*-only; it is in fact **both
engines**. So a swap can move an outdoor stop into the rain, and a "closer park" swap can
replace a weather-cleared pick with a blocked one, with no note. The user-visible effect is
mild (an outdoor stop during rain, no wrong times), and it's deferred scope rather than a
defect — recorded so the gap list is accurate. `CLAUDE.md` has been corrected in this pass.

**Test coverage:** n/a — deliberate.

---

## Appendix — things checked and found correct

Recorded so a future pass doesn't re-derive them:

- **`filterPools` cross-category dedup** (`filter.ts:248-251`) is order-dependent by design;
  when it empties a later category the drop reason is honest ("the only match is already
  elsewhere in your plan") and routes into the recovery panel correctly.
- **`selectVenues`' `highestRated` fallback** (`:273`) cannot receive an empty array — empty
  pools are split out at `:168-172` before the LLM call, so `fb.id` can't throw.
- **ID validation on select** holds: `findProblems` (`:114-141`) validates every id against
  the pool, `id: null` is accepted only with an `unmet_constraint`, and the hedge guard
  (`:251-262`) converts "may accommodate" picks into honest failures.
- **Reroute floor/anchor logic** (`reroute.ts:133-145`, `:219-223`) matches the documented
  invariant: affected set is strictly downstream *and* strictly after floor *and* unlocked, and
  the chain departs at `max(floor, previous kept stop's committed end)` rather than `now`.
- **`zoneTime.ts`** is sound — `wallClockParts` correctly converts luxon's 1=Mon..7=Sun to
  0=Sun via `% 7`, `normalizeZone` guards persisted data, and `zoneFromLatLng` cannot throw.
- **The weather-gate override mechanism** (`weather: null` → gate skipped, all other filters
  intact) works exactly as documented, with no server-side changes required.
- **Map/strip presentation** carries no scheduling logic; both take `timeZone` and delegate all
  formatting to `timeLabels.ts`.

---

## Suggested batching (for whatever comes next)

Not a recommendation to act now — just the dependency order if these become batches.

1. **§1.1 + §5.2 + §1.3 together.** One zone-aware `isOpenAt` helper fixes the high-severity
   bug, the duplication, and the fixture divergence in a single coherent change. Needs a new
   test that exercises the *production* default rather than an injected stub.
2. **§7.1 + §7.2 together.** Both are the category-as-key design; splitting them means touching
   the same code twice.
3. **§1.4 + §1.5 together.** Both are "the plan doesn't happen at t₀"; a per-stop arrival-time
   pass gives both the data they need.
4. **§3.1 + §5.1 together.** One shared constant, fixed once.
5. **§4.2/§4.4** (typing `parseData`) is a good low-risk warm-up and would make several of the
   above safer to change.
