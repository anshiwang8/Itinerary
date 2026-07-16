# E2E (Playwright)

## Modes

**Mock (default).** Playwright starts its own dev server on **:3100** with
`E2E_MOCK=1` — the pipeline data sources (Groq parse/select/interpret,
Places search, Routes legs, Weather) return deterministic fixtures from
`app/api/_mock/fixtures.ts`. No quota burned; a live server on :3000 is
never touched. The objective filter, scheduling, floor guards, and the
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

Note: the browser-side Maps JS key (`NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`) is
still used in mock mode — the map render layer is presentation, not a
mocked pipeline source.

## Fixtures worth knowing (for scenario tests)

- Dinner pick is **Velvet Fig** (4.8, $$$) — a "cheaper" swap lands on
  **The Corner Table** (4.5, $$), and the strip's dollar signs must go
  $$$ → $$ (the price rides on the stop, not a pools lookup).
- Drinks pick is **Ten O'Clock Curfew** (4.7, closes 22:00) — pushing
  drinks past 10 PM fires the ADAPT path (→ The Standing Room, open to 2).
- **Sundown Scoops** (dessert, closes 21:00) is the downstream adapt
  trigger for late-shifted evenings; **Midnight Flour** is its late
  replacement.
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
- Unknown categories get a generated "Fixture <Category> One/Two/Three"
  pool. Weather is 48 calm hours (20°, precip 10%) with a built-in daily
  **rain window at 3 PM local** (precip 80, `MOCK_RAIN_HOUR`) — plan an
  outdoor category "at 3pm" to trigger the weather gate / empty-pool net.

## Fail-loud guards — deterministic in mock mode

All of these produce their exact message with zero live calls:
- `"."` / `"asdfghjkl"` → unparseable (pre-parse guard, mode-independent).
- `"brunch at 3am"` / `"dinner at 4am"` → the category-window message
  (mockParse extracts the clock time + category; the band check is code).
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
- `fixtures.spec.ts` (@mock) — guards the seam: deterministic picks,
  fixture transit line, canned weather.
- `failloud.spec.ts` (@mock) — every bad-input message pinned exact-text
  (impossible times, contradictions incl. dietary-vs-venue, gibberish,
  weather net, unmet constraint + the positive vegan pick).
- `recovery.spec.ts` (@mock) — the partial-failure recovery flow: honest
  reason + widen offer for an empty category, accept-widen recovers the
  slot, decline routes to the replace follow-up, TWO empties resolve one
  at a time before the plan finishes, all-empty stays on the plain
  fail-loud path.
- `scenarios.spec.ts` (@mock) — interacting state: price refresh on a
  cheaper swap ($$$ → $$), description present/absent, swap input takes
  real keystrokes with spaces, repeated swaps (cheaper → fancier →
  cheaper), swap-then-reroute (locked swapped stop survives), active-stop
  swap rejection. Uses the dev time-sim (`simAt`) for status control.
- `helpers.ts` — `planEvening(page, prompt)`,
  `planExpectingProblem(page, prompt)` (fail-loud counterpart — asserts
  the surface, returns the message), `swapOn(page, venue, refinement)`,
  and `expectStripMatchesPin(page, venueName)` — the strip↔map agreement
  check. Reuse it after every mutation (swap, reroute, time travel).
