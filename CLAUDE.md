# CLAUDE.md — Itinerary

Operational rules and invariants. Read this before making changes.

## What this is
Hyperlocal AI day-planner for Ossington/West Queen West, Toronto. Free-text prompt → one executable outing (real venues, real times, real transit), rendered on a map, that heals itself when transit breaks. Next.js, Groq (Llama 3.3 70B), Google Places/Routes/Weather/Maps.

## Core architecture rule (governs everything)
The LLM does semantic work only: parsing prompts, selecting venues, writing reasons. Code does every verifiable fact: hours, prices, ratings, distances, travel times, scheduling. Never let the LLM compute distance/time or check "is it open" — that's a field comparison, not a judgment call. If a change asks the LLM to do something checkable, that's the bug.

## The pipeline (in order)
parse → weather fetch → Places search (one per category) → objective filter → LLM select → durations → travel (computeRoutes) → schedule → map. Each step is its own module and was built/tested in isolation.

## Non-negotiable invariants
- **Reroute floor_time:** floor_time = max(now, active stop's end). Stops at or before floor_time NEVER change. Locked stops never change. If any change violates this, STOP and flag it — do not paper over it.
- **Locked ratchet:** a stop locks when active or past, and never unlocks — survives completion and backwards time travel.
- **Keep-on-missing-data:** never drop a venue for missing data (no price, no hours, no rating = keep). Applies to every filter rule.
- **ID validation on select:** the LLM picks by venue ID only; invalid ID → one retry with correction → highest-rated fallback flagged. It can never invent a venue.

## Reuse, don't fork
The replan reuses the real pipeline via `searchPlaces.ts` and `selectVenues.ts` (callable cores; the routes are thin wrappers). Reroute imports these — never fork a parallel replan path, or fixes drift.

## Standing policies
- API keys server-side in `.env`, one per Google service, restricted in Cloud Console. Only the Maps JS key is browser-side (`NEXT_PUBLIC_`), protected by referrer restriction.
- Unstated times resolve via CATEGORY_START_DEFAULTS (dinner 19:00, brunch 10:30, etc.) before falling to next-full-hour. Past times roll forward to next day.
- One resolved `startInstant` is shared by scheduling, hours filtering, and the weather gate — they must never diverge.
- Transit legs get a +5 min delay margin; that buffer is separate from stop-duration buffers. Short legs (<400m, or transit no faster than walking) relabel as walk, no margin.
- Location is hardcoded to Ossington (single-neighborhood launch) — don't build location plumbing.

## Dev/testing
- `?now=ISO` on GET /api/itinerary/[id] simulates time — the backbone of all reroute testing.
- E2E: `npm run test:e2e` (mock, default) / `npm run test:e2e:headed` / `npm run test:e2e:live`. Mock mode = Playwright's own server on :3100 with `E2E_MOCK=1` — deterministic fixtures from `app/api/_mock/fixtures.ts` replace the DATA SOURCES only (Groq/Places/Routes/Weather); filter, scheduling, floor guards, and both engines run for real. :3000 is never touched by mock runs. Live mode reuses :3000 and skips `@mock`-tagged tests. Fixture cheat-sheet lives in `e2e/README.md`. Reuse `expectStripMatchesPin` from `e2e/helpers.ts` after every mutation in new scenario tests — it's the strip/map/store desync check.
- The mock seam is `isMockMode()` checks at seven points (5 routes + both engines' `realDeps()`). Adding a new pipeline data source? Give it a fixture in `_mock/fixtures.ts` and a seam check — never let mock mode fork logic, only data.
- Build vertically: prove one slice end-to-end before stacking the next. Test error paths, not just happy paths. Test in isolation before integrating.
- Repo hygiene: `.next` and `node_modules` gitignored (UTF-8, verify with `git check-ignore`). Never commit `.env`. Never commit build output.

## Devlog
Maintain the devlog. Every feature/fix lands as an entry: type label, then Goal / What should be done / What was done (technical) — each on its own line, plain English keeping technical terms.

## Currently in progress
All three swap types (venue / time / duration) are SHIPPED and verified — engine, tests, and live runs. Current work, from manual testing:
- **4 bugs**: (1) invalid-input fail-loud surface, (2) gibberish error message, (3) constraint enforcement, (4) price display refresh.
- **2 UI items**: swap input spaces, venue description on the stop card.
- Then: Playwright scenario tests covering those fixes, built on the mock fixtures (`E2E_MOCK`, `app/api/_mock/fixtures.ts`).
GTFS remains deferred.

## Shipped — swap engine (operational notes)
Per-stop swap (`app/api/itinerary/swap.ts`, `POST /api/itinerary/[id]/swap`): user taps an UPCOMING stop, types a complaint, the engine acts on intent — VENUE (replace, hold slot), TIME (move the slot), DURATION (change how long), or CONSTRAINT (re-search). Distinct from reroute (external disruption → downstream replan). `floorTime()` shared from `store.ts` by both engines.
- **Time / duration swaps**: `parseTimeExpr` (relative "an hour earlier" = -60, absolute "after 8" = 20:00) and `parseDurationExpr` (absolute "stay 2 hours" = 120, relative "stay longer" = +30) are the deterministic floors under the Groq interpret — arithmetic never depends on the model, and duration wins over time. Both call the reusable **try → adapt → notify** ladder `resettleTail` (shift/reflow the tail, keep a downstream venue if still open at its new arrival, else re-search an equivalent, else fail loud). Plan-then-commit: a failed resettle leaves the itinerary untouched. Duration guards: floor at the category's realistic minimum, cap 6h. `buildStop` takes a `durationOverride`; `resettleTail`/`commitTail` carry each stop's `totalMinutes` so a custom duration survives a later reflow. Keep `resettleTail` generic — it's the shared spine of time + duration (and future) swaps.
- **Availability seam**: `SwapDeps.isUsableAt(place, when, category)` is the ONE "is this venue usable then" check (default = objective hours, keep-on-missing). A real availability/reservation API replaces that function body only.
- **UI**: the swap prompt is inline under the selected strip card (`ItineraryStrip` `SwapInline`), upcoming-only; reuses the reroute reflow (chartreuse "changed" keyed by venue id). The map's projection probe defers its `setState` to rAF (never call setState inside a Google `OverlayView.draw()`).

## Shipped — product UI (operational notes)
The product page (`app/page.tsx`) replaced the `PlacesTest` harness: a full-bleed printed-cartography Google map (warm-paper inline style JSON, no Cloud map id), venue chips at pins, a horizontal itinerary strip as the primary surface, ink-navy route lines (dashed transit / solid walk), a distinct home marker, and the reroute reflow as the one signature animation (dimmed leg, struck→settled times, chartreuse accents + redrawn route, plain-voice banner). Design tokens live in `app/globals.css` (warm paper / ink-navy / RESERVED acid-green `--live`; Fraunces display + Space Grotesk mechanical). Map + HTML overlays are in `app/ItineraryMap.tsx` (custom `OverlayView` projection probe positions the React chip layer). The dev time-sim + disruption trigger survive as a discreet cornered strip. Pipeline wiring unchanged — presentation only.

## UI invariants (don't regress)
- Acid green (`--live`) is reserved. The FULL chartreuse marker/border = the active "now" stop only. Swap-/reroute-changed elements get chartreuse *accents* (changed-ring marker, settling time pill, redrawn route) but an upcoming changed stop keeps its ink marker — chartreuse never means "changed" and "now" at the same visual weight. Never decoration.
- Swap vs reroute: swap is user-initiated + surgical (one upcoming stop, hold the slot); reroute is disruption-driven + replans the tail. Both share `floorTime()` and reuse the same pipeline cores — never fork a third replan path.
- Map uses inline `styles` JSON on a classic `Map` (no `mapId`) so paper styling works; markers/cards are `OverlayView` HTML, NOT AdvancedMarkerElement (which needs a Cloud map id).
- fitBounds keys off venue coordinates (`fitKey`), never status ticks — status changes must not yank the map view.
- Expanded cards clamp to the viewport (horizontal) and flip below the pin near the top edge.

## Open gaps (deferred, not blockers)
Reservation availability (needs OpenTable/Resy partnership), GTFS-realtime (manual disruption button for now), rideshare fallback, movie runtimes (TMDB), multi-location prompts flatten to one location, stop reordering, pick reasons don't see resolved times, reroute skips weather gate (lands with GTFS), chips can tuck under an expanded card when two venues are <~300m apart (active card wins the z-order), weather-blocked categories have no pin (shown as a text note since there's no venue/coords).
