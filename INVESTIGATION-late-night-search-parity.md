# Investigation: late-night search parity for swap and reroute (and the Task 5 sweep)

Branch `late-night-search-parity`, 2026-09-25. Task 5 was a cleanup sweep of
*already-documented* small items. This branch is the one fix that survived the
"small, safe, well-understood" filter; the rest of the sweep is recorded below so
it is not redone.

## The item

Recorded in the 2026-07 DEVLOG entry "Fix: 'right now' means TONIGHT ...":

> swap/reroute call `searchPools` directly and don't pass the flag yet, scope kept
> contained, noted as a follow-up.

The flag is `lateNight`: from 21:00 to 05:00 in the plan's zone a category's search
also runs a "late night <category>" sibling query. The original probe (Toronto,
23:30) is in the code comment: "restaurant" returned 6/20 open venues and the
late-night variant 8/20 with partial overlap, so the union roughly doubles the
genuinely-open pool.

## Verified still open on current code

`grep lateNight` over `app/`: one caller, `places/search/route.ts`. `swap.ts` and
`reroute.ts` call `searchPools` with two or three arguments and never pass it. So
the initial plan at 11 PM gets the broadened pool, and a swap or reroute at 11 PM
hunting a replacement for one of its stops does not.

## The fix

- One definition, `isLateNightAt(instant, timeZone)`, beside the option it controls
  in `searchPlaces.ts`. The route now calls it in place of its inline copy (the same
  rule, byte-identical behaviour).
- `SwapDeps.searchPools` and `RerouteDeps.searchPools` take an optional trailing
  `{ lateNight }`; both production bindings forward it; mock deps ignore it.
- The engine decides it, from the instant it is searching for, in the plan's zone.

### The one design default (flagged, change it if you disagree)

The initial plan judges the **plan's start hour**. The engines judge the **stop's
own hour**: a venue swap the target slot's start (the instant `filterPools` judges
opening hours at), `findReplacement` its `when`, and a reroute is late if its
departure or any stop it replans is late (one search serves the whole tail).

Consequence: a plan that starts at 6 PM with an 11 PM final stop now broadens a
swap of that final stop, where the initial search for it did not. That seemed the
honest reading, since the flag exists to find venues open at the instant being
searched, and it can only ADD a query. The alternative is "use the plan's start",
which would leave the 11 PM swap thin in exactly the case that motivated this. Not
a hard call, but it is a call, hence flagged.

### Cost

A late-night swap or reroute search is two Places calls per category rather than
one, inside the existing per-search bounds. It can widen a pool, never shrink one.

## Tests

`searchPlaces.test.ts` 25 to 26, `swap.test.ts` 85 to 89, `reroute.test.ts` 13 to 15,
each guard mutation-checked (see the DEVLOG entry). The zone case is the one worth
knowing about: 21:00-04:00 is late in Toronto, not late in Vancouver (18:00), and
late again in London (02:00); a version that judged in the default zone fails it.
Reroute's `realDeps` is not exported, so its production binding is covered by
inspection, not a test; swap's is tested through a fetch stub.

---

## The sweep: what was considered, and why it was not built

Searched DEVLOG (820 KB, by marker rather than read end to end), CLAUDE.md's "Open
gaps", `AUDIT_FINDINGS.md`, the audit trackers, and source comments for TODO,
FIXME, "follow-up", "flagged, not fixed", "known limitation", "deliberately not".
Only `durations.ts` carries a literal TODO.

Built: the late-night parity above.

Already resolved since it was recorded (verified against current code, nothing to do):
- Provider status and a 15s client deadline ("browser gives up before the server")
  now 25s and documented.
- `parseScheduledStops` not validating `travelToNext` (audit D2).
- The availability seam being inert because stored stops carried no hours.
- The `clarify.ts` rule table ("jazz bar" drawing the wrong narrowing question):
  that file was deleted in the planner rewrite.
- The Places `includedType` allowlist: built on branch `places-type-allowlist`.
- Weather-blocked category in a mixed request: the weather-gate recovery mode.

Considered and NOT small or NOT safe (each needs an owner decision):
- **Audit `H8/M3-F1` (planner accepts `dinner at 13pm`) and `M1-F1` (planner does
  not check a stated activity count against the prompt).** Still open, confirmed by
  grep. Both are "restore a deterministic raw-prompt guard" and both turn on policy:
  how strict, what the refusal says, whether an ambiguous multi-category count asks
  or refuses.
- **Reroute never reads `plannedEndISO`**, no re-check after the arrival-adapt
  re-route, the last stop's buffer counting against a stated end
  (`INVESTIGATION-window-fit-status.md`): policy.
- **The initial pipeline's arrival-only hours check** (a venue that closes mid-slot
  can be scheduled): recorded as "the fix belongs in `filterPools`", a policy change
  to what the initial plan accepts.
- **The platform-wait under-budgeting** ("the arrive row is telling you the plan
  under-budgeted that leg"): explicitly shelved, scheduling policy.
- **`LIVE_TRACKING_ENABLE_HIGH_ACCURACY` false to true**, and the you-marker's
  two-gate staleness reading (`AUDIT_FINDINGS.md` R2): "Owner judgment required".
- **Movie runtimes** (`durations.ts` TODO): needs a showtimes/runtime data source.
- **Removing the only upcoming stop beside a completed one concludes the plan:**
  documented as genuine conclusion, not a defect.
- **Two same-category slots with different neighbourhoods collapse onto one pool:**
  a documented limitation whose fix is a much larger re-keying.
- **Editing a stop from the mobile sheet; chips tucking under an expanded card; the
  one-frame chip lag; a declined weather block having no pin; the phone hero making
  a clarify panel need a scroll:** UI work that needs eyes on a device, not
  small-and-safe changes for an unattended run.
- **Dev-only `?now=` picker reading the viewer's zone:** dev control only, hidden in
  production; low value.
