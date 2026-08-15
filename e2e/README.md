# E2E (Playwright)

## Modes

**Mock (default).** The npm harness starts one hidden dev server on **:3100**
with `E2E_MOCK=1`, runs Playwright against it, and tears down only the process
trees it created — the pipeline data sources (the LLM parse/select/interpret,
Geocoding results, Places search, Routes legs, Weather) return deterministic fixtures from
`app/api/_mock/fixtures.ts`. No quota burned; a live server on :3000 is
never touched. Geocoding's real type/component/ambiguity validator, the
objective filter, scheduling, floor guards, and the
swap/reroute engines still run for real over the fixture data.

**Live.** Occasional real-world checks against the actual APIs on :3000
(reuses a running dev server). Venue names/counts vary run to run —
scenario assertions should stay structural in live mode. Fixture-pinned
tests are tagged `@mock` and excluded automatically.

```
npm run test:e2e          # mock, headless (default)
npm run test:e2e:headed   # mock, headed
npm run test:e2e:live     # live APIs on :3000, skips @mock tests
```

Mock mode supplies a deliberately fake browser Maps key, while the shared
Playwright fixture aborts every non-local browser request. The production map
component therefore renders venue chips on its deterministic fallback
projection without burning Maps quota. `maps-resilience.spec.ts` intercepts
the Maps script locally to prove both provider-signalled invalid-key fallback
and blocked-script recovery through Retry and a real component remount. Fonts
are served from the application bundle; accessibility coverage waits for both
families, verifies them through `document.fonts`, and asserts zero requests to
Google Fonts hosts.
The same harness proves an `unknown` travel estimate creates no confident
straight map polyline.

## Fixtures worth knowing (for scenario tests)

- Dinner pick is **Velvet Fig** (4.8, $$$) — a "cheaper" swap lands on
  **The Corner Table** (4.5, $$), and the strip's dollar signs must go
  $$$ → $$ (the price rides on the stop, not a pools lookup).
- **Brass and Bone** (4.0, $$$, 17–23) is the dinner pool's SAME-TIER
  sibling for Velvet Fig, and exists only for price-direction tests: a
  "fancier" swap off Velvet Fig must NOT return it, because $$$ is not
  fancier than $$$. Without a same-price sibling the pool just runs out
  and a broken strictness gate looks identical to a working one. It is
  the lowest-rated dinner fixture and shares Velvet Fig's hours, so it
  never displaces a pick another spec pins.
- **Price direction is code, not the model**: "fancier"/"cheaper" is
  parsed from the RAW refinement and ranked against the CURRENT stop's
  own `priceLevel`. Only strictly-higher/lower candidates reach the
  selector; when none exist the swap REFUSES ("already the priciest one I
  can find nearby") rather than shuffling in a same-tier venue. An
  UNPRICED candidate is never the answer either — every fixture venue
  carries a `priceLevel`, so if you add one without a price, a
  price-direction swap will decline it and may refuse with the other
  message ("can't compare prices for this <category>"). That is the rule,
  not a fixture bug: keep-on-missing still applies to ordinary swaps.
- **Category-changing swaps** are triggered by a refinement that NAMES a
  different kind of place: `board games` → `board game cafe`, `coffee
  instead` → `coffee shop` (`MOCK_CATEGORY_CHANGES` in `fixtures.ts`).
  Any unknown category gets a synthesised `genericPool`, so the new kind
  lands on **Fixture Board game cafe One/Two/Three**. The fixture returns
  the shape a real model has been SEEN to return, not the tidy one: path
  `"refilter"` disagreeing with its own new `category`, and that category
  ALSO leaked into `constraints`. Both are deliberate — the engine has to
  honour the answer over the path, and strip the leak before the judge, or
  `mockSelect` (real `placeMeetsAllConstraints`) answers unmet_constraint
  and the swap refuses. Plain dissatisfaction ("somewhere else",
  "cheaper", "surprise me") is deliberately NOT a trigger: those must stay
  same-category, and the specs that swap with them are the proof.
- Drinks pick is **Ten O'Clock Curfew** (4.7, closes 22:00) — pushing
  drinks past 10 PM fires the ADAPT path (→ The Standing Room, open to 2).
  **Night Owl** (4.1, NO listed hours) is the bar pool's any-hour
  keep-on-missing survivor — lowest-rated on purpose so it never displaces
  the pinned picks; it exists so late/odd-hour bar scenarios (the
  time-gate "something else → drinks" e2e) stay deterministic.
- **Sundown Scoops** (dessert, closes 21:00) is the downstream adapt
  trigger for late-shifted evenings; **Midnight Flour** is its late
  replacement.
- **"riverside"** in a swap refinement is THE PUSH trigger: it maps to the
  `riverside bar` category (`MOCK_CATEGORY_CHANGES`), whose one venue —
  **Riverside Long Bar** (4.6, $$, 16–02) — sits ~12 km east, which
  `mockLeg` turns into a ~53-minute transit ride. Every other fixture is a
  three-minute walk from the rest of the strip, so this is the only
  deterministic way to reach "the replacement can't be reached at its
  committed start", which now PUSHES the later stops back rather than
  refusing. It lives behind its own category (like `tiny bar` / `late
  gallery`) so it can never enter the BAR pool and displace a pinned pick,
  and it is open to 2 AM on purpose — the pushed arrival must not be the
  thing that fails, or the test would be proving the closing-time refusal
  instead. It resolves to the same 70-minute `bar` duration as drinks, so
  the slot's LENGTH is held and only its start moves.
  Pair it with a stated FINISH ("dinner and drinks from 5-8pm") and the
  push exceeds the plan's `plannedEndISO`, which opens the end-time
  confirmation dialog instead of applying. Without a stated finish there is
  no ceiling and no dialog.
- Fixtures carry an `editorialSummary` (the card's description line) —
  EXCEPT **Sundown Scoops**, deliberately description-less (the
  absent-description case). Two summaries double as **constraint
  evidence** for mockSelect: "vegan" lives on **Noodle Letterpress**
  (dinner), "patio" on **The Standing Room** (bar). A constraint with no
  evidence in the pool → id:null + unmetConstraint → the fail-loud
  surface ("dessert with a patio" fails — no dessert fixture has patio
  evidence; "vegan dinner" picks Noodle Letterpress).
- **Recovery triggers** (partial-failure flow): "**dumplings**" and
  "**bao**" are neighbourhood-sensitive — searched WITH a neighbourhood
  they return only a permanently-closed venue (the objective filter
  empties the pool), searched city-wide (the widen path) they return a
  real open venue (Citywide Dumpling Bar / Harbourside Bao House). Pair
  one or both with a resolving category ("… then a bar at 7pm") for
  single- or multi-empty recovery scenarios.
- **Per-slot recovery triggers:** **late gallery** opens at 8 PM, so
  "dinner then a late gallery at 7pm" is empty at the plan anchor but valid
  at slot 2's provisional 8:45 PM arrival. **Tiny bar** has exactly one
  venue; asking for another tiny bar proves recovery excludes the ID already
  occupied by slot 1 instead of duplicating it.
- Unknown categories get a generated "Fixture <Category> One/Two/Three"
  pool — **Three carries NO hours** (keep-on-missing), so it survives the
  objective filter at ANY server hour: the determinism anchor for
  late-night scenarios (the time-gate override e2e). Weather is 48 calm
  hours (20°, precip 10%) with a built-in daily **rain window at 3 PM
  local** (precip 80, `MOCK_RAIN_HOUR`) — plan an outdoor category "at
  3pm" to trigger the weather gate / empty-pool net.
- **Duplicate categories** (§7.1/§7.2): a prompt matching `another bar|another
  drink|another round|two bars|bar hop|second bar` pushes the **drinks** signal
  TWICE, so two stops share the one BAR pool. Pair it with a stated time —
  "drinks at 7pm then another bar" — and the picks are deterministic: the two
  highest-rated bars open at 19:00, **Ten O'Clock Curfew** then **The Standing
  Room**. Selecting the second card exercises stop identity being the venue id
  rather than the category string.
- **"beach"** is the deliberately EMPTY park-family pool: it shares the
  park plausible band (a late no-time beach prompt fires the batch-4b
  time-gate) but nothing is ever found — the deterministic trigger for
  "override finds nothing → recovery flow" scenarios.

## Fail-loud guards — deterministic in mock mode

All of these produce their exact message with zero live calls:
- `"."` / `"asdfghjkl"` → unparseable (pre-parse guard, mode-independent).
- (removed 2026-07-27) `"brunch at 3am"` / `"dinner at 4am"` no longer fail.
  The plausibility gate that refused them is gone; an unusual hour is
  planned, and the objective hours filter decides what is really open.
- `"cheap fancy dinner"` → the contradiction message (prompt-level guard).
- `"vegan steakhouse"` → the CONTRADICTION message naming the pair ("vegan
  and steakhouse pull opposite ways") — caught by the dietary-vs-venue-type
  guard BEFORE search/select, not the unmet-constraint path.
- `"dessert with a patio at 8pm"` → unmet-constraint fail-loud (no dessert
  fixture has patio evidence; nothing trips the contradiction guard, so it
  reaches select's id:null + unmetConstraint and the page-level message).
- `"a walk in the park at 3pm"` → the all-pools-empty net via the built-in
  3 PM rain window.

All of the above are pinned exact-text in `failloud.spec.ts`.

## Files

- `smoke.spec.ts` — harness proof: plans "dinner and drinks", asserts both
  stop cards render with names/times, runs the desync check.
- `maps-resilience.spec.ts` (@mock) — provider-signalled invalid browser Maps
  key, usable fallback pins, successful bounded Retry after a blocked script,
  remount after a cached transport rejection, and no invented line for an
  uncertain travel estimate. Its provider responses are local stubs; no
  Google request runs.
- `geocode.spec.ts` (@mock) — city and starting-address ambiguity pause before
  venue search, show formatted candidates, pass resolved city context to the
  address request, and resume without repeating the chosen query.
- `fixtures.spec.ts` (@mock) — guards the seam: deterministic picks,
  fixture transit line, canned weather, and a visible/readable accessible
  caution on every walking leg.
- `mobile.spec.ts` (@mock) — rendered geometry and screenshots at 320, 375,
  390, and 768 px: editable non-overlapping landing inputs, horizontal mobile
  dividers, 44 px targets, no page-level overflow/chrome collision, intentional
  strip scrolling, and viewport-contained map chips.
- `accessibility.spec.ts` (@mock) — axe A/AA scans, keyboard-only stop/swap
  operation, native non-nested semantics, live/error regions, focus restoration
  after swaps/reroutes, and locally bundled font verification.
- `failloud.spec.ts` (@mock) — every bad-input message pinned exact-text
  (impossible times, contradictions incl. dietary-vs-venue, gibberish,
  weather net, unmet constraint + the positive vegan pick).
- `recovery.spec.ts` (@mock) — the partial-failure recovery flow: honest
  reason + widen offer for an empty category, accept-widen recovers the
  slot, decline routes to the replace follow-up, TWO empties resolve one
  at a time before the plan finishes, all-empty stays on the plain
  fail-loud path; later slots use their own hours/weather instant, and an
  occupied-only repeated category remains unresolved honestly.
- `client-resilience.spec.ts` (@mock) — every client transport stage:
  network rejection, abort/non-JSON/invalid payload handling, stale-weather
  clearing, recovery retry safety, store/read failures, and swap/reroute
  follow-up 500s. Every case asserts the relevant busy control clears.
- `scenarios.spec.ts` (@mock) — interacting state: price refresh on a
  cheaper swap ($$$ → $$), description present/absent, swap input takes
  real keystrokes with spaces, repeated swaps (cheaper → fancier →
  cheaper), swap-then-reroute (locked swapped stop survives), active-stop
  swap rejection, and the SLOT PUSH (an unreachable replacement moves its
  own slot later and cascades; past a stated finish it asks first —
  decline keeps the plan, accept applies it). Uses the dev time-sim
  (`simAt`) for status control.
- `helpers.ts` — `planEvening(page, prompt)`,
  `planExpectingProblem(page, prompt)` (fail-loud counterpart — asserts
  the surface, returns the message), `swapOn(page, venue, refinement)`,
  and `expectStripMatchesPin(page, venueName)` — the strip↔map agreement
  check. Reuse it after every mutation (swap, reroute, time travel).
