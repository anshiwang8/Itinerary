# Investigation: `second-city-timezone` and `transit-rider` persona findings

Branch `investigate-timezone-and-transit-findings`, written 2026-09-25.
Read-only investigation of two findings that recurred across full persona runs,
plus one small harness fix where the root cause was proven.

## Verdicts

| Finding | Verdict | Where the bug is | Action taken |
|---|---|---|---|
| (a) `second-city-timezone` "timed out waiting for a plan or an error" | **Harness sequencing bug. Not an app bug, not a timezone bug, not a too-short budget.** Root cause reproduced. | `testing/agent-personas/lib/app.ts` `planFromLanding` | **Fixed** (harness only), verified against a reproduction |
| (b) `transit-rider` 1 timed stop where 2 were expected | **Not a planning shortfall in the app.** The stop count tracks the wall-clock hour of the run (a "right now" prompt), and the report row gave no way to see that. One counter-example worth the owner's attention (see below). | Persona design (time-of-day-dependent expectation) + a diagnostic gap in the report | **Diagnostic added** (harness only). No expectation change: that is an owner decision. |

Nothing in `app/` was changed.

---

## (a) `second-city-timezone`

### Symptom

Every full run since the persona existed (2026-09-10 ... 2026-09-14, four runs)
records `plan_created` for the Vancouver plan as "no plan: timed out waiting
for a plan or an error". From 2026-09-13 the general refusal net also flags it
as `refusal_is_a_known_app_message`, because that string is the harness's own
timeout text and is in no app vocabulary. It is 4 for 4, so it is deterministic,
not flaky.

### What the screenshot at the moment of timeout shows

`second-city-timezone/01-plan-created.png` (identical in all runs) is not an
error, a spinner or a blank page. It is the landing page with the app's own
**clarifying round open**: "What kind of dinner?" / "What kind of drink?" with
`Go` and `Skip, just plan it`, idle, waiting for an answer.

The decisive clue is in the form fields. The persona typed the address
`800 Robson Street, Vancouver, BC`. The screenshot's starting-location field
reads **`800 Robson St, Van...`**. Nothing the harness does rewrites that field.
The only code in the app that does is `chooseGeocodeCandidate`
(`app/page.tsx:2064`), which calls `setStartAddress(candidate.formattedAddress)`
with Google's abbreviated formatted address. So the address geocode was
**ambiguous**, the harness's recovery step chose the first candidate, and only
then did the clarifying round appear.

### Why the harness never answered it

`chooseGeocodeCandidate` resumes with `resolvePlace(...)` then
`planFrom(gate.prompt, place)`, a **fresh first planner pass**, and a first
pass on a thin prompt raises a clarifying round. So the app's real order for an
ambiguous start is: geocode choice, then clarifying round.

`planFromLanding` handled them in the opposite order, once each:

```
const clarified = await skipClarifyIfShown(page, timeoutMs);   // once, first
const recovered = await resolveRecoveryIfShown(page, timeoutMs); // once, second
```

Run 1: the geocode-choice panel is showing (its class list includes `clarify`,
so the first helper's wait matches it) but it has no "Skip, just plan it"
button, so it returns `false`. Run 2: picks the candidate. The app then opens
the clarifying round. Nobody is left to skip it, the outcome wait sees neither
an itinerary nor an error, and after the timeout the screenshot shows the app
politely waiting.

The app's own e2e already encodes the real order:
`e2e/geocode.spec.ts` calls `dismissClarifyIfShown(page)` **after** choosing a
geocode candidate.

### Independent corroboration in a different run

The BREAK run of 2026-09-22 has a Vancouver persona,
`r1-multicity-plan-stranger-denied`, with the same prompt. Because it does not
set `refusalIsAcceptable`, its report row prints the full `plan_created` text,
which is the signature of this bug verbatim:

> no plan: timed out waiting for a plan or an error; recovery panel (MORE THAN
> ONE STARTING ADDRESS MATCHED. CHOOSE THE ADDRESS YOU MEANT.): chose the first
> offered address candidate

Its screenshot is pixel-identical to `second-city-timezone`'s.

### Reproduction (no real APIs, no money)

Mock-mode dev server on :3200 (`E2E_MOCK=1`). A throwaway script called the
harness's real `planFromLanding` with the persona's inputs, with
`/api/geocode` stubbed to return an ambiguous address, using the same reply
shape as `e2e/geocode.spec.ts`:

| Code | Address geocode | Result |
|---|---|---|
| before fix | not ambiguous | plan in 6s, clarify skipped (harness logic is fine on its own) |
| before fix | **ambiguous** | `ok:false`, "timed out waiting for a plan or an error", `clarified:false`, recovery step recorded, **clarify panel still open**, start field rewritten to the formatted address. Same signature as all five live reports. |
| after fix | ambiguous | `ok:true`, `clarified:true`, recovery recorded, 3.3s |
| after fix | not ambiguous | unchanged, plan in 1.6s |
| after fix | **city AND address ambiguous** | `ok:true`, both choices made, clarify skipped, 4.8s |

### Is there any cross-timezone problem in the app itself? No, verified

Because the plan never got built in the live runs, the persona's headline
expectation ("7pm should be 7pm in Vancouver") was never actually checked live.
Without spending money, I checked the plumbing that the persona is meant to
prove:

- `tz-lookup` on real Vancouver coordinates returns `America/Vancouver`
  (Toronto and Calgary give `America/Toronto` and `America/Edmonton`).
- Mock pipeline with the geocode stubbed to a resolved Vancouver city and
  address in `America/Vancouver` (coordinates left at the Toronto fixture so
  mock Places/Routes answer), driven at 02:05 Toronto (23:05 Vancouver):
  - planner resolved "7pm" to `2026-09-25T19:00:00-07:00` (Vancouver's own
    offset, and correctly rolled to the next day since 7pm had passed there);
  - the stored itinerary has `timeZone: "America/Vancouver"` and stops at
    `19:16-07:00` to `21:01-07:00` and `21:04-07:00` to `22:14-07:00`.

What this does **not** prove: real Google Places hours and real Routes
timetables for Vancouver. That remains live-only, exactly as the persona's own
comment says. The persona will finally be able to exercise it now that the
harness answers the clarifying round.

### Fix (harness only)

`answerBuildQuestions` replaces the two single-shot calls with a bounded loop
(`MAX_ANSWER_ROUNDS = 6`). Each round waits for the first of: the clarifying
round's Skip button, a recovery panel, or a settled outcome, answers the first
two, and stops on the third. A panel that will not go away still ends in the
caller's own timeout, never a loop.

Two small related edits: the recovery label said "address candidate" even for a
city choice (now "location candidate (city or address)", nothing matched on the
old string), and `skipClarifyIfShown` (no other callers) was folded into the new
function.

### Not done, flagged

- The live ambiguity of `800 Robson Street, Vancouver, BC` is inferred from the
  rewritten field and the BREAK report's recorded panel text, not re-observed.
  Confirming it needs one paid geocode call, which this session may not make.
  If the owner would rather the persona use an unambiguous address, that is a
  one-line persona edit and a separate choice; the harness now copes either way.

---

## (b) `transit-rider`

Persona: prompt `"dinner in the Distillery District right now then live music
on Ossington"`, `expect: { minStops: 2 }`.

### What was recorded

Run directories are UTC; Toronto in September is UTC-4. Local time is the
column that matters, because "right now" resolves to the wall clock of the run
(the immediacy floor), and the two activities are venue kinds with real
opening hours.

| Run (UTC) | Local (Toronto) | Resolved leave | Timed stops | Which activity survived |
|---|---|---|---|---|
| 2026-09-10T06:13 | 02:13 | 3:00 AM | 2 (see below) | "The Distillery District" 3:44 AM, "Ground Control" 6:17 AM |
| 2026-09-10T15:30 | 11:30 | | **1** | dinner (El Catrin Destileria) |
| 2026-09-13T21:05 | **17:05** | 6:00 PM | **2, healthy** | El Catrin 6:51-8:36 PM, The Garrison 9:31 PM |
| 2026-09-14T05:46 | 01:46 | 2:00 AM | **1** | live music (The Garrison 2:08-4:18 AM) |
| 2026-09-14T14:45 | 10:45 | 11:00 AM | **1** | dinner (Mill Street Brewpub 11:51 AM) |

The single-stop runs are **not** the same activity going missing every time. In
two of the three it is the live-music stop that is missing (asked at late
morning, the live-music stop would land in the early afternoon); in the third
it is the dinner stop (asked at 01:46, dinner in the Distillery District would
land at 2 AM). The one run at a real evening hour produced a healthy two-stop
plan. A drifting cause that follows the clock is the signature of "nothing open
in that category at that hour", not of a planner that drops the second
activity.

### Why this reads as legitimate, and where it does not

The app's designed answer to "an activity's pool came back empty because
everything is closed" is the interactive recovery panel (`mode: "empty"`,
`partialEmptyCategories`): it names the reason and offers widen / replace /
"Plan without it". The harness answers it non-destructively first
(widen -> override -> skip, per the 2026-09-13 order fix), and widening a
closed category city-wide is still closed at that hour, so a run ends on "Plan
without it", a 1-stop plan. Consistent with all three short runs.

I could **not** confirm the individual drops from data, because the report
rows that would show it (`plan_created`) pass and are omitted from the
deviations-only report, and confirming real Places hours would need a paid
call. So this verdict is an inference from timestamps, screenshots and the
app's designed behaviour, not a data dump. It is a strong one: 3 of 3 short
runs are outside a plausible dinner/live-music window and 1 of 1 in-window run
passed.

**The 02:13 pass is the honest counter-example, and it cuts the other way.**
That run "passed" `minStops: 2`, but its first stop is the neighbourhood
landmark "The Distillery District" categorised as a restaurant, at 3:44 AM.
That can only have passed the hours filter through the keep-on-missing rule (a
place with no hours data is never dropped), and a neighbourhood being offered
as a *restaurant* is exactly the failure Task 3 of this session is about (a
Places `includedType` allowlist). So a passing `minStops` at 02:13 was itself
a false comfort. The persona's stop count is a function of the clock and of the
data, and only the evening run is a meaningful "yes".

A second, separate observation from the 01:46 screenshot: the lone stop
(The Garrison) is scheduled 2:08 AM to 4:18 AM, a 2h10m stop starting when a
Toronto bar would close at 2 AM. That is the already-documented
"initial pipeline's `filterPools` is arrival-only" gap (CLAUDE.md, swap engine
section, "FOLLOW-UP, not done"). Noted, not part of this finding.

### D9 provenance

`INVESTIGATION-self-contradicting-constraint.md` lists "D9 (transit-rider
dropped activity)" as a separate later item. That was an owner-supplied list
label; no earlier write-up of it exists in the repo. This document is that
write-up.

### What was changed

Only the report. When `minStops` fails, the `plan_shape` row now also prints the
recovery answers the run gave and the first stop's start time, so a reader can
tell "the app asked, and the run answered 'Plan without it' at 11:00 AM" from a
real shortfall without opening screenshots. Passing rows are unchanged.

### Decision for the owner (not made here)

The persona uses "right now" **on purpose**: it is the only way a stop goes
active inside a run, and movement/arrival needs that. The cost is a stop count
that depends on the hour. Options:

1. **Leave it.** The deviation is now self-explaining. Cheapest. Keeps a
   time-dependent expectation that can fail for no app reason.
2. **Gate the expectation on the run's local hour** (assert 2 stops only when
   the Toronto hour is inside a dinner/live-music window, otherwise record
   "NOT EXERCISED: nothing plausible is open at this hour", the report's
   existing convention for unreachable scenarios). Honest, small, harness only.
   Needs a policy number (which hours).
3. **Change the prompt** to a stated evening time. Removes the time dependence
   but also removes the immediacy floor, so the stop no longer goes active in
   the run and the movement and arrival steps stop being reachable. Trades one
   blind spot for another.

Recommendation: option 2, but the hour window is a policy choice, so it is left
for the owner.
