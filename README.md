# Itinerary — a hyperlocal AI day-planner

Describe an evening in plain language and get **one executable plan** — real venues, real
times, real transit — laid out on a map. Tap any stop to swap it ("somewhere cheaper", "an
hour earlier", "stay 2 hours"), and when a transit leg is cancelled the plan **reroutes and
heals itself**, keeping the stops you've already reached unchanged. It's scoped to **one
neighbourhood — Ossington, Toronto — by design** (venue search is anchored there), so every
prompt is planned in and around Ossington even though the UI no longer says so.

---

## Try it — live

### 👉 **https://itinerary-six.vercel.app/**

Open it and use the full app immediately — real Toronto venues, real transit, every feature.
No install, no keys, nothing to set up. **This is the main way to use it.**

---

## How to use it

1. **Plan an evening.** Type something like **`dinner and drinks`** and hit *Plan it*. You get
   a plan on the map — venues, times, and the transit/walk leg between stops. The plan is live
   the moment it appears. (The **weather chip**, top-left, shows the current Ossington
   forecast.)

2. **Swap a stop.** Click a stop card in the top strip to open its inline prompt, then try:
   - `somewhere cheaper` — swaps in a cheaper venue and holds the time slot (watch `$$$` → `$$`).
   - `an hour earlier` — moves the stop and reflows everything after it.
   - `stay 2 hours` — changes how long you're there; later stops shift to fit.

3. **Watch it reroute and heal.** Open the **Dev** panel (bottom-right corner):
   - Pick a **leg** in the dropdown and hit **cancel** → that transit leg is "cancelled" and
     the app replans: earlier stops stay exactly as they were, only the affected stop and what
     follows get new venues/times (old time struck through → new time settles in green).
   - Optional: set the **time** control to a moment during your first stop → it turns
     chartreuse ("now") and locks, and you'll see a reroute keep it untouched while replanning
     only the tail.

---

## Run it locally (optional — requires API keys)

For real Toronto venues on your own machine. This calls paid/rate-limited APIs, so it needs
keys.

**Prerequisites:** Node.js **18.18+** (Next.js 14's requirement; the repo doesn't pin it —
`node --version` to check) and npm.

```bash
git clone <your-repo-url>
cd <repo>/itinerary
npm install
```

**Add your keys.** Copy the template and fill in all five values:

```bash
cp .env.example .env
```

```bash
# .env
GROQ_API_KEY=...                    # LLM: parse prompt, pick venues, interpret swaps
GOOGLE_PLACES_API_KEY=...           # venue search (Places API — New)
GOOGLE_ROUTES_API_KEY=...           # transit / walk legs (Routes API)
GOOGLE_WEATHER_API_KEY=...          # hourly forecast (Weather API)
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=... # browser map tiles (Maps JavaScript API)
```

Where to get them:

- **Groq** — free key at <https://console.groq.com> (uses `llama-3.3-70b-versatile`).
- **The four Google keys** — [Google Cloud Console](https://console.cloud.google.com) →
  enable **Places API (New)**, **Routes API**, **Weather API**, and **Maps JavaScript API**,
  then create keys under *APIs & Services → Credentials*. One key can serve all four, or use
  separate keys — the variable names above are what the code reads.
- **Maps key referrer restriction** — the Maps key is the only one exposed to the browser.
  Restrict it (Cloud Console → the key → *Application restrictions → Websites*) to
  `http://localhost:3000/*` for local use.

**Run:**

```bash
npm run dev      # → http://localhost:3000
```

`.env` is gitignored, so your keys are never committed.

---

## Tests (optional)

Run from `itinerary/`.

**End-to-end (Playwright):**

```bash
npm run test:e2e          # run the e2e suite, headless
npm run test:e2e:headed   # same, with a visible browser
npm run test:e2e:live     # run against a live dev server on :3000 (start `npm run dev` first)
```

**Unit tests** are standalone files run directly with `tsx` (no aggregate script) — run any
suite by path:

```bash
npx tsx app/api/itinerary/swap.test.ts        # per-stop swap engine
npx tsx app/api/itinerary/reroute.test.ts     # reroute / self-healing
npx tsx app/lib/planGuards.test.ts            # bad-input handling
```

Every `*.test.ts` file under `app/` runs the same way.
