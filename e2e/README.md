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
  **The Corner Table** (4.5, $$).
- Drinks pick is **Ten O'Clock Curfew** (4.7, closes 22:00) — pushing
  drinks past 10 PM fires the ADAPT path (→ The Standing Room, open to 2).
- **Sundown Scoops** (dessert, closes 21:00) is the downstream adapt
  trigger for late-shifted evenings; **Midnight Flour** is its late
  replacement.
- Unknown categories get a generated "Fixture <Category> One/Two/Three"
  pool. Weather is 24 calm hours (20°, precip 10%).

## Files

- `smoke.spec.ts` — harness proof: plans "dinner and drinks", asserts both
  stop cards render with names/times, runs the desync check.
- `fixtures.spec.ts` (@mock) — guards the seam: deterministic picks,
  fixture transit line, canned weather.
- `helpers.ts` — `planEvening(page, prompt)` and
  `expectStripMatchesPin(page, venueName)` — the strip↔map agreement
  check. Reuse it after every mutation (swap, reroute, time travel).
