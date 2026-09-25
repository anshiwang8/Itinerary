# Investigation: is the stated-window fit issue still live? (window-fit status)

Branch `investigate-window-fit-status`, written 2026-09-25, against `main` at
`8e025e3`. **Read-only. No fix was built and none is proposed for merge**: this
was owner-deferred pending policy, and the report confirms the open questions
rather than answering them.

Scope note: the separate bug where a bare START-only time ("dinner at 7pm") had
already passed was fixed on 2026-09-23 (`pastStartSameDay`). This report is about
the case where BOTH a start and an end are stated and what is planned does not
fit.

## Verdict

**Yes, still live, on current code. It is reproducible on demand, and it is
independent of the bare-start fix.** The arithmetic is correct and honest: code
detects the overrun from real travel legs and tells the user. What remains open
is *policy*, and this investigation found **three sharper edges inside that
policy** than the ones recorded so far, two of which were not written down
anywhere:

| # | Finding | Status | New? |
|---|---|---|---|
| F1 | A squeezed plan drops whole TRAILING stops, so the evening anchor (dinner, live music) is what goes | Live, reproduced in real-model runs | Known deferral, now with real evidence |
| F2 | The LAST stop's scheduling buffer counts against the stated end, so there is a **one-minute cliff between "trim" and "refuse outright"** | Live, reproduced to the minute | **New** |
| F3 | The window is NOT re-checked after the arrival-adapt re-route | Live, reproduced with an injected leg | **New** |
| F4 | Reroute never consults the stated end | By inspection; dev-only trigger | **New** (low reach) |
| F5 | The planner sizes a plan for the stated window; the "window already underway" clamp shrinks it afterwards | Live evidence, model-side half unverifiable offline | Documented interplay, now measured |

## How it works today (verified by reading the code, not from memory)

- `checkWindowFit(stops, endISO)` (`app/api/schedule/schedule.ts:543`) is pure.
  It takes stops AS SCHEDULED (real travel legs already folded in) and the stated
  end, returns `null` for no usable end (an unstated end is never a constraint).
  Otherwise it counts how many LEADING stops finish by `end + 30 min`
  (`WINDOW_OVERRUN_TOLERANCE_MINUTES`).
- It runs in `finishPipeline` (`app/page.tsx:1617`, `validateWindow`) once, after
  the first `planOnce`, before the arrival re-check. Three outcomes: fits
  (`[window-fit] underfilled` logged at 90+ unused minutes, never filled);
  `keep === 0` fails loud (`windowTooTightReason`); otherwise trailing stops are
  dropped, the plan re-routed once, and `windowOverrunMessage` names them.
- The stated end is persisted as `plannedEndISO`. Downstream: **swap** ASKS
  (`endsAfterStatedEnd`, `swap.ts:1141`), **mode switch** adds a NOTE
  (`endTimeNote`, `modeSwitch.ts:181`), **remove** cannot overrun (it only pulls
  stops earlier). All three share the same 30-minute constant and the same
  definition of a stop's end (see F2).
- The planner is told to "fill" a stated window "allowing for travel between
  stops" but is never given a number (`planner.ts:259`), and is told it never
  computes travel. It proposes `estimatedMinutes`; code adds the table buffer and
  the real legs.

## Fresh reproduction on current code

Mock server on :3200 (`E2E_MOCK=1`), client clock frozen exactly as
`e2e/scenarios.spec.ts` does (`addInitScript` replacing `Date`), non-local
requests blocked. Mock fixtures only; nothing real was called. All times are the
plan's own (Toronto), date 2026-07-16.

| Prompt | Asked at | Planner proposed | Result |
|---|---|---|---|
| dinner+drinks+dessert 7-9pm | 19:05 (underway) | 90 + 60 + 30 min | dinner 19:21-21:06 only. "fits 1 of these 3... dropped drinks and dessert". Overrun 122 min. |
| dinner+drinks+dessert 7-9pm | 17:05 (not started) | same | dinner 19:16-21:01 only. Same banner. Overrun 117. |
| dinner+drinks 5-9pm | 17:05 | 90 + 60 | Both fit: dinner 17:21-19:06, drinks 19:09-20:19. No banner. |
| dinner+drinks 5-9pm | **19:29** | 90 + 60 | dinner 19:45-**21:30** only. "fits 1 of these 2... dropped drinks". Overrun 103. |
| dinner+drinks 5-9pm | **19:30** | 90 + 60 | **Refused**: "Couldn't fit anything into your 5-9pm window once travel time is counted...". Overrun 104. No plan. |
| dinner+drinks 5-9pm | 20:30 | 90 + 60 | Refused, overrun 164. |
| dinner+drinks 8-11pm | 17:05 | 90 + 60 | Drinks venue closes 22:00, adapt fires: "Swapped in The Standing Room". Plan fits, ends 23:14. |
| same, **second travel call lengthened +40 min** | 17:05 | 90 + 60 | drinks 22:44-**23:54** against a stated **23:00** end. Only the "Swapped in" banner. No trim. |

The 19:29 vs 19:30 rows are the whole of F2 (below). The last row is F3.

Real-model evidence already on disk (agent-persona run 2026-09-14, deployed app,
all three window personas reported zero deviations, meaning behaviour matched the
documented expectation):

- `impossible-window` ("8 stops between 9 and 9:30pm", asked at 10:45 local):
  "Couldn't fit anything into your 9 to 9:30pm window once travel time is
  counted, want to widen it, or ask for something shorter?"
- `long-window` ("plan my whole day from 9am to 9pm", asked at 10:45, so the
  window was underway): "Your 9am to 9pm window fits **4 of these 6** once
  travel is counted, dropped **dinner restaurant and live music venues**." The
  plan ends 7:43 PM, leaving 77 minutes unused, with no dinner.
- Same persona at 01:46 local (window not yet started, leave by 9:00 AM): "fits
  **5 of these 6**, dropped **live music**", plan ends 7:45 PM.

## Findings

### F1. A squeezed plan drops whole trailing stops, which are the evening stops

Both real-model runs above dropped the *last* activities, which in a whole-day
plan are dinner and the night's entertainment: the two stops that are most tied to
a time of day and least replaceable by a midday filler. The plan also ended
77 minutes (and 75 minutes) before the window closed, i.e. it dropped a stop that
would have missed by a small margin rather than shortening anything. This is the
"what should a squeezed plan do" question the owner deferred; it is now shown to
matter for the exact request type ("plan my whole day") the persona set was built
around.

### F2. The last stop's buffer counts against the stated end: a one-minute cliff

`buildSchedule` sets `end_time = start + base + buffer` for every stop, **the last
one included** (`schedule.ts:630-641`). The buffer is documented as "transition,
ordering, settling margin", i.e. margin *to the next stop*, and the last stop has
no next stop. `checkWindowFit` compares that buffer-inclusive end against
`stated end + 30`.

Effect, reproduced above: asked at 19:29 the dinner ends 21:30, exactly on the
limit, so the plan is *trimmed* to one stop and ships. Asked at **19:30** the
dinner ends 21:31, one minute past the limit, so `keep === 0` and the request is
**refused outright** ("Couldn't fit anything...") even though the dinner's actual
90-minute occupancy would end at 21:16, well inside the tolerance. Ninety minutes
of a window is enough for a 90-minute dinner, and the user is told it is not.

Swap and mode switch use the same buffer-inclusive end (`proposedDayEndMs`,
`endTimeNote`), so the three surfaces are consistent; the question is whether the
definition is right, not whether they agree.

Buffers today: coffee 10, restaurant 15, bar 10, dessert 10, museum 15, park 5,
movie 30, default 10 (`durations.ts`). A movie as the last stop spends 30 minutes
of the 30-minute tolerance on nothing.

### F3. No re-check after the arrival-adapt step

`validateWindow` runs once (`page.tsx:1709`). The arrival re-check that follows
can replace a venue that would be closed on arrival and re-route
(`page.tsx:1759`). The re-routed schedule is never passed back through
`checkWindowFit`. A replacement that is farther away (or a longer leg for any
reason) can therefore push the day past the stated end with no trim, no banner and
no refusal: reproduced above, 54 minutes past the stated end, well beyond the
30-minute tolerance, shipping only the "Swapped in..." notice.

Not reproducible with the shipped fixtures alone, because the mock replacement
sits at the same distance as the original. I reproduced it by lengthening the
second travel response in the browser, which exercises the real client code path;
whether real Places pools produce this often is unknown. The code comment says the
ordering is deliberate ("no point adapting a venue we're about to drop, and it
keeps the common case at one routing pass"); the missing half is the re-check
after an adapt happens.

### F4. Reroute never consults the stated end

`reroute.ts` does not reference `plannedEndISO` (grep of `app/`: only creation,
swap and mode switch do). A reroute replans the tail with new venues and new
legs and can push the day past the stated end silently. Reach is low: the reroute
trigger is behind `SHOW_DEV_CONTROLS` and unreachable from the production UI, and
there is no live transit-disruption feed, so this is latent rather than active.
Noted so it is not rediscovered.

### F5. The planner sizes for the stated window; the clamp shrinks it afterwards

`windowUnderway` moves a stated start that has already passed up to `now`, keeping
the stated end. Code does this after the planner has proposed its activities, and
the planner is not told the clamp will happen. The two real-model `long-window`
runs bracket the effect: window not started, 1 of 6 dropped; window underway by
1h45m, 2 of 6 dropped. The mock rows show the same shape (asked at 19:29 vs 17:05
for the same prompt). So the clamp is an amplifier, not the base cause: even with
the whole window available the model over-proposes for a long window (6 stops
became 5), because it is not told buffers or real leg lengths and estimates
durations optimistically.

What I could NOT establish offline: how the real model sizes a plan for a given
window (that is model behaviour, not code). The mock planner ignores time
entirely, so it cannot show it.

## Relationship to the bare-start bug (fixed 2026-09-23)

**Independent, and mutually exclusive by construction.** `pastStartSameDay`
requires `end === null`; `checkWindowFit` returns `null` when there is no
`endISO`. A plan can have one or the other, never both. The bare-start floor
repairs a wrong start; window-fit polices a stated end. They sit in the same
neighbourhood (`windowUnderway` is the sibling of `pastStartSameDay`, and F5 is
about `windowUnderway`), but nothing in the bare-start fix touches, depends on, or
changes any behaviour reported here. Confirmed by reading both paths and by the
absence of any `pastStartSameDay` reference in `schedule.ts`/`page.tsx`'s window
code.

## Open questions, confirmed and NOT decided

These are the owner's. Nothing below is answered here; each lists the fork so the
decision can be made without re-deriving it.

1. **What should a travel-time reserve be, and who applies it?** Today the planner
   is told to allow "for travel" with no number, and code discovers the real
   arithmetic afterwards. Options: (a) tell the planner a per-leg reserve (a fixed
   number of minutes) so it proposes plans that fit; (b) have code pre-size the
   proposal (drop or shorten before routing); (c) leave sizing to the planner and
   keep policing after the fact (today). The real legs are only known after
   search, select and routing, so any pre-routing reserve is an estimate. The
   number is a policy value, like `DRIVING_MARGIN_MIN`, not a measurement.
2. **What should a squeezed plan do?** Today: drop trailing whole stops (F1).
   Alternatives: shorten durations toward the 15-minute floor first, drop the
   least valuable stop rather than the last one, ask the user (as swap does),
   re-search a closer venue, or widen the tolerance. Each changes what "fits
   N of M" means.
3. **Should the last stop's buffer count against a stated end?** (F2, new.) The
   consistent alternative is to compare the last stop's `start + base` (occupancy)
   rather than `start + base + buffer`, in all three surfaces at once. This alone
   would remove the one-minute cliff; it does not answer question 2.
4. **Should the window be re-checked after an adapt, and what then?** (F3, new.)
   A re-check costs a routing pass only when an adapt actually happened. What it
   should DO on a breach is a policy choice: trim again, keep the closed venue,
   or say so in the banner.
5. **Should reroute respect the stated end, and how?** (F4.) Ask is impossible for
   a disruption-driven replan; a note (as mode switch does) is the natural analogue.
6. **Should the planner be told about the underway clamp?** (F5.) Either pass the
   effective window to the planner or accept that code trims what it over-sized.

## Method and limits

- Probes were run with a small Playwright script against the mock server, with the
  clock frozen as the e2e suite does; F3 additionally intercepted the second
  `/api/schedule/travel` response in the browser. No application code was changed
  and no probe file is committed (they live in the session scratchpad; the
  reproduction is the table above).
- No real API was called and no persona run was made. Real-model behaviour is
  inferred only from the existing persona reports on disk
  (`testing/agent-personas/output/`, gitignored).
- Every number in the table is from a run made in this session on current `main`;
  the persona figures are from 2026-09-14 and predate two later changes
  (2026-09-22 geocode reorder, 2026-09-23 `pastStartSameDay`), neither of which
  touches window-fit.
