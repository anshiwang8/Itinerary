# Handoff — Transit B, ride palette, and time-scoped travel-leg visibility

Updated 2026-08-20 for Claude. Read `CLAUDE.md` first; it is canonical. Then read
`AGENTS.md`, the top Transit B entries in `DEVLOG.md`, and
`code-audit-2026-07-18.md` before changing code. Prefer the exact current code
over this handoff or historical prose if they ever disagree.

## Repository state

- Branch: `transit-walkline-fix`.
- Current tip: `7149f6d43529ebf2bdc0c91ec64db4217c0b9669`
  (`Fix time-scoped travel leg visibility`).
- `origin/transit-walkline-fix` points at the same commit; the branch is
  `0` ahead / `0` behind because the fix has been pushed to GitHub.
- The immediately preceding visibility commit is
  `9587dbd89f7cdf174bc60c23554c2c9db34513c5`
  (`Add context-focused transit leg visibility`), which is also the current
  `main` / `origin/main` tip.
- Palette Part 2 is:
  `cf8a072f4616b0140e810c5a27aeff3e25b0edb5`
  (`Apply Transit B ride palette (Part 2)`).
- Palette Part 1 is `70e6f86e7584b1ac570c8554424a199ad781c73c`.
- The earlier Transit B renderer chain is `2c8fb69` (Piece 1 data plumbing),
  `54b76d5` (per-ride transit geometry), and `7e7bbbf` (embedded walking runs).
- `e7d863b` stopped tracking the local research document before Palette Part 1.
- The contaminated commit `117196dd7323b4ad2d7d9f02375391e8697ad85a`
  is not an ancestor of this branch.
- Current local branches are only `main` and `transit-walkline-fix`; no local
  `transitB2` branch is present. Do not introduce or merge the contaminated
  history.
- The tracked tree and index are clean. This `HANDOFF.md` is the only
  working-tree status entry and is deliberately untracked, unstaged, and
  excluded from every listed commit.
- `docs/research/reddit-demand-analysis.md` is absent, as explicitly
  authorized. Its exact path is covered by committed `.gitignore`; do not
  create, restore, read, stage or commit it if it appears later.
- `next-env.d.ts` has no textual or staged diff, reports matching LF worktree
  and index content, and its filtered worktree and HEAD hashes are both
  `c4b7818fbb2c2c34c24feb1b627ee824507c5600`.

## What is complete

### Transit B geometry and lifecycle

- `TravelLeg.pathSegments` carries provider-native step geometry in provider
  order. Transit and walk steps are decoded independently with the already
  loaded Google geometry library.
- A usable transit ride creates one native primary polyline. Missing,
  throwing, empty, one-point, non-finite or out-of-range transit geometry
  creates no line and never becomes a fabricated endpoint chord.
- Pre-step-array legacy transit may still use its real whole-leg encoded path.
  Transit with no provider geometry draws nothing. Ordinary whole-leg walking
  keeps its one solid ink line.
- Embedded walking inside a transit leg is accumulated only within that leg.
  Consecutive paths merge at boundaries within 2 metres, paths at or below
  0.5 metres are discarded, and invalid/disconnected/transit boundaries flush
  the run. No connector, simplification, coordinate offset or marker-alignment
  correction is invented.
- Route effects own every overlay they create. Rerender, cancellation,
  Strict Mode, unmount and remount detach the correct overlays without stale
  duplication. Bounds still use venue coordinates and marker projection is
  unchanged.

### Exact ride identity and slot contract (palette Part 1)

- Every new computed leg has an app-owned `legId`.
- Every source transit ride gets one `rideId` and raw `sourceStepIndex` before
  facts and geometry can be filtered independently. The same exact occurrence
  bundle reaches whichever `TransitSummary` and transit `PathSegment` survive.
- Renderers read the slot carried by their own record. Never zip filtered
  facts and geometry arrays or infer identity from route name, provider color,
  time, coordinates or encoded geometry.
- Valid `paletteSlot` values are unique integers `0..23` across the itinerary.
  Retained slots are reserved before new rides receive the lowest free slot.
  Ride 25+ remains valid with explicit `paletteSlot: null`; it never wraps.
- Freshly recomputed legs/rides receive fresh identity. Untouched legs retain
  identity and slots through save/load and swap/reroute/remove reconstruction.
- All-absent legacy metadata remains valid and is never guessed or backfilled.
  Partial new records and relational conflicts are rejected, except that the
  server may drop a malformed decorative path under its established sanitize
  policy.

### Palette Part 2 visual contract

`app/lib/transitRidePalette.ts` is the sole browser-safe palette table. The
mapping is fixed and deterministic:

```text
 0 #005A9C    1 #9A4D00    2 #006B57    3 #A31545
 4 #5F6500    5 #6B4C9A    6 #B3261E    7 #006D8F
 8 #76502F    9 #5145A4   10 #3F6B35   11 #8A3A75
12 #2D6FA3   13 #B05A14   14 #1B7A67   15 #B13F68
16 #687014   17 #805DA8   18 #C13F37   19 #176F89
20 #89654A   21 #675ABD   22 #46753D   23 #A04B87
```

- Every ride with a valid non-null slot uses that exact app color on its native
  primary line, changed-state halo, map bubble, compact strip badge and BOARD
  badge.
- Multiple rides inside one transfer leg and separate occurrences of the same
  TTC route retain their own occurrence colors.
- The changed halo is wider and lower-opacity but uses the exact same display
  color as its primary. Route geometry never uses reserved chartreuse
  `#C8F000`.
- App-colored badges/bubbles force `#FFFFFF` foreground. Provider `color` and
  `textColor` remain stored facts but control only legacy/all-absent and
  explicit-null-overflow fallback.
- `bubbleDisplayColors()` is shared by the real strip badge and map bubbles so
  compact and BOARD surfaces cannot drift. Paired/color-only map bubbles
  publish authentic ordered route names through screen-reader-only text;
  single-ride labels avoid a duplicate accessible name.
- `rideId`, `sourceStepIndex`, `legId` and `paletteSlot` do not enter visible
  labels or DOM attributes.
- Invalid, missing or null slots return no app color. There is no randomness,
  ID hashing, provider-color slot selection or overflow wrapping.

### Stronger embedded walking dots

The approved styling is now exact:

```text
Neutral gray                    #4F6F7E
Dot repeat                      12px
Primary fill opacity / scale    0.88 / 2.0
Changed fill opacity / scale    0.24 / 3.6
Primary / changed z-index       2 / 1
Base stroke opacity             0
Symbol stroke opacity           0
```

These are genuinely dotted native-symbol polylines. Walking remains neutral;
it never borrows provider, occurrence, ink or chartreuse color. Geometry,
merging and the ordinary solid walking route were not changed.

### Context-focused complete travel-leg visibility, including the WALK leak fix

Commit `9587dbd` introduced context-focused identified transit-leg visibility.
Commit `7149f6d` completes that presentation seam for identified inter-stop
WALK legs and deliberately adds pre-start home TRANSIT visibility. Neither
commit changes slot allocation, route colours, provider data, scheduling, or
travel-mode selection.

- The complete modern travel leg is the visibility unit: its rides, embedded
  walks, whole-leg walk, changed halo, label/bubbles and transfer markers share
  one decision and appear or disappear together.
- `automaticTravelLegId()` uses the existing `displayNow` and absolute
  scheduler windows in this exact priority:
  1. the first identified WALK/TRANSIT leg underway in the half-open
     `[leaveISO, arriveISO)` window;
  2. identified home→first TRANSIT while `displayNow < firstStopStart`, with no
     look-ahead threshold, so it is visible from plan creation even before its
     calculated departure;
  3. the active stop's identified WALK/TRANSIT outbound leg.
- At the exact first-stop start, the special home-transit rule ends. The normal
  underway/active-stop context takes over; invalid or missing timing invents no
  boundary.
- The reported premature line was `itinerary.stops[0].travelToNext`, a nearby
  first-stop→second-stop route legitimately relabelled as a whole-leg WALK by
  the existing travel policy. `ItineraryMap` had gated only TRANSIT, so that
  WALK was decoded and constructed unconditionally before its context was
  current. The fix gates identified inter-stop WALK before decoding or native
  construction. It does not alter the `<400m` or competitive-walk policies.
- This was not a lifecycle-duplication defect. The renderer still has one
  production construction path with invocation-local overlay ownership;
  rerender, cancellation, unmount and remount detach the exact owned set.
- One ephemeral `manualLegId` can add a completed or future identified
  inter-stop WALK/TRANSIT leg. Selecting a different leg replaces the prior
  selection; selecting it again clears it; automatic plus manual IDs are
  deduplicated exactly.
- Manual identity lives in `page.tsx`, is shared by strip and map, survives
  ordinary status refreshes while the exact ID survives, clears on plan/history
  replacement, and clears when a topology mutation removes that ID. It is
  independent of venue selection.
- Identified inter-stop WALK and TRANSIT summaries are real buttons with
  `aria-pressed`. Only coherent transit timelines additionally expose
  `aria-expanded`/`aria-controls`; WALK never invents a transit timeline.
- Home WALK deliberately keeps its pre-existing always-visible, non-manual
  compatibility behavior. Identity-absent WALK remains visible. A legacy plan
  with a missing transit `legId` keeps all transit legs visible and its local
  timeline behavior. No identity is inferred or backfilled.
- `UNKNOWN` remains non-drawable. Hidden identified legs create no polyline,
  ride, embedded walking run, halo, route label/bubble or transfer marker.
- Palette colours, provider fallbacks, exact provider coordinates, ordinary
  solid WALK styling, embedded-walk merge/style rules, cleanup, bounds and
  markers remain unchanged.

Important live-check consequence: not every modern travel leg is visible at
once. Home TRANSIT is the automatic pre-start context; after that, use the
strip's manual WALK/TRANSIT selection to inspect completed or future legs in
addition to the automatic one.

## Part 2 verification already completed

The final Palette Part 2 tree at `cf8a072` recorded:

- Palette helper: 3/3.
- Transit bubbles: 18/18.
- Transit detail: 33/33.
- Ride identity: 11/11.
- Travel: 28/28.
- Server schema: 18/18.
- Browser payload: 19/19.
- Real-component mock map/strip harness: 10/10.
- Full unit run: all 50 suites passed.
- Full mock E2E: 91/91 passed.
- Typecheck: clean.
- Lint: 0 errors, the same 10 existing warnings.
- Required `next build --webpack`: passed.
- Local production server on port 3200: HTTP 200; the planning page rendered,
  two mock-backed stops planned, map reached `ready`, slot-0 blue/white agreed
  in the real strip and map bubble, no ride ID leaked, and no browser warning or
  error appeared. This was deterministic mock verification, not a
  real-provider claim.

The Palette Part 2 discriminating revert-run temporarily bypassed map palette
resolution. The cross-surface test failed on the real mismatch—expected slot-0
`#005A9C`, received provider red `#D71920` on the exact same path—then passed
1/1 after restoration. The mutation is absent from history.

## Current-tip visibility-fix verification

The finalized `7149f6d` tree was verified, committed, and pushed. Exact focused
results recorded in `DEVLOG.md` and the implementation report:

- Visibility unit suite: 20/20.
- Real-component Maps/strip harness: 17/17.
- Typecheck: clean.
- Lint: 0 errors and the same 8 warnings.
- Full `npm run check`: all 51 unit suites, webpack production build, and
  98/98 mock E2E tests across 12 spec files.
- All three known clock-sensitive tests passed on the first full run; no
  isolated rerun or waiver was needed.

The required discriminating revert-run bypassed only identified inter-stop
WALK gating. The screenshot regression failed at
`e2e/maps-resilience.spec.ts:602`: expected no line, but received one active
solid `#2E6F8A`, opacity `0.92`, weight `2.5` polyline on the exact decoded
provider path:

```text
[[43.649,-79.42],[43.6495,-79.4195],[43.65,-79.419]]
```

The independently named home-transit-before-departure case remained green.
After restoring only the deliberate bypass, both focused cases passed 2/2 and
the mutation was absent from the committed diff.

An independent post-review adjustment made the plan/history fixture change the
plan ID while preserving the selected leg ID, so its assertion now proves the
plan-identity reset rather than merely stale-ID removal. `npm run check` was
rerun on that exact final tree and passed again with the same 51-suite,
98-E2E, 0-error/8-warning result.

The production build can rewrite the generated `next-env.d.ts` route-types
import. An earlier cleanup was superseded by the final-tree verification run;
that final complete gate itself left `next-env.d.ts` byte-identical to HEAD,
with its committed `./.next/dev/types/routes.d.ts` import, empty textual/staged
diffs, and matching raw/filtered hashes. No final restore was necessary and no
build ran afterward. In future, inspect any generated diff before restoring
only that file; stop if it contains anything besides the known generated
import change.

The exact known clock-dependent E2E descriptions are:

1. `a push past a STATED end asks first: decline keeps the plan, accept applies it @mock`
2. `a stated window plans multiple stops that end inside it @mock`
3. `an OVER-STUFFED window drops what doesn't fit and says so @mock`

Only those exact tests may be treated as known clock flakes, and only when the
failure evidence matches the documented stated-window clock behavior.

## Remaining owner/live work

No real-provider visual claim has been made for the palette or the new
visibility behavior. The branch is pushed, but deployment of `7149f6d` has not
been verified in this handoff. Anshi should verify after deployment:

1. Create a future real itinerary whose first and second events are close
   enough that the first→second leg is labelled WALK. Before the first event,
   confirm that line and its map label are completely absent.
2. For the same plan, confirm home→first TRANSIT is visible immediately after
   creation, including before its calculated departure.
3. At the exact first-stop start, confirm the home route clears and the active
   stop's outbound WALK/TRANSIT becomes the automatic context.
4. Manually select the future WALK leg by pointer and keyboard; confirm its one
   solid provider-shaped route appears, `aria-pressed` reflects the selection,
   and selecting it again clears it.
5. Select a second completed/future leg and confirm it replaces the prior
   manual route without hiding or duplicating the automatic one.
6. Switch plans, resume history, and reroute repeatedly; confirm plan changes
   and replaced IDs clear manual selection while exact surviving IDs remain
   stable across ordinary refreshes.
7. Confirm home WALK remains always visible/non-manual and a legacy stored plan
   retains its established all-visible transit and identity-absent WALK
   behavior.
8. Generate a real itinerary with multiple TTC rides that previously shared
   red, and use automatic/manual complete-leg visibility to inspect every ride.
9. Confirm each ride's map line matches its compact badge, BOARD badge and map
   bubble exactly.
10. Confirm rides within one transfer leg use different colors.
11. Confirm repeated occurrences of the same route may use different colors.
12. Confirm changed rides retain their assigned color and gain only the
    wider/lighter same-color halo.
13. Confirm no ride geometry uses `#C8F000`.
14. Confirm embedded walking dots are darker, larger and clearly visible.
15. Confirm changed walking dots retain a visible neutral rim.
16. Confirm an ordinary whole-leg WALK remains a single solid ink route when
    its automatic/manual visibility condition is met.
17. Confirm no straight, shifted or marker-aligned geometry was fabricated.
18. Confirm rerender/status refresh does not duplicate route overlays.
19. Reload a newly generated plan from history and confirm identity/colors
    persist.
20. Check desktop and mobile, including white-text readability and meaningful
    accessible names.
21. Confirm no opaque IDs or palette-slot numbers appear in UI or attributes.
22. Confirm selection, cards, timing, framing, markers and bounds otherwise
    behave as before.
23. Check the live Routes billing/SKU after the Piece 1 step-field additions;
    the code-level expectation that the SKU does not move is inferred, not a
    measured billing result.

Real-provider visual inspection, the Routes billing-line check, and deployment
confirmation remain owner work.

## Known limitations and explicit non-goals

- Home `arriveISO` is the first stop's exact `start_time`; the scheduler does
  not represent a separate “arrived but event not started” interval. The home
  visibility rule therefore ends at that one authoritative boundary rather
  than inventing another timestamp.
- Home WALK remains an explicit always-visible, non-manual compatibility case.
  Changing that product decision is separate work; do not silently fold it
  into the identified inter-stop WALK gate.
- Exactly coincident native paths cannot both be visually exposed by static
  color because the upper line covers the lower one. Do not offset or falsify
  provider geometry. A future ride-selection/interaction treatment is the
  appropriate seam.
- The conditional deferred-route-loader cancellation test was not added for
  Palette Part 2 because the cached loader resolves before route drawing and a
  true deferred draw would require a parallel injection architecture. Existing
  rerender, retry, unmount, remount and exact-overlay-set tests remain the
  lifecycle coverage.
- The known server-side `stops[].travelToNext` sanitizer gap predates this work
  and remains deliberately deferred. Browser validation rejects corrupt nested
  legs, but do not claim the server gap was fixed.
- Tasks 2–4 were not started. Transit-vs-drive, em-dash cleanup,
  indoor-constraint recovery and marker-offset work remain outside this work.
- Scheduler math/order, venue selection, provider requests and factual parsing,
  board/alight calculations, durations, `staticDuration`, swap/remove/reroute
  semantics, persistence, prompts/model routing, map bounds and marker
  positioning were not changed by Palette Part 2 or either visibility commit.
  The visibility work changes presentation state only and must not be used as
  a reason to alter the `<400m` or competitive-walk relabelling policies.

## Files to know

Palette Part 2 production:

- `app/lib/transitRidePalette.ts`
- `app/lib/transitBubbles.ts`
- `app/ItineraryMap.tsx`
- `app/ItineraryStrip.tsx`

Palette Part 2 tests/harness:

- `app/lib/transitRidePalette.test.ts`
- `app/lib/transitBubbles.test.ts`
- `app/test-harness/maps/MapsHarness.tsx`
- `e2e/maps-resilience.spec.ts`

Current-tip visibility implementation (`9587dbd` + `7149f6d`):

- `app/lib/travelLegVisibility.ts`
- `app/lib/travelLegVisibility.test.ts`
- `app/page.tsx`
- `app/ItineraryMap.tsx`
- `app/ItineraryStrip.tsx`
- `app/test-harness/maps/MapsHarness.tsx`
- `e2e/maps-resilience.spec.ts`

Tracked documentation updated by the final fix:

- `CLAUDE.md`
- `AGENTS.md`
- `DEVLOG.md`

Exact `7149f6d` commit stat: 10 files changed, 1,574 insertions and 183
deletions. The committed files are the three tracked documentation files plus
the seven visibility implementation/test/harness files above. `HANDOFF.md`,
`next-env.d.ts`, and the ignored research path were not included.

Canonical documentation and full technical history are in `CLAUDE.md` and
`DEVLOG.md`. Prefer the exact current code over historical prose if they ever
disagree.
