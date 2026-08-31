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

Timezone handling is now per plan. Geocoding resolves an IANA zone and the
shared `zoneTime.ts` layer owns scheduling, opening-hours checks, status
math, and display labels. Vercel's UTC wall clock does not drive those
results. `TZ=America/Toronto` may remain as an optional compatibility/logging
default, but it is not a correctness requirement for multi-city scheduling.

Build with Node.js **22.12.0 or newer**, matching this repository's
`engines.node` requirement. The current runtime is React / React DOM 19.2.8.

## Environment variables (Vercel → Project → Settings → Environment Variables)

| Variable | Value / purpose |
| --- | --- |
| `OPENROUTER_API_KEY` | OpenRouter (parse / select / swap interpret) — server-side only. The endpoint itself is hardcoded in `app/api/_shared/openrouter.ts`; there is deliberately no base-URL env var. |
| `OPENROUTER_MODELS_PLANNER` | OPTIONAL. Comma-separated planner chain, tried in order on 429/provider 5xx. Unset = the in-code default. |
| `OPENROUTER_MODELS_SELECT` | OPTIONAL. Same, for venue selection (used by /api/select, reroute and swap's replacement search). |
| `OPENROUTER_MODELS_SWAP` | OPTIONAL. Same, for swap-intent classification — deliberately a smaller primary, since swap is a label job with deterministic parsers under it. |
| `GOOGLE_PLACES_API_KEY` | Places Text Search (venue search) — server-side only |
| `GOOGLE_GEOCODING_API_KEY` | Geocoding API (typed city and starting-address resolution) — server-side only |
| `GOOGLE_ROUTES_API_KEY` | Routes computeRoutes — server-side only |
| `GOOGLE_WEATHER_API_KEY` | Weather hourly forecast — server-side only |
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | Maps JS (browser-side by design — see referrer note) |
| `NEXT_PUBLIC_FIREBASE_API_KEY` | OPTIONAL public Firebase Web config for Google sign-in and anonymous guest identity; all six Web values are required together |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | OPTIONAL Firebase Web config |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | OPTIONAL Firebase Web config |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | OPTIONAL Firebase Web config |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | OPTIONAL Firebase Web config |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | OPTIONAL Firebase Web config |
| `NEXT_PUBLIC_ENABLE_DEV_CONTROLS` | Optional build-time public flag. Leave unset/`false` to hide time travel and disruption simulation in production; set exactly `true` only for an intentional demo, then rebuild. |
| `TZ` | Optional compatibility/logging default; scheduling correctness does not depend on it |
| `KV_REST_API_URL` + `KV_REST_API_TOKEN` | injected automatically when you connect Upstash Redis / Vercel KV storage (the `UPSTASH_REDIS_REST_URL`/`_TOKEN` names work too) |

**Firebase Admin — server-side secrets, separate from the public Web config above.**
Set all three from the same Firebase project's service-account JSON when enabling
ownership, resume, history, and personalization. Never expose them to the browser
or prefix them with `NEXT_PUBLIC_`.

| Variable | Value / purpose |
| --- | --- |
| `FIREBASE_ADMIN_PROJECT_ID` | SERVER-SIDE SECRET configuration: service-account `project_id` |
| `FIREBASE_ADMIN_CLIENT_EMAIL` | SERVER-SIDE SECRET configuration: service-account `client_email` |
| `FIREBASE_ADMIN_PRIVATE_KEY` | SERVER-SIDE SECRET: service-account `private_key` PEM; real newlines or literal `\n` escapes are supported |

Missing Admin credentials do not stop guest planning or client sign-in. They make
server verification unavailable, so callers are treated as unauthenticated and
ownership/resume/history/personalization do not work. There is no user-facing
configuration error; verify these server features as well as the sign-in UI.

The three `OPENROUTER_MODELS_*` vars allow a chain to change without a build.
Blank or unset falls back to the in-code defaults. Only upstream 429 and
provider 5xx failures advance the chain; auth/config/client errors fail
immediately. Planner/select exhaustion returns a stable capacity response;
swap falls back to its deterministic local parsers. Verify every override
against `GET https://openrouter.ai/api/v1/models` and the real JSON contract
before deployment — and confirm the model has a serving endpoint supporting
`response_format`, because every request is sent with
`provider.require_parameters: true` and a model whose endpoints cannot hold
the contract is skipped rather than left to answer in prose.

Routing is also sorted by THROUGHPUT under a price ceiling
(`provider.sort: "throughput"` + `max_price`, both in `openrouter.ts`), because
OpenRouter's default is price-weighted and was observed serving the planner at
single-digit tokens/sec — slow enough to miss the browser's own deadline. Two
consequences for an operator. First, a chain override needs at least one
serving endpoint that is both `response_format`-capable AND under the ceiling
(5 USD/M prompt, 10 USD/M completion); check
`GET https://openrouter.ai/api/v1/models/{id}/endpoints`, which reports price
PER ENDPOINT — the per-model figure is a blend and will understate it. Second,
fastest is not cheapest: expect a modest per-call cost increase versus the
price-sorted default, which is the trade being made deliberately.

Browser-visible configuration consists of the Maps JS key, the six optional
Firebase Web values, and the optional development-control flag. Firebase Web
values are client configuration by design; protect sign-in through Firebase
authorized domains and Auth rules, not key secrecy. All OpenRouter and Google
server-service credentials and all Firebase Admin credentials remain server-only.
Never put `NEXT_PUBLIC_` on a server credential.

**Maps key referrer restriction (do this or the map breaks / the key leaks):**
Google Cloud Console → APIs & Services → Credentials → the Maps JS key →
Application restrictions → Websites: add your deployed domain, e.g.
`https://<project>.vercel.app/*` (add `https://*.vercel.app/*` only if you
also want preview deployments to work — it's broader). Keep your
`http://localhost:3000/*` entry for dev. The server-side keys should stay
API-restricted to their one service each (existing policy).

If Firebase sign-in is enabled, add the production and intended preview hosts
to Firebase Authentication's authorized domains. Missing or partial Firebase
configuration must be verified to degrade to guest mode, not a failed app.

## Current pipeline and auth boundary

The production order is geocode → LLM planner → optional one-round questions
→ weather → Places search/filter → validated LLM venue selection → Routes →
deterministic scheduling/window validation → map. Geocoding must run first so
the planner receives the correct timezone-aware current instant. Model output
proposes semantics and bounded estimates; code owns IDs, hours, prices,
coordinates, travel, arithmetic, window fit, hard-constraint evidence, and
persistence.

Optional Google sign-in coexists with anonymous guest identity and guest planning.
Server token verification, itinerary ownership, active-plan resume, account
history/archive, and profile-based personalization are implemented. History and
personalization require a verified non-anonymous account. `/end` verifies the
caller and enforces ownership.

Authorization remains **partial**: the by-id `GET` and `/swap`, `/remove`, `/mode`,
and `/reroute` do **no caller verification**; possession of an itinerary ID is
enough to read or mutate that plan. Do not rely on complete owner-only access.
The broader authorization/sharing contract remains an unresolved product decision.

## Provider call envelope

- Places Text Search deliberately keeps one complete field mask, including
  Enterprise + Atmosphere fields: deterministic hours/status/rating/price
  filters, stop-card copy, and structured hard-constraint evidence all need
  those facts before selection. A normal category costs one call, late-night
  mode at most two calls per distinct category, the general pool five, and a
  public request at most 16. Request-local identical query+type work is
  deduplicated; separate attempts always refetch current hours.
- Do not add a cross-request cache of full Places payloads. Current Places
  policy generally prohibits storing that content beyond documented
  exceptions, and stale opening hours would make the plan factually unsafe.
  Place IDs remain the safe long-lived identifier.
- Geocoding uses one typed city request plus one optional address request.
  Ambiguous matches pause before Places search and resume from the selected
  candidate without repeating that geocode.
- Routes normally requests transit and walking once per leg. A defensibly
  short hop (under 250 m straight-line) requests walking only.

## Deploy steps

The application is at the repository root.

1. Commit + push. `.env` is gitignored (`git check-ignore .env`
   confirms) — `git status` must never list it. Never commit `.env`.
2. vercel.com → **Add New… → Project** → import the GitHub repo.
3. Leave **Root Directory** at the repository root (Framework Preset detects Next.js).
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
3. On an intentional demo build with
   `NEXT_PUBLIC_ENABLE_DEV_CONTROLS=true`, use the bottom-corner strip to set
   `time` to mid-dinner → the stop shows **now** (status + lock ratchet
   persisted).
4. In that same demo build, `cancel` the leg → "…cancelled. Replanned from …"
   reflow.
5. Fail-loud sanity: plan `brunch at 3am` → the honest message, not an
   empty map.
6. Wait ~10 minutes (functions go cold), then swap or time-travel the SAME
   itinerary again — still works ⇒ persistence is real.

Any `No itinerary with id …` 404 during this = the KV store isn't
connected; a missing-KV deploy fails loudly at plan time with a message
pointing at this file.

Authentication smoke checks are separate from itinerary persistence: verify
the app remains fully usable with all Firebase values absent; when all six
are present, verify Google sign-in/sign-out and the production authorized
domain. Do not infer owner enforcement from a successful login—current main
does not implement it.

Notes: production omits the dev strip by default. Enabling it is a public
build-time choice and requires a rebuild/redeploy; leave it off for ordinary
deployments. Usage still spends OpenRouter / Google quota, so keep provider quota
caps and alerts configured.

## Security and quota go-live checklist

The source tree now rejects oversized/invalid requests and applies a
per-instance burst limit before provider or Redis work. Serverless instances
do not share memory, so that layer is defense in depth, not the production
global quota. Complete every external item below before treating a public
deployment as abuse-resistant:

- [ ] Keep the browser key restricted by HTTP referrer to the exact
  production and intended preview origins; restrict it to Maps JavaScript
  API only.
- [ ] If Firebase sign-in is enabled, restrict its authorized domains to the
  intended production/preview hosts and verify guest mode with config absent.
  Also verify the three Admin credentials and the server identity features.
  Authorization remains partial: `/end` enforces ownership, while most by-id
  reads and mutations still accept the itinerary ID alone (see the boundary above).
- [ ] Use separate server-side keys for Places, Routes, Weather, and
  Geocoding when that endpoint is enabled; API-restrict each key to its one
  service and never expose it through `NEXT_PUBLIC_`.
- [ ] Set OpenRouter credit/spend limits and alerts appropriate to the public
  plan/selection/refinement endpoints.
- [ ] Set Google per-API quotas, daily budget alerts, and hard caps where
  supported.
- [ ] Put a shared edge or Redis-backed limiter in front of the API routes.
  Give it a dedicated Redis namespace and least-privilege token; do not mix
  rate-limit keys with `itin:*` records.
- [ ] Restrict the itinerary-store Upstash token to the intended database,
  require its HTTPS/REST endpoint, and rotate it independently from any
  rate-limit token.
- [ ] Keep Production, Preview, and Development environment values separate
  in Vercel; do not copy production secrets into preview deployments unless
  preview access is intentionally trusted.
- [ ] Configure production log retention and access controls. Alerts may use
  correlation IDs and structured error codes only; do not ingest prompts,
  refinements, model output, upstream bodies, keys, tokens, home labels, or
  environment values.
- [ ] Roll out a Content-Security-Policy in report-only mode first, including
  only the Maps origins actually required, then enforce after reviewing
  violations. Keep the existing framework security headers in the same
  review.
- [ ] Configure a bot challenge or managed WAF rule for sustained automated
  traffic. Exempt ordinary short bursts from shared networks and verify the
  `429`/`Retry-After` path remains reachable.
- [ ] After deployment, send controlled oversized and over-limit requests
  and confirm provider dashboards show zero corresponding OpenRouter/Google calls.
