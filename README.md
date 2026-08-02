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

   Calendar language is resolved in the plan city's timezone. Supported qualifiers are
   `today`, `tomorrow`, bare weekdays, `next <weekday>`, ISO dates such as `2026-08-15`,
   and named dates such as `August 15, 2026`, with or without a clock. A bare weekday means
   the nearest future occurrence: today when its requested clock is still ahead, otherwise
   the following week. `next Friday` is also the nearest future Friday, but when today is
   Friday it means the Friday one week later. Nonexistent DST wall times and fall-back
   overlaps have deterministic code-side policies (reject the gap; choose the earlier
   overlap). A current audit follow-up covers malformed raw date/clock syntax on the new
   planner path; see **Known limitations**.

   The planner treats a stated stop count as authoritative, and downstream selection keeps
   repeated slots distinct. A current audit follow-up is restoring a deterministic
   raw-prompt count check so a malformed model response cannot silently ignore that count.

4. **Swap a stop.** Click a stop card in the top strip to open its inline prompt, then try:
   - `somewhere cheaper` — swaps in a cheaper venue and holds the time slot (watch `$$$` → `$$`).
   - `an hour earlier` — moves the stop and reflows everything after it.
   - `stay 2 hours` — changes how long you're there; later stops shift to fit.
   - `find a closer one` — ranks by real distance from where you're coming from, and says so
     honestly if nothing is actually closer.

5. **Watch it reroute and heal.** In local development—or a demo build made with
   `NEXT_PUBLIC_ENABLE_DEV_CONTROLS=true`—open the **Dev** panel (bottom-right corner):
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
  - **A city or starting address has multiple matches** → choose the formatted address before
    any venue search runs; the planner never silently takes the provider's first result.
  - **A category came back empty** ("the only ramen nearby is permanently closed") → the
    honest reason, plus an offer to look further out or put something else in that slot.
  - **Weather blocks it** ("rain likely at 3pm") → *Still want it* skips only the weather
    check (hours, rating, price, and closures all still apply), *Something else* swaps that
    one stop.
- **A walk is only offered when a walk makes sense.** A short or genuinely-faster walk beats
  transit; a 75-minute walk is never presented over a comparable transit ride — unless transit
  there is effectively broken (walking at least twice as fast), which is exactly when you'd
  want to know. Hops under 250 m straight-line skip the transit request entirely. If Routes
  cannot price either mode, the planner shows an explicitly uncertain estimate (1.35× detour
  allowance plus a 20%, minimum-five-minute margin), draws no invented route line, and labels
  every real walking route with the required caution.
- **The map fails soft.** If Maps JavaScript cannot load or authenticate, the itinerary and
  deterministic fallback pins remain usable, with bounded retry/remount recovery; mock E2E
  proves that path without a real browser key.

### How the pipeline is divided

City/address geocode runs first, establishing the plan's IANA timezone. The LLM planner then
proposes the activity shape, questions, rough durations, and resolved intent. Code fetches
weather and Places data, applies objective filters, validates the model's venue IDs and hard
constraint evidence, computes Routes legs, and builds/checks the schedule against any stated
window. Model output is always validated; a correction is validated again before a
deterministic fallback. Planner, selection, and swap use separate ordered Groq model chains;
only 429 and provider-side 5xx failures advance a chain.

**Places request/cost boundary.** A normal named category uses one complete Text Search because
hours, status, rating, price, card copy, and structured constraint evidence are all consumed
before a safe choice exists. Late-night mode is bounded at two variants per distinct category;
the general pool uses five queries; public input is capped at eight categories, so one search
attempt makes at most 16 provider calls. Identical query+type work is shared only within that
attempt (for example, overlapping `bar` / `late night bar` work went from four calls to two).
Full Places payloads are deliberately not cached across attempts: provider policy restricts
storage of Places content, and opening hours must remain fresh. Splitting discovery from
selected-place enrichment would add a Details request without a fact-safe cheaper shortlist.

---

## Run it locally (optional — requires API keys)

For real venues on your own machine. This calls paid/rate-limited APIs, so it needs keys.

**Prerequisites:** Node.js **20.9+** (Next.js 16.2.11's declared minimum) and npm. The current
application uses React / React DOM 19.2.8.

```bash
git clone <your-repo-url>
cd <repo-name>
npm ci
```

**Add the required service keys.** Copy the template and fill in these six values:

```bash
cp .env.example .env
```

```bash
# .env
GROQ_API_KEY=...                    # LLM: parse prompt, pick venues, interpret swaps
GOOGLE_PLACES_API_KEY=...           # venue search (Places API — New)
GOOGLE_GEOCODING_API_KEY=...        # city/address resolution (Geocoding API)
GOOGLE_ROUTES_API_KEY=...           # transit / walk legs (Routes API)
GOOGLE_WEATHER_API_KEY=...          # hourly forecast (Weather API)
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=... # browser map tiles (Maps JavaScript API)
```

Where to get them:

- **Groq** — free key at <https://console.groq.com>. Planner and selection default to
  `llama-3.3-70b-versatile`; separate ordered fallback chains are defined in
  `app/api/_shared/models.ts` and can be overridden per call type in deployment.
- **The five Google keys** — [Google Cloud Console](https://console.cloud.google.com) →
  enable **Places API (New)**, **Geocoding API**, **Routes API**, **Weather API**, and
  **Maps JavaScript API**, then create keys under *APIs & Services → Credentials*. The code
  reads a dedicated `GOOGLE_GEOCODING_API_KEY`; in production, use a separately
  API-restricted server key for each Google service.
- **Maps key referrer restriction** — the Maps key is a browser-visible service credential.
  Restrict it (Cloud Console → the key → *Application restrictions → Websites*) to
  `http://localhost:3000/*` for local use.

**Optional Google sign-in (Stage 1A).** Sign-in is not required and never gates the app. To
enable it, add all six Firebase Web config values below; partial or missing configuration
degrades to “sign-in unavailable” while guest planning keeps working. These are client config
by design, not server secrets:

```bash
NEXT_PUBLIC_FIREBASE_API_KEY=...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=...
NEXT_PUBLIC_FIREBASE_PROJECT_ID=...
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=...
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=...
NEXT_PUBLIC_FIREBASE_APP_ID=...
```

Stage 1A captures client auth state only. Current `main` has no server-side token verification,
owner-only itinerary mutation, account history/archive, or sharing contract.

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
| `NEXT_PUBLIC_ENABLE_DEV_CONTROLS` | `app/page.tsx` | Optional build-time flag. Production hides the time/disruption simulator unless this is exactly `true`; local development keeps it available. Rebuild after changing it. |
| `GROQ_MODELS_PLANNER` / `GROQ_MODELS_SELECT` / `GROQ_MODELS_SWAP` | `app/api/_shared/models.ts` | Optional comma-separated per-call model-chain overrides. Blank/unset uses the validated in-code defaults. |
| `NEXT_PUBLIC_FIREBASE_*` (six values above) | `app/lib/firebase.ts` | Optional Firebase Web configuration for client-only Google sign-in. All six are required to enable it; they do not add server authorization. |
| `E2E_MOCK` | `app/api/_mock/fixtures.ts` | `=1` swaps the pipeline's **data sources** (Groq, Places, Routes, Weather, geocode) for deterministic fixtures. Playwright sets it on its own server; never set it for real use. |
| `TZ` | Runtime compatibility / logs | Optional. Scheduling, hours checks, status math, and display are per-plan zone-aware and do not depend on the server wall clock. |

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
data — only the data sources are swapped. Non-local browser traffic is aborted, and the
fixture seams prevent Groq/Google provider calls. `e2e/README.md` documents every fixture, including
which venue names and prompts trigger which scenario.

**Project checks:**

```bash
npm run lint
npm run typecheck
npm run test:unit       # aggregate runner: every app/**/*.test.ts suite
npm run build
npm run check           # lint → typecheck → unit → build → mock E2E
```

Run an individual unit suite directly with `tsx` when investigating a focused behavior:

```bash
npx tsx app/api/itinerary/swap.test.ts        # per-stop swap engine
npx tsx app/api/itinerary/reroute.test.ts     # reroute / self-healing
npx tsx app/lib/planGuards.test.ts            # bad-input handling
npx tsx app/lib/zoneTime.test.ts              # per-plan timezone math
```

The aggregate runner discovers every `*.test.ts` file under `app/`.

---

## Known limitations

Deliberate scope choices, not bugs. `CLAUDE.md` keeps the authoritative list ("Open gaps");
this is the short version.

- **One city per plan.** City and starting address are plain query inputs — there's no
  geolocation, and a prompt that spans two cities is planned in the city you entered.
- **No reservations or real-time availability.** "Is it open" is opening-hours data only;
  there's no OpenTable/Resy check behind it.
- **Transit disruptions are simulated.** The reroute engine is real; the trigger is a
  development control because GTFS-realtime isn't wired up yet. Production hides that
  control by default; set `NEXT_PUBLIC_ENABLE_DEV_CONTROLS=true` at build time only for
  an intentional demo deployment. There's no rideshare fallback.
- **Movie runtimes are a placeholder** (a 2-hour assumption) — real showtimes need an
  external source.
- **Authentication is login-only.** Guest and signed-in users currently have identical
  itinerary access. Server-side ownership, migration, sharing, deletion, and history/archive
  are unresolved Stage 1B product/security work.
- **Planner raw-fact guards need restoration.** The new planner path does not yet
  deterministically cross-check malformed raw date/clock syntax or a stated count against an
  otherwise-valid model response. The audit tracker records these as `H8/M3-F1` and `M1-F1`.
- **The source limiter is per process.** A public serverless deployment still needs a shared
  edge/Redis/platform limiter plus Groq/Google quota caps and billing alerts; see `DEPLOY.md`.
- **Stops can't be reordered** by hand, and pick reasons are written before the schedule is
  computed, so a reason never refers to a stop's final time.
- **The dev `?now=` time picker reads your browser's zone**, so simulating time on a
  non-local-zone plan is offset. It's a dev control only — the plan's own status logic is
  correct regardless.
