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
- Build vertically: prove one slice end-to-end before stacking the next. Test error paths, not just happy paths. Test in isolation before integrating.
- Repo hygiene: `.next` and `node_modules` gitignored (UTF-8, verify with `git check-ignore`). Never commit `.env`. Never commit build output.

## Devlog
Maintain the devlog. Every feature/fix lands as an entry: type label, then Goal / What should be done / What was done (technical) — each on its own line, plain English keeping technical terms.

## Currently in progress
Home origin shipped: itineraries start from HOME (Chestnut Residence, `app/api/schedule/home.ts`) as leg 0; resolved start = leave-home time, first stop starts after the leg; `homeLeg` is stored outside stops/legs so the reroute engine never sees it.
Next: date-display fix, then the real UI pass. GTFS only if time allows.

## Open gaps (deferred, not blockers)
Reservation availability (needs OpenTable/Resy partnership), GTFS-realtime (manual disruption button for now), rideshare fallback, movie runtimes (TMDB), multi-location prompts flatten to one location, stop reordering, pick reasons don't see resolved times, rolled-forward dates not shown in UI, reroute skips weather gate (lands with GTFS).
