# Deploying Itinerary to Vercel

## The serverless store problem (real, and fixed)

The itinerary store was an in-memory Map on `globalThis`. **That breaks on
Vercel**: every `ƒ` API route in the build output deploys as its own
serverless function, so the `POST /api/itinerary` that stores a plan and
the `GET` / `swap` / `reroute` that read it never share memory — the
Start → swap → reroute flow would 404 on the first read.

Fix (already in the code, a seam like the mock layer): routes go through
`loadItinerary` / `saveItinerary` in `store.ts`. With the KV env vars set
they read/write **Upstash Redis over REST** (plain fetch, no new
dependency, 7-day TTL, Redis is the single source of truth). Without
them, they collapse to the old in-memory Map — local dev and mock e2e are
byte-identical to before. On Vercel **without** KV configured the store
refuses loudly with a message pointing here, instead of silent 404s
mid-demo. The engines (swap/reroute) never touch the store and are
unchanged.

A second serverless gotcha: Vercel functions run in **UTC**, and some date
math still reads the server's clock. Set `TZ` (below).

**The reason for this changed — read it before you decide to drop it.** The
original rationale was that the scheduler did server-local date math. That
is no longer true: since Phase 5 every plan carries its own IANA timezone
and `schedule.ts` computes against *that*, so the headline scheduling path
genuinely does not care what `TZ` says. The conclusion still holds anyway,
for a narrower reason found in the 2026-07-18 audit (§1.1/§1.6): the swap
engine's availability check and `buildSchedule`'s cursor arithmetic both
read the server's wall clock. Group A of the audit fixes closed both, but
`TZ=America/Toronto` remains cheap insurance against the next such leak,
and the `[schedule-resolve]` log prints the server TZ on every plan so you
can confirm it. Don't remove it just because the *old* explanation is
stale.

## Environment variables (Vercel → Project → Settings → Environment Variables)

| Variable | Value / purpose |
| --- | --- |
| `GROQ_API_KEY` | Groq (parse / select / swap interpret) — server-side only |
| `GOOGLE_PLACES_API_KEY` | Places Text Search (venue search + `/api/geocode` city/address lookup — no separate Geocoding API key) — server-side only |
| `GOOGLE_ROUTES_API_KEY` | Routes computeRoutes — server-side only |
| `GOOGLE_WEATHER_API_KEY` | Weather hourly forecast — server-side only |
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | Maps JS (browser-side by design — see referrer note) |
| `TZ` | `America/Toronto` — recommended; see the note above for what it does and does NOT do now |
| `KV_REST_API_URL` + `KV_REST_API_TOKEN` | injected automatically when you connect Upstash Redis / Vercel KV storage (the `UPSTASH_REDIS_REST_URL`/`_TOKEN` names work too) |

Only the Maps key is ever exposed to the browser; your mentor never sees
the other four — they live inside the serverless functions. Never put
`NEXT_PUBLIC_` on anything else.

**Maps key referrer restriction (do this or the map breaks / the key leaks):**
Google Cloud Console → APIs & Services → Credentials → the Maps JS key →
Application restrictions → Websites: add your deployed domain, e.g.
`https://<project>.vercel.app/*` (add `https://*.vercel.app/*` only if you
also want preview deployments to work — it's broader). Keep your
`http://localhost:3000/*` entry for dev. The server-side keys should stay
API-restricted to their one service each (existing policy).

## Deploy steps

The app lives in the `itinerary/` subfolder of the repo and is currently
**uncommitted** — commit it first.

1. Commit + push. `.env` is gitignored (`git check-ignore itinerary/.env`
   confirms) — `git status` must never list it. Never commit `.env`.
2. vercel.com → **Add New… → Project** → import the GitHub repo.
3. **Root Directory: `itinerary`** (Framework Preset auto-detects Next.js).
4. Add the env vars from the table (Production; add Preview too if you
   want preview URLs to work).
5. Project → **Storage** → Create/connect **Upstash Redis** (free tier) —
   this injects the KV env vars. Redeploy if it was added after the first
   build.
6. Deploy, then run the verification checklist below **before sharing the
   URL**.

## Verify the stateful flows on the live URL

Each step crosses serverless functions, so together they prove the KV
store — not warm-instance luck:

1. Plan `dinner and drinks in Ossington` → strip + map render (create →
   read already spans two functions).
2. Click the dinner card → swap `cheaper` → banner + venue/price change.
3. Dev strip (bottom corner) → set `time` to mid-dinner → the stop shows
   **now** (status + lock ratchet persisted).
4. `cancel` the leg → "…cancelled. Replanned from …" reflow.
5. Fail-loud sanity: plan `brunch at 3am` → the honest message, not an
   empty map.
6. Wait ~10 minutes (functions go cold), then swap or time-travel the SAME
   itinerary again — still works ⇒ persistence is real.

Any `No itinerary with id …` 404 during this = the KV store isn't
connected; a missing-KV deploy fails loudly at plan time with a message
pointing at this file.

Notes: the dev strip (time sim + disruption trigger) ships in the UI on
purpose — it's the demo control. Your mentor's usage spends your Groq /
Google quota; both have free tiers, but set Google Cloud quota caps if
you're worried.
