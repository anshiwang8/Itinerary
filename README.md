# Itinerary

**Turn “what should we do?” into a day out.**

Describe an outing in plain language. Itinerary finds venues, works out how to get between
them, and puts your stops and times on a map you can adjust as you go.

[Try Itinerary](https://itinerary-six.vercel.app/) · [Run locally](#local-development) ·
[Deployment guide](DEPLOY.md) · [Report an issue](https://github.com/anshiwang8/Itinerary/issues)

## Highlights

- **Plan from a sentence.** Ask for dinner and drinks, a quiet afternoon, or a few stops
  within a time window. Answer a few follow-up questions when more detail would help.
- **See the whole outing.** Venue cards, a map, and travel times bring the plan together,
  with a compact itinerary panel on mobile.
- **Make it fit your day.** Choose Transit or Drive, plan in your city's timezone, and
  start from an address, the city centre, or your current location.
- **Change your mind along the way.** Request a cheaper or closer venue, change an upcoming
  stop's time or duration, or remove it. The remaining schedule adjusts where possible.
- **Use it as a guest or make it personal.** Planning needs no account. Optional Google
  sign-in adds saved preferences and account history.

## Overview

Itinerary is a web app for planning outings within one city. It combines an AI planner
with Google venue, weather, and routing data to turn an idea into a sequence of places to
visit. If a location is ambiguous, a search comes back empty, or weather rules out an
activity, the app offers ways to refine the plan.

The AI proposes activities and venue choices; application code validates those choices,
checks available opening hours and other provider facts, calculates travel, and builds the
schedule. The app uses **Next.js, React, TypeScript, OpenRouter, Google Maps Platform,
Firebase Auth, Cloud Firestore, and optional Upstash Redis storage**.

Created by [Anshi Wang](https://github.com/anshiwang8).

## Try it

Open [the web app](https://itinerary-six.vercel.app/). No installation or API keys are
needed to use the hosted version.

1. **Choose your starting point.** Enter a city and an optional starting address. Leave
   the address blank to start from the city centre, or choose **Use current location**
   and allow the browser's location request.
2. **Describe your outing.** Select **Transit** or **Drive**, then try:

   > Dinner and drinks tomorrow at 7pm, somewhere relaxed and affordable.

3. **Build the plan.** Select **Plan it**, answer any follow-up questions, and explore
   the venue cards and routes on the map.
4. **Adjust an upcoming stop.** Open its details and try an edit:

| Request | What it changes |
| --- | --- |
| `somewhere cheaper` | Looks for a cheaper venue of the same kind; travel changes may adjust its time. |
| `find a closer one` | Looks for a venue closer to the preceding stop or starting point. |
| `an hour earlier` | Moves the stop and reschedules later stops where possible. |
| `stay 2 hours` | Changes the visit duration and adjusts what follows. |

You can also remove an upcoming stop or switch travel mode. Edits that cannot fit receive
an explanation; stops already underway or completed stay protected. Enable **Live location**
to show your position on the map while you travel. Location access is optional.

## Current boundaries

- Plans cover **one city and one outing**; multi-city trips and manual stop reordering
  are outside the current scope.
- Venue hours, prices, and route information depend on provider coverage. A venue with
  missing hours or price data can remain a candidate; the app does not book reservations
  or check table availability. Movie durations are estimates, without showtime integration.
- **Transit-disruption rerouting is a development demo.** The engine replans the affected
  portion of a trip, but automatic disruption monitoring is not connected. Local development
  exposes a simulator; production hides the simulator controls unless explicitly enabled.

## Local development

To work on the app or run your own copy, install **Node.js 22.12.0 or newer**, npm, and Git.
Real planning uses external services and requires your own API credentials.

### 1. Get the code

```bash
git clone https://github.com/anshiwang8/Itinerary.git
cd Itinerary
npm ci
```

### 2. Configure the services

Copy [`.env.example`](.env.example) to `.env` in the repository root. On macOS/Linux or
Git Bash, run `cp .env.example .env`; in PowerShell, run `Copy-Item .env.example .env`.
Fill in these six values:

| Variable | Service |
| --- | --- |
| `OPENROUTER_API_KEY` | AI planning, venue selection, and edit interpretation |
| `GOOGLE_PLACES_API_KEY` | Places API (New) |
| `GOOGLE_GEOCODING_API_KEY` | Geocoding API |
| `GOOGLE_ROUTES_API_KEY` | Routes API |
| `GOOGLE_WEATHER_API_KEY` | Weather API |
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | Maps JavaScript API |

Create an [OpenRouter key](https://openrouter.ai/keys) and enable the listed Google APIs
in [Google Cloud Console](https://console.cloud.google.com/), with billing configured as
required. Live planning consumes API quota and may incur charges.

Use a separately API-restricted server key for each Google service. Restrict the
browser-visible Maps key to your site's referrers, including `http://localhost:3000/*`
for development. Keep server credentials in the gitignored `.env` file.

### 3. Start the app

```bash
npm run dev
```

Open [localhost:3000](http://localhost:3000).

### Optional accounts and persistent storage

- **Google sign-in:** configure Firebase Authentication for Google and anonymous users,
  then fill in all six `NEXT_PUBLIC_FIREBASE_*` values in your `.env`. Verified
  ownership, active-plan resume, history, and personalization also require
  `FIREBASE_ADMIN_PROJECT_ID`, `FIREBASE_ADMIN_CLIENT_EMAIL`, and
  `FIREBASE_ADMIN_PRIVATE_KEY` from the same project. Enable Cloud Firestore for account
  history and preferences. Client configuration alone does not enable those server
  features. Account history and preferences require a non-anonymous sign-in.
- **Live-plan storage:** without Redis configuration, local plans use memory and disappear
  when the server restarts. Set `KV_REST_API_URL` and `KV_REST_API_TOKEN` for persistent
  Redis storage; `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are accepted
  aliases. Redis is required on Vercel; Firestore handles account history and preferences
  separately.

See [DEPLOY.md](DEPLOY.md) for Vercel setup, Firebase authorized domains, environment
variables, key restrictions, and deployment limitations.

### Run the checks

Install the browser used by the end-to-end tests once:

```bash
npx playwright install chromium
npm run check
```

`npm run check` runs lint, TypeScript checks, unit tests, a production build, and mock
Playwright tests. For a focused run:

| Command | Purpose |
| --- | --- |
| `npm run lint` | Check code style and lint rules. |
| `npm run typecheck` | Check TypeScript types. |
| `npm run test:unit` | Run all unit suites under `app/`. |
| `npm run test:e2e` | Run mock browser tests on port 3100. |
| `npm run test:e2e:headed` | Run the same tests in a visible browser. |
| `npm run build` | Create a production build. |
| `npm run start` | Serve that production build. |

Mock browser tests replace external data sources with fixtures while exercising the real
filtering, scheduling, and edit logic. They do not consume Google or OpenRouter quota.
See the [E2E guide](e2e/README.md) for fixtures and live tests; live tests use real APIs.

## Feedback and contributing

Found a bug or have an idea? [Open an issue](https://github.com/anshiwang8/Itinerary/issues).
For planning problems, include the prompt, city, expected result, and what happened.

Code fixes, documentation improvements, and reproducible bug reports are welcome. Before
changing behavior, read [CLAUDE.md](CLAUDE.md), the canonical architecture and contributor
rules. Run `npm run check` for changes and record them in [DEVLOG.md](DEVLOG.md).

Useful starting points:

- [Deployment and configuration](DEPLOY.md)
- [Architecture and project rules](CLAUDE.md)
- [Browser tests and fixtures](e2e/README.md)
- [Development history](DEVLOG.md)

## License

No license file is currently included in this repository.
