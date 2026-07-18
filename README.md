# Itinerary — a hyperlocal AI day-planner

Describe a day in plain language and get **one executable plan** — real venues, real times,
real transit — laid out on a map. Tap any stop to swap it ("somewhere cheaper", "an hour
earlier", "stay 2 hours"), and when a transit leg is cancelled the plan **reroutes and heals
itself**, keeping the stops you've already reached unchanged. You pick the **city and starting
address**, so a plan in Vancouver runs on Vancouver's clock, not Toronto's.

---

## Try it — live

### 👉 **https://itinerary-six.vercel.app/**

Open it and use the full app immediately — real venues, real transit, every feature. No
install, no keys, nothing to set up. **This is the main way to use it.**

---

## How to use it

1. **Say where.** The **city** field is prefilled (Toronto) and the **starting address** is
   optional — leave it blank and the plan starts from the city centre. Both are plain text
   queries, geocoded when you plan.

2. **Plan a day.** Type something like **`dinner and drinks`** and hit *Plan it*. You get a
   plan on the map — venues, times, and the transit/walk leg between stops. The plan is live
   the moment it appears. (The **weather chip**, top-left, shows the forecast for your city.)

3. **Answer a question or two.** A thin prompt ("not sure what to do") gets 1–3 quick
   questions — what kind of thing, when, what vibe — with one-tap chips and a *Skip — just
   plan it* escape. A prompt that already says enough is never interrupted.

4. **Swap a stop.** Click a stop card in the top strip to open its inline prompt, then try:
   - `somewhere cheaper` — swaps in a cheaper venue and holds the time slot (watch `$$$` → `$$`).
   - `an hour earlier` — moves the stop and reflows everything after it.
   - `stay 2 hours` — changes how long you're there; later stops shift to fit.
   - `find a closer one` — ranks by real distance from where you're coming from, and says so
     honestly if nothing is actually closer.

5. **Watch it reroute and heal.** Open the **Dev** panel (bottom-right corner):
   - Pick a **leg** in the dropdown and hit **cancel** → that transit leg is "cancelled" and
     the app replans: earlier stops stay exactly as they were, only the affected stop and what
     follows get new venues/times (old time struck through → new time settles in green).
   - Optional: set the **time** control to a moment during your first stop → it turns
     chartreuse ("now") and locks, and you'll see a reroute keep it untouched while replanning
     only the tail.

---

## What it actually does

- **One executable plan, not a list of options.** Real venues with real opening hours, real
  travel legs between them (transit or walk, with a departure buffer on transit), and a
  schedule that adds up.
- **Multi-city, with real per-city timezones.** The plan's timezone is resolved from the
  geocoded starting point, and *every* time — scheduling, the hours filter, every label on
  screen — renders in that zone. A Vancouver plan shows Vancouver's wall clock to a viewer in
  Toronto, and vice versa.
- **Distance-aware picks.** Each candidate carries a code-computed straight-line distance from
  your starting point, so selection treats distance as a real cost instead of picking a
  slightly-better-rated venue across the region. "Closer" swaps are ranked in code, never by
  the model.
- **Self-healing.** A cancelled transit leg replans only what's downstream — stops at or
  before the current moment, and anything already underway, never change.
- **It tells you when it can't.** Impossible ("brunch at 3am"), contradictory ("vegan
  steakhouse"), or unparseable input gets a specific reason and a suggested fix — never an
  empty map. When a hard constraint has no real match, it says so instead of suggesting a
  venue and telling you to "check with them".
- **When something blocks a stop, you get a real choice**, not a dead end. One panel, three
  situations:
  - **A category came back empty** ("the only ramen nearby is permanently closed") → the
    honest reason, plus an offer to look further out or put something else in that slot.
  - **The hour looks wrong** and you never named one ("it's 10:54 PM — late for a typical park
    visit") → *Still want it* pushes past the guess, *Something else* switches direction. An
    hour **you** typed still fails loud; only our own guess is overridable.
  - **Weather blocks it** ("rain likely at 3pm") → *Still want it* skips only the weather
    check (hours, rating, price, and closures all still apply), *Something else* swaps that
    one stop.
- **A walk is only offered when a walk makes sense.** A short or genuinely-faster walk beats
  transit; a 75-minute walk is never presented over a comparable transit ride — unless transit
  there is effectively broken (walking at least twice as fast), which is exactly when you'd
  want to know.

---

## Run it locally (optional — requires API keys)

For real venues on your own machine. This calls paid/rate-limited APIs, so it needs keys.

**Prerequisites:** Node.js **18.18+** (Next.js 14's requirement; the repo doesn't pin it —
`node --version` to check) and npm.

```bash
git clone <your-repo-url>
cd <repo>/itinerary
npm install
```

**Add your keys.** Copy the template and fill in the five values:

```bash
cp .env.example .env
```

```bash
# .env
GROQ_API_KEY=...                    # LLM: parse prompt, pick venues, interpret swaps
GOOGLE_PLACES_API_KEY=...           # venue search AND city/address geocoding (Places API — New)
GOOGLE_ROUTES_API_KEY=...           # transit / walk legs (Routes API)
GOOGLE_WEATHER_API_KEY=...          # hourly forecast (Weather API)
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=... # browser map tiles (Maps JavaScript API)
```

Where to get them:

- **Groq** — free key at <https://console.groq.com> (uses `llama-3.3-70b-versatile`).
- **The four Google keys** — [Google Cloud Console](https://console.cloud.google.com) →
  enable **Places API (New)**, **Routes API**, **Weather API**, and **Maps JavaScript API**,
  then create keys under *APIs & Services → Credentials*. One key can serve all four, or use
  separate keys — the variable names above are what the code reads. There is **no Geocoding
  API key**: `/api/geocode` reuses the Places key via Text Search.
- **Maps key referrer restriction** — the Maps key is the only one exposed to the browser.
  Restrict it (Cloud Console → the key → *Application restrictions → Websites*) to
  `http://localhost:3000/*` for local use.

`.env` is gitignored, so your keys are never committed.

**Run:**

```bash
npm run dev      # → http://localhost:3000
```

### Other environment variables the code reads

Not needed for local dev — listed so the full set is in one place.

| Variable | Read by | Purpose |
| --- | --- | --- |
| `KV_REST_API_URL` + `KV_REST_API_TOKEN` | `app/api/itinerary/store.ts` | Redis REST endpoint (Vercel KV / Upstash). **Set → Redis is the single source of truth for stored plans; unset → an in-memory Map.** Required in production: on serverless each request can land on a different instance, so an in-memory plan would 404 between the POST that stores it and the GET that reads it. |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | `app/api/itinerary/store.ts` | Accepted as aliases for the pair above. |
| `VERCEL` | `app/api/itinerary/store.ts` | Set by the platform. On Vercel **without** KV configured, the store refuses loudly instead of serving silent 404s. |
| `E2E_MOCK` | `app/api/_mock/fixtures.ts` | `=1` swaps the pipeline's **data sources** (Groq, Places, Routes, Weather, geocode) for deterministic fixtures. Playwright sets it on its own server; never set it for real use. |
| `TZ` | `app/api/places/search/route.ts` (log line only) | Printed in the `[schedule-resolve]` server log. Scheduling is per-plan zone-aware and no longer driven by server `TZ` — see the caveat in `CLAUDE.md`. |

Full deployment instructions (Vercel + Upstash, the env table, the Maps referrer
restriction) live in **`DEPLOY.md`**.

---

## Tests (optional)

Run from `itinerary/`.

**End-to-end (Playwright):**

```bash
npm run test:e2e          # mock mode (default) — Playwright's own server on :3100
npm run test:e2e:headed   # same, with a visible browser
npm run test:e2e:live     # run against a live dev server on :3000 (start `npm run dev` first)
```

Mock mode burns no API quota and never touches a server on :3000. The objective filter,
scheduling, floor guards, and both the swap and reroute engines run **for real** over fixture
data — only the data sources are swapped. `e2e/README.md` documents every fixture, including
which venue names and prompts trigger which scenario.

**Unit tests** are standalone files run directly with `tsx` (no aggregate script) — run any
suite by path:

```bash
npx tsx app/api/itinerary/swap.test.ts        # per-stop swap engine
npx tsx app/api/itinerary/reroute.test.ts     # reroute / self-healing
npx tsx app/lib/planGuards.test.ts            # bad-input handling
npx tsx app/lib/zoneTime.test.ts              # per-plan timezone math
```

Every `*.test.ts` file under `app/` runs the same way.

---

## Known limitations

Deliberate scope choices, not bugs. `CLAUDE.md` keeps the authoritative list ("Open gaps");
this is the short version.

- **One city per plan.** City and starting address are plain query inputs — there's no
  geolocation, and a prompt that spans two cities is planned in the city you entered.
- **No reservations or real-time availability.** "Is it open" is opening-hours data only;
  there's no OpenTable/Resy check behind it.
- **Transit disruptions are simulated.** The reroute engine is real; the trigger is a dev
  button, because GTFS-realtime isn't wired up yet. There's no rideshare fallback.
- **Movie runtimes are a placeholder** (a 2-hour assumption) — real showtimes need an
  external source.
- **Rerouting and swaps skip the weather gate.** Only the initial plan checks the forecast.
- **Stops can't be reordered** by hand, and pick reasons are written before the schedule is
  computed, so a reason never refers to a stop's final time.
- **The dev `?now=` time picker reads your browser's zone**, so simulating time on a
  non-local-zone plan is offset. It's a dev control only — the plan's own status logic is
  correct regardless.
