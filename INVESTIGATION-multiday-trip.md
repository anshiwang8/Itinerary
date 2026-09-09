# Multi-day International Trip Investigation

## 0. FULL REPO INVENTORY

**VERDICT — `app/lib` contains shared/client utilities for validation, time, auth, recovery, display, and live tracking plus the explicitly server-only Firebase Admin helper; `app/api` is the complete server boundary for mock data, provider calls, planning/search/select/schedule, account records, and active-itinerary mutations; the dependency set contains used timezone support but no hotel, FX-conversion, or i18n library.** (`app/lib/zoneTime.ts:1-16`, `app/lib/firebaseAdmin.ts:1-24`, `app/api/_shared/provider.ts:3-34`, `package.json:20-44`)

### Source authority and applicable prior lessons

- `CLAUDE.md` is canonical because `AGENTS.md` is a hand-maintained near-duplicate that has demonstrably drifted; `HANDOFF.md` separately says current code wins over handoff prose where they disagree. (`AGENTS.md:3-8`, `HANDOFF.md:3-6`)
- The product is presently an anonymous-first hyperlocal day planner built with Next, OpenRouter, Google services, and optional Firebase sign-in. (`CLAUDE.md:5-6`)
- The governing architecture rule assigns semantic proposal to the LLM and every checkable fact—hours, prices, ratings, distance, travel time, and scheduling—to code/provider validation. (`CLAUDE.md:8-11`)
- The planner's model fallback remains safe only while the validation/correction/deterministic-fallback ladders remain intact; the canonical migration note explicitly forbids weakening validation for a weaker fallback model. (`CLAUDE.md:14-27`)
- Geocoding precedes planning because the parser must resolve relative time against the selected location's clock, and code supplies clarification guarantees the model can omit. (`CLAUDE.md:29-39`)
- Replanning engines reuse the same search/select pipeline cores instead of forking parallel fact logic. (`CLAUDE.md:75-76`)
- Active persistence is accessed through store seams, uses Redis as source of truth when configured, allows memory only for dev/e2e, and fails loudly on serverless without KV. (`CLAUDE.md:103`)
- A prior provider defect passed unit/build/mock checks because the stub asserted only one outgoing field against a canned 200; the recorded lesson is that provider legality depending on field combinations needs a rejecting strict responder and live evidence. (`CLAUDE.md:57`)
- The recent audit establishes current gates of 68 unit suites and 137 mock browser tests, with all three former clock exclusions resolved and only the documented 768 px mobile baseline exception. (`CLAUDE.md:108-116`, `DEVLOG.md:21`)
- Devlog entries are required to use a type label followed by Goal, What should be done, and What was done; this investigation makes no feature/fix change and therefore does not create a devlog entry. (`CLAUDE.md:120-121`)

### `app/lib` production files

- `activeTriangleCreep.ts` computes pure CSS-animation timing/fraction for an active stop's progress marker without a JavaScript ticker. (`app/lib/activeTriangleCreep.ts:1-24`)
- `allDayTime.ts` deterministically recognizes strong raw-prompt “all day” duration language before model output is trusted. (`app/lib/allDayTime.ts:1-21`)
- `arrivalDetection.ts` folds real distance/time samples into a session-local, display-only arrived state without mutating the itinerary. (`app/lib/arrivalDetection.ts:1-23`)
- `authUser.ts` defines the app-owned user shape, safely maps Firebase user payloads, distinguishes anonymous users, and supplies identity/label helpers. (`app/lib/authUser.ts:1-28`, `app/lib/authUser.ts:50-70`, `app/lib/authUser.ts:99-135`)
- `bannerDismiss.ts` owns the framework-free transient-banner delay/fade timer and cleanup controller. (`app/lib/bannerDismiss.ts:1-24`)
- `budget.ts` parses symbolic, relative, and numeric budgets and implements Places price caps plus cheaper/fancier ranking/search terms. (`app/lib/budget.ts:1-24`, `app/lib/budget.ts:56-137`)
- `cameraTween.ts` implements cancellable `requestAnimationFrame` camera interpolation with injected clock/frame dependencies. (`app/lib/cameraTween.ts:1-24`, `app/lib/cameraTween.ts:66-122`)
- `categoryTraits.ts` centralizes park-like and weather-exposed category classification used by search, duration, band, and weather behavior. (`app/lib/categoryTraits.ts:1-24`, `app/lib/categoryTraits.ts:29-42`)
- `clientFetch.ts` supplies the browser's uniform 25-second JSON-fetch deadline, typed transport errors, response parsing, and abort handling. (`app/lib/clientFetch.ts:1-23`, `app/lib/clientFetch.ts:83-177`)
- `clientPayloads.ts` is the browser-side parser and relational validator for geocode, parse, weather, Places, selections, travel, itinerary, and mutation payloads. (`app/lib/clientPayloads.ts:14-93`, `app/lib/clientPayloads.ts:232-337`, `app/lib/clientPayloads.ts:403-449`, `app/lib/clientPayloads.ts:631-997`)
- `constraints.ts` normalizes/deduplicates requested constraints, extracts evidence from provider place facts, and evaluates one/all constraints. (`app/lib/constraints.ts:3-15`, `app/lib/constraints.ts:26-98`)
- `devControls.ts` decides whether developer controls are visible from `NODE_ENV` and the explicit public override. (`app/lib/devControls.ts:1-10`)
- `firebase.ts` lazily initializes browser Firebase Auth only when all six public configuration values exist and degrades to `null` when unavailable. (`app/lib/firebase.ts:1-19`, `app/lib/firebase.ts:28-48`, `app/lib/firebase.ts:54-77`)
- `firebaseAdmin.ts` initializes the server-only named Admin app, verifies ID tokens, and exposes a fail-soft Firestore handle. (`app/lib/firebaseAdmin.ts:1-24`, `app/lib/firebaseAdmin.ts:37-85`, `app/lib/firebaseAdmin.ts:88-128`)
- `historyView.ts` validates the archived-plan projection and builds timezone-aware history list/detail labels without inventing absent fields. (`app/lib/historyView.ts:1-15`, `app/lib/historyView.ts:28-71`, `app/lib/historyView.ts:130-248`)
- `immediateTime.ts` deterministically recognizes strong raw-prompt immediacy phrases such as “right now,” “open now,” and “ASAP.” (`app/lib/immediateTime.ts:1-20`)
- `liveTracking.ts` contains the foreground-only geolocation state machine, visibility pause/resume, stale-fix heartbeat, and locked honest UI wording. (`app/lib/liveTracking.ts:1-18`, `app/lib/liveTracking.ts:21-45`, `app/lib/liveTracking.ts:68-164`, `app/lib/liveTracking.ts:233-596`)
- `locationLabels.ts` removes the UI's `Start ·`/`Home ·` origin prefixes while preserving the resolved address text. (`app/lib/locationLabels.ts:1-7`)
- `mapRoutePolicy.ts` maps only provider-backed transit, walk, or driving modes to drawable route modes and excludes unknown estimates. (`app/lib/mapRoutePolicy.ts:1-20`)
- `pendingWrite.ts` tracks a fire-and-forget profile write and lets the next dependent plan action await its settlement. (`app/lib/pendingWrite.ts:1-24`, `app/lib/pendingWrite.ts:28-52`)
- `planGuards.ts` is the deterministic fail-loud surface for degenerate, empty, contradictory, empty-pool, and unmet-constraint prompts. (`app/lib/planGuards.ts:1-16`, `app/lib/planGuards.ts:40-76`, `app/lib/planGuards.ts:128-389`)
- `planSlots.ts` enforces the eight-stop ceiling and resolves/normalizes requested stop counts into planner slots. (`app/lib/planSlots.ts:1-57`)
- `profileEdit.ts` parses profile loads/saves and computes editor seed/dirty state independently of React or Firestore. (`app/lib/profileEdit.ts:1-15`, `app/lib/profileEdit.ts:25-72`, `app/lib/profileEdit.ts:81-122`)
- `recoverySlots.ts` computes provisional/final recovery arrival times, row arrivals, used IDs, and merged place pools. (`app/lib/recoverySlots.ts:3-46`, `app/lib/recoverySlots.ts:83-159`)
- `retryableLoader.ts` creates a single-flight loader that shares concurrent work and permits a new attempt after failure. (`app/lib/retryableLoader.ts:1-16`)
- `sanitizeProse.ts` removes model-authored em/en dashes and known mojibake only from prose fields. (`app/lib/sanitizeProse.ts:1-18`, `app/lib/sanitizeProse.ts:28-64`)
- `tastePreferences.ts` defines the four-dimension onboarding survey, normalization, eligibility, and stored preference document contract. (`app/lib/tastePreferences.ts:1-20`, `app/lib/tastePreferences.ts:22-66`, `app/lib/tastePreferences.ts:304-544`)
- `timeLabels.ts` formats date-aware stop labels in the plan's IANA timezone and labels only the post-midnight portion of a crossing schedule with a date. (`app/lib/timeLabels.ts:1-19`, `app/lib/timeLabels.ts:24-88`)
- `transitBubbles.ts` supplies shared pure transit badge grouping, color, label, and inline badge/place splitting for map and strip. (`app/lib/transitBubbles.ts:1-24`, `app/lib/transitBubbles.ts:31-144`)
- `transitDetail.ts` constructs the display-only board/alight timeline and transfer points from provider facts without changing schedule duration. (`app/lib/transitDetail.ts:1-23`, `app/lib/transitDetail.ts:69-275`)
- `transitRidePalette.ts` exposes the fixed browser-safe 24-color occurrence palette and valid-slot lookup. (`app/lib/transitRidePalette.ts:1-31`)
- `travelLegVisibility.ts` owns exact-ID automatic/manual visibility, legacy detection, retention, and toggling for complete travel legs. (`app/lib/travelLegVisibility.ts:1-24`, `app/lib/travelLegVisibility.ts:27-110`)
- `tz-lookup.d.ts` supplies the missing TypeScript declaration for `tz-lookup`'s default `(lat,lng) -> IANA zone` export. (`app/lib/tz-lookup.d.ts:1-4`)
- `useAuth.ts` is the client hook for Firebase anonymous sessions, Google upgrade/sign-in, token refresh observation, sign-out, and fresh ID tokens. (`app/lib/useAuth.ts:1-46`, `app/lib/useAuth.ts:118-180`, `app/lib/useAuth.ts:209-323`)
- `useLiveTracking.ts` is the thin React binding that mirrors the pure live tracker and ties its lifetime to an `enabled` flag. (`app/lib/useLiveTracking.ts:1-24`, `app/lib/useLiveTracking.ts:28-57`)
- `youMarker.ts` derives whether and how a real/stale device fix renders and supplies live-control labels without interpolation. (`app/lib/youMarker.ts:1-24`, `app/lib/youMarker.ts:35-137`)
- `zoneTime.ts` is the sole client-safe Luxon wrapper for zone normalization, ISO rendering, wall-clock parts, next-full-hour, and DST-safe wall-clock instants. (`app/lib/zoneTime.ts:1-24`, `app/lib/zoneTime.ts:26-150`)

### `app/lib` test files

- `activeTriangleCreep.test.ts` pins active-progress timing at controlled instants. (`app/lib/activeTriangleCreep.test.ts:1-18`)
- `arrivalDetection.test.ts` pins the arrival reducer's radius/dwell/session-reset branches with injected samples. (`app/lib/arrivalDetection.test.ts:1-14`)
- `authUser.test.ts` pins provider-payload mapping, anonymous classification, identity comparison, labels, and initials. (`app/lib/authUser.test.ts:1-11`)
- `bannerDismiss.test.ts` pins dismiss/fade sequencing, cancellation, and stale-timer cleanup. (`app/lib/bannerDismiss.test.ts:1-16`)
- `budget.test.ts` pins budget parsing, Places-level caps, price direction, search terms, and ranking. (`app/lib/budget.test.ts:1-16`)
- `cameraTween.test.ts` pins interpolation/easing/cancel-and-redirect with fake frames and clock. (`app/lib/cameraTween.test.ts:1-13`)
- `clientFetch.test.ts` pins browser fetch success, validation, HTTP/body errors, timeout, and abort behavior. (`app/lib/clientFetch.test.ts:1-12`)
- `clientPayloads.test.ts` pins every browser wire parser, including relational travel identity and decorative-path rejection. (`app/lib/clientPayloads.test.ts:1-12`)
- `constraints.test.ts` pins constraint normalization, evidence, and all-constraint evaluation. (`app/lib/constraints.test.ts:1-12`)
- `devControls.test.ts` pins the environment/flag visibility matrix. (`app/lib/devControls.test.ts:1-12`)
- `emdashGuard.test.ts` scans non-test TypeScript/TSX sources and fails on unallowlisted user-facing em/en dashes. (`app/lib/emdashGuard.test.ts:1-24`)
- `historyView.test.ts` pins archive shape validation, limits, dates, timezone labels, and honest missing-field display. (`app/lib/historyView.test.ts:1-20`)
- `itineraryCompletion.test.ts` executes extracted page completion closures with injected transport/state sinks and server-rendered React. (`app/lib/itineraryCompletion.test.ts:1-18`)
- `liveTracking.test.ts` pins the geolocation state machine, exact-fix retention, staleness, visibility restart, errors, and cleanup. (`app/lib/liveTracking.test.ts:1-21`)
- `locationLabels.test.ts` pins removal of only the known origin-label prefixes. (`app/lib/locationLabels.test.ts:1-18`)
- `mapRoutePolicy.test.ts` pins drawable provider modes and unknown/non-route exclusions. (`app/lib/mapRoutePolicy.test.ts:1-19`)
- `pendingWrite.test.ts` pins ordering between an in-flight taste-profile save and the next plan request. (`app/lib/pendingWrite.test.ts:1-14`)
- `planGuards.test.ts` pins fail-loud messages and ordering for nonsense, contradictions, empty pools, and unmet constraints. (`app/lib/planGuards.test.ts:1-20`)
- `planSlots.test.ts` pins stop-count parsing, bounds, and normalized category slots. (`app/lib/planSlots.test.ts:1-22`)
- `profileEdit.test.ts` pins editor seeding, dirty-state comparison, and save-result parsing. (`app/lib/profileEdit.test.ts:1-22`)
- `recoverySlots.test.ts` pins provisional/final arrivals, row matching, dedupe IDs, and pool merging. (`app/lib/recoverySlots.test.ts:1-18`)
- `retryableLoader.test.ts` pins concurrent single-flight and post-failure retry behavior. (`app/lib/retryableLoader.test.ts:1-6`)
- `sanitizeProse.test.ts` pins prose dash/mojibake cleanup and list handling. (`app/lib/sanitizeProse.test.ts:1-7`)
- `tastePreferences.test.ts` pins survey eligibility, closed option sets, normalization, and Firestore-safe document shape. (`app/lib/tastePreferences.test.ts:1-22`)
- `timeLabels.test.ts` pins date/time labels independently of the test runner's timezone. (`app/lib/timeLabels.test.ts:1-18`)
- `transitBubbles.test.ts` pins grouping, labels, colors, and inline badge/place splitting. (`app/lib/transitBubbles.test.ts:1-15`)
- `transitDetail.test.ts` pins four-instant timelines, underway detection, and provider-backed transfer points. (`app/lib/transitDetail.test.ts:1-14`)
- `transitRidePalette.test.ts` pins the fixed palette and slot lookup independently of React/Maps. (`app/lib/transitRidePalette.test.ts:1-10`)
- `travelLegVisibility.test.ts` pins automatic priority, exact-ID manual visibility, retention, toggling, and legacy behavior. (`app/lib/travelLegVisibility.test.ts:1-19`)
- `youMarker.test.ts` pins real/stale/no-fix marker behavior and control labels with injected time. (`app/lib/youMarker.test.ts:1-13`)
- `zoneTime.test.ts` pins validation, DST-safe wall-clock operations, and runner-zone independence. (`app/lib/zoneTime.test.ts:1-16`)

### `app/api` directories and production files

- **`app/api/_mock/`** is the deterministic provider/data-source substitution boundary for mock execution. (`app/api/_mock/fixtures.ts:1-18`, `app/api/_mock/fixtures.ts:48-49`)
  - `fixtures.ts` implements mock parse, geocode, weather, Places, selection, travel, swap, reroute, removal, and mode data/dependencies while leaving application logic real. (`app/api/_mock/fixtures.ts:48-49`, `app/api/_mock/fixtures.ts:315-337`, `app/api/_mock/fixtures.ts:581-581`, `app/api/_mock/fixtures.ts:832-832`, `app/api/_mock/fixtures.ts:933-933`, `app/api/_mock/fixtures.ts:1045-1385`)
- **`app/api/_shared/`** contains the cross-route identity, HTTP, model-routing, provider, and schema boundary. (`app/api/_shared/caller.ts:1-11`, `app/api/_shared/http.ts:1-18`, `app/api/_shared/schemas.ts:1-18`)
  - `caller.ts` extracts a Bearer token and returns only Firebase-verified caller identity. (`app/api/_shared/caller.ts:1-21`, `app/api/_shared/caller.ts:26-62`)
  - `http.ts` defines body/text/cardinality caps, the process-local scoped/IP limiter, JSON request parsing, logging, and normalized API/provider errors. (`app/api/_shared/http.ts:1-18`, `app/api/_shared/http.ts:30-36`, `app/api/_shared/http.ts:53-123`, `app/api/_shared/http.ts:146-225`)
  - `modelFallback.ts` executes an ordered call-type model chain and advances only after retryable provider failures. (`app/api/_shared/modelFallback.ts:1-14`, `app/api/_shared/modelFallback.ts:23-23`, `app/api/_shared/modelFallback.ts:43-100`)
  - `models.ts` defines planner/select/swap call types, defaults, validated environment overrides, and chain selection. (`app/api/_shared/models.ts:1-21`, `app/api/_shared/models.ts:64-125`)
  - `openrouter.ts` defines the fixed OpenRouter endpoint and canonical JSON-mode/provider-routing request body. (`app/api/_shared/openrouter.ts:1-13`, `app/api/_shared/openrouter.ts:103-123`)
  - `provider.ts` supplies provider deadlines, abort/body-read handling, status/Retry-After preservation, and wrapped-error recognition. (`app/api/_shared/provider.ts:3-34`, `app/api/_shared/provider.ts:48-84`, `app/api/_shared/provider.ts:118-232`, `app/api/_shared/provider.ts:264-272`)
  - `schemas.ts` is the server-side untrusted-wire validator for route inputs and persisted itinerary/travel structures. (`app/api/_shared/schemas.ts:1-18`, `app/api/_shared/schemas.ts:59-80`, `app/api/_shared/schemas.ts:106-331`, `app/api/_shared/schemas.ts:397-397`, `app/api/_shared/schemas.ts:612-612`, `app/api/_shared/schemas.ts:751-815`)
- **`app/api/geocode/`** resolves city/address coordinates and timezone before planning. (`app/api/geocode/geocode.ts:29-74`, `app/api/geocode/route.ts:18-49`, `app/api/geocode/zoneLookup.ts:1-16`)
  - `geocode.ts` calls Google Geocoding and enforces locality typing, ambiguity, country/region, proximity, and full-address validity. (`app/api/geocode/geocode.ts:12-14`, `app/api/geocode/geocode.ts:59-128`, `app/api/geocode/geocode.ts:273-349`, `app/api/geocode/geocode.ts:481-639`)
  - `route.ts` is the rate-limited POST geocode handler and chooses mock or keyed real resolution. (`app/api/geocode/route.ts:18-49`)
  - `zoneLookup.ts` is the `server-only` offline coordinate-to-IANA lookup wrapper around `tz-lookup`. (`app/api/geocode/zoneLookup.ts:1-16`)
- **`app/api/history/`** exposes account-history reads. (`app/api/history/route.ts:6-50`)
  - `route.ts` returns a verified caller's archived Firestore plans and returns an empty list for anonymous/unverified callers. (`app/api/history/route.ts:16-50`)
- **`app/api/itinerary/`** owns active-plan persistence, lifecycle, ownership, history projection, and all mutation engines. (`app/api/itinerary/store.ts:1-2`, `app/api/itinerary/store.ts:121-438`, `app/api/itinerary/ownership.ts:1-20`, `app/api/itinerary/readLifecycle.ts:11-92`)
  - `byIdOwnership.ts` classifies by-ID access as allow, masked-not-found, or missing under legacy/owned-plan rules. (`app/api/itinerary/byIdOwnership.ts:1-28`, `app/api/itinerary/byIdOwnership.ts:41-55`)
  - `fallbackParsed.ts` reconstructs minimal parsed context for older/partial stored itineraries. (`app/api/itinerary/fallbackParsed.ts:1-27`)
  - `history.ts` archives and lists the Firestore completed-plan projection. (`app/api/itinerary/history.ts:1-13`, `app/api/itinerary/history.ts:24-35`, `app/api/itinerary/history.ts:51-137`)
  - `modeSwitch.ts` plans a travel-mode change through injected dependencies, then commits an accepted proposal by mutating the supplied itinerary. (`app/api/itinerary/modeSwitch.ts:1-20`, `app/api/itinerary/modeSwitch.ts:85-100`, `app/api/itinerary/modeSwitch.ts:237-239`, `app/api/itinerary/modeSwitch.ts:422-428`)
  - `ownership.ts` defines caller/owner decisions, active-pointer helpers, and archive projection. (`app/api/itinerary/ownership.ts:1-20`, `app/api/itinerary/ownership.ts:35-160`)
  - `readLifecycle.ts` derives and CAS-persists status/lock ratchets on GET, then handles conclusion by conditionally clearing the owner pointer, archiving eligible history, and best-effort persisting `archivedAt`. (`app/api/itinerary/readLifecycle.ts:11-60`, `app/api/itinerary/readLifecycle.ts:64-92`)
  - `removeStop.ts` runs atomic stop removal, direct-leg replacement, and tail resettlement. (`app/api/itinerary/removeStop.ts:1-17`, `app/api/itinerary/removeStop.ts:71-109`, `app/api/itinerary/removeStop.ts:154-154`, `app/api/itinerary/removeStop.ts:400-400`)
  - `reroute.ts` applies floor/anchor/blast-radius rerouting while reusing search/select cores. (`app/api/itinerary/reroute.ts:1-5`, `app/api/itinerary/reroute.ts:41-124`, `app/api/itinerary/reroute.ts:228-228`)
  - `route.ts` creates/stores a validated itinerary and gets the verified caller's current active itinerary. (`app/api/itinerary/route.ts:37-106`, `app/api/itinerary/route.ts:112-141`)
  - `stopPlan.ts` decides whether stops remain and which stop/date ends the plan. (`app/api/itinerary/stopPlan.ts:1-18`, `app/api/itinerary/stopPlan.ts:30-62`)
  - `store.ts` defines itinerary data types and implements in-memory/Upstash storage, owner pointers, TTL, Lua CAS, and atomic update retries. (`app/api/itinerary/store.ts:19-119`, `app/api/itinerary/store.ts:121-438`)
  - `swap.ts` implements model-assisted intent interpretation, deterministic time/duration parsing, venue/research swaps, tail resettlement, and atomic commit. (`app/api/itinerary/swap.ts:1-17`, `app/api/itinerary/swap.ts:58-189`, `app/api/itinerary/swap.ts:309-309`, `app/api/itinerary/swap.ts:457-457`, `app/api/itinerary/swap.ts:633-633`, `app/api/itinerary/swap.ts:1177-1910`)
- **`app/api/itinerary/[id]/`** is the by-plan read and mutation namespace. (`app/api/itinerary/[id]/route.ts:15-79`)
  - `[id]/route.ts` gets one itinerary, applies lifecycle status ratchets, and masks unauthorized owned records as 404 while retaining legacy capability-by-ID reads. (`app/api/itinerary/[id]/route.ts:15-33`, `app/api/itinerary/[id]/route.ts:46-79`)
- **`app/api/itinerary/[id]/end/`** contains the explicit plan-conclusion route. (`app/api/itinerary/[id]/end/route.ts:22-128`)
  - `end/route.ts` requires the verified owner, CAS-concludes/discards, archives when applicable, and clears the active pointer. (`app/api/itinerary/[id]/end/route.ts:22-40`, `app/api/itinerary/[id]/end/route.ts:53-128`)
- **`app/api/itinerary/[id]/mode/`** contains the travel-mode mutation route. (`app/api/itinerary/[id]/mode/route.ts:20-98`)
  - `mode/route.ts` authorizes, validates expected version/mode, invokes the mode engine, and CAS-saves accepted changes. (`app/api/itinerary/[id]/mode/route.ts:20-54`, `app/api/itinerary/[id]/mode/route.ts:67-98`)
- **`app/api/itinerary/[id]/remove/`** contains the stop-removal route. (`app/api/itinerary/[id]/remove/route.ts:17-99`)
  - `remove/route.ts` authorizes and CAS-applies the removal engine, leaving version/storage unchanged on refusal. (`app/api/itinerary/[id]/remove/route.ts:35-99`)
- **`app/api/itinerary/[id]/reroute/`** contains the disruption reroute route. (`app/api/itinerary/[id]/reroute/route.ts:19-84`)
  - `reroute/route.ts` validates time/version, loads the plan, invokes reroute dependencies, and CAS-saves the result. (`app/api/itinerary/[id]/reroute/route.ts:19-84`)
- **`app/api/itinerary/[id]/swap/`** contains the user-requested stop-change route. (`app/api/itinerary/[id]/swap/route.ts:21-104`)
  - `swap/route.ts` authorizes, validates refinement/version, invokes swap, and CAS-saves only a successful mutation. (`app/api/itinerary/[id]/swap/route.ts:21-35`, `app/api/itinerary/[id]/swap/route.ts:39-104`)
- **`app/api/parse/`** contains the AI planner and preference-to-prompt projection. (`app/api/parse/planner.ts:1-16`, `app/api/parse/plannerPreferences.ts:1-20`, `app/api/parse/route.ts:104-189`)
  - `planner.ts` defines planner prompt/schema coercion, semantic validation, clarification, and the deterministic time-resolution ladder. (`app/api/parse/planner.ts:37-49`, `app/api/parse/planner.ts:78-148`, `app/api/parse/planner.ts:276-276`, `app/api/parse/planner.ts:415-415`, `app/api/parse/planner.ts:741-1055`)
  - `plannerPreferences.ts` validates stored taste context and produces/merges the bounded planner preference projection. (`app/api/parse/plannerPreferences.ts:1-20`, `app/api/parse/plannerPreferences.ts:65-65`, `app/api/parse/plannerPreferences.ts:91-91`, `app/api/parse/plannerPreferences.ts:153-153`, `app/api/parse/plannerPreferences.ts:245-321`)
  - `route.ts` rate-limits, validates planner input, loads optional taste context, runs the OpenRouter model chain, and validates/caps JSON output. (`app/api/parse/route.ts:30-37`, `app/api/parse/route.ts:62-101`, `app/api/parse/route.ts:104-189`)
- **`app/api/places/`** is the namespace for venue discovery. (`app/api/places/search/route.ts:26-104`)
- **`app/api/places/search/`** contains provider search plus objective filtering and hours. (`app/api/places/search/searchPlaces.ts:1-20`, `app/api/places/search/filter.ts:1-18`, `app/api/places/search/hours.ts:1-13`)
  - `filter.ts` applies business-status, rating, price, hours, weather, and hard-constraint filters with drop reasons and keep-on-missing behavior. (`app/api/places/search/filter.ts:1-18`, `app/api/places/search/filter.ts:36-36`, `app/api/places/search/filter.ts:83-83`, `app/api/places/search/filter.ts:139-139`)
  - `hours.ts` parses provider opening periods and checks a venue at an absolute instant in the plan timezone. (`app/api/places/search/hours.ts:1-13`, `app/api/places/search/hours.ts:15-58`, `app/api/places/search/hours.ts:128-190`)
  - `route.ts` is the bounded rate-limited POST wrapper around the reusable search core. (`app/api/places/search/route.ts:26-104`)
  - `searchPlaces.ts` performs Google Places Text Search, bounded query expansion, request-local in-flight dedupe, and partial-failure aggregation. (`app/api/places/search/searchPlaces.ts:20-70`, `app/api/places/search/searchPlaces.ts:80-190`, `app/api/places/search/searchPlaces.ts:202-363`)
- **`app/api/profile/`** is the verified-user preference-record boundary. (`app/api/profile/profileStore.ts:1-17`, `app/api/profile/route.ts:15-105`)
  - `profileStore.ts` reads/writes the fixed Firestore taste-profile document. (`app/api/profile/profileStore.ts:26-32`, `app/api/profile/profileStore.ts:50-118`)
  - `route.ts` provides verified-user GET/POST profile operations and fail-soft anonymous/unavailable-store results. (`app/api/profile/route.ts:15-35`, `app/api/profile/route.ts:37-105`)
- **`app/api/schedule/`** owns code-derived duration, home, schedule, and travel facts. (`app/api/schedule/durations.ts:1-18`, `app/api/schedule/home.ts:1-22`, `app/api/schedule/schedule.ts:1-18`, `app/api/schedule/travel.ts:1-18`)
  - `durations.ts` maps categories to realistic activity and buffer minutes. (`app/api/schedule/durations.ts:1-18`, `app/api/schedule/durations.ts:25-59`)
  - `home.ts` defines the legacy Chestnut origin and resolves itinerary-specific home first. (`app/api/schedule/home.ts:1-22`, `app/api/schedule/home.ts:30-30`)
  - `schedule.ts` deterministically resolves a start, sequences stop/leg times, enforces time windows, and returns scheduled stops; `createItinerary` separately builds the persisted document. (`app/api/schedule/schedule.ts:1-18`, `app/api/schedule/schedule.ts:23-105`, `app/api/schedule/schedule.ts:438-652`, `app/api/itinerary/store.ts:463-503`)
  - `travel.ts` calls Google Routes, compares/relabels modes, validates facts/geometry, and assigns leg/ride/palette identity. (`app/api/schedule/travel.ts:1-18`, `app/api/schedule/travel.ts:23-177`, `app/api/schedule/travel.ts:398-398`, `app/api/schedule/travel.ts:604-604`, `app/api/schedule/travel.ts:672-672`, `app/api/schedule/travel.ts:764-764`, `app/api/schedule/travel.ts:822-1040`)
- **`app/api/schedule/travel/`** contains the HTTP travel-calculation boundary. (`app/api/schedule/travel/route.ts:21-63`)
  - `route.ts` validates/rate-limits a travel request and calls the mock or real reusable travel core. (`app/api/schedule/travel/route.ts:21-63`)
- **`app/api/select/`** contains AI venue selection over code-filtered candidates. (`app/api/select/route.ts:23-75`, `app/api/select/selectVenues.ts:1-18`)
  - `route.ts` validates/rate-limits candidate pools and invokes keyed selection. (`app/api/select/route.ts:23-75`)
  - `selectVenues.ts` enforces ID-only model choice, one invalid-ID correction, constraint failures, highest-rated fallback, reasons, and duration refinement. (`app/api/select/selectVenues.ts:47-170`, `app/api/select/selectVenues.ts:381-381`)
- **`app/api/weather/`** contains Google Weather access. (`app/api/weather/fetchWeather.ts:1-14`, `app/api/weather/route.ts:18-43`)
  - `fetchWeather.ts` is the fail-soft server helper used by the pipeline. (`app/api/weather/fetchWeather.ts:24-65`)
  - `route.ts` is the force-dynamic public GET proxy that validates coordinates and returns up to 24 hourly metric records. (`app/api/weather/route.ts:18-43`, `app/api/weather/route.ts:43-111`)

### `app/api` test files

- `_mock/fixtures.test.ts` pins fixture shape, determinism, and mock data-source contracts. (`app/api/_mock/fixtures.test.ts:1-18`)
- `_shared/http.test.ts` pins request parsing/bounds and shared HTTP error behavior. (`app/api/_shared/http.test.ts:1-17`)
- `_shared/modelFallback.test.ts` pins ordered fallback and retryability rules. (`app/api/_shared/modelFallback.test.ts:1-18`)
- `_shared/openrouter.test.ts` pins the canonical OpenRouter body for every model class. (`app/api/_shared/openrouter.test.ts:1-17`)
- `_shared/provider.test.ts` pins deadlines, statuses, Retry-After, wrapped errors, and response-body handling. (`app/api/_shared/provider.test.ts:1-17`)
- `_shared/schemas.test.ts` pins persisted/request wire validation and travel topology/fact checks. (`app/api/_shared/schemas.test.ts:1-12`)
- `geocode/geocode.test.ts` pins typed-city/address ambiguity and locality/proximity validation. (`app/api/geocode/geocode.test.ts:1-13`)
- `geocode/zoneLookup.test.ts` pins coordinate zones/fallbacks and the client import-graph isolation boundary. (`app/api/geocode/zoneLookup.test.ts:1-18`, `app/api/geocode/zoneLookup.test.ts:18-63`, `app/api/geocode/zoneLookup.test.ts:78-78`)
- `history/route.test.ts` pins anonymous history as an empty non-error response. (`app/api/history/route.test.ts:1-18`)
- `itinerary/create.validation.test.ts` pins create-handler validation and store round trips. (`app/api/itinerary/create.validation.test.ts:1-16`)
- `itinerary/driveModeEngines.test.ts` pins mutation engines to the itinerary's stored travel mode. (`app/api/itinerary/driveModeEngines.test.ts:1-17`)
- `itinerary/itinerary.test.ts` pins stop-status derivation and locked-stop ratcheting. (`app/api/itinerary/itinerary.test.ts:1-7`)
- `itinerary/lifecycle.routes.test.ts` pins handler-level lifecycle writes, archive/pointer behavior, and CAS. (`app/api/itinerary/lifecycle.routes.test.ts:1-18`)
- `itinerary/modeSwitch.test.ts` pins the mode-switch engine and its atomic/refusal paths. (`app/api/itinerary/modeSwitch.test.ts:1-18`)
- `itinerary/mutationAuth.routes.test.ts` pins mutation-route owner, stranger, anonymous, and legacy authorization outcomes. (`app/api/itinerary/mutationAuth.routes.test.ts:1-13`)
- `itinerary/ownership.test.ts` pins pure ownership, archive eligibility, and privacy decisions. (`app/api/itinerary/ownership.test.ts:1-18`)
- `itinerary/removeStop.test.ts` pins removal/reflow, open-time clamping, and refusal behavior. (`app/api/itinerary/removeStop.test.ts:1-12`)
- `itinerary/reroute.atomic.test.ts` pins failed reroutes leaving stored plans unchanged. (`app/api/itinerary/reroute.atomic.test.ts:1-7`)
- `itinerary/reroute.test.ts` pins floor time, blast radius, anchors, locks, and reused replan dependencies. (`app/api/itinerary/reroute.test.ts:1-9`)
- `itinerary/stopPlan.test.ts` pins plan-ending and remaining-stop decisions. (`app/api/itinerary/stopPlan.test.ts:1-12`)
- `itinerary/store.cas.test.ts` pins in-memory CAS/version conflict and owner-pointer behavior. (`app/api/itinerary/store.cas.test.ts:1-14`)
- `itinerary/store.kv.test.ts` pins Redis REST commands, key/TTL behavior, reads, and serverless fail-loud behavior. (`app/api/itinerary/store.kv.test.ts:1-15`)
- `itinerary/swap.atomic.test.ts` pins a rejected/failed swap's no-partial-write guarantee. (`app/api/itinerary/swap.atomic.test.ts:1-18`)
- `itinerary/swap.test.ts` pins parsing, intent, slot/duration preservation, venue replacement, resettlement, and guards. (`app/api/itinerary/swap.test.ts:1-18`)
- `itinerary/version.routes.test.ts` pins route ETags, expected-version CAS, and conflict responses. (`app/api/itinerary/version.routes.test.ts:1-17`)
- `parse/parse.test.ts` pins planner-route requests, output validation, correction, and fail-loud handling. (`app/api/parse/parse.test.ts:1-18`)
- `parse/planner.test.ts` pins planner coercion, semantic validation, clarification, and time behavior. (`app/api/parse/planner.test.ts:1-18`)
- `parse/plannerPreferences.test.ts` pins preference-context validation, prompt bounds, and merge behavior. (`app/api/parse/plannerPreferences.test.ts:1-18`)
- `places/search/filter.test.ts` pins objective filters, drop reasons, constraints, and keep-on-missing. (`app/api/places/search/filter.test.ts:1-14`)
- `places/search/hours.test.ts` pins provider-period parsing and zone-aware open-at-instant behavior. (`app/api/places/search/hours.test.ts:1-18`)
- `places/search/searchPlaces.test.ts` pins query expansion, in-flight dedupe, type selection, and partial failure. (`app/api/places/search/searchPlaces.test.ts:1-17`)
- `schedule/driveMode.test.ts` pins driving-mode choice and fallback behavior. (`app/api/schedule/driveMode.test.ts:1-14`)
- `schedule/home.test.ts` pins itinerary-home precedence and legacy fallback. (`app/api/schedule/home.test.ts:1-7`)
- `schedule/rideMetadata.test.ts` pins leg/ride occurrence identity and palette allocation. (`app/api/schedule/rideMetadata.test.ts:1-14`)
- `schedule/schedule.test.ts` pins deterministic schedule/time-window and itinerary-construction behavior. (`app/api/schedule/schedule.test.ts:1-13`)
- `schedule/travel.test.ts` pins provider parsing, modes, relabeling, travel facts, geometry, and error degradation. (`app/api/schedule/travel.test.ts:1-17`)
- `select/select.test.ts` pins ID-only selection, retry/fallback, constraints, reasons, and duration output. (`app/api/select/select.test.ts:1-18`)

### Package dependencies

- `@fontsource-variable/fraunces@5.3.0` and `@fontsource-variable/space-grotesk@5.3.0` are production dependencies imported by the root layout for local fonts. (`package.json:20-23`, `app/layout.tsx:1-3`)
- `@googlemaps/js-api-loader@^2.1.1` is the production browser loader used by `ItineraryMap`. (`package.json:23`, `app/ItineraryMap.tsx:4-4`, `app/ItineraryMap.tsx:160-167`)
- `firebase@^12.17.0` is the production browser Auth SDK used for optional anonymous and Google identity. (`package.json:24`, `app/lib/firebase.ts:18-19`, `app/lib/useAuth.ts:14-24`)
- `firebase-admin@^14.2.0` is the production server Auth/Firestore SDK used for ID-token verification, history, and profiles. (`package.json:25`, `app/lib/firebaseAdmin.ts:22-24`, `app/lib/firebaseAdmin.ts:101-128`)
- `luxon@^3.7.2` is the used production date/time dependency and already supplies per-IANA-zone arithmetic and formatting. (`package.json:26`, `app/lib/zoneTime.ts:1-16`, `app/lib/timeLabels.ts:18-24`, `app/lib/historyView.ts:16-16`)
- `next@16.2.11`, `react@19.2.8`, and `react-dom@19.2.8` are the production framework/runtime packages. (`package.json:27-29`, `app/page.tsx:1-4`, `app/layout.tsx:1-1`)
- `server-only@0.0.1` guards the server timezone lookup from client imports. (`package.json:30`, `app/api/geocode/zoneLookup.ts:1-5`)
- `tz-lookup@^6.1.25` is the used production offline coordinate-to-IANA-zone database. (`package.json:31`, `app/api/geocode/zoneLookup.ts:5-16`)
- `@playwright/test@^1.61.1` drives browser e2e tests, and `axe-core@4.12.1` supplies their accessibility audit. (`package.json:33-34`, `package.json:40-40`, `e2e/test.ts:1-1`, `e2e/accessibility.spec.ts:1-7`)
- `@types/google.maps@^3.65.2`, `@types/luxon@^3.7.2`, `@types/node@^22.20.1`, `@types/react@19.2.17`, and `@types/react-dom@19.2.3` are development-only type packages. (`package.json:35-39`, `tsconfig.json:3-18`)
- `eslint@9.39.5` with `eslint-config-next@16.2.11` provides linting; `tsx@4.23.1` runs TypeScript test scripts; and `typescript@^5` compiles/type-checks, with lockfile resolution `5.9.3`. (`package.json:41-44`, `package.json:12-18`, `package-lock.json:9215-9217`)
- Package overrides exactly pin Next's transitive `postcss@8.5.23` and `sharp@0.35.3`, while constraining `jose` with the semver range `^5.10.0`. (`package.json:46-51`)
- Every direct production dependency has a current import/use, and the only dependencies specifically aligned with cross-timezone date handling are the already-used `luxon` and `tz-lookup`; the manifest contains no hotel/availability SDK, currency-rate/conversion library, or i18n/locale framework. (`package.json:20-44`, `app/lib/zoneTime.ts:1-16`, `app/api/geocode/zoneLookup.ts:4-16`)

### Environment-variable inventory and `DEPLOY.md` cross-reference

- `OPENROUTER_API_KEY` authenticates planner, selector, reroute, and swap model calls; `OPENROUTER_MODELS_PLANNER`, `OPENROUTER_MODELS_SELECT`, and `OPENROUTER_MODELS_SWAP` optionally replace the respective ordered chains. (`app/api/parse/route.ts:130-130`, `app/api/select/route.ts:55-55`, `app/api/itinerary/reroute.ts:98-124`, `app/api/itinerary/swap.ts:638-665`, `app/api/_shared/models.ts:88-114`)
- `GOOGLE_PLACES_API_KEY`, `GOOGLE_GEOCODING_API_KEY`, `GOOGLE_ROUTES_API_KEY`, and `GOOGLE_WEATHER_API_KEY` authenticate the four separately keyed backend Google services. (`app/api/places/search/route.ts:80-88`, `app/api/geocode/route.ts:34-43`, `app/api/schedule/travel/route.ts:44-52`, `app/api/weather/route.ts:49-65`)
- `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` is the browser Maps JavaScript key. (`app/ItineraryMap.tsx:160-167`)
- `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`, `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`, and `NEXT_PUBLIC_FIREBASE_APP_ID` are the six all-or-none browser Firebase values. (`app/lib/firebase.ts:28-42`)
- `FIREBASE_ADMIN_PROJECT_ID`, `FIREBASE_ADMIN_CLIENT_EMAIL`, and `FIREBASE_ADMIN_PRIVATE_KEY` are the three server service-account values. (`app/lib/firebaseAdmin.ts:37-47`)
- `KV_REST_API_URL`/`KV_REST_API_TOKEN` and aliases `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` configure Redis REST; `VERCEL` makes missing KV fail loudly in deployed execution. (`app/api/itinerary/store.ts:154-173`)
- `NODE_ENV` and `NEXT_PUBLIC_ENABLE_DEV_CONTROLS` control developer UI visibility and diagnostic auth behavior. (`app/page.tsx:122-125`, `app/lib/useAuth.ts:95-102`)
- `E2E_MOCK` selects deterministic data sources and the Maps harness. (`app/api/_mock/fixtures.ts:48-49`, `app/test-harness/maps/page.tsx:4-10`)
- `E2E_ALLOW_EXTERNAL_BROWSER` is the live-browser opt-in, `E2E_FORCE_EXIT_ON_END` and `E2E_SERVER_PRESTARTED` control Playwright orchestration, and `LIFECYCLE_TEST_FILTER` narrows the lifecycle test matrix. (`playwright.live.config.ts:4-4`, `e2e/test.ts:5-17`, `playwright.config.ts:3-22`, `app/api/itinerary/lifecycle.routes.test.ts:507-507`)
- `DEPLOY.md` documents every operational OpenRouter/Google/public Firebase/Admin/dev-control/KV variable, all three model-chain overrides, and optional `TZ`. (`DEPLOY.md:30-70`)
- `TZ` is documented but is not read through `process.env` in application/config source; scheduling correctness is explicitly per-plan and the host variable is only an optional compatibility/logging default. (`DEPLOY.md:21-25`, `DEPLOY.md:50-50`, `app/lib/zoneTime.ts:1-16`)
- `VERCEL` and `NODE_ENV` are code-referenced platform/framework variables not named in the deployment table, while `E2E_*` and `LIFECYCLE_TEST_FILTER` are test-only variables not named there. (`app/api/itinerary/store.ts:168-168`, `app/page.tsx:123-123`, `playwright.config.ts:3-22`, `app/api/itinerary/lifecycle.routes.test.ts:507-507`, `DEPLOY.md:30-67`)
- No application-specific production credential/configuration variable is absent from the deployment table; the code-referenced platform/framework variables `VERCEL` and `NODE_ENV` are the exceptions identified above. (`DEPLOY.md:30-67`, `app/api/_shared/models.ts:88-114`, `app/api/itinerary/store.ts:154-173`, `app/lib/firebase.ts:28-42`, `app/lib/firebaseAdmin.ts:37-47`)

## 1. DATA MODEL

**VERDICT — The active persistence unit is one whole `Itinerary` value, keyed by raw ID in memory and by `itin:<id>` in Redis; it requires one ordered stop/leg topology and may independently carry one home point, one home-to-first leg, one timezone, one stated end, one travel-mode intent, and itinerary-level lifecycle markers.** (`app/api/itinerary/store.ts:32-119`, `app/api/itinerary/store.ts:121-129`, `app/api/itinerary/store.ts:195-201`, `app/api/itinerary/store.ts:269-297`)

### `Itinerary` fields and absence conventions

| Field | Meaning and absence convention |
|---|---|
| `id: string` | Required server-generated UUID and route/store identity; absence or mismatch makes a Redis value unloadable, and existing IDs are never overwritten. (`app/api/itinerary/store.ts:236-260`, `app/api/itinerary/store.ts:279-297`, `app/api/itinerary/store.ts:481-485`) |
| `version: number` | Monotonic optimistic-concurrency token; initial storage is forced to 1 and every successful CAS writes `expectedVersion + 1`. Legacy Redis data with no valid positive integer version normalizes to 1 on load. (`app/api/itinerary/store.ts:34-35`, `app/api/itinerary/store.ts:255-260`, `app/api/itinerary/store.ts:280-292`, `app/api/itinerary/store.ts:345-383`) |
| `createdAt: string` | ISO creation instant generated by the server and copied into history; the field is required, so absence makes a stored Redis value invalid. (`app/api/itinerary/store.ts:36`, `app/api/itinerary/store.ts:236-260`, `app/api/itinerary/store.ts:481-485`, `app/api/itinerary/ownership.ts:147-151`) |
| `status: ItineraryStatus` | Required in the TypeScript/browser shape, so absence is a browser payload error; Redis loading does not validate it, and lifecycle code re-derives it from stop clocks whenever `withStatuses` runs. (`app/api/itinerary/store.ts:20`, `app/api/itinerary/store.ts:37`, `app/api/itinerary/store.ts:236-260`, `app/api/itinerary/store.ts:546-592`, `app/lib/clientPayloads.ts:870-872`) |
| `stops: ItineraryStop[]` | Required ordered outing stops, so absence is rejected by both Redis and browser loading; API creation requires 1–8, and the server overwrites each stop's `status`/`locked` on creation. (`app/api/itinerary/store.ts:22-30`, `app/api/itinerary/store.ts:38`, `app/api/itinerary/store.ts:236-260`, `app/api/itinerary/store.ts:485-491`, `app/api/_shared/schemas.ts:331-389`, `app/lib/clientPayloads.ts:858-895`) |
| `legs: TravelLeg[]` | Required inter-stop legs, so absence is rejected by both Redis and browser loading; `rebuildLegs` treats the array as a projection of timed stops' `travelToNext`, not an independent source. (`app/api/itinerary/store.ts:39`, `app/api/itinerary/store.ts:236-260`, `app/api/itinerary/store.ts:518-530`, `app/lib/clientPayloads.ts:858-895`) |
| `homeLeg?: TravelLeg` | Home-to-first-stop origin metadata outside `stops`/`legs`, with no status, lock, or completion role; absence means no stored home leg, including legacy/no-route cases. (`app/api/itinerary/store.ts:40-45`, `app/api/schedule/home.ts:1-4`, `app/api/schedule/home.ts:30-39`) |
| `home?: HomePoint` | Per-plan geocoded origin; absence falls back to the Chestnut `HOME` compatibility origin. (`app/api/itinerary/store.ts:46-48`, `app/api/schedule/home.ts:7-19`) |
| `timeZone?: string` | Resolved per-plan IANA zone; absence means `America/Toronto`. (`app/api/itinerary/store.ts:49-53`) |
| `plannedEndISO?: string` | User-stated finish; absence includes unstated finishes and older plans and means no ceiling. (`app/api/itinerary/store.ts:54-68`, `app/api/itinerary/route.ts:61-64`) |
| `travelMode?: "transit" | "driving"` | Plan-level intent; absence means transit, and switching to transit deletes the field. (`app/api/itinerary/store.ts:69-86`, `app/api/itinerary/store.ts:497-499`, `app/api/itinerary/modeSwitch.ts:408-428`) |
| `parsed?: ParsedPrompt` | Original parse retained for later re-search; absence covers legacy/omitting writers, with a Toronto-only minimal fallback and an honest refusal for non-default-zone plans whose city cannot be recovered. (`app/api/itinerary/store.ts:87-88`, `app/api/itinerary/fallbackParsed.ts:1-6`, `app/api/itinerary/fallbackParsed.ts:15-39`) |
| `ownerUid?: string` | Verified Firebase UID; absent/blank means unowned/legacy, with no owner-pointer/history identity; by-ID GET, swap, remove, and mode retain capability access, reroute is ungated regardless of this field, and End still requires a verified exact owner. (`app/api/itinerary/store.ts:89-96`, `app/api/itinerary/ownership.ts:23-37`, `app/api/itinerary/[id]/route.ts:46-75`, `app/api/itinerary/byIdOwnership.ts:35-55`, `app/api/itinerary/[id]/reroute/route.ts:1-89`, `app/api/itinerary/[id]/end/route.ts:53-67`) |
| `ownerIsAnonymous?: boolean` | Anonymity captured at creation; natural archiving requires this value to be exactly `false`, so absence is treated as not proven non-anonymous. (`app/api/itinerary/store.ts:97-100`, `app/api/itinerary/ownership.ts:102-107`, `app/api/itinerary/ownership.test.ts:125-140`) |
| `archivedAt?: string` | Itinerary-side once-only archive marker; absence means no persisted marker, but does not prove the Firestore history document is absent because history write and marker CAS are separate. (`app/api/itinerary/store.ts:101-103`, `app/api/itinerary/readLifecycle.ts:35-60`) |
| `endedAt?: string` | A nonblank persisted value is the explicit human conclusion marker and makes the plan unresumable; absence/blank means there is no valid durable marker, not that no request was attempted. (`app/api/itinerary/store.ts:104-114`, `app/api/itinerary/ownership.ts:60-78`, `app/api/itinerary/store.ts:236-260`) |
| `discardedAt?: string` | Durable archive veto written only for `discard-end`; absence covers legacy/natural completion, `save-end`, and failed archive attempts. (`app/api/itinerary/store.ts:115-118`, `app/api/itinerary/[id]/end/route.ts:90-99`, `app/api/itinerary/ownership.ts:81-107`) |

- The exact compatibility wording is explicit: `timeZone` absent means `America/Toronto`, `plannedEndISO` absent means “no ceiling,” `travelMode` absent means transit, `home` absent means the legacy `HOME`, and `ownerUid` absent means unowned/legacy. (`app/api/itinerary/store.ts:46-75`, `app/api/itinerary/store.ts:89-96`)
- `ItineraryStop` extends `ScheduledStop` with required `status` and monotonic `locked`; `ScheduledStop` contains selection metadata, nullable times/duration, and optional outgoing travel details. (`app/api/itinerary/store.ts:19-30`, `app/api/schedule/schedule.ts:451-487`)
- `buildSchedule` emits a null-ID selection with null times/duration and `createItinerary` always forces its initial status to `skipped`; this is builder behavior rather than a persisted-schema invariant, because `parseScheduledStops` validates ID, times, and duration independently. The last timed stop built by the scheduler has no outgoing travel fields. (`app/api/schedule/schedule.ts:610-647`, `app/api/_shared/schemas.ts:331-389`, `app/api/itinerary/store.ts:486-490`)
- `TravelLeg` contains optional legacy-compatible `legId`, required origin index/mode/minutes, nullable distance/polyline, optional transit facts, and optional step geometry. (`app/api/schedule/travel.ts:308-343`)
- `ParsedPrompt` contains `time_window`, `stop_count`, `aesthetic`, `category_signals`, `group_context`, `budget`, `constraints`, `location`, and optional `city`, `home`, and `cityCenter`. (`app/api/places/search/filter.ts:35-63`)
- Redis loading validates only matching ID, string `createdAt`, array `stops`/`legs`, and version normalization before casting the rest, whereas browser parsing explicitly validates status, stop/leg shape, home, timezone, travel mode, and parsed data. (`app/api/itinerary/store.ts:236-260`, `app/lib/clientPayloads.ts:858-895`)

### Owner index

- The memory index is `Map<string,string>` and the Redis equivalent is one `owner:<uid>:active` key containing one plan ID, so the index is exactly one UID to one current-plan pointer. (`app/api/itinerary/store.ts:123-129`, `app/api/itinerary/store.ts:195-201`, `app/api/itinerary/store.ts:300-329`)
- The pointer is not an ownership-cardinality constraint: repeated creation can stamp the same UID onto multiple itinerary documents, while only the latest `SET` is discoverable through `GET /api/itinerary`. (`app/api/itinerary/route.ts:69-101`, `app/api/itinerary/store.ts:279-329`)
- `setActiveItineraryForOwner` writes the pointer, `activeItineraryIdForOwner` reads it, and `clearActiveItineraryForOwner` deletes only when the stored pointer still equals the concluding ID; blank UIDs are no-ops. (`app/api/itinerary/store.ts:309-343`)
- Production call sites are: create writes after a successful itinerary save; collection GET reads; natural completion clears in `readLifecycle`; explicit End clears. (`app/api/itinerary/route.ts:87-101`, `app/api/itinerary/route.ts:118-137`, `app/api/itinerary/readLifecycle.ts:20-31`, `app/api/itinerary/[id]/end/route.ts:104-115`)
- Test-only call sites are confined to `store.cas.test.ts` and `lifecycle.routes.test.ts`, which pin pointer round-trip, per-user isolation, blank-UID behavior, pointer-only clearing, preservation of newer plan B while concluding A, missing pointers, and unauthorized-read non-effects. (`app/api/itinerary/store.cas.test.ts:253-295`, `app/api/itinerary/lifecycle.routes.test.ts:189-230`, `app/api/itinerary/lifecycle.routes.test.ts:280-400`, `app/api/itinerary/lifecycle.routes.test.ts:470-500`)
- With N itinerary day documents, N successful pointer writes leave only the last successfully written day ID; earlier day documents remain stored but are not enumerable through the owner index, and completion of the pointed day clears the pointer without advancing to another day. (`app/api/itinerary/store.ts:300-343`, `app/api/itinerary/route.ts:87-101`, `app/api/itinerary/route.ts:127-137`, `app/api/itinerary/readLifecycle.ts:20-31`)
- Pointing `owner:<uid>:active` at a parent ID sends that value only through the itinerary loader: a differently keyed record reads as missing, a malformed `itin:<id>` value is rejected before lifecycle work, and only a minimally itinerary-shaped value reaches `withStatuses`; no alternate parent-record parser exists on this route. (`app/api/itinerary/route.ts:127-137`, `app/api/itinerary/store.ts:236-276`, `app/api/itinerary/readLifecycle.ts:73-92`)

### CAS, version, and conflict behavior

- Create uses `SET ... NX EX` in Redis or `store.has` in memory and reports an `ItineraryConflictError` instead of overwriting an existing ID. (`app/api/itinerary/store.ts:279-297`)
- CAS is whole-document and per `itin:<id>`: Redis Lua reads one key, compares its decoded version, and writes the complete serialized proposal with `KEEPTTL`; memory performs the equivalent compare/set without an intervening `await`. (`app/api/itinerary/store.ts:212-230`, `app/api/itinerary/store.ts:345-383`)
- `ItineraryConflictError` is HTTP 409 / `itinerary_conflict`; it covers create-ID collision, invalid expected versions, stale/lost races, and missing/corrupt/mismatched CAS state or result. (`app/api/itinerary/store.ts:143-152`, `app/api/itinerary/store.ts:279-297`, `app/api/itinerary/store.ts:345-383`, `app/api/itinerary/store.cas.test.ts:187-233`)
- `updateItinerary` performs load, clone, mutate, then CAS; `changed:false` skips persistence/version bump, and CAS retry occurs only when no explicit `expectedVersion` was supplied. (`app/api/itinerary/store.ts:397-438`)
- Default update attempts are 2, requested attempts are clamped to 1–3, and any supplied expected version forces exactly one attempt. (`app/api/itinerary/store.ts:140-142`, `app/api/itinerary/store.ts:407-413`)
- Swap/remove/reroute/mode request at most two attempts, but the normal client supplies a version and therefore receives one attempt plus deterministic 409 on staleness. (`app/api/itinerary/[id]/swap/route.ts:60-96`, `app/api/itinerary/[id]/remove/route.ts:69-92`, `app/api/itinerary/[id]/reroute/route.ts:53-75`, `app/api/itinerary/[id]/mode/route.ts:75-91`, `app/page.tsx:2239-2248`, `app/page.tsx:2371-2383`, `app/page.tsx:2523-2533`, `app/page.tsx:2637-2647`)
- Lifecycle status writes, archive-marker writes, and End use up to three attempts without a client version. (`app/api/itinerary/readLifecycle.ts:38-50`, `app/api/itinerary/readLifecycle.ts:73-89`, `app/api/itinerary/[id]/end/route.ts:90-102`)
- A natural completion can consume two independent version bumps, one for status/lock and one for `archivedAt`. (`app/api/itinerary/lifecycle.routes.test.ts:280-296`)
- N day documents therefore have independent CAS/version domains and no cross-document atomic commit; a single document is versioned and replaced as one complete JSON value. (`app/api/itinerary/store.ts:195`, `app/api/itinerary/store.ts:345-383`)
- Owner-pointer and Firestore-history writes are outside itinerary CAS. (`app/api/itinerary/route.ts:87-101`, `app/api/itinerary/readLifecycle.ts:20-60`, `app/api/itinerary/[id]/end/route.ts:78-115`)

## 2. INFRASTRUCTURE & BUILD

**VERDICT — The deployed source/config defines a Next.js 16 Node/serverless application with 15 App Router handlers and no separate service, worker, queue, or cron declaration; active plans use Upstash Redis REST with per-document CAS and seven-day expiry, account history/profile use Firestore, and identity is optional Firebase Auth.** (`package.json:5-18`, `package.json:20-44`, `next.config.mjs:5-17`, `DEPLOY.md:3-19`, `DEPLOY.md:111-119`, `app/api/itinerary/store.ts:131-193`, `app/api/itinerary/history.ts:12-35`, `app/api/profile/profileStore.ts:1-17`, `app/api/geocode/route.ts:1-49`, `app/api/history/route.ts:1-50`, `app/api/itinerary/route.ts:1-141`, `app/api/itinerary/[id]/route.ts:1-82`, `app/api/itinerary/[id]/end/route.ts:1-132`, `app/api/itinerary/[id]/mode/route.ts:1-103`, `app/api/itinerary/[id]/remove/route.ts:1-104`, `app/api/itinerary/[id]/reroute/route.ts:1-89`, `app/api/itinerary/[id]/swap/route.ts:1-109`, `app/api/parse/route.ts:1-189`, `app/api/places/search/route.ts:1-104`, `app/api/profile/route.ts:1-105`, `app/api/schedule/travel/route.ts:1-63`, `app/api/select/route.ts:1-75`, `app/api/weather/route.ts:1-111`)

### Runtime, build, and route execution

- The manifest requires Node `>=22.12.0`, pins Next `16.2.11`, React `19.2.8`, and React DOM `19.2.8`, declares TypeScript `^5`, and the lockfile resolves TypeScript `5.9.3`. (`package.json:5-6`, `package.json:27-29`, `package.json:43-44`, `package-lock.json:9215-9217`)
- Development uses `next dev`, production uses `next build --webpack`, and execution uses `next start`. (`package.json:8-11`)
- `next.config.mjs` configures a Turbopack root for development and retains `serverExternalPackages:["firebase-admin"]`; the production build explicitly selects webpack. (`next.config.mjs:5-17`, `package.json:8-11`)
- Webpack was adopted because a Turbopack build emitted a hashed Firebase Admin package copy that Vercel output tracing omitted, while webpack emitted normal `firebase-admin/*` externals. (`DEVLOG.md:562-565`)
- TypeScript targets ES2017 with DOM/ESNext libraries, strict checking, no emit, ESNext modules, bundler resolution, isolated modules, and React JSX. (`tsconfig.json:2-19`)
- None of the 15 route modules declares `export const runtime` or `maxDuration`; the route handlers therefore use Next's default Node runtime, and only weather declares `dynamic = "force-dynamic"`. (`DEVLOG.md:562-565`, `app/api/geocode/route.ts:1-49`, `app/api/history/route.ts:1-50`, `app/api/itinerary/route.ts:1-141`, `app/api/itinerary/[id]/route.ts:1-82`, `app/api/itinerary/[id]/end/route.ts:1-132`, `app/api/itinerary/[id]/mode/route.ts:1-103`, `app/api/itinerary/[id]/remove/route.ts:1-104`, `app/api/itinerary/[id]/reroute/route.ts:1-89`, `app/api/itinerary/[id]/swap/route.ts:1-109`, `app/api/parse/route.ts:1-189`, `app/api/places/search/route.ts:1-104`, `app/api/profile/route.ts:1-105`, `app/api/schedule/travel/route.ts:1-63`, `app/api/select/route.ts:1-75`, `app/api/weather/route.ts:1-111`)
- The complete route surface is POST `/api/geocode`, GET `/api/history`, POST/GET `/api/itinerary`, GET `/api/itinerary/[id]`, POST `/api/itinerary/[id]/{end,mode,remove,reroute,swap}`, POST `/api/parse`, POST `/api/places/search`, GET/POST `/api/profile`, POST `/api/schedule/travel`, POST `/api/select`, and GET `/api/weather`. (`app/api/geocode/route.ts:18-49`, `app/api/history/route.ts:6-50`, `app/api/itinerary/route.ts:37-141`, `app/api/itinerary/[id]/route.ts:15-79`, `app/api/itinerary/[id]/end/route.ts:22-128`, `app/api/itinerary/[id]/mode/route.ts:20-98`, `app/api/itinerary/[id]/remove/route.ts:17-99`, `app/api/itinerary/[id]/reroute/route.ts:19-84`, `app/api/itinerary/[id]/swap/route.ts:21-104`, `app/api/parse/route.ts:104-189`, `app/api/places/search/route.ts:26-104`, `app/api/profile/route.ts:37-105`, `app/api/schedule/travel/route.ts:21-63`, `app/api/select/route.ts:23-75`, `app/api/weather/route.ts:38-111`)
- No separate service, queue consumer, scheduled handler, or cron manifest is declared in source/config; every present provider call and mutation completes inside one of the 15 Next handlers. (`package.json:8-18`, `next.config.mjs:5-17`, `app/api/_shared/provider.ts:110-180`, `app/api/geocode/route.ts:1-49`, `app/api/history/route.ts:1-50`, `app/api/itinerary/route.ts:1-141`, `app/api/itinerary/[id]/route.ts:1-82`, `app/api/itinerary/[id]/end/route.ts:1-132`, `app/api/itinerary/[id]/mode/route.ts:1-103`, `app/api/itinerary/[id]/remove/route.ts:1-104`, `app/api/itinerary/[id]/reroute/route.ts:1-89`, `app/api/itinerary/[id]/swap/route.ts:1-109`, `app/api/parse/route.ts:1-189`, `app/api/places/search/route.ts:1-104`, `app/api/profile/route.ts:1-105`, `app/api/schedule/travel/route.ts:1-63`, `app/api/select/route.ts:1-75`, `app/api/weather/route.ts:1-111`)
- Route-local limits per minute are geocode 60, history 120, create 60, active read 120, by-ID read 180, end 60, mode/remove/reroute/swap 30 each, parse 120, Places 60, profile GET 120/POST 60, travel 90, select 60, and weather 90. (`app/api/geocode/route.ts:18-29`, `app/api/history/route.ts:6-27`, `app/api/itinerary/route.ts:37-41`, `app/api/itinerary/route.ts:112-121`, `app/api/itinerary/[id]/route.ts:15-33`, `app/api/itinerary/[id]/end/route.ts:22-40`, `app/api/itinerary/[id]/mode/route.ts:20-54`, `app/api/itinerary/[id]/remove/route.ts:17-44`, `app/api/itinerary/[id]/reroute/route.ts:19-28`, `app/api/itinerary/[id]/swap/route.ts:21-35`, `app/api/parse/route.ts:104-112`, `app/api/places/search/route.ts:26-33`, `app/api/profile/route.ts:37-40`, `app/api/profile/route.ts:65-68`, `app/api/schedule/travel/route.ts:21-29`, `app/api/select/route.ts:23-27`, `app/api/weather/route.ts:41-46`)

### Backend and authentication shape

- Create validates a complete itinerary, derives ownership only from a verified caller, saves version 1, best-effort attempts the caller's active-pointer write without failing an otherwise successful create, and responds with an ETag/version. (`app/api/itinerary/route.ts:37-106`)
- Active-plan GET verifies the caller, resolves the owner pointer, applies the lifecycle read, and returns `null` for no caller, no pointer, dangling TTL pointer, or a concluded plan. (`app/api/itinerary/route.ts:112-137`)
- By-ID GET masks an owned plan from an anonymous/foreign caller as 404, while an ownerless legacy plan remains capability-readable by anyone holding its ID. (`app/api/itinerary/[id]/route.ts:15-25`, `app/api/itinerary/[id]/route.ts:46-79`, `app/api/itinerary/byIdOwnership.ts:41-55`)
- End, swap, remove, and mode enforce ownership; reroute directly loads and mutates by ID without calling `verifyCaller`. (`app/api/itinerary/[id]/end/route.ts:22-33`, `app/api/itinerary/[id]/end/route.ts:53-128`, `app/api/itinerary/[id]/swap/route.ts:39-104`, `app/api/itinerary/[id]/remove/route.ts:35-99`, `app/api/itinerary/[id]/mode/route.ts:42-98`, `app/api/itinerary/[id]/reroute/route.ts:19-84`)
- The deployment document records reroute as the sole partial authorization boundary and describes it as dev-control-only from the production UI. (`DEPLOY.md:121-136`)
- Browser auth initializes only when all six public Firebase values exist, observes `onIdTokenChanged`, silently creates an anonymous session when no user exists, can link or sign in with Google, and supplies a fresh ID token for API calls. (`app/lib/firebase.ts:28-77`, `app/lib/useAuth.ts:28-46`, `app/lib/useAuth.ts:118-180`, `app/lib/useAuth.ts:209-323`)
- The app's `AppUser` requires a nonblank UID and treats only explicit `isAnonymous:false` as a real account; missing/malformed anonymity defaults to guest. (`app/lib/authUser.ts:10-28`, `app/lib/authUser.ts:50-70`)
- Server auth parses only `Authorization: Bearer ...`, verifies it through Firebase Admin, and never trusts a UID from a request body. (`app/api/_shared/caller.ts:1-21`, `app/api/_shared/caller.ts:26-62`)
- Firebase Admin returns `{uid,isAnonymous}`, with anonymity derived from the signed token's `firebase.sign_in_provider === "anonymous"`; absent credentials, expired/wrong-project/garbage tokens, and malformed identities all return `null`. (`app/lib/firebaseAdmin.ts:88-115`)
- History and taste personalization require a verified non-anonymous account, while planning remains available to anonymous or unverified callers. (`app/api/history/route.ts:16-47`, `app/api/profile/route.ts:25-35`, `app/api/profile/route.ts:37-102`, `CLAUDE.md:241-247`)

### Persistence and Redis keyspace

- Redis is not the only persistence layer: active itinerary documents and current-plan pointers use Upstash Redis REST, while concluded-plan history and taste profiles use Firebase Firestore; no relational/SQL store or ORM appears in the dependency/backend inventory. (`app/api/itinerary/store.ts:131-193`, `app/api/itinerary/history.ts:12-35`, `app/api/profile/profileStore.ts:1-17`, `app/api/profile/profileStore.ts:26-32`, `package.json:20-44`)
- Local development and mock e2e instead use process-global `Map<string,Itinerary>` and `Map<string,string>` instances so they survive Next hot reloads within one process. (`app/api/itinerary/store.ts:121-140`)
- KV configuration independently resolves URL as `KV_REST_API_URL ?? UPSTASH_REDIS_REST_URL` and token as `KV_REST_API_TOKEN ?? UPSTASH_REDIS_REST_TOKEN`, then requires both resolved values; mixed-family values can configure the store, while a defined blank primary blocks its populated alias. A Vercel process without both resolved values throws instead of using memory. (`app/api/itinerary/store.ts:154-173`)
- Every Redis operation is one authenticated JSON POST to the configured REST URL through the five-second provider wrapper, with `cache:"no-store"`, and requires a response object containing `result`. (`app/api/itinerary/store.ts:176-193`, `app/api/_shared/provider.ts:25-33`)
- The complete Redis keyspace has exactly two patterns: `itin:${id}` for the complete active itinerary document and `owner:${uid}:active` for the UID's current itinerary ID pointer. (`app/api/itinerary/store.ts:195-201`)
- A new `itin:*` key is written with `SET key json NX EX 604800`; a new/replaced owner pointer is written with `SET key id EX 604800`. (`app/api/itinerary/store.ts:140-140`, `app/api/itinerary/store.ts:279-319`)
- Both key types receive a seven-day TTL at their own creation/write time; the pointer and plan expirations are separate clocks even though the comment calls the TTL shared. (`app/api/itinerary/store.ts:140-140`, `app/api/itinerary/store.ts:279-315`)
- Itinerary mutations use a Lua compare-and-set that reads/decodes the current document, compares its version, writes the full proposal with `KEEPTTL`, and returns the incremented version; mutations do not refresh the plan TTL. (`app/api/itinerary/store.ts:212-230`, `app/api/itinerary/store.ts:345-384`)
- Pointer clearing uses a Lua GET/conditional DEL, so an older plan's conclusion cannot delete a newer active pointer. (`app/api/itinerary/store.ts:203-210`, `app/api/itinerary/store.ts:332-343`)
- KV-mode plan and pointer reads always issue Redis `GET`; there is no warm-instance read cache, TTL read, TTL extension, or cross-request response cache. (`app/api/itinerary/store.ts:263-276`, `app/api/itinerary/store.ts:321-329`)
- `updateItinerary` performs load, clone, propose, then CAS; it immediately rejects an explicitly stale expected version, defaults unversioned retries to two, and clamps any requested retry count to at most three. (`app/api/itinerary/store.ts:397-438`)
- If `itin:*` expires during a trip, `loadItinerary` returns `undefined`, by-ID GET returns the same 404 as a missing itinerary, and current-active GET returns `itinerary:null`; if only the owner pointer expires, current-active GET also returns `null` even if the document remains reachable by ID. (`app/api/itinerary/store.ts:269-276`, `app/api/itinerary/store.ts:321-329`, `app/api/itinerary/[id]/route.ts:51-56`, `app/api/itinerary/route.ts:127-135`)
- Firestore history uses `users/{uid}/history/{itineraryId}`, overwrites idempotently, and reads newest-first with a 50-record limit; the application sets no history TTL. (`app/api/itinerary/history.ts:24-35`, `app/api/itinerary/history.ts:51-77`, `app/api/itinerary/history.ts:117-130`)
- Firestore profile storage uses the fixed document `users/{uid}/profile/preferences`, reads it by verified UID, and overwrites the whole record without merge; the application sets no profile TTL. (`app/api/profile/profileStore.ts:1-11`, `app/api/profile/profileStore.ts:26-32`, `app/api/profile/profileStore.ts:44-110`)
- The only Redis REST caller and commands under `app/` are the itinerary/pointer `GET`, `SET`, and two Lua `EVAL` operations in `store.ts`; history and profile never write Redis. (`app/api/itinerary/store.ts:176-230`, `app/api/itinerary/store.ts:263-384`, `app/api/itinerary/history.ts:12-35`, `app/api/profile/profileStore.ts:26-32`)

### Shared request, rate, timeout, and cost controls

- Shared provider deadlines are OpenRouter 45 seconds, Places 10 seconds, Routes 10 seconds, Weather 8 seconds, Geocoding 10 seconds, and Redis 5 seconds; the timeout stays armed through body consumption. (`app/api/_shared/provider.ts:11-34`, `app/api/_shared/provider.ts:118-180`)
- Provider errors preserve upstream HTTP status and valid `Retry-After`, distinguish 429, reject malformed JSON, and recognize OpenRouter's HTTP-200 `{error:{code,...}}` body. (`app/api/_shared/provider.ts:36-84`, `app/api/_shared/provider.ts:182-232`)
- Only upstream 429 and 5xx model errors are retryable on another model; timeouts/transport errors and 4xx configuration/request errors do not advance the chain. (`app/api/_shared/provider.ts:70-84`, `app/api/_shared/modelFallback.ts:43-100`)
- Incoming JSON is capped at 256 KiB, with maxima of 2,000 prompt characters, 1,000 refinement characters, eight categories, 25 candidates per pool, 160 total candidates, nine geographic points, and 240 characters for generic bounded text. (`app/api/_shared/http.ts:5-14`, `app/api/_shared/http.ts:61-84`)
- The route limiter is an in-process map keyed by route scope plus client IP, uses a 60-second window, returns 429 with `Retry-After`, and bounds itself at 10,000 buckets. (`app/api/_shared/http.ts:16-27`, `app/api/_shared/http.ts:53-58`, `app/api/_shared/http.ts:86-115`)
- Vercel instances do not share that limiter, so deployment documentation classifies it as defense in depth and records a shared edge/Redis limiter as unimplemented. (`DEPLOY.md:207-213`, `DEPLOY.md:231-236`)
- Browser JSON calls have a uniform 25-second deadline, so that client ceiling precedes OpenRouter's 45-second server deadline. (`app/lib/clientFetch.ts:1-20`, `app/api/_shared/provider.ts:21-28`)

### OpenRouter

- `app/api/_shared/openrouter.ts` targets `https://openrouter.ai/api/v1/chat/completions`; planner/select routes and mutation-engine dependencies attach `OPENROUTER_API_KEY`. (`app/api/_shared/openrouter.ts:13-13`, `app/api/_shared/openrouter.ts:103-123`, `app/api/parse/route.ts:130-149`, `app/api/select/route.ts:55-65`, `app/api/itinerary/swap.ts:638-665`, `app/api/itinerary/reroute.ts:98-124`)
- The request body is `{model,messages,response_format:{type:"json_object"},temperature:0,provider:{require_parameters:true,sort:"throughput",max_price:{prompt:5,completion:10}}}`, with low/excluded reasoning added only for mandatory-reasoning model IDs. (`app/api/_shared/openrouter.ts:103-122`)
- Planner and selector default to Llama 3.3 70B, GPT-OSS 120B, then GPT-OSS 20B; swap defaults to Llama 3.1 8B, GPT-OSS 20B, then Llama 3.3 70B. (`app/api/_shared/models.ts:64-85`)
- Each call expects `choices[0].message.content`, caps that string at 50,000 characters, parses JSON, and validates the call-specific result rather than trusting model structure. (`app/api/parse/route.ts:62-101`, `app/api/select/selectVenues.ts:112-145`, `app/api/itinerary/swap.ts:510-545`)
- There is no `max_tokens` field, response-`usage` reader, or application token/cost ledger; the implemented monetary control is the endpoint-routing ceiling of 5 USD/M prompt and 10 USD/M completion tokens. (`app/api/_shared/openrouter.ts:103-122`, `DEPLOY.md:80-90`)
- Operator-level OpenRouter credit/spend limits and alerts are deployment configuration rather than code-owned accounting. (`DEPLOY.md:227-230`)
- The provider migration followed a Groq platform-wide token ceiling that produced capacity 503s, and the OpenRouter follow-up followed a measured approximately 21-second planner request caused by a low-throughput serving endpoint. (`DEVLOG.md:447-455`)

### Google Places

- `searchPlaces.ts` POSTs to `https://places.googleapis.com/v1/places:searchText` with `GOOGLE_PLACES_API_KEY`, `X-Goog-FieldMask`, JSON `{textQuery,includedType?}`, and `cache:"no-store"`. (`app/api/places/search/searchPlaces.ts:20-20`, `app/api/places/search/searchPlaces.ts:113-127`, `app/api/places/search/route.ts:80-88`)
- Its field mask requests ID/name/location, rating/price/opening hours/business status, editorial summary, and structured vegetarian/outdoor/live-music/children/dogs/accessibility evidence. (`app/api/places/search/searchPlaces.ts:22-58`)
- The response may expose `places` as an array or omit it for an empty result; each retained candidate requires a nonempty ID, optional coordinates must be valid, and an optional rating must be finite within 0–5. (`app/api/places/search/searchPlaces.ts:128-154`)
- Search expansion is bounded at 16 ordinary late-night variants and 19 when one of eight category slots is the five-query general union. (`app/api/places/search/searchPlaces.ts:60-70`)
- Identical query/type work is deduplicated only within one `searchPools` invocation; rejected work is evicted and separate attempts refetch current facts. (`app/api/places/search/searchPlaces.ts:157-190`)
- Full Places payloads have no cross-request cache because they include restricted provider content and time-sensitive opening hours. (`app/api/places/search/searchPlaces.ts:166-174`, `DEPLOY.md:140-150`)
- Parallel query/category failures are collected with `Promise.allSettled`, allowing partial pools rather than failing all provider work. (`app/api/places/search/searchPlaces.ts:287-362`)

### Google Geocoding and timezone lookup

- `geocode.ts` calls `https://maps.googleapis.com/maps/api/geocode/json` with `GOOGLE_GEOCODING_API_KEY`; city resolution and optional address resolution are separate provider requests. (`app/api/geocode/geocode.ts:12-14`, `app/api/geocode/geocode.ts:324-349`, `app/api/geocode/route.ts:34-43`, `DEPLOY.md:151-153`)
- Input city/address text is trimmed and bounded at 2,000 characters, and the address URL carries the resolved city's country, region, and bounds context. (`app/api/geocode/geocode.ts:273-294`, `app/api/geocode/geocode.ts:324-349`)
- Provider responses are validated for status/results; city candidates must be locality-typed, ambiguity returns at most five candidates, and address results are checked for a complete street address, country, distance, and a conditional broad-region mismatch—not locality equality. (`app/api/geocode/geocode.ts:481-500`, `app/api/geocode/geocode.ts:512-639`, `CLAUDE.md:100`)
- `zoneLookup.ts` resolves coordinates locally through `tz-lookup`; it performs no external request and uses no API key. (`app/api/geocode/zoneLookup.ts:1-16`)

### Google Weather

- `weather/route.ts` and `fetchWeather.ts` call `https://weather.googleapis.com/v1/forecast/hours:lookup` using `GOOGLE_WEATHER_API_KEY`, one latitude/longitude, `hours=24`, `pageSize=24`, and `unitsSystem=METRIC`. (`app/api/weather/route.ts:25-25`, `app/api/weather/route.ts:65-79`, `app/api/weather/fetchWeather.ts:14-14`, `app/api/weather/fetchWeather.ts:24-47`)
- Weather responses must contain `forecastHours`; the public route maps interval, temperature, precipitation probability, and condition fields and slices the result to 24 records. (`app/api/weather/route.ts:26-36`, `app/api/weather/route.ts:79-108`)
- Both weather paths use ten-minute Next data revalidation; the pipeline helper fails soft to `null`, while the route itself is force-dynamic. (`app/api/weather/fetchWeather.ts:24-65`, `app/api/weather/route.ts:38-43`, `app/api/weather/route.ts:75-108`)

### Google Routes, Maps, and Firebase SDK calls

- `travel.ts` POSTs to `https://routes.googleapis.com/directions/v2:computeRoutes` using `GOOGLE_ROUTES_API_KEY`, origin/destination coordinates, travel mode, optional future departure, and a fixed facts/geometry/transit field mask. (`app/api/schedule/travel.ts:9-14`, `app/api/schedule/travel.ts:92-110`, `app/api/schedule/travel.ts:822-867`, `app/api/schedule/travel/route.ts:44-52`)
- Driving requests use `TRAFFIC_AWARE`, not `TRAFFIC_AWARE_OPTIMAL`; code comments and canonical notes expect this to avoid the Preferred SKU, but a real Routes billing-line verification remains pending, so the SKU outcome is inferred rather than measured. (`app/api/schedule/travel.ts:836-855`, `CLAUDE.md:55`)
- The parser reads route/leg duration, distance, encoded route and step polylines, step mode, and transit line/color/stop/time facts before building a validated leg. (`app/api/schedule/travel.ts:176-220`, `app/api/schedule/travel.ts:499-604`, `app/api/schedule/travel.ts:867-903`)
- Driving mode requests drive and walk concurrently, ordinary transit requests transit and walk concurrently, a sub-250-metre hop requests only walk, and consecutive legs remain sequential because each next departure depends on prior travel and dwell. (`app/api/schedule/travel.ts:923-988`, `app/api/schedule/travel.ts:997-1040`)
- When only one requested/alternate route survives, travel degrades to that surviving route; when both transit and walk fail, transit produces an unknown positive walking estimate, whereas when both drive and walk fail, driving produces an unknown leg with zero minutes. (`app/api/schedule/travel.ts:764-819`, `app/api/schedule/travel.ts:923-988`)
- `ItineraryMap.tsx` loads browser Maps JS with only `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`, version `weekly`, and the `maps` and `geometry` libraries. (`app/ItineraryMap.tsx:160-167`)
- Firebase Auth/Admin calls run through their SDKs rather than `fetchProvider`; route gates bound request frequency/access, but the source-owned provider deadline table contains no Firebase deadline for token verification or Firestore operations. (`app/lib/firebaseAdmin.ts:101-128`, `app/api/_shared/caller.ts:36-62`, `app/api/_shared/provider.ts:11-34`, `app/api/history/route.ts:6-50`, `app/api/profile/route.ts:37-105`)

### Deployment and bundle isolation

- The documented deployed topology is Vercel serverless route functions plus connected Upstash Redis, deployed from the repository root under Next.js framework autodetection. (`DEPLOY.md:3-19`, `DEPLOY.md:157-170`)
- Production, Preview, and Development environment values are separate Vercel scopes; production secrets are not to be copied into Preview unless that access is intentionally trusted. (`DEPLOY.md:237-239`)
- Browser-visible configuration is limited to the Maps JS key, six optional Firebase Web values, and optional dev controls; OpenRouter, server Google APIs, Firebase Admin, and Redis credentials remain server-only. (`DEPLOY.md:51-62`, `DEPLOY.md:92-97`, `app/api/itinerary/store.ts:154-186`)
- The Maps key is expected to use exact-origin HTTP-referrer and Maps-JavaScript-API restrictions, while each backend Google key is separately API-restricted to its service. (`DEPLOY.md:99-109`, `DEPLOY.md:215-226`)
- The deployment guide lists OpenRouter spend limits/alerts, Google quotas/budget alerts/hard caps, Upstash token restrictions, production log retention/access, CSP rollout, and bot/WAF controls as operator/go-live checklist items; repository evidence does not establish their live external configuration. (`DEPLOY.md:207-250`)
- Source-side structured logging is constrained not to ingest prompts, refinements, model output, upstream bodies, keys, tokens, home labels, or environment values. (`DEPLOY.md:240-243`)
- A stale sentence later in `DEPLOY.md` says current main does not implement owner enforcement, while that document's current auth section and route code show enforcement on end/by-ID/swap/remove/mode; reroute remains the stated exception. (`DEPLOY.md:121-136`, `DEPLOY.md:196-200`, `app/api/itinerary/[id]/end/route.ts:22-33`, `app/api/itinerary/[id]/swap/route.ts:39-55`, `app/api/itinerary/[id]/remove/route.ts:35-51`, `app/api/itinerary/[id]/mode/route.ts:42-58`)
- The recent timezone remediation moved only `zoneFromLatLng` into server-only `zoneLookup.ts`, while `zoneTime.ts` retained client-safe Luxon arithmetic and stopped importing/re-exporting the geographic lookup database. (`DEVLOG.md:71-80`, `app/api/geocode/zoneLookup.ts:1-16`, `app/lib/zoneTime.ts:1-16`)
- Two measured webpack builds found the timezone database in a 75,596-byte raw/30,831-byte gzip eager client chunk before the split and in none of 38 client chunks afterward; the page's client-reference set fell by 73,483 raw and 29,840 gzip bytes. (`DEVLOG.md:81`)
- `zoneLookup.test.ts` walks every `"use client"` import root, rejects any path to `zoneLookup` or `tz-lookup`, and asserts that only server geocoding imports the lookup module. (`app/api/geocode/zoneLookup.test.ts:18-63`, `app/api/geocode/zoneLookup.test.ts:78-78`)
- `clientPayloads.ts` duplicates travel geometry bounds instead of importing `travel.ts` because the former runs in the browser and the latter reaches server-only modules. (`app/lib/clientPayloads.ts:330-340`)
- Firebase Admin is server-only, imported through server helpers, and externalized from the server bundle; webpack is the deployment-compatible packaging path. (`app/lib/firebaseAdmin.ts:1-24`, `next.config.mjs:9-17`, `DEVLOG.md:562-565`)
- No hotel, lodging-availability, reservation, currency-rate, translation, or locale provider is called by the present backend provider inventory. (`app/api/_shared/provider.ts:3-9`, `package.json:20-44`, `CLAUDE.md:276-280`)

## 3. STATUS/LIFECYCLE

**VERDICT — `"planning" | "active" | "completed"` describes the outing's clock phase, not a navigation mode; status is persisted opportunistically but re-derived from stop instants, while explicit human termination and history are represented separately.** (`app/api/itinerary/store.ts:20`, `app/api/itinerary/store.ts:546-592`, `app/api/itinerary/ownership.ts:60-113`)

### Derivation and transitions

- A stop is skipped for missing/unusable times, upcoming before start, active on `[start,end)`, and completed at or after end. (`app/api/itinerary/store.ts:441-460`)
- `withStatuses` leaves already-skipped stops alone, recomputes other statuses, and permanently ratchets `locked` on active/completed stops even if dev time later rewinds. (`app/api/itinerary/store.ts:552-569`, `app/api/itinerary/itinerary.test.ts:44-74`)
- The itinerary is completed when all non-skipped/live stops are completed and also when every stop is completed-or-skipped, including the zero-live/all-skipped case; otherwise any active or completed stop makes it active, including gaps, and no started stop means planning. (`app/api/itinerary/store.ts:577-592`, `app/api/itinerary/itinerary.test.ts:136-186`)
- The factory stores `planning` initially, and transitions occur only when a GET or mutation invokes `withStatuses`; the store has no autonomous timer. (`app/api/itinerary/store.ts:481-501`, `app/api/itinerary/readLifecycle.ts:73-92`)
- By-ID GET derives against real time or `?now=ISO`, while owner-resume GET derives against server `new Date()`, so the dev query can persist simulated status/locks and trigger conclusion. (`app/api/itinerary/[id]/route.ts:15-44`, `app/api/itinerary/[id]/route.ts:67-79`, `app/api/itinerary/route.ts:127-137`)
- `modeSwitch` derives statuses before computing the movement floor and after rebuilding legs; only a successful final assignment reaches the stored proposal, while refusal/no-op is returned as `changed:false`. (`app/api/itinerary/modeSwitch.ts:203-249`, `app/api/itinerary/modeSwitch.ts:396-428`, `app/api/itinerary/[id]/mode/route.ts:79-91`)
- Remove, reroute, and swap engines also invoke `withStatuses` around their own mutation calculations; status derivation is therefore not confined to GET and mode-switch paths. (`app/api/itinerary/removeStop.ts:410-410`, `app/api/itinerary/removeStop.ts:499-499`, `app/api/itinerary/reroute.ts:240-240`, `app/api/itinerary/reroute.ts:494-494`, `app/api/itinerary/swap.ts:1190-1190`, `app/api/itinerary/swap.ts:1399-1399`, `app/api/itinerary/swap.ts:1883-1883`, `app/api/itinerary/swap.ts:2508-2508`)
- `endedAt`, `discardedAt`, and `archivedAt` do not participate in `nextItineraryStatus`; `isResumable` separately rejects `endedAt` and status `completed`. (`app/api/itinerary/store.ts:583-592`, `app/api/itinerary/ownership.ts:60-78`)

### Conclusion and archive states

- Both GET surfaces share `readItineraryWithLifecycle`, which persists status/lock changes through up to three CAS attempts before running conclusion handling. (`app/api/itinerary/route.ts:127-137`, `app/api/itinerary/[id]/route.ts:67-79`, `app/api/itinerary/readLifecycle.ts:64-92`)
- A completed owned plan first compare-clears its owner pointer regardless of anonymity; automatic/natural history eligibility is separately limited to not-discarded, completed, nonblank-owner, explicitly non-anonymous, and not-already-archived plans. (`app/api/itinerary/readLifecycle.ts:20-36`, `app/api/itinerary/ownership.ts:86-113`)
- A successful natural history write is followed by a separate `archivedAt` CAS; marker-CAS failure is nonfatal and returns an optimistic response containing `archivedAt`, while a later read can overwrite the same idempotent Firestore document and retry the marker. (`app/api/itinerary/readLifecycle.ts:35-60`, `app/api/itinerary/history.ts:32-35`)
- `endedAt` is written only for a validated non-cancel End choice; `discardedAt` is written only for exact `discard-end` and uses the same timestamp. (`app/api/itinerary/stopPlan.ts:17-54`, `app/api/itinerary/[id]/end/route.ts:69-102`)
- In the tested eligible/success branches, natural completion produces `archivedAt` without `endedAt`, real-account save-end produces `endedAt + archivedAt`, and discard-end produces `endedAt + discardedAt`; natural completion without archive eligibility and save-end whose archive write fails do not gain `archivedAt`. (`app/api/itinerary/lifecycle.routes.test.ts:215-292`, `app/api/itinerary/ownership.ts:102-107`, `app/api/itinerary/readLifecycle.ts:33-36`)
- Explicit End archives before its separate itinerary CAS and clears the pointer afterward, so history, itinerary markers, and the pointer are not one transaction. (`app/api/itinerary/[id]/end/route.ts:78-115`)
- The archive record omits plan-level status, `endedAt`, `discardedAt`, legs, and parse data; it stores itinerary/owner IDs, creation/archive times, nullable timezone, and compact stop facts. (`app/api/itinerary/ownership.ts:116-160`, `app/api/itinerary/ownership.test.ts:195-219`)
- All lifecycle markers are itinerary-level; if each day is an itinerary, existing code evaluates conclusion independently, archives only when eligibility and the Firestore write succeed, and compare-clears only when that day is still the current pointer, with no parent-trip completion or aggregate archive field. (`app/api/itinerary/store.ts:32-119`, `app/api/itinerary/readLifecycle.ts:20-92`, `app/api/itinerary/ownership.ts:102-160`, `app/api/itinerary/store.ts:332-343`)

### Vocabulary collisions

- `"planning"` already means “no stop has started” in persisted JSON, while visible `"Planning"` is already the Plan button's busy `aria-label` and title. (`app/api/itinerary/store.ts:577-592`, `app/page.tsx:3333-3334`)
- User-facing errors say “try planning again” and “try planning it fresh,” while page/parser/search comments and identifiers also use planning for the generation workflow rather than lifecycle status. (`app/page.tsx:849-849`, `app/page.tsx:1386-1389`, `app/page.tsx:1818-1820`, `app/page.tsx:2155-2171`, `app/page.tsx:1985-1991`, `app/api/parse/route.ts:52-52`, `app/api/places/search/searchPlaces.ts:166-174`, `app/api/places/search/searchPlaces.ts:280-284`, `app/api/itinerary/fallbackParsed.ts:11-13`)
- The phrase “active plan” and identifiers `owner:<uid>:active`, `activeItineraryIdForOwner`, and `activeId` mean a last-written/current candidate pointer rather than guaranteed resumability: a pointer may be absent, dangling, ended, or completed, and collection GET applies lifecycle then `isResumable`. (`app/api/itinerary/store.ts:195-201`, `app/api/itinerary/store.ts:300-329`, `app/api/itinerary/route.ts:112-135`, `app/api/itinerary/readLifecycle.ts:24-30`, `app/api/itinerary/[id]/end/route.ts:104-115`)
- The UI primarily consumes stop status: active produces live/`now` styling and completed produces done styling; plan-level `itinerary.status` is not rendered as a label. (`app/ItineraryStrip.tsx:677-732`, `app/ItineraryMap.tsx:1108-1133`, `app/page.tsx:2718-2731`)
- The browser wire parser explicitly accepts the three itinerary statuses and four stop statuses; `page.tsx` searches for active stops, while `travelLegVisibility.ts` also consumes stop status to choose an outbound leg. (`app/lib/clientPayloads.ts:602-605`, `app/lib/clientPayloads.ts:870-872`, `app/page.tsx:1983-2013`, `app/lib/travelLegVisibility.ts:34-110`)
- `ItineraryStrip`, `ItineraryMap`, and the map test harness duplicate the stop-status string union at their view boundaries; those are stop presentation states rather than additional itinerary lifecycle enums. (`app/ItineraryStrip.tsx:60-60`, `app/ItineraryMap.tsx:52-52`, `app/test-harness/maps/MapsHarness.tsx:184-224`, `app/test-harness/maps/MapsHarness.tsx:943-980`)
- Arrival detection and travel-leg visibility receive a stop's `active` status as input, and the map harness uses `active`/`completed` to simulate lifecycle moments. (`app/lib/arrivalDetection.ts:80-92`, `app/lib/arrivalDetection.ts:239-240`, `app/lib/travelLegVisibility.ts:11-61`, `app/test-harness/maps/MapsHarness.tsx:941-980`, `app/test-harness/maps/MapsHarness.tsx:1232-1246`)
- Profile `completed` means survey completion, and preference value `active` renders as “Active & sporty” and appears as the same taste word in the swap-model prompt; neither is itinerary lifecycle state. (`app/api/profile/route.ts:71-100`, `app/api/profile/profileStore.ts:82-111`, `app/api/parse/plannerPreferences.ts:130-130`, `app/lib/tastePreferences.ts:180-180`, `app/api/itinerary/swap.ts:202-202`)
- Resume selection, mutation banners, and editability variables also use `active`/`completed` stop states, distinct from the itinerary-level status even when the string values coincide. (`app/page.tsx:2181-2185`, `app/page.tsx:2292-2299`, `app/page.tsx:2718-2731`)
- Every CSS `:active` occurrence denotes pointer/keyboard press state rather than itinerary status. (`app/globals.css:248-248`, `app/globals.css:315-327`, `app/globals.css:1005-1020`, `app/globals.css:1128-1128`, `app/globals.css:1327-1343`, `app/globals.css:1503-1503`, `app/globals.css:1650-1650`, `app/globals.css:1720-1720`)
- Auth and live tracking also use their own status domains; their state types are not `ItineraryStatus`. (`app/lib/useAuth.ts:25-46`, `app/lib/liveTracking.ts:213-252`)
- The current `/mode`, `modeSwitch`, and mode radiogroups use “mode” specifically for transit-versus-driving, separate from lifecycle status. (`app/api/itinerary/[id]/mode/route.ts:20-40`, `app/api/itinerary/modeSwitch.ts:1-18`, `app/page.tsx:3318-3327`)

## 4. SCHEDULING ENGINE

**VERDICT — Core scheduling and travel arithmetic already crosses midnight as absolute elapsed time; the restrictive assumptions are one calendar qualifier, one timezone, and one origin per itinerary.** (`app/api/schedule/schedule.ts:574-652`, `app/lib/zoneTime.ts:1-30`)

### Clocks and midnight

- With an explicit `now`, `buildSchedule` advances home travel, stop duration, and inter-stop travel deterministically by epoch milliseconds with no midnight-specific branch; omitting `now` reads `new Date()`, so the defaulted call is not referentially pure. (`app/api/schedule/schedule.ts:574-608`, `app/api/schedule/schedule.ts:610-652`)
- Stop timestamps are serialized in one supplied IANA timezone, defaulting to `America/Toronto`; every stop in an invocation shares that zone. (`app/api/schedule/schedule.ts:586-597`, `app/lib/zoneTime.ts:9-30`)
- Local date changes use Luxon calendar arithmetic, invalid dates and spring-forward gaps are rejected, and fall-back overlaps choose the earliest matching instant. (`app/lib/zoneTime.ts:88-96`, `app/lib/zoneTime.ts:98-150`)
- Time parsing represents one qualifier—none, today, tomorrow, weekday, or date—and rejects multiple qualifiers with “Choose one day.” (`app/api/schedule/schedule.ts:183-194`, `app/api/schedule/schedule.ts:245-269`)
- Time labels compare each stop's start date with the supplied reference date: past/same-day starts have no prefix, next-day starts say “tomorrow,” and later dates use a weekday/date label; a stop's end receives no independent date prefix even when that stop spans midnight. (`app/lib/timeLabels.ts:46-61`, `app/lib/timeLabels.ts:73-90`, `app/lib/timeLabels.test.ts:48-60`)
- `datePrefix`, `formatStopTime`, and `formatStopRange` each default an omitted reference clock to `new Date()`, so repeated per-day calls are deterministic only when the caller supplies the same reference instant. (`app/lib/timeLabels.ts:46-70`, `app/lib/timeLabels.ts:73-90`)
- Travel-leg accumulation is absolute and sequential; a focused test proves that 23:00 plus a 15-minute leg and a 105-minute stay produces a 01:00 next-day departure. (`app/api/schedule/travel.ts:997-1040`, `app/api/schedule/travel.test.ts:954-967`)
- One exported 30-minute stated-window overrun tolerance is shared: initial fit counts leading stops ending by the stated end plus tolerance, swap uses it as the end-confirm threshold, and mode switch uses it as the end-note threshold. (`app/api/schedule/schedule.ts:508-540`, `app/page.tsx:1363-1441`, `app/api/itinerary/swap.ts:1129-1151`, `app/api/itinerary/modeSwitch.ts:188-198`)

### Repeat invocation and hidden state

- Scheduler state is invocation-local: `start`, `cursor`, `timed`, and `timedIndex` are recreated for each `buildSchedule` call. (`app/api/schedule/schedule.ts:586-612`)
- Travel state is invocation-local: each `getTravelLegs` call creates its own cursor and leg array, and its one plan travel mode is passed as an argument. (`app/api/schedule/travel.ts:997-1040`)
- Routing consults global wall time only to decide whether Google receives `departureTime`; past departures omit that provider field. (`app/api/schedule/travel.ts:822-855`)
- Fresh travel identities use injectable `globalThis.crypto.randomUUID()`, and palette allocation operates only on the supplied leg topology. (`app/api/schedule/travel.ts:128-153`, `app/api/schedule/travel.ts:387-468`)
- These functions have no mutable trip singleton, but each invocation is structurally one chain with one timezone, origin, travel mode, and sequential cursor. (`app/api/schedule/schedule.ts:574-612`, `app/api/schedule/travel.ts:997-1040`)

### Origin/home boundary

- `HomePoint` is one label plus one coordinate; it is a waypoint rather than a stop and contributes only the home-to-first-stop leg. (`app/api/schedule/home.ts:1-11`)
- With no entered address, the origin is the geocoded city center; with an address, the address becomes the origin, while the plan timezone remains the selected city's timezone. (`app/page.tsx:942-985`)
- Routing receives `[home, ...venues]`; the first route is converted to the `HOME_LEG_INDEX` sentinel and the remaining routes are reindexed for stop scheduling. (`app/page.tsx:1319-1348`, `app/api/schedule/home.ts:21-39`)
- No current origin path derives home from a previous itinerary's last stop or lodging: the caller supplies one `HomePoint`, and the scheduler accepts one home leg. (`app/api/schedule/home.ts:7-11`, `app/api/schedule/schedule.ts:586-596`)

### Arrival detection

- Arrival detection is display-only and folds the active stop ID, caller-measured distance, accuracy, freshness, and time without mutating itinerary or schedule state. (`app/lib/arrivalDetection.ts:1-23`, `app/lib/arrivalDetection.ts:80-109`)
- Arrival policy is 75 metres for 45 seconds on fresh fixes; a known finite accuracy radius above 75 metres is inconclusive, while `accuracyM:null` is permitted to accumulate/confirm because unusable device accuracy is normalized to null. (`app/lib/arrivalDetection.ts:35-78`, `app/lib/arrivalDetection.ts:191-220`, `app/lib/arrivalDetection.test.ts:178-186`, `app/lib/youMarker.ts:81-84`)
- Arrival progress contains only arrived/dwell stop IDs and dwell start time; it contains no day, date, or itinerary ID. (`app/lib/arrivalDetection.ts:112-129`)
- A confirmed arrival clears when the active stop ID changes or the page hard-resets on itinerary replacement/end; an unconfirmed dwell also clears on no/bad measurement, no active stop, invalid clock, or an out-of-range fix, and a backward clock restarts the dwell from that instant. (`app/lib/arrivalDetection.ts:143-182`, `app/lib/arrivalDetection.ts:206-235`, `app/page.tsx:2068-2086`, `app/page.tsx:2888-2902`)
- Midnight has no reset branch: a day change under the same itinerary and active-stop identity does not itself clear arrival progress, while a different itinerary ID does trigger the page-level reset. (`app/lib/arrivalDetection.ts:143-182`, `app/page.tsx:2888-2902`)

## 5. ROUTES & MUTATION SURFACE

**VERDICT — Every itinerary route addresses one flat itinerary resource and one stop chain; the complete route/body validator surface carries no Trip ID, day index, parent ownership, or sibling-day membership.** (`app/api/itinerary/store.ts:32-119`, `app/api/_shared/schemas.ts:106-397`, `app/api/itinerary/route.ts:37-141`, `app/api/itinerary/[id]/route.ts:15-82`, `app/api/itinerary/[id]/end/route.ts:22-132`, `app/api/itinerary/[id]/mode/route.ts:20-103`, `app/api/itinerary/[id]/remove/route.ts:17-104`, `app/api/itinerary/[id]/reroute/route.ts:19-89`, `app/api/itinerary/[id]/swap/route.ts:21-109`)

| Route | Current behavior and singular-plan boundary |
|---|---|
| `POST /api/itinerary` | Creates one 1–8-stop itinerary, stamps ownership only when caller verification succeeds, stores one document, and best-effort writes that caller's current pointer; repeated day creation leaves the last successfully written pointer discoverable through resume. (`app/api/itinerary/route.ts:37-110`, `app/api/_shared/schemas.ts:331-389`, `app/api/itinerary/store.ts:309-329`) |
| `GET /api/itinerary` | Requires a verified caller but returns `itinerary:null` rather than 401 when none exists; otherwise it resolves one owner pointer and returns one resumable itinerary or `null`, without enumerating/advancing sibling days. (`app/api/itinerary/route.ts:112-140`, `app/api/itinerary/readLifecycle.ts:20-31`) |
| `GET /api/itinerary/[id]` | Validates a flat ID, accepts optional simulated time, ownership-gates owned data, runs lifecycle, and returns one full itinerary with ETag; it does not apply `isResumable`, so ended/completed plans remain directly readable when authorized. (`app/api/itinerary/[id]/route.ts:15-82`, `app/api/itinerary/readLifecycle.ts:20-60`, `app/api/itinerary/ownership.ts:60-78`) |
| `POST /api/itinerary/[id]/end` | Accepts `save-end`/`discard-end`/`cancel`, requires verified exact ownership even for cancel, has no client expected-version/ETag input, and uses unversioned CAS for accepted conclusions before pointer clear; it has no parent-trip transition. (`app/api/itinerary/[id]/end/route.ts:22-132`, `app/api/itinerary/stopPlan.ts:17-65`) |
| `POST /api/itinerary/[id]/mode` | Changes one itinerary's plan-level transit/driving intent and reprices its still-movable legs while keeping venues; no sibling-day mode propagation exists. (`app/api/itinerary/[id]/mode/route.ts:20-103`, `app/api/itinerary/modeSwitch.ts:203-249`, `app/api/itinerary/modeSwitch.ts:396-450`) |
| `POST /api/itinerary/[id]/remove` | Removes one local stop index and re-times that itinerary's tail, while refusing to leave zero timed venues; an itinerary day cannot be reduced to an intentionally empty day. (`app/api/itinerary/[id]/remove/route.ts:17-104`, `app/api/itinerary/removeStop.ts:90-109`, `app/api/itinerary/removeStop.ts:125-134`, `app/api/itinerary/removeStop.ts:393-515`) |
| `POST /api/itinerary/[id]/reroute` | Handles only one cancelled inter-stop leg and replans eligible downstream stops within the same itinerary; it has no ownership gate and no cross-day blast radius. (`app/api/itinerary/[id]/reroute/route.ts:19-89`, `app/api/itinerary/reroute.ts:228-304`, `app/api/itinerary/reroute.ts:474-530`) |
| `POST /api/itinerary/[id]/swap` | Mutates one local stop index plus its same-itinerary tail under that itinerary's home/timezone/stated-end fields; it cannot reach sibling days or a parent document. (`app/api/itinerary/[id]/swap/route.ts:21-109`, `app/api/itinerary/swap.ts:1177-1269`) |

- All JSON request bodies share a 256 KiB limit, and itinerary creation remains capped at eight stops/nine route points. (`app/api/_shared/http.ts:5-13`, `app/api/_shared/http.ts:123-143`)
- All flat by-ID routes accept only `[A-Za-z0-9-]{1,128}`, so composite IDs containing `/` or `:` are rejected. (`app/api/itinerary/[id]/route.ts:30-36`, `app/api/itinerary/[id]/end/route.ts:37-43`, `app/api/itinerary/[id]/mode/route.ts:51-57`, `app/api/itinerary/[id]/remove/route.ts:41-47`, `app/api/itinerary/[id]/reroute/route.ts:25-31`, `app/api/itinerary/[id]/swap/route.ts:32-38`)

### Ownership logic

- `CallerIdentity` is only `{uid,isAnonymous}`; UID equality controls access and anonymity controls history. (`app/api/itinerary/ownership.ts:14-21`, `app/api/itinerary/ownership.ts:52-58`)
- Missing/blank stored UID is legacy/unowned; `stampOwner` records only a verified nonblank caller and `ownsItinerary` requires exact trimmed UID equality. (`app/api/itinerary/ownership.ts:23-58`)
- `enforceItineraryOwnership` runs caller verification and itinerary load in parallel, returns the same 404 for missing and unauthorized owned plans, and permits unowned/legacy plans to any caller. (`app/api/itinerary/byIdOwnership.ts:35-55`)
- Swap/remove/mode invoke that helper before body parsing and CAS; the helper returns neither caller nor loaded plan because current code assumes `ownerUid` is immutable after creation. (`app/api/itinerary/byIdOwnership.ts:18-28`, `app/api/itinerary/[id]/swap/route.ts:34-44`, `app/api/itinerary/[id]/remove/route.ts:43-53`, `app/api/itinerary/[id]/mode/route.ts:53-63`)
- By-ID GET duplicates the initial matrix inline and additionally passes the verified owner into each lifecycle CAS retry; legacy reads pass no caller. (`app/api/itinerary/[id]/route.ts:46-75`, `app/api/itinerary/readLifecycle.ts:64-91`)
- End differs by requiring a verified caller and exact ownership even for an otherwise legacy/unowned plan. (`app/api/itinerary/[id]/end/route.ts:53-67`, `app/api/itinerary/ownership.ts:52-58`)
- Reroute invokes no ownership verification. (`app/api/itinerary/[id]/reroute/route.ts:1-89`)
- If each day copies `ownerUid`, current checks establish ownership of that day but not membership in a parent Trip; if ownership exists only on the parent and the day omits `ownerUid`, current code classifies the day as legacy and opens GET/swap/remove/mode to capability-by-ID access. (`app/api/itinerary/store.ts:32-119`, `app/api/itinerary/ownership.ts:23-58`, `app/api/itinerary/byIdOwnership.ts:41-55`)

## 6. PARSE / AI PIPELINE

**VERDICT — The AI pipeline represents one flat outing: one resolved city/timezone is supplied and injected by the client, while the model contract carries one activity list of at most eight stops, one start/end intent, one context object, and at most one clarification round.** (`app/page.tsx:942-952`, `app/page.tsx:1028-1055`, `app/api/parse/planner.ts:33-49`, `app/api/parse/planner.ts:86-138`, `app/page.tsx:1067-1108`)

### Parsed and planner shapes

- `ParsedPrompt` contains `time_window`, nullable `stop_count`, `aesthetic`, `category_signals`, `group_context`, nullable `budget`, `constraints`, and `location`, plus optional app-injected `city`, `home`, and `cityCenter`. (`app/api/places/search/filter.ts:35-63`)
- `location` is one neighbourhood within the city, `home` is one starting/distance anchor, and `cityCenter` is one weather anchor. (`app/api/places/search/filter.ts:44-62`)
- Server validation reconstructs only those fields, caps stop count and list fields at eight, validates the two coordinate objects, and normalizes legacy stop-count slots. (`app/api/_shared/schemas.ts:110-169`)
- `PlannedActivity` has one dense slot, intent, map-search query, estimated duration, and confidence flag; `PlanIntent` has one activity array, one `TimeIntent`, one question array, and one context. (`app/api/parse/planner.ts:86-138`)
- `TimeIntent` has one nullable start, one nullable end, one kind, and one label. (`app/api/parse/planner.ts:102-114`)
- Planner hard bounds are 15–360 minutes per activity, eight activities, three questions, eight options, a 14-day future-start horizon, and a 60-minute ordinary past-start limit. (`app/api/parse/planner.ts:33-49`, `app/api/parse/planner.ts:473-493`)

### Current one-day pipeline

- The client rejects degenerate input, geocodes first, resolves one city timezone, then calls `/api/parse` with one prompt, one current instant, one timezone, one city, and optional answers. (`app/page.tsx:865-891`, `app/page.tsx:999-1046`)
- City, home, and city center are injected into `ParsedPrompt` after the planner response rather than inferred by the model. (`app/page.tsx:1048-1055`)
- The system prompt explicitly defines a “hyperlocal day-plan generator,” a flat activity array, one time intent, and one context object. (`app/api/parse/planner.ts:148-189`)

  > `You are the PLANNER for a hyperlocal day-plan generator. You turn one free-text request into the SHAPE of a day` (`app/api/parse/planner.ts:148-148`)

- With no stated count or window, the prompt asks for two or three activities, never more than eight, and applies ordering and variety rules across the whole day. (`app/api/parse/planner.ts:191-208`)

  > `With no stated window and no stated count, 2 to 3 activities make a good outing.` (`app/api/parse/planner.ts:202-203`)

- Relative time is resolved against one current instant and one timezone; an end is emitted only for a user-stated finish or duration. (`app/api/parse/planner.ts:232-239`)
- Valid output is sorted and renumbered into dense slots, durations are clamped, question IDs are deduplicated, and missing time/activity questions are synthesized in code. (`app/api/parse/planner.ts:620-733`)
- Validation performs one model answer, one correction retry on the same model, then a deterministic one-stop fallback. (`app/api/parse/planner.ts:740-857`)
- The per-model fallback wrapper surrounds that entire answer/correction ladder; after a successful outcome the route applies deterministic raw-prompt time floors and removes leaked activity-preference constraints. (`app/api/parse/route.ts:132-159`, `app/api/parse/planner.ts:1007-1033`)
- Clarification is one additional `/api/parse` request; questions returned after that second pass are ignored. (`app/page.tsx:1067-1108`)
- `planToParsed` flattens activity search queries into `category_signals`, sets `stop_count` to null, and copies the single context; no trip/day/landing/departure/lodging data survives this adapter. (`app/api/parse/planner.ts:1038-1065`)
- `planStartInstant` converts the planner's single time intent into one anchor, and the client reuses that resolved instant for weather/hours filtering and as the start override after sequential route calculation. (`app/api/parse/planner.ts:1068-1076`, `app/page.tsx:1123-1162`, `app/page.tsx:1294-1360`)
- The relevant shared schema is flat and bounded rather than trip-aware: it accepts `stop_count` only from 1 through `REQUEST_LIMITS.categories` and reconstructs one `category_signals` list. (`app/api/_shared/schemas.ts:110-139`)

  > `stopCount > REQUEST_LIMITS.categories` … `category_signals: stringList(value.category_signals, "parsed.category_signals")` (`app/api/_shared/schemas.ts:113-131`)

- `_shared/models.ts` names only planner/select/swap call types, while `openrouter.ts` builds a generic messages request; neither module contains a trip/day/landing/departure schema, so the single-day contract resides in planner types/prompts, `ParsedPrompt`, and downstream flat limits rather than in transport. (`app/api/_shared/models.ts:1-21`, `app/api/_shared/models.ts:64-125`, `app/api/_shared/openrouter.ts:103-122`, `app/api/parse/planner.ts:86-208`)
- The repository contains neither an extended trip schema nor a parallel trip pipeline, so the choice between those future structures is not established by current implementation evidence. (`app/api/parse/planner.ts:86-138`, `app/api/places/search/filter.ts:35-63`, `app/api/_shared/schemas.ts:110-169`)
- Search concatenates plan-wide aesthetic, every constraint, category, one neighbourhood, and one city; an absent city falls back to Toronto. (`app/api/places/search/searchPlaces.ts:72-94`)
- Objective filtering uses one plan budget and one resolved start/forecast bucket across the pools. (`app/api/places/search/filter.ts:139-176`)
- Selection receives one plan-wide aesthetic, group context, budget, and constraint list plus flat slots and candidate pools. (`app/api/select/selectVenues.ts:440-470`)
- The finalized `ParsedPrompt` is persisted so swap and reroute can reuse it. (`app/api/itinerary/store.ts:87-88`, `app/api/itinerary/route.ts:46-87`)

### Personalization

- Planner preferences contain only optional `style`, `foods`, `dietary`, and `activities` arrays. (`app/api/parse/plannerPreferences.ts:146-161`)
- Preferences are read only for a verified non-anonymous UID, are supplied on both planner passes, and cannot make planning fail. (`app/api/parse/route.ts:39-70`, `app/api/parse/route.ts:104-124`)
- Planner policy makes request text win per aspect; preferences cannot add/remove stops, change time/count, or become hard constraints. (`app/api/parse/planner.ts:216-230`)

### Model, context, and cost limits

- Planner and selector default to `meta-llama/llama-3.3-70b-instruct`, `openai/gpt-oss-120b`, then `openai/gpt-oss-20b`; swap uses the 8B model, 20B model, then 70B model. (`app/api/_shared/models.ts:64-86`)
- Each call-type chain can be replaced by its corresponding environment variable. (`app/api/_shared/models.ts:88-114`)
- Only provider 429 and provider-side 5xx responses advance the model chain. (`app/api/_shared/provider.ts:70-84`, `app/api/_shared/modelFallback.ts:43-100`)
- OpenRouter routing requires parameter-compatible endpoints, sorts by throughput, and filters endpoints above `$5/M` prompt or `$10/M` completion pricing. (`app/api/_shared/openrouter.ts:34-85`, `app/api/_shared/openrouter.ts:103-122`)
- `max_price` is a per-million-token endpoint-rate filter, not a total call-cost or token-count cap. (`app/api/_shared/openrouter.ts:72-85`)
- The locally documented measured planner cost is approximately `$0.002` per call versus approximately `$0.0005` on the cheapest endpoint. (`CLAUDE.md:22`)
- The OpenRouter body contains no `max_tokens`, `max_completion_tokens`, context-length, or total-spend field. (`app/api/_shared/openrouter.ts:103-122`)
- The route reads only `choices[0].message.content`; token-usage fields are not consumed or logged. (`app/api/parse/route.ts:75-101`)
- Input is capped at 256 KiB and 2,000 prompt characters, while planner content is rejected above 50,000 characters. (`app/api/_shared/http.ts:5-14`, `app/api/parse/route.ts:89-101`)
- Current model context-window sizes are neither stored nor enforced in the model-chain or OpenRouter request definitions, so the repository cannot establish a context-window limit for an N-day generation. (`app/api/_shared/models.ts:64-125`, `app/api/_shared/openrouter.ts:103-122`)
- The presently observable N-day boundary is therefore structural rather than a measured model-limit result: the validated activity array and downstream category/route-point shapes stop at eight, while no total-token accounting is recorded. (`app/api/parse/planner.ts:33-49`, `app/api/_shared/http.ts:5-14`, `app/api/parse/route.ts:75-101`)

## 7. UI STRUCTURE

**VERDICT — The client is one large page-level state machine holding one current `Itinerary`; it has no top-level trip/day tabs, no active-day index, and no multi-document save coordinator, while the strip and map already accept day-shaped data through props.** (`app/page.tsx:584-615`, `app/page.tsx:3125-3363`, `app/ItineraryStrip.tsx:857-940`, `app/ItineraryMap.tsx:229-258`)

### Top-level state and rendering

- `Home` keeps prompt, city, starting address, travel mode, one home point, one timezone, one pool set, one schedule, one home leg, one map-stop array, one `Itinerary`, one selected venue ID, one manual leg ID, and one weather-block array in local React state; there is no React context or trip collection in this state boundary. (`app/page.tsx:584-615`)
- The page has a binary render split: `itinerary === null` returns the landing/planning form, and a non-null itinerary returns the map stage; there is no top-level tab list or tab panel around either branch. (`app/page.tsx:3124-3359`)
- The landing form invokes `runPipeline`, while the populated stage mounts one `ItineraryMap`, one `ItineraryStrip`, and a replan form whose controls all read the same current itinerary. (`app/page.tsx:3248-3253`, `app/page.tsx:3359-3418`, `app/page.tsx:3460-3525`)
- Plan persistence is not polled: after authentication settles, a one-shot effect GETs `/api/itinerary`, parses at most one returned itinerary, and marks the resume attempt complete; the canonical notes also state that no interval exists and status changes arrive only on an existing render/read cadence. (`app/page.tsx:2155-2195`, `CLAUDE.md:87`)
- `itineraryRef` mirrors the single itinerary for race checks, `applyItinerary` rejects a response for a replaced ID or older version, and `clearItineraryState` nulls the itinerary plus all derived single-plan state. (`app/page.tsx:2028-2058`, `app/page.tsx:2061-2087`, `app/page.tsx:2151-2153`)
- The two current structural boundaries at which a top-level mode could affect rendering are immediately before the `if (!itinerary)` landing/stage split and inside the populated stage before its map/topbar children; neither boundary currently carries a trip object or an active-day index. (`app/page.tsx:3124-3127`, `app/page.tsx:3359-3363`, `app/page.tsx:3460-3467`)

### Existing controls and component boundaries

- The existing mode-switch pattern is an accessible two-option radiogroup: the landing control maps `transit`/`driving` to `role="radio"` buttons with `aria-checked`, and the populated topbar repeats that pattern while adding an in-flight pending class and disabling both options. (`app/page.tsx:3298-3328`, `app/page.tsx:3476-3525`)
- `ItineraryStrip` receives one `stops` array, optional home row, timezone, selection/focus callbacks, mutation callbacks, version-sensitive UI flags, and one display clock; it does not fetch or own an itinerary document. (`app/ItineraryStrip.tsx:857-883`)
- The strip maps the supplied stop array in order, numbers cards by array position, and renders home and inter-stop leg cards from supplied leg data, making its external data boundary one ordered day-shaped sequence rather than the store document itself. (`app/ItineraryStrip.tsx:885-940`)
- Each `StopCard` owns only local interaction state such as the armed remove confirmation; its timing, status, venue, price, selection, arrival, and callbacks come from the parent. (`app/ItineraryStrip.tsx:631-700`)
- Day-specific wording remains hardcoded: the strip's group is labelled “Your evening,” and the landing and populated prompt inputs are labelled “Describe your evening.” (`app/ItineraryStrip.tsx:902`, `app/page.tsx:3265-3267`, `app/page.tsx:3469-3475`)
- `HistoryPanel` loads a flat history list once per open, keeps one opened entry ID, and renders one read-only `PlanDetail`; `AccountMenu` only owns menu disclosure and delegates Preferences, History, and Sign out to parent callbacks. (`app/HistoryPanel.tsx:44-91`, `app/HistoryPanel.tsx:122-145`, `app/HistoryPanel.tsx:245-274`, `app/AccountMenu.tsx:39-58`, `app/AccountMenu.tsx:134-176`)

### Map switching behavior

- The request's “48K, largest client file” premise is stale in the tracked source inspected: `ItineraryMap.tsx` ends at line 1,165, while `page.tsx` ends at line 3,721. (`app/ItineraryMap.tsx:1160-1165`, `app/page.tsx:3716-3721`)
- `ItineraryMap` receives stops, home, selected ID, timezone, visible leg IDs, focus request, live-position rendering, and arrival samples entirely by props; it does not call the Routes API. (`app/ItineraryMap.tsx:229-258`)
- The Google map instance and projection probe are created once per loader retry and retained in refs; changing stops does not construct a new `google.maps.Map`. (`app/ItineraryMap.tsx:258-341`)
- A stops/home/visibility change cleans up the prior native polylines and constructs new route overlays from already-supplied encoded geometry and path segments; this is client-side reconstruction, not route-data refetching. (`app/ItineraryMap.tsx:343-408`, `app/ItineraryMap.tsx:676`)
- `fitKey` contains only rounded venue/home coordinates, so changed day geography triggers `fitAllStops`, while status-only changes do not reframe the map; one point centers at zoom 15 and multiple points call `fitBounds`. (`app/ItineraryMap.tsx:678-709`)
- Stop markers/chips are likewise projected from the current supplied stop array, so replacing that array replaces the rendered pin set. (`app/ItineraryMap.tsx:1104-1158`)

### Writes, retries, and partial-save semantics

- `pendingWrite.ts` is not a general optimistic-write layer: it tracks one promise in a ref and makes the next plan wait for an in-flight taste-profile write, swallowing that write's failure because planning must still continue. (`app/lib/pendingWrite.ts:1-21`, `app/lib/pendingWrite.ts:23-46`)
- `clientFetch.ts` gives every JSON request a default 25-second deadline, composes caller cancellation, distinguishes timeout/abort/network/HTTP/invalid-JSON/invalid-payload errors, and performs optional runtime parsing or guarding. (`app/lib/clientFetch.ts:1-20`, `app/lib/clientFetch.ts:83-177`)
- `retryableLoader.ts` caches and coalesces provider-library load promises and evicts a rejected promise so a later call can retry; it does not retry itinerary mutations. (`app/lib/retryableLoader.ts:1-18`)
- Current mutation flows send one itinerary ID and expected version to the server, apply the returned version only after success, and, when the transport outcome could be ambiguous, reread that same itinerary ID before deciding what the client should show. (`app/page.tsx:2197-2205`, `app/page.tsx:2239-2319`, `app/page.tsx:2371-2467`, `app/page.tsx:2486-2603`, `app/page.tsx:2607-2715`)
- There is therefore no present client transaction, rollback record, or completion barrier spanning N itinerary documents; all response-order guards and ambiguous-result recovery are keyed to one `itinerary.id` and one `version`. (`app/page.tsx:2028-2058`, `app/page.tsx:2197-2205`, `app/page.tsx:2239-2319`)

## 8. ADJACENT SYSTEMS THAT A TRIP WILL TOUCH

**VERDICT — Budget, weather, history, live tracking, preferences, guards, and recovery are all scoped to one flat itinerary or one user profile; none carries trip/day identity, cross-day totals, or cross-day recovery state.** (`app/lib/budget.ts:1-66`, `app/api/weather/fetchWeather.ts:24-61`, `app/api/itinerary/ownership.ts:116-160`, `app/lib/liveTracking.ts:177-252`, `app/lib/tastePreferences.ts:304-332`, `app/api/_shared/schemas.ts:127-139`, `app/lib/recoverySlots.ts:3-24`)

### Budget

- Budget is one plan-wide venue filter/ranking signal, represented as a Places-level ceiling, relative “cheap,” or one numeric maximum with optional currency. (`app/lib/budget.ts:1-47`)
- Recognized markers map `$`/`US$` to USD, `C$`/`CA$` to CAD, and support EUR, GBP, and JPY. (`app/lib/budget.ts:6-20`)
- Numeric maxima do not become hard Places filters because Places exposes only relative price levels. (`app/lib/budget.ts:49-66`, `app/api/places/search/filter.ts:253-258`)
- `Place` has only `priceLevel`, with no cost amount or currency field. (`app/api/places/search/filter.ts:11-18`)
- The UI renders generic `$` through `$$$$`; when the price-label lookup is falsy and the category resolves to park it renders “Free,” which includes missing, explicit `PRICE_LEVEL_FREE`, and unrecognized price values. (`app/ItineraryStrip.tsx:97-102`, `app/ItineraryStrip.tsx:676-676`, `app/ItineraryStrip.tsx:747-759`)
- No per-stop cost arithmetic, currency conversion, daily subtotal, or trip total exists in the current budget or place shapes. (`app/lib/budget.ts:1-66`, `app/api/places/search/filter.ts:11-18`)

### Weather

- Weather requests exactly 24 hourly records for one latitude/longitude and fixes units to `METRIC`; failures return `null` under keep-on-missing behavior. (`app/api/weather/fetchWeather.ts:24-65`)
- The public weather route also requires one coordinate pair and caches provider data for ten minutes. (`app/api/weather/route.ts:43-78`)
- The initial pipeline fetches weather once at the selected city center and passes that one array into Places filtering. (`app/page.tsx:1123-1166`)
- Initial filtering uses the single plan-start forecast bucket for every outdoor category. (`app/api/places/search/filter.ts:161-214`)
- A target outside the returned forecast horizon has no matching bucket, so weather filtering is skipped rather than blocking. (`app/api/places/search/filter.ts:114-128`, `app/api/places/search/filter.ts:173-187`)
- Swap and reroute use one stored city-center coordinate, falling back to home for older plans. (`app/api/itinerary/swap.ts:713-723`, `app/api/itinerary/reroute.ts:306-316`)

### History

- Automatic/natural archiving requires a completed, non-discarded, owned, explicitly non-anonymous, not-already-archived itinerary; explicit verified-owner `save-end` can archive before clock completion. (`app/api/itinerary/ownership.ts:86-113`, `app/api/itinerary/[id]/end/route.ts:69-99`, `app/api/itinerary/stopPlan.ts:43-54`)
- One archived document contains itinerary ID, owner UID, created/archive timestamps, one timezone, and one flat stop list. (`app/api/itinerary/ownership.ts:116-160`)
- The archive deliberately excludes pools, provider payloads, polylines, home, and other live-plan state. (`app/api/itinerary/ownership.ts:136-160`)
- Archive storage is `users/<uid>/history/<itineraryId>`, while Redis remains the live source of truth. (`app/api/itinerary/history.ts:8-35`)
- History has no title, original prompt, city, venue coordinates, or travel legs. (`app/lib/historyView.ts:10-15`, `app/HistoryPanel.tsx:3-13`)
- Each rendered history entry has one timezone, one date label, one first-start-to-last-end span, and flat stop views. (`app/lib/historyView.ts:48-67`, `app/lib/historyView.ts:180-219`)
- The entry date comes from the first stop with a usable start instant, then falls back to `createdAt` and finally `archivedAt`; individual stop ranges contain times but no per-stop date labels. (`app/lib/historyView.ts:98-108`, `app/lib/historyView.ts:180-214`)
- Explicit `save-end` archives the raw loaded itinerary before any `withStatuses` call, and the archive projection copies stored stop statuses, so that explicit history record may preserve statuses that are stale relative to the request-time clock. (`app/api/itinerary/[id]/end/route.ts:59-99`, `app/api/itinerary/ownership.ts:142-160`)
- The history surface is view-only, with no delete, edit, replay, or resume action. (`app/api/history/route.ts:16-23`, `app/HistoryPanel.tsx:245-274`)
- No trip ID, trip title, day grouping, arrival/departure facts, per-day location, or per-day timezone exists in the archive type. (`app/api/itinerary/ownership.ts:119-134`)

### Live tracking

- Live tracking is foreground-only and cannot continue through a backgrounded tab or locked screen. (`app/lib/liveTracking.ts:1-18`)
- Tracker state stores one last real device position and freshness/error metadata, with no itinerary, stop, date, or day identifier. (`app/lib/liveTracking.ts:177-252`)
- Tracker lifecycle variables are local to each `createLiveTracker` instance. (`app/lib/liveTracking.ts:347-358`)
- The React hook ties tracker lifetime only to one boolean `enabled` dependency. (`app/lib/useLiveTracking.ts:32-54`)
- Page enables tracking as `liveTrackWanted && Boolean(itinerary)`, and the opt-in persists across plans. (`app/page.tsx:671-681`)
- Switching directly between two non-null itinerary objects leaves that boolean true and does not itself recreate the tracker; changing to `null` stops it. (`app/lib/useLiveTracking.ts:42-54`, `app/page.tsx:671-681`)
- Arrival state separately resets when itinerary ID changes. (`app/page.tsx:2888-2902`)

### Taste/profile

- Taste data is one user-global profile with `style`, `foods`, `dietary`, and `activities`; only food supports sanitized free text, capped at 40 characters. (`app/lib/tastePreferences.ts:29-76`, `app/lib/tastePreferences.ts:101-109`)
- The profile is one Firestore document per UID containing those arrays, food free text, seen/completed flags, and a timestamp. (`app/lib/tastePreferences.ts:292-344`)
- `TasteSurvey` renders the shared four optional multi-select questions and submits one complete `TasteAnswers` value; `profileEdit.ts` maps the same fixed dimensions between stored profile and editor seed/dirty state. (`app/TasteSurvey.tsx:14-34`, `app/TasteSurvey.tsx:45-96`, `app/lib/profileEdit.ts:18-59`, `app/lib/profileEdit.ts:92-123`)
- Planner projection supplies the four optional preference arrays as background on each request, and a profile-read failure degrades to no preferences instead of failing the plan. (`app/api/parse/plannerPreferences.ts:219-286`, `app/api/parse/route.ts:44-69`, `app/api/parse/route.ts:104-124`)
- The profile type has no trip, day, destination, hotel, flight, pace, currency, or locale field. (`app/lib/tastePreferences.ts:304-332`)

### Constraints and guards

- Constraints are normalized, deduplicated, capped at 120 characters each, and applied conjunctively. (`app/lib/constraints.ts:3-24`, `app/lib/constraints.ts:91-100`)
- Structured evidence is limited to vegetarian food, outdoor seating/patio, live music, child suitability, dogs, and wheelchair facilities; names and prose are never evidence. (`app/lib/constraints.ts:26-56`)
- Alias parsing recognizes vegan, gluten-free, halal, and kosher, but the evidence builder emits none of those values. (`app/lib/constraints.ts:31-56`, `app/lib/constraints.ts:74-88`)
- All plan constraints are inserted into every category query and must be satisfied by every selected venue. (`app/api/places/search/searchPlaces.ts:72-94`, `app/api/select/selectVenues.ts:232-299`)
- `ParsedPrompt.constraints` is one plan-level array capped at eight entries, with no slot/day association. (`app/api/_shared/schemas.ts:127-139`)
- The contradiction guard evaluates one global combination of prompt, budget, aesthetic, constraints, and categories. (`app/lib/planGuards.ts:137-172`)
- Window validation operates on one optional end instant and one leading sequence of timed stops. (`app/api/schedule/schedule.ts:531-571`, `app/page.tsx:1363-1441`)

### Recovery and disruption

- `recoverySlots.ts` is pre-commit slot repair, not runtime disruption handling; its arrival map is keyed only by flat numeric slot. (`app/lib/recoverySlots.ts:3-24`, `app/page.tsx:1236-1283`)
- Provisional arrivals start from one plan anchor and add slot durations in absolute milliseconds without travel; final scheduled starts later overwrite them. (`app/lib/recoverySlots.ts:32-99`)
- Missing row timing falls back to the one plan anchor and then the Unix epoch. (`app/lib/recoverySlots.ts:101-113`)
- Recovery excludes IDs used by every other slot and merges provider pools by venue ID. (`app/lib/recoverySlots.ts:115-159`)
- The UI recovery union has exactly `geocode`, `empty`, and `weather-gate` modes. (`app/page.tsx:775-820`)
- One-slot recovery retains the original plan time, budget, and constraints, uses that slot's arrival instant, and changes only the matching slot. (`app/page.tsx:1589-1703`)
- Weather override bypasses only the weather gate; unresolved slots move into ordinary empty recovery. (`app/page.tsx:1832-1900`)
- Runtime disruption is handled separately by reroute, which may affect only unlocked, strictly downstream stops after the floor. (`app/api/itinerary/reroute.ts:228-257`)
- The reroute target is one contiguous downstream chain, anchored at the later of floor time and the previous kept stop's committed end. (`app/api/itinerary/reroute.ts:268-305`)
- Before commit, reroute verifies that every unaffected stop's ID, name, start, and end remain unchanged. (`app/api/itinerary/reroute.ts:496-532`)
- Neither pre-commit recovery nor runtime reroute represents missed-flight input, a trip-level schedule, sibling day IDs, or a cross-day blast radius. (`app/page.tsx:775-820`, `app/lib/recoverySlots.ts:3-24`, `app/api/itinerary/reroute.ts:228-305`)

## 9. INTERNATIONALIZATION

**VERDICT — One itinerary can already schedule and render in a resolved non-Toronto IANA timezone and geocoding is not North-America-format-bound, but currency display is symbolic, weather/distance policy is metric, UI copy is English-only, and one itinerary cannot express a journey that changes timezone.** (`app/api/itinerary/store.ts:49-53`, `app/api/geocode/zoneLookup.ts:1-16`, `app/lib/budget.ts:6-20`, `app/layout.tsx:17`)

### Currency and price representation

- The budget parser recognizes `$` as USD, `US$` as USD, `C$`/`CA$` as CAD, and the symbols or codes for EUR, GBP, and JPY; a bare numeric budget may have no currency. (`app/lib/budget.ts:6-20`, `app/lib/budget.ts:25-47`)
- Code enforcement uses ordinal Google Places levels rather than money amounts, and numeric maximums return no hard level ceiling. (`app/lib/budget.ts:49-66`, `app/api/places/search/filter.ts:253-258`)
- Venue cards convert Places levels to generic `$`, `$$`, `$$$`, or `$$$$` glyphs without attaching a currency code or locale formatter. (`app/ItineraryStrip.tsx:97-102`, `app/ItineraryStrip.tsx:747-759`)
- No current persisted stop, selection, or place shape carries a monetary amount and currency pair; those shapes carry only `priceLevel`. (`app/api/places/search/filter.ts:11-18`, `app/api/select/selectVenues.ts:58-80`, `app/api/schedule/schedule.ts:451-477`)

### Timezones and international date boundaries

- Each itinerary persists one optional resolved IANA timezone, with `America/Toronto` as the explicit absence fallback for older/unresolvable plans. (`app/api/itinerary/store.ts:49-53`)
- Geocoding derives that zone offline from the resolved latitude/longitude through server-only `tz-lookup`, while browser-safe arithmetic uses Luxon in `zoneTime.ts`. (`app/api/geocode/zoneLookup.ts:1-16`, `app/lib/zoneTime.ts:1-24`)
- Scheduling, hours checks, and time labels accept one timezone parameter for the whole itinerary rather than deriving a zone per stop. (`app/api/schedule/schedule.ts:574-597`, `app/api/places/search/hours.ts:128-190`, `app/lib/timeLabels.ts:46-90`)
- The test suite exercises non-Toronto lookup and display cases, including Europe/London geocoding and America/Vancouver time labels. (`e2e/geocode.spec.ts:52-76`, `app/lib/timeLabels.test.ts:48-60`, `app/api/geocode/zoneLookup.test.ts:18-63`)
- No itinerary field represents departure timezone, arrival timezone, or a timezone transition, and every stop produced by one `buildSchedule` invocation is serialized in the same supplied zone. (`app/api/itinerary/store.ts:32-119`, `app/api/schedule/schedule.ts:586-597`)

### Geocoding, addresses, and Places

- A valid city result may be typed `locality`, `postal_town`, or `administrative_area_level_3`, which accommodates provider locality taxonomies outside North America. (`app/api/geocode/geocode.ts:59-72`)
- User queries are Unicode-normalized and comparison folding explicitly uses the English locale, rather than an ASCII-only address parser. (`app/api/geocode/geocode.ts:146-160`)
- `CityContext` records one locality, region, country, two-letter country code, and coordinates; the provider component parser falls back through administrative levels when needed. (`app/api/geocode/geocode.ts:239-270`, `app/api/geocode/geocode.ts:381-442`)
- Address requests append country components plus region/bounds bias, then code validates country, broad region, distance, and street-address specificity instead of parsing a North-American street/postal template. (`app/api/geocode/geocode.ts:297-349`, `app/api/geocode/geocode.ts:555-638`)
- The address-specificity check recognizes provider `street_address`/`subpremise` types or a `street_number`; provider response types contain formatted address/components/geometry but no phone-number parsing path. (`app/api/geocode/geocode.ts:74-128`, `app/api/geocode/geocode.ts:555-583`)
- Google Places search requests `textQuery` and optional `includedType` with a fixed field mask for identity, coordinates, rating/count, price level, hours, business status, editorial summary, and selected accessibility/amenity booleans; it sends neither `languageCode` nor `regionCode`. (`app/api/places/search/searchPlaces.ts:34-58`, `app/api/places/search/searchPlaces.ts:113-127`)
- Search results do not retain address, phone, website, booking, or local-currency amount fields because those fields are absent from the mask and local `Place` shape. (`app/api/places/search/searchPlaces.ts:34-58`, `app/api/places/search/filter.ts:11-34`)

### Units

- Google Weather is requested with `unitsSystem=METRIC`, and the filter's cold-weather threshold and explanation use degrees Celsius. (`app/api/weather/route.ts:65-78`, `app/api/places/search/filter.ts:190-205`)
- The visible weather chip rounds `tempC` and prints a bare degree sign rather than a locale/unit label. (`app/page.tsx:3410-3415`)
- Routing and arrival logic store distance in metres; transit/walking thresholds and arrival policy are metre constants, not locale-selected values. (`app/api/schedule/travel.ts:23-62`, `app/lib/arrivalDetection.ts:35-78`)
- Map arrival sampling computes and passes metres, while no miles/feet display formatter appears in that render path. (`app/ItineraryMap.tsx:784-805`)

### Language

- The document root is fixed to `<html lang="en">`, metadata and visible UI labels are hardcoded English, and the package dependencies include no message-catalog or internationalization framework. (`app/layout.tsx:6-19`, `app/page.tsx:3243-3334`, `package.json:20-44`)
- Provider requests do not send a requested UI/content language to Geocoding, Places, Weather, or Routes. (`app/api/geocode/geocode.ts:324-349`, `app/api/places/search/searchPlaces.ts:113-127`, `app/api/weather/route.ts:65-78`, `app/api/schedule/travel.ts:822-865`)
- “International Appeal” can therefore mean geographic/timezone/currency reach without implying translated UI, or it can include language support; the supplied feature brief does not disambiguate those two scopes, and the current code has no locale state with which to resolve that ambiguity. (`app/layout.tsx:6-19`, `app/page.tsx:584-615`)

## 10. HOTELS / LODGING

**VERDICT — Production code has no hotel/lodging entity, booking or inventory provider, room/rate/availability record, check-in/check-out state, or hotel-night scheduling primitive; the only nearby mechanisms are generic Places discovery and a synchronous venue-hours availability seam.** (`app/api/places/search/filter.ts:11-34`, `app/api/itinerary/store.ts:32-119`, `app/api/_shared/provider.ts:3-34`, `app/api/itinerary/swap.ts:170-181`)

### What exists and what the matching words mean

- The only production `accommodation` wording in `app/` is dietary-language handling: `planGuards.ts` removes phrases such as accommodating a diet before judging a hard dietary contradiction, and `plannerPreferences.ts` documents that same phrase-stripping boundary. (`app/lib/planGuards.ts:108-114`, `app/api/parse/plannerPreferences.ts:188-190`)
- The shipped product documentation explicitly says there are no reservations or real-time availability and that “open” means opening-hours data only. (`README.md:276-279`)
- The canonical deferred-gap entry names OpenTable/Resy as absent reservation sources and identifies `SwapDeps.isUsableAt` as the existing venue-availability seam. (`CLAUDE.md:276-280`)
- `SwapDeps.isUsableAt` is a synchronous boolean callback over a `Place`, instant, and category; its default implementation delegates to objective opening-hours checks under keep-on-missing behavior. (`app/api/itinerary/swap.ts:170-181`, `app/api/itinerary/swap.ts:669-686`)
- That seam is consulted at the beginning and occupied end of a venue slot, but it represents venue usability rather than remotely queried rooms, rates, guests, nights, or booking inventory. (`app/api/itinerary/swap.ts:780-813`, `app/api/itinerary/swap.ts:885-904`)
- `ProviderName` is limited to `openrouter | places | routes | weather | geocoding | redis`, and the shared timeout table contains exactly those provider classes. (`app/api/_shared/provider.ts:3-34`)
- The OpenRouter helper is an LLM chat-completions body builder, not a generic inventory client; the generic reusable HTTP mechanics are `fetchProvider`, bounded body consumption, wrapped-error detection, and provider-safe error mapping. (`app/api/_shared/openrouter.ts:1-13`, `app/api/_shared/openrouter.ts:103-123`, `app/api/_shared/provider.ts:118-232`)

### Necessary touch surfaces established by current boundaries

- A hotel-availability backend call has no current route or provider discriminator: the complete API inventory contains geocode, history, itinerary, parse, Places, profile, schedule/travel, select, and weather surfaces only, while provider deadlines reject names outside the fixed `ProviderName` union. (`app/api/geocode/route.ts:18-49`, `app/api/history/route.ts:6-50`, `app/api/itinerary/route.ts:37-141`, `app/api/parse/route.ts:104-189`, `app/api/places/search/route.ts:26-104`, `app/api/profile/route.ts:37-105`, `app/api/schedule/travel/route.ts:21-63`, `app/api/select/route.ts:23-75`, `app/api/weather/route.ts:18-111`, `app/api/_shared/provider.ts:3-34`)
- No current environment variable names a hotel or booking provider; external secrets are presently limited to OpenRouter, four Google server APIs, Maps browser configuration, Firebase, and Redis aliases. (`DEPLOY.md:30-67`, `app/api/_shared/models.ts:88-114`, `app/api/itinerary/store.ts:154-173`)
- No persisted type can hold hotel identity, room/rate, reservation, check-in, or check-out state; the active document, server schema, and browser parser recognize only the current itinerary/stop/travel/home/owner/lifecycle fields. (`app/api/itinerary/store.ts:22-119`, `app/api/_shared/schemas.ts:331-397`, `app/lib/clientPayloads.ts:858-895`)
- No archive projection can retain hotel-night or stay state because its fixed record contains only plan/owner timestamps, timezone, and compact stop facts. (`app/api/itinerary/ownership.ts:116-160`, `app/lib/historyView.ts:28-71`)
- No planner schema can express landing, departure, hotel criteria, room occupancy, nights, or check-in/out because `PlanIntent` is one activity list plus one time intent/questions/context, and `ParsedPrompt` is one flattened day context. (`app/api/parse/planner.ts:86-138`, `app/api/places/search/filter.ts:35-63`)
- No schedule shape distinguishes an arrival day, full day, or departure day: it takes one start, one origin/home leg, one ordered activity chain, and at most one stated end. (`app/api/schedule/schedule.ts:574-652`, `app/api/itinerary/store.ts:40-68`)
- No origin transition expresses “checked into hotel” or “next morning at hotel”: `HomePoint` is one fixed label/coordinate outside the stop lifecycle, and every schedule invocation receives one home leg. (`app/api/schedule/home.ts:1-11`, `app/api/schedule/schedule.ts:586-596`)
- Consequently, arrival-day bounds, full-day bounds, departure-day bounds, and hotel-night boundaries are four facts the present single-chain model cannot distinguish; that conclusion follows from the single `TimeIntent`, single `plannedEndISO`, and single `HomePoint` fields rather than from a chosen future design. (`app/api/parse/planner.ts:102-114`, `app/api/itinerary/store.ts:40-68`)
- The deterministic mock seam currently substitutes only planner/select/geocode/Places/Routes/weather and itinerary-engine dependencies; the canonical mock rule says every new pipeline data source needs a fixture seam rather than a forked logic path. (`app/api/_mock/fixtures.ts:1-18`, `app/api/_mock/fixtures.ts:1045-1385`, `CLAUDE.md:116`)
- The existing external-integration operational boundary requires server secrets in deployment configuration, explicit provider timeouts/errors, and route-local input/rate bounds; these are observed conventions, not hotel-specific behavior already present. (`DEPLOY.md:30-67`, `app/api/_shared/provider.ts:3-34`, `app/api/_shared/http.ts:5-18`, `app/api/_shared/http.ts:86-123`)

## 11. TESTING SURFACE

**VERDICT — The deterministic harness is broad but uniformly exercises one itinerary at a time; all route/lifecycle tests, the flat planner/scheduler tests, the relevant client projections, and all 16 browser specs encode or consume that one-plan/one-day boundary, while the three formerly clock-sensitive scenarios are now fixed and the sole documented browser baseline failure is at 768 px.** (`CLAUDE.md:108-116`, `CLAUDE.md:110`, `DEVLOG.md:21`)

### Tests with direct one-plan ownership/persistence assumptions

- `app/api/history/route.test.ts` assumes history is the archive list reached from the current account rather than a parent trip collection. (`app/api/history/route.test.ts:1-18`)
- `app/api/itinerary/create.validation.test.ts` round-trips one created itinerary and its single stop/leg topology. (`app/api/itinerary/create.validation.test.ts:1-16`)
- `app/api/itinerary/driveModeEngines.test.ts` binds each mutation engine to one itinerary's stored travel mode. (`app/api/itinerary/driveModeEngines.test.ts:1-17`)
- `app/api/itinerary/itinerary.test.ts` derives one itinerary status from one ordered stop array and pins the lock ratchet. (`app/api/itinerary/itinerary.test.ts:1-7`, `app/api/itinerary/itinerary.test.ts:44-74`)
- `app/api/itinerary/lifecycle.routes.test.ts` exercises one active pointer, one itinerary conclusion, one archive record, and pointer-preservation races between plan A and plan B. (`app/api/itinerary/lifecycle.routes.test.ts:1-18`, `app/api/itinerary/lifecycle.routes.test.ts:189-213`, `app/api/itinerary/lifecycle.routes.test.ts:280-400`)
- `app/api/itinerary/modeSwitch.test.ts` reprices one plan's stop chain. (`app/api/itinerary/modeSwitch.test.ts:1-18`)
- `app/api/itinerary/mutationAuth.routes.test.ts` tests owner/stranger/anonymous/legacy access to one itinerary ID, without parent membership. (`app/api/itinerary/mutationAuth.routes.test.ts:1-13`)
- `app/api/itinerary/ownership.test.ts` tests owner equality, itinerary-level archive eligibility, and one archive projection. (`app/api/itinerary/ownership.test.ts:1-18`)
- `app/api/itinerary/removeStop.test.ts` removes one index from one plan and reflows its tail. (`app/api/itinerary/removeStop.test.ts:1-12`)
- `app/api/itinerary/reroute.atomic.test.ts` and `reroute.test.ts` treat one itinerary as the complete atomic/blast-radius boundary. (`app/api/itinerary/reroute.atomic.test.ts:1-7`, `app/api/itinerary/reroute.test.ts:1-9`)
- `app/api/itinerary/stopPlan.test.ts` decides whether one plan has remaining timed stops and which stop ends it. (`app/api/itinerary/stopPlan.test.ts:1-12`)
- `app/api/itinerary/store.cas.test.ts` directly pins one `itin:<id>` CAS domain and one UID-to-current-ID pointer, including newer-plan pointer preservation. (`app/api/itinerary/store.cas.test.ts:1-14`, `app/api/itinerary/store.cas.test.ts:253-295`)
- `app/api/itinerary/store.kv.test.ts` pins the Redis one-document/one-pointer command surface and TTL behavior. (`app/api/itinerary/store.kv.test.ts:1-15`)
- `app/api/itinerary/swap.atomic.test.ts` and `swap.test.ts` treat one itinerary document and one same-document tail as the whole mutation transaction. (`app/api/itinerary/swap.atomic.test.ts:1-18`, `app/api/itinerary/swap.test.ts:1-18`)
- `app/api/itinerary/version.routes.test.ts` pins ETags and expected-version conflicts for one itinerary resource. (`app/api/itinerary/version.routes.test.ts:1-17`)

### Tests with direct one-day planning/scheduling assumptions

- `app/api/_mock/fixtures.test.ts` pins one deterministic planner result, one city/home, one weather series, flat venue pools, and one route chain. (`app/api/_mock/fixtures.test.ts:1-18`)
- `app/api/_shared/schemas.test.ts` validates the flat parsed prompt, at-most-eight categories/stops, and one itinerary topology. (`app/api/_shared/schemas.test.ts:1-12`)
- `app/api/parse/parse.test.ts`, `planner.test.ts`, and `plannerPreferences.test.ts` exercise one `PlanIntent`, one clarification round, one time intent, and one plan-wide preference context. (`app/api/parse/parse.test.ts:1-18`, `app/api/parse/planner.test.ts:1-18`, `app/api/parse/plannerPreferences.test.ts:1-18`)
- `app/api/places/search/filter.test.ts`, `hours.test.ts`, and `searchPlaces.test.ts` apply one parsed plan/timezone/weather context to flat category pools. (`app/api/places/search/filter.test.ts:1-14`, `app/api/places/search/hours.test.ts:1-18`, `app/api/places/search/searchPlaces.test.ts:1-17`)
- `app/api/schedule/driveMode.test.ts`, `home.test.ts`, `rideMetadata.test.ts`, `schedule.test.ts`, and `travel.test.ts` exercise one origin, one travel mode, one sequential stop chain, and one topology-wide ride palette. (`app/api/schedule/driveMode.test.ts:1-14`, `app/api/schedule/home.test.ts:1-7`, `app/api/schedule/rideMetadata.test.ts:1-14`, `app/api/schedule/schedule.test.ts:1-13`, `app/api/schedule/travel.test.ts:1-17`)
- `app/api/select/select.test.ts` selects IDs for one flat slot/pool set under one plan-wide context. (`app/api/select/select.test.ts:1-18`)
- The affected client-domain suites are `arrivalDetection.test.ts`, `clientPayloads.test.ts`, `historyView.test.ts`, `itineraryCompletion.test.ts`, `planGuards.test.ts`, `planSlots.test.ts`, `recoverySlots.test.ts`, `timeLabels.test.ts`, and `travelLegVisibility.test.ts`; each consumes either one itinerary, one ordered stop list, one active stop, one plan clock, or one flat archive. (`app/lib/arrivalDetection.test.ts:1-14`, `app/lib/clientPayloads.test.ts:1-13`, `app/lib/historyView.test.ts:1-20`, `app/lib/itineraryCompletion.test.ts:1-18`, `app/lib/planGuards.test.ts:1-20`, `app/lib/planSlots.test.ts:1-22`, `app/lib/recoverySlots.test.ts:1-18`, `app/lib/timeLabels.test.ts:1-18`, `app/lib/travelLegVisibility.test.ts:43-82`)

### Browser suite and test harness

- The 16 browser spec files are `accessibility`, `banner-dismiss`, `client-resilience`, `drive-mode`, `emdash`, `failloud`, `fixtures`, `geocode`, `history`, `maps-resilience`, `mobile`, `mode-switch`, `recovery`, `remove`, `scenarios`, and `smoke`; each drives either the one-itinerary page transition or the one-plan map/strip specimen. (`e2e/accessibility.spec.ts:1-7`, `e2e/banner-dismiss.spec.ts:1-15`, `e2e/client-resilience.spec.ts:1-18`, `e2e/drive-mode.spec.ts:1-35`, `e2e/emdash.spec.ts:1-39`, `e2e/failloud.spec.ts:1-10`, `e2e/fixtures.spec.ts:1-23`, `e2e/geocode.spec.ts:1-12`, `e2e/history.spec.ts:1-22`, `e2e/maps-resilience.spec.ts:1-39`, `e2e/mobile.spec.ts:1-8`, `e2e/mode-switch.spec.ts:1-49`, `e2e/recovery.spec.ts:1-71`, `e2e/remove.spec.ts:1-39`, `e2e/scenarios.spec.ts:1-14`, `e2e/smoke.spec.ts:1-13`)
- Mock mode starts its own server on port 3100, replaces only external data sources with deterministic fixtures, leaves validation/scheduling/mutation engines real, blocks non-local browser requests, and never touches a live server on port 3000. (`e2e/README.md:5-17`, `e2e/README.md:20-30`)
- The only `app/test-harness` route is `/test-harness/maps`; it returns 404 unless `E2E_MOCK=1`. (`app/test-harness/maps/page.tsx:1-10`)
- `MapsHarness` stores alternate fixed map/strip specimens and simulated lifecycle moments in React state, then passes one selected specimen into the production `ItineraryMap` and `ItineraryStrip`; it does not call the parse/search/schedule/store APIs or model a trip/day collection. (`app/test-harness/maps/MapsHarness.tsx:937-1033`, `app/test-harness/maps/MapsHarness.tsx:1136-1244`, `app/test-harness/maps/MapsHarness.tsx:1351-1389`)
- The provider-fixture seam can execute planning without real external APIs, but mock geocoding intentionally returns fixed Chestnut coordinates for any query, so a second-city mock proves plumbing rather than real geographic behavior. (`e2e/README.md:5-12`, `CLAUDE.md:116`, `CLAUDE.md:289`)

### Clock and viewport baselines

- The three historically clock-sensitive cases now begin at `scenarios.spec.ts:329`, `:521`, and `:555`; the approximate `~496`/`~519` locations in the investigation brief are stale in the current file. (`e2e/scenarios.spec.ts:329-329`, `e2e/scenarios.spec.ts:520-521`, `e2e/scenarios.spec.ts:555-555`)
- The first pins the browser `Date` and drives server simulation for a stated-end confirmation; the latter two pin browser time for stated-window scheduling and overfilled-window trimming. (`e2e/scenarios.spec.ts:329-356`, `e2e/scenarios.spec.ts:521-548`, `e2e/scenarios.spec.ts:555-565`)
- Canonical documentation says all three former clock exclusions are resolved, and the latest recorded gate reports all three passing. (`CLAUDE.md:110`, `DEVLOG.md:21`)
- Multi-day tests that allow the browser, parse request, route departure legality check, lifecycle GET, and dev `?now` to observe different instants would exercise the same split-clock failure category; this is an inference from the current multi-surface clock inputs, not a currently reproduced defect. (`app/page.tsx:999-1046`, `app/api/schedule/travel.ts:822-855`, `app/api/itinerary/[id]/route.ts:15-44`, `e2e/scenarios.spec.ts:329-356`)
- `mobile.spec.ts` runs 320, 375, 390, and 768 px viewports, enforces 44 px targets, checks landing-form alignment, and checks stage controls/overflow. (`e2e/mobile.spec.ts:5-8`, `e2e/mobile.spec.ts:96-170`, `e2e/mobile.spec.ts:175-286`)
- The latest recorded full gate is 68 unit suites and 136/137 mock browser cases; its sole failure is the pre-existing 768 px hit test where the map-fallback dismiss button is covered by the dev title. (`DEVLOG.md:21`, `DEVLOG.md:85-85`)
- Two additional horizontal control rows—one top-level pair and an N-item day row—would add width/target/overflow pressure to surfaces already covered by the 320–768 px checks; this is an evident viewport-risk inference, not a measured implementation regression because those controls do not exist. (`e2e/mobile.spec.ts:5-8`, `e2e/mobile.spec.ts:175-286`, `app/page.tsx:3125-3363`)

## 12. OPEN QUESTIONS / RISKS

**VERDICT — The largest unresolved boundaries are the persistence/atomicity unit, active-day lifecycle, parent ownership, hotel-inventory semantics, arrival/departure timezone meaning, N-day generation limits, and trip-level recovery/history; each is absent from the current one-itinerary contract rather than a hidden capability waiting to be exposed.** (`app/api/itinerary/store.ts:32-119`, `app/api/parse/planner.ts:86-138`, `app/api/itinerary/ownership.ts:116-160`)

- **Persistence unit remains unspecified:** the brief does not state whether a Trip is one versioned document or a parent plus N independently versioned day documents; current CAS is whole-value and confined to one `itin:<id>`. (`app/api/itinerary/store.ts:195-230`, `app/api/itinerary/store.ts:345-383`)
- **Cross-document atomicity risk:** N current day documents can commit or conflict independently, and owner-pointer/history writes occur outside itinerary CAS, so partial multi-day persistence has no present transaction boundary. (`app/api/itinerary/store.ts:345-438`, `app/api/itinerary/route.ts:87-101`, `app/api/itinerary/readLifecycle.ts:20-60`)
- **One active pointer is under-specified for trips:** `owner:<uid>:active` contains one itinerary ID and has no enumeration or next-day advancement behavior. (`app/api/itinerary/store.ts:195-201`, `app/api/itinerary/store.ts:300-343`, `app/api/itinerary/route.ts:127-137`)
- **Parent/day ownership is unresolved:** current authorization proves exact ownership of one document; GET/swap/remove/mode treat an ownerless child as legacy/capability-by-ID, End rejects it without a verified exact owner, reroute has no ownership gate, and no route verifies that a day belongs to a parent Trip. (`app/api/itinerary/ownership.ts:23-58`, `app/api/itinerary/byIdOwnership.ts:35-55`, `app/api/itinerary/[id]/end/route.ts:53-67`, `app/api/itinerary/[id]/reroute/route.ts:1-89`)
- **Existing reroute exposure remains material:** `/reroute` has no ownership gate even though the other by-ID mutation routes do, and a trip/day hierarchy would not itself close that current route boundary. (`app/api/itinerary/[id]/reroute/route.ts:1-89`, `CLAUDE.md:105`)
- **Active-day semantics are undefined:** an itinerary becomes active when any stop is active or completed and completes when all live stops complete, but there is no trip status, active day, day skipped, future day, or trip-completed vocabulary. (`app/api/itinerary/store.ts:577-592`, `app/api/itinerary/store.ts:32-119`)
- **“Planning” is already overloaded:** it is both a persisted clock phase and the current submit button's busy label, while the proposed navigation label uses the same word for a product mode. (`app/api/itinerary/store.ts:20`, `app/api/itinerary/store.ts:577-592`, `app/page.tsx:3333-3334`)
- **Explicit End scope is undefined:** one End action currently marks, optionally archives, and pointer-clears one itinerary; the brief does not state whether ending a day, Day Mode session, or whole Trip should have those effects. (`app/api/itinerary/[id]/end/route.ts:69-115`, `app/api/itinerary/stopPlan.ts:17-65`)
- **Trip history granularity is undefined:** the existing record is one flat completed itinerary with one timezone and date/span; it has no parent grouping, trip title, arrival/departure, hotel nights, or per-day sections. (`app/api/itinerary/ownership.ts:116-160`, `app/lib/historyView.ts:180-219`)
- **Archive ordering can become externally inconsistent:** Firestore history is written before the separate itinerary `archivedAt` CAS, relying on idempotent overwrite for retries, and no parent aggregate marker exists. (`app/api/itinerary/readLifecycle.ts:35-60`, `app/api/itinerary/history.ts:24-35`)
- **Seven-day expiry may intersect a trip:** itinerary and active-pointer keys are created with independent seven-day expiries, mutations preserve rather than refresh itinerary TTL, and a dangling pointer degrades to no active plan. (`app/api/itinerary/store.ts:140-140`, `app/api/itinerary/store.ts:279-315`, `app/api/itinerary/store.ts:212-230`, `app/api/itinerary/route.ts:127-135`)
- **The requested `2-N` upper bound is undefined:** current parser/server/client shapes cap activities, categories, and route points at eight/nine and the planner accepts starts only up to 14 days ahead. (`app/api/parse/planner.ts:33-49`, `app/api/_shared/http.ts:5-14`, `app/api/_shared/schemas.ts:110-169`)
- **Generation granularity is undefined:** current correction/fallback logic validates one flat model answer and falls back to one stop, so failure semantics for one bad day within an otherwise usable N-day result do not exist. (`app/api/parse/planner.ts:620-733`, `app/api/parse/planner.ts:740-857`)
- **Model capacity/cost is unmeasured for N days:** no token maximum, usage parser, aggregate dollar ledger, or repository-recorded context window exists; `max_price` only filters serving endpoints by per-million-token rates. (`app/api/_shared/openrouter.ts:72-85`, `app/api/_shared/openrouter.ts:103-122`, `app/api/parse/route.ts:75-101`)
- **Provider fan-out risk scales with stops/days:** current Places search can expand to 16/19 provider queries per category and Routes calls are sequential per leg because each departure depends on prior travel/dwell. (`app/api/places/search/searchPlaces.ts:60-70`, `app/api/places/search/searchPlaces.ts:287-362`, `app/api/schedule/travel.ts:923-1040`)
- **Rate limiting is not shared across serverless instances:** it is a process-local 60-second map, and deployment documentation records that a shared edge/Redis limiter is not implemented. (`app/api/_shared/http.ts:16-27`, `app/api/_shared/http.ts:86-115`, `DEPLOY.md:207-213`)
- **No asynchronous refresh runtime exists:** no API route declares a cron/scheduled handler or route `maxDuration`, and all routes use the default server runtime except the weather route's `force-dynamic` cache declaration. (`app/api/weather/route.ts:38-43`, `package.json:8-18`)
- **Hotel availability semantics are undefined:** there is no distinction among discovery, quoted availability, reservation hold, booking, cancellation, room occupancy, or stale rate; the only availability seam is a synchronous opening-hours predicate for venues. (`app/api/itinerary/swap.ts:170-181`, `app/api/itinerary/swap.ts:669-686`, `README.md:276-279`)
- **Hotel supplier/provider choice is absent:** the provider union, dependency manifest, environment table, and route inventory contain no hotel/booking integration. (`app/api/_shared/provider.ts:3-34`, `package.json:20-44`, `DEPLOY.md:30-67`)
- **Arrival/departure inputs are semantically ambiguous:** the current model has a day start/end window but no flight, airport, transport reservation, origin timezone, destination timezone, terminal, buffer, or delay record. (`app/api/parse/planner.ts:102-114`, `app/api/itinerary/store.ts:32-119`)
- **Cross-timezone trip semantics are absent:** one itinerary uses one city-derived timezone for every stop even when absolute arithmetic crosses midnight; a departure in one zone and landing in another cannot be represented within that plan. (`app/page.tsx:942-985`, `app/api/schedule/schedule.ts:586-597`)
- **Day origin semantics are unresolved:** current home is a fixed city-centre/entered-address point and is not derived from the prior day's endpoint or a hotel/check-in state. (`app/api/schedule/home.ts:1-11`, `app/page.tsx:942-985`)
- **Cross-midnight versus next-day membership is ambiguous:** the scheduler can naturally put a later stop after midnight, while date labels call that portion “tomorrow”; no field says which trip day owns that stop. (`app/api/schedule/schedule.ts:610-652`, `app/lib/timeLabels.ts:46-90`)
- **Weather coverage is shorter than many trips:** only 24 hourly points are fetched for one coordinate, and missing future buckets skip the weather gate rather than marking forecast unavailable as a separate trip state. (`app/api/weather/route.ts:65-108`, `app/api/places/search/filter.ts:114-128`, `app/api/places/search/filter.ts:173-187`)
- **Multi-city remains outside the current plan:** canonical gaps state one city per plan, and search applies one city/neighbourhood context to all slots. (`CLAUDE.md:281-284`, `app/api/places/search/searchPlaces.ts:72-94`)
- **Currency meaning is unresolved across a trip:** input can name several currencies, but venue facts are ordinal price levels and output glyphs do not identify currency, so neither conversion date/rate nor trip totals exist. (`app/lib/budget.ts:6-66`, `app/ItineraryStrip.tsx:97-102`)
- **Language scope is unresolved:** geographic internationalization exists, but the page declares English and has no locale state or i18n dependency; the brief does not say whether “International Appeal” includes translation. (`app/layout.tsx:6-19`, `app/page.tsx:584-615`, `package.json:20-44`)
- **Trip-wide versus day-specific preferences/constraints is unresolved:** preference context is user-global and soft, while all parsed constraints are one hard plan-wide array injected into every category. (`app/api/parse/plannerPreferences.ts:146-161`, `app/api/places/search/searchPlaces.ts:72-94`, `app/api/select/selectVenues.ts:232-299`)
- **Trip-level disruption has no analog:** current pre-commit recovery repairs one numbered slot and runtime reroute protects one same-day upstream prefix; neither can shift sibling days after a missed flight or overrun. (`app/lib/recoverySlots.ts:3-24`, `app/api/itinerary/reroute.ts:228-305`)
- **Live tracking cannot independently identify a day:** tracker state has no plan/day ID, and its hook lifetime changes only when the boolean enabled flag changes. (`app/lib/liveTracking.ts:177-252`, `app/lib/useLiveTracking.ts:32-54`)
- **UI response races are scoped to one ID/version:** the page rejects stale responses for one current itinerary but has no generation/commit identity spanning multiple day responses. (`app/page.tsx:2028-2058`, `app/page.tsx:2197-2205`)
- **Tab density has a known mobile risk class:** the existing 768 px map-fallback/dev-panel overlap is the sole documented e2e baseline failure, while the mobile suite already enforces viewport containment and 44 px targets at four widths. (`DEVLOG.md:21`, `e2e/mobile.spec.ts:5-8`, `e2e/mobile.spec.ts:175-286`)
- **Real provider legality cannot be inferred from canned success fixtures:** canonical guidance records that mode-only assertions once passed while the live provider rejected an illegal field combination, and mock e2e replaces provider calls entirely. (`CLAUDE.md:57`, `e2e/README.md:5-12`)
- **Architecture constrains factual hotel/travel claims:** the LLM is a semantic proposer only; hours, prices, distances, travel time, schedules, and other checkable facts must remain code/provider-validated. (`CLAUDE.md:8-11`)
- **Large migrations retain existing validation ladders:** the OpenRouter migration records that weaker fallback models are safe only because correction and deterministic validation remain intact and must not be weakened. (`CLAUDE.md:14-27`)

## CONSTRAINTS SUMMARY

- `CLAUDE.md` is canonical when it disagrees with `AGENTS.md`, and current code wins over stale handoff prose. (`AGENTS.md:3-8`, `HANDOFF.md:3-6`)
- LLMs propose semantic choices; code owns verifiable hours, prices, ratings, coordinates, distances, travel, and scheduling. (`CLAUDE.md:8-11`)
- Geocoding runs before planning so relative time is resolved against the selected place's IANA-zone clock. (`CLAUDE.md:29-32`)
- Model fallback must retain the existing validation, correction, and deterministic-fallback ladders. (`CLAUDE.md:14-27`)
- Replan/mutation paths reuse shared search, selection, schedule, travel, and tail-resettlement cores rather than forked fact logic. (`CLAUDE.md:75-76`, `CLAUDE.md:163-165`)
- Keep-on-missing-data preserves venues whose price, hours, or rating is absent, except that a price-direction swap cannot claim an unpriced answer. (`AGENTS.md:44-49`)
- LLM venue selection is by candidate ID only; invalid ID gets one correction attempt before code fallback. (`AGENTS.md:50-51`, `app/api/select/selectVenues.ts:112-170`)
- `travelMode` is stored plan-level intent, absence means transit, and an individual leg's measured/relabelled mode remains authoritative even when a driving plan legitimately contains walking legs. (`CLAUDE.md:52-54`, `app/api/itinerary/store.ts:69-86`, `app/api/schedule/travel.ts:923-988`)
- Transit travel adds a separate five-minute delay margin and follows the fixed short/competitive/broken-transit walking relabel ladder; a sub-250-metre hop skips the transit provider request. (`CLAUDE.md:85`, `app/api/schedule/travel.ts:23-62`, `app/api/schedule/travel.ts:923-988`)
- If both transit and walk provider calls fail, transit uses an unknown positive walking estimate; if both drive and walk fail, driving uses an unknown zero-minute leg. (`app/api/schedule/travel.ts:764-819`, `app/api/schedule/travel.ts:923-988`)
- Driving requests use `TRAFFIC_AWARE` rather than `TRAFFIC_AWARE_OPTIMAL`, but the expected non-Preferred Routes SKU remains an unmeasured billing inference. (`app/api/schedule/travel.ts:836-855`, `CLAUDE.md:55`)
- Reroute may change only stops strictly downstream of the disrupted leg and never changes locked or floor-protected stops. (`CLAUDE.md:46-48`, `app/api/itinerary/reroute.ts:228-305`)
- A stop locks on first active/completed derivation and never unlocks, including after simulated time moves backwards. (`app/api/itinerary/store.ts:22-29`, `app/api/itinerary/store.ts:552-569`)
- `ownerIndex` is one UID to one current itinerary ID, not a collection. (`app/api/itinerary/store.ts:123-129`, `app/api/itinerary/store.ts:195-201`)
- One UID may own multiple stored itinerary documents even though only one is resumable through its owner pointer. (`app/api/itinerary/route.ts:69-101`, `app/api/itinerary/store.ts:279-329`)
- Repeated successful itinerary creations leave only the last successfully written ID in the owner pointer; current code neither enumerates earlier owned documents nor advances the pointer to another itinerary after conclusion. (`app/api/itinerary/route.ts:87-101`, `app/api/itinerary/route.ts:127-137`, `app/api/itinerary/store.ts:300-343`, `app/api/itinerary/readLifecycle.ts:20-31`)
- The create route saves the itinerary before its best-effort owner-pointer write, so creation can succeed while owner resume remains undiscoverable. (`app/api/itinerary/route.ts:69-101`)
- An owner pointer is interpreted only as an itinerary ID: a differently keyed parent is missing, a malformed `itin:<id>` parent is rejected before lifecycle work, and no alternate parent-record loader exists. (`app/api/itinerary/route.ts:127-137`, `app/api/itinerary/store.ts:236-276`, `app/api/itinerary/readLifecycle.ts:73-92`)
- The active-itinerary store defines two Redis key constructors: `itin:<id>` for itinerary documents and `owner:<uid>:active` for the current-owner pointer. (`app/api/itinerary/store.ts:176-201`, `app/api/itinerary/store.ts:263-384`)
- Both Redis key types begin with a seven-day TTL, and itinerary CAS preserves rather than refreshes the existing TTL. (`app/api/itinerary/store.ts:140-140`, `app/api/itinerary/store.ts:212-230`, `app/api/itinerary/store.ts:279-315`)
- A missing/expired itinerary returns 404 by ID and `itinerary:null` through owner resume; an expired pointer makes an otherwise existing plan undiscoverable through resume. (`app/api/itinerary/[id]/route.ts:51-56`, `app/api/itinerary/route.ts:127-135`)
- Redis is the configured source of truth for active plans, memory mode is dev/e2e only, and Vercel without KV fails loudly. (`app/api/itinerary/store.ts:131-173`, `CLAUDE.md:103`)
- Redis URL and token independently prefer their `KV_*` value through nullish coalescing before the `UPSTASH_*` alias; mixed families can configure the store, while a defined blank primary blocks its populated alias. (`app/api/itinerary/store.ts:154-173`)
- Redis is not the sole persistence layer: Firestore stores concluded-plan history and per-user taste profiles. (`app/api/itinerary/history.ts:12-35`, `app/api/itinerary/[id]/end/route.ts:69-99`, `app/api/profile/profileStore.ts:1-11`, `app/api/profile/profileStore.ts:26-32`)
- No relational database, SQL store, or ORM is present. (`package.json:20-44`, `app/api/itinerary/store.ts:131-193`, `app/api/itinerary/history.ts:12-35`)
- Itinerary CAS is whole-document and per `itin:<id>`. (`app/api/itinerary/store.ts:212-230`, `app/api/itinerary/store.ts:345-383`)
- N itinerary documents have independent versions and no cross-document atomic commit. (`app/api/itinerary/store.ts:195-195`, `app/api/itinerary/store.ts:345-383`)
- An explicit client version disables CAS retry; unversioned updates default to two attempts and are capped at three. (`app/api/itinerary/store.ts:397-438`)
- Owner-pointer writes, owner-pointer clears, and Firestore archive writes are outside itinerary CAS. (`app/api/itinerary/route.ts:87-101`, `app/api/itinerary/readLifecycle.ts:20-60`, `app/api/itinerary/[id]/end/route.ts:78-115`)
- `Itinerary` has one required stop/leg topology plus independent optional home point and home-to-first leg fields, one optional timezone, one optional stated end, and one optional plan-level travel-mode field. (`app/api/itinerary/store.ts:32-88`)
- Missing `home` means the legacy Chestnut origin. (`app/api/itinerary/store.ts:46-48`, `app/api/schedule/home.ts:7-19`)
- Missing `timeZone` means `America/Toronto`. (`app/api/itinerary/store.ts:49-53`)
- One resolved `startInstant` is shared by scheduling, hours filtering, and the weather gate. (`CLAUDE.md:83`, `app/page.tsx:1123-1166`, `app/page.tsx:1286-1361`)
- Scheduling, opening-hours checks, and display labels use the itinerary's one resolved IANA timezone rather than server or viewer wall time. (`CLAUDE.md:84`, `app/api/schedule/schedule.ts:574-597`, `app/api/places/search/hours.ts:128-190`, `app/lib/timeLabels.ts:46-90`)
- Missing `plannedEndISO` means no stated finish and no ceiling. (`app/api/itinerary/store.ts:54-68`)
- Missing `travelMode` means transit. (`app/api/itinerary/store.ts:69-86`)
- Missing/blank `ownerUid` means legacy/unowned: by-ID GET, swap, remove, and mode preserve capability access; reroute is capability-by-ID regardless of ownership; collection GET does not discover an unowned record; and End still requires a verified exact owner. (`app/api/itinerary/store.ts:89-96`, `app/api/itinerary/ownership.ts:23-37`, `app/api/itinerary/route.ts:118-137`, `app/api/itinerary/[id]/route.ts:46-75`, `app/api/itinerary/byIdOwnership.ts:35-55`, `app/api/itinerary/[id]/reroute/route.ts:1-89`, `app/api/itinerary/[id]/end/route.ts:53-67`)
- Missing `ownerIsAnonymous` does not prove a real account and therefore does not qualify for natural history archiving. (`app/api/itinerary/store.ts:97-100`, `app/api/itinerary/ownership.ts:102-107`)
- Owned by-ID GET/swap/remove/mode require a verified exact owner, while unowned records remain capability-by-ID on those surfaces; collection GET instead requires a verified caller plus owner pointer. (`app/api/itinerary/route.ts:118-137`, `app/api/itinerary/[id]/route.ts:46-75`, `app/api/itinerary/byIdOwnership.ts:35-55`)
- Authorized by-ID GET remains readable for ended or completed itineraries because that route does not apply `isResumable`. (`app/api/itinerary/[id]/route.ts:67-79`, `app/api/itinerary/ownership.ts:60-78`)
- End requires a verified exact owner even for an otherwise unowned record. (`app/api/itinerary/[id]/end/route.ts:53-67`)
- Reroute has no ownership gate. (`app/api/itinerary/[id]/reroute/route.ts:1-89`)
- The complete itinerary route surface verifies no parent-trip membership and updates no sibling days. (`app/api/itinerary/store.ts:32-119`, `app/api/itinerary/route.ts:37-141`, `app/api/itinerary/[id]/route.ts:15-82`, `app/api/itinerary/[id]/end/route.ts:22-132`, `app/api/itinerary/[id]/mode/route.ts:20-103`, `app/api/itinerary/[id]/remove/route.ts:17-104`, `app/api/itinerary/[id]/reroute/route.ts:19-89`, `app/api/itinerary/[id]/swap/route.ts:21-109`)
- `POST /api/itinerary` permits 1–8 stops, and removal cannot leave zero timed venues. (`app/api/_shared/schemas.ts:331-340`, `app/api/itinerary/removeStop.ts:125-134`)
- Every by-ID route parameter accepts only `[A-Za-z0-9-]{1,128}`. (`app/api/itinerary/[id]/route.ts:30-36`, `app/api/itinerary/[id]/end/route.ts:37-43`, `app/api/itinerary/[id]/mode/route.ts:51-57`, `app/api/itinerary/[id]/remove/route.ts:41-47`, `app/api/itinerary/[id]/reroute/route.ts:25-31`, `app/api/itinerary/[id]/swap/route.ts:32-38`)
- Itinerary lifecycle status is exactly `planning | active | completed` and is derived from stop clocks when lifecycle code runs. (`app/api/itinerary/store.ts:20-20`, `app/api/itinerary/store.ts:441-460`, `app/api/itinerary/store.ts:577-592`)
- An all-skipped or zero-live-stop itinerary derives as completed, while a gap after any completed stop remains active until all live stops complete. (`app/api/itinerary/store.ts:577-592`, `app/api/itinerary/itinerary.test.ts:136-186`)
- Stop activity windows are half-open `[start,end)`. (`app/api/itinerary/store.ts:451-460`)
- Status transitions are read/action driven; no autonomous lifecycle timer exists. (`app/api/itinerary/readLifecycle.ts:64-92`, `CLAUDE.md:87`)
- `endedAt`, `discardedAt`, and `archivedAt` are itinerary-level markers independent of the clock-derived status. (`app/api/itinerary/store.ts:101-118`, `app/api/itinerary/ownership.ts:60-113`)
- Natural completion and explicit End are separate conclusion paths. (`app/api/itinerary/readLifecycle.ts:20-60`, `app/api/itinerary/[id]/end/route.ts:22-128`)
- Automatic/natural history eligibility requires completed, owned, explicitly non-anonymous, non-discarded, and not-yet-marked-archived state; explicit verified-owner `save-end` may archive a planning or active itinerary before it is completed. (`app/api/itinerary/ownership.ts:86-113`, `app/api/itinerary/[id]/end/route.ts:69-99`, `app/api/itinerary/stopPlan.ts:43-54`)
- History is one flat Firestore document per itinerary ID and is listed newest-first with a 50-record cap. (`app/api/itinerary/history.ts:24-35`, `app/api/itinerary/history.ts:117-130`)
- Explicit `save-end` archives the raw loaded itinerary before lifecycle derivation, so its compact history projection may preserve stop statuses stale relative to the request-time clock. (`app/api/itinerary/[id]/end/route.ts:59-99`, `app/api/itinerary/ownership.ts:142-160`)
- History and profile records have no application TTL. (`app/api/itinerary/history.ts:24-35`, `app/api/profile/profileStore.ts:44-110`)
- The scheduler advances absolute epoch milliseconds and can cross midnight without a special branch. (`app/api/schedule/schedule.ts:574-652`)
- One scheduler invocation serializes every stop in one supplied IANA timezone. (`app/api/schedule/schedule.ts:586-597`)
- Time parsing accepts only one calendar qualifier and rejects competing qualifiers with “Choose one day.” (`app/api/schedule/schedule.ts:183-194`, `app/api/schedule/schedule.ts:245-269`)
- Creation fit, swap end confirmation, and mode-switch end notes share one 30-minute stated-window overrun tolerance. (`app/api/schedule/schedule.ts:508-540`, `app/api/itinerary/swap.ts:1129-1151`, `app/api/itinerary/modeSwitch.ts:188-198`)
- Public time-label helpers default an omitted reference instant to `new Date()`. (`app/lib/timeLabels.ts:46-70`, `app/lib/timeLabels.ts:73-90`)
- Scheduler and travel cursors are invocation-local, but each invocation has one origin, timezone, travel mode, and sequential stop chain. (`app/api/schedule/schedule.ts:586-612`, `app/api/schedule/travel.ts:997-1040`)
- `HomePoint` is a fixed waypoint, not a stop, and has no status or check-in lifecycle. (`app/api/schedule/home.ts:1-11`, `app/api/itinerary/store.ts:40-48`)
- No current origin is derived from a previous itinerary's last stop or a hotel. (`app/api/schedule/home.ts:7-11`, `app/page.tsx:942-985`)
- Arrival detection is display-only, uses a 75-metre/45-second policy, and contains no day/date/itinerary identity. (`app/lib/arrivalDetection.ts:1-23`, `app/lib/arrivalDetection.ts:35-78`, `app/lib/arrivalDetection.ts:112-129`)
- Confirmed arrival resets on active-stop or itinerary-ID change, not at midnight; an unconfirmed dwell has additional bad/missing-measurement, out-of-range, and backward-clock reset/restart behavior. (`app/lib/arrivalDetection.ts:143-182`, `app/lib/arrivalDetection.ts:206-235`, `app/page.tsx:2888-2902`)
- Every freshly computed travel leg has an app-owned `legId`; each source transit occurrence receives one `rideId`, raw `sourceStepIndex`, and compatible palette metadata before fact and geometry filtering diverge. (`CLAUDE.md:95`, `app/api/schedule/travel.ts:128-153`, `app/api/schedule/travel.ts:499-604`)
- Retained valid transit palette slots are reserved before new allocation, non-null slots are unique integers `0..23`, overflow is explicit `null`, and legacy all-absent identity is never guessed or backfilled. (`CLAUDE.md:95`, `app/api/schedule/travel.ts:387-468`)
- A valid transit palette slot maps directly to one fixed occurrence colour across line, halo, bubble, compact badge, and BOARD badge; slots never wrap/hash/randomize and route geometry never uses reserved chartreuse. (`CLAUDE.md:96`, `app/lib/transitRidePalette.ts:1-40`)
- For identified modern walking/transit legs, one exact-ID visibility decision governs the complete leg, and hidden legs are rejected before geometry decoding or native overlay construction. (`CLAUDE.md:73`, `app/lib/travelLegVisibility.ts:34-110`, `app/ItineraryMap.tsx:343-408`)
- `ParsedPrompt` is one flat plan context with one time window, one city/home/weather anchor, and no trip/day/flight/hotel fields. (`app/api/places/search/filter.ts:35-63`)
- `PlanIntent` contains one flat activity array, one `TimeIntent`, one question array, and one context object. (`app/api/parse/planner.ts:86-138`)
- Planner bounds are 15–360 minutes per activity, eight activities, three questions, eight options, a 14-day future-start horizon, and a 60-minute ordinary past-start limit. (`app/api/parse/planner.ts:33-49`, `app/api/parse/planner.ts:473-493`)
- Clarification is limited to one additional planner request; questions returned by that pass are ignored. (`app/page.tsx:1067-1108`)
- Planner validation permits one correction retry on the same model and then a deterministic one-stop fallback. (`app/api/parse/planner.ts:740-857`)
- Request text wins per preference aspect; taste preferences cannot add/remove stops, change time/count, or become hard constraints. (`app/api/parse/planner.ts:216-230`)
- Places search applies one city, neighbourhood, aesthetic, category, and constraint set to flat slots, while venue selection applies one aesthetic, group context, budget, and constraint set to those slots. (`app/api/places/search/searchPlaces.ts:72-94`, `app/api/select/selectVenues.ts:440-470`)
- Incoming JSON is capped at 256 KiB; prompts at 2,000 characters; refinements at 1,000; generic bounded text at 240; categories at eight; pools at 25 candidates; total candidates at 160; and points at nine. (`app/api/_shared/http.ts:5-14`, `app/api/_shared/http.ts:61-84`)
- Model content is rejected above 50,000 characters. (`app/api/parse/route.ts:89-100`)
- OpenRouter planner/select/swap chains are centralized and can be replaced only by their corresponding environment overrides. (`app/api/_shared/models.ts:64-114`)
- Only upstream 429 and 5xx model errors advance the model chain. (`app/api/_shared/provider.ts:70-84`, `app/api/_shared/modelFallback.ts:43-100`)
- OpenRouter `max_price` is an endpoint-rate ceiling of 5 USD/M prompt and 10 USD/M completion tokens, not a total-cost or token-count cap. (`app/api/_shared/openrouter.ts:72-85`, `app/api/_shared/openrouter.ts:103-122`)
- OpenRouter requests contain no output-token maximum, and response token usage is not consumed or logged. (`app/api/_shared/openrouter.ts:103-122`, `app/api/parse/route.ts:75-101`)
- Current model context-window sizes are not stored or enforced in the repository. (`app/api/_shared/models.ts:64-125`, `app/api/_shared/openrouter.ts:103-122`)
- Provider deadlines are OpenRouter 45 s, Places 10 s, Routes 10 s, Weather 8 s, Geocoding 10 s, and Redis 5 s. (`app/api/_shared/provider.ts:11-34`)
- Firebase Admin token-verification and Firestore SDK calls bypass `fetchProvider` and have no source-owned deadline in the provider timeout table. (`app/lib/firebaseAdmin.ts:101-128`, `app/api/_shared/provider.ts:11-34`)
- Browser JSON requests default to a 25-second deadline. (`app/lib/clientFetch.ts:1-20`)
- The source rate limiter is per process and is not shared across Vercel instances. (`app/api/_shared/http.ts:16-27`, `app/api/_shared/http.ts:86-115`, `DEPLOY.md:207-213`)
- Every present provider/mutation operation is synchronous within one of the 15 Next routes; source/config declares no queue, worker, scheduled handler, or cron surface. (`package.json:8-18`, `next.config.mjs:5-17`, `app/api/_shared/provider.ts:110-180`, `app/api/geocode/route.ts:1-49`, `app/api/history/route.ts:1-50`, `app/api/itinerary/route.ts:1-141`, `app/api/itinerary/[id]/route.ts:1-82`, `app/api/itinerary/[id]/end/route.ts:1-132`, `app/api/itinerary/[id]/mode/route.ts:1-103`, `app/api/itinerary/[id]/remove/route.ts:1-104`, `app/api/itinerary/[id]/reroute/route.ts:1-89`, `app/api/itinerary/[id]/swap/route.ts:1-109`, `app/api/parse/route.ts:1-189`, `app/api/places/search/route.ts:1-104`, `app/api/profile/route.ts:1-105`, `app/api/schedule/travel/route.ts:1-63`, `app/api/select/route.ts:1-75`, `app/api/weather/route.ts:1-111`)
- All 15 routes run on the default Node server runtime; none declares Edge runtime or route-specific `maxDuration`. (`DEVLOG.md:562-565`, `app/api/geocode/route.ts:1-49`, `app/api/history/route.ts:1-50`, `app/api/itinerary/route.ts:1-141`, `app/api/itinerary/[id]/route.ts:1-82`, `app/api/itinerary/[id]/end/route.ts:1-132`, `app/api/itinerary/[id]/mode/route.ts:1-103`, `app/api/itinerary/[id]/remove/route.ts:1-104`, `app/api/itinerary/[id]/reroute/route.ts:1-89`, `app/api/itinerary/[id]/swap/route.ts:1-109`, `app/api/parse/route.ts:1-189`, `app/api/places/search/route.ts:1-104`, `app/api/profile/route.ts:1-105`, `app/api/schedule/travel/route.ts:1-63`, `app/api/select/route.ts:1-75`, `app/api/weather/route.ts:1-111`)
- Deployment requires Node `>=22.12.0`; the production build command is `next build --webpack`, and `firebase-admin` remains server-external because the recorded Turbopack packaging path broke Vercel output tracing. (`package.json:5-10`, `next.config.mjs:5-17`, `DEVLOG.md:562-565`)
- Weather fetches at most 24 hourly metric records for one coordinate and filters nothing when the target hour has no forecast bucket. (`app/api/weather/route.ts:65-108`, `app/api/places/search/filter.ts:114-128`, `app/api/places/search/filter.ts:173-187`)
- Places search has request-local deduplication only and no cross-request cache. (`app/api/places/search/searchPlaces.ts:157-190`)
- Consecutive Routes calls are sequential because each departure depends on prior travel and dwell. (`app/api/schedule/travel.ts:997-1040`)
- The browser page holds one current itinerary and its derived state in local React state. (`app/page.tsx:584-615`)
- The page has a binary landing-versus-map-stage branch and no top-level trip/day tab state. (`app/page.tsx:3124-3363`)
- Owner resume performs one fetch after auth settles and does not poll. (`app/page.tsx:2155-2195`, `CLAUDE.md:87`)
- Client mutation race guards are keyed to one itinerary ID and one version. (`app/page.tsx:2028-2058`, `app/page.tsx:2197-2205`)
- `pendingWrite` fences only an in-flight taste-profile write before planning; it is not a multi-document transaction coordinator. (`app/lib/pendingWrite.ts:1-46`)
- `retryableLoader` retries provider-library loading after rejected promises, not itinerary writes. (`app/lib/retryableLoader.ts:1-18`)
- `ItineraryMap` reuses one map instance but rebuilds native route overlays when supplied stop/home/visibility data changes. (`app/ItineraryMap.tsx:278-341`, `app/ItineraryMap.tsx:343-408`, `app/ItineraryMap.tsx:676-676`)
- Map bounds react to venue/home coordinate changes and not status-only changes. (`app/ItineraryMap.tsx:678-709`)
- Budget enforcement is based on ordinal Places price levels, not monetary totals. (`app/lib/budget.ts:49-66`, `app/api/places/search/filter.ts:253-258`)
- Visible venue prices are generic dollar-sign levels without currency identification. (`app/ItineraryStrip.tsx:97-102`, `app/ItineraryStrip.tsx:747-759`)
- Taste preferences are one user-global four-dimension profile and contain no trip/day/destination/hotel/locale fields. (`app/lib/tastePreferences.ts:304-372`)
- Taste food free text is capped at 40 sanitized characters. (`app/lib/tastePreferences.ts:69-76`, `app/lib/tastePreferences.ts:101-109`)
- Hard constraints are one plan-wide array of at most eight entries, each normalized to at most 120 characters, applied to every category/selection with no day/slot association. (`app/api/_shared/schemas.ts:127-139`, `app/lib/constraints.ts:3-24`, `app/api/places/search/searchPlaces.ts:72-94`, `app/api/select/selectVenues.ts:232-299`)
- Pre-commit recovery is keyed by one numeric slot, and runtime reroute is limited to one itinerary's downstream chain. (`app/lib/recoverySlots.ts:3-24`, `app/api/itinerary/reroute.ts:228-305`)
- Live tracking is foreground-only, and tracker state has no itinerary/day identity. (`app/lib/liveTracking.ts:1-18`, `app/lib/liveTracking.ts:177-252`)
- One itinerary can carry one non-Toronto timezone, but cannot represent a timezone transition within the itinerary. (`app/api/itinerary/store.ts:49-53`, `app/api/schedule/schedule.ts:586-597`)
- City and starting address are plain geocoded inputs; city results must be locality-typed, ambiguity is explicit recovery, `parsed.location` remains an intra-city neighbourhood, and a user-entered city never silently falls back to Toronto. (`CLAUDE.md:99`, `app/api/geocode/geocode.ts:481-639`, `app/page.tsx:942-1055`)
- Google Weather and distance policies use metric units and are not locale-selected. (`app/api/weather/route.ts:65-78`, `app/api/schedule/travel.ts:23-62`, `app/lib/arrivalDetection.ts:35-78`)
- The document language is hardcoded English and the dependency set contains no i18n framework. (`app/layout.tsx:6-19`, `package.json:20-44`)
- The dependency/provider surface contains no hotel availability, reservation, foreign-exchange conversion, translation, or locale integration. (`package.json:20-44`, `app/api/_shared/provider.ts:3-9`, `CLAUDE.md:276-280`)
- The only availability seam is a synchronous venue-hours predicate; it does not represent rooms, nights, rates, holds, or bookings. (`app/api/itinerary/swap.ts:170-181`, `app/api/itinerary/swap.ts:669-686`)
- Browser-safe timezone arithmetic is isolated in `app/lib/zoneTime.ts`; offline coordinate lookup and its geographic database are isolated behind `server-only` in `app/api/geocode/zoneLookup.ts`. (`CLAUDE.md:84`, `app/api/geocode/zoneLookup.ts:1-16`)
- The map uses inline styling on a classic `google.maps.Map` with HTML `OverlayView` markers rather than a cloud map ID or advanced markers. (`CLAUDE.md:260`, `app/ItineraryMap.tsx:278-341`, `app/ItineraryMap.tsx:1104-1158`)
- Map fitting is keyed to venue/home coordinates rather than status ticks, so lifecycle-only changes do not reframe the viewport. (`CLAUDE.md:264`, `app/ItineraryMap.tsx:678-709`)
- Full chartreuse marker/border treatment is reserved for the active-now stop; changed stops use accents, and changed route geometry retains its own colour with a same-colour halo. (`CLAUDE.md:257`, `app/globals.css:6-18`, `app/ItineraryMap.tsx:423-478`)
- Browser-visible configuration is limited to Maps, Firebase Web values, and dev controls; provider, Admin, and Redis credentials remain server-only. (`DEPLOY.md:51-62`, `DEPLOY.md:92-97`, `app/api/itinerary/store.ts:154-186`)
- Mock e2e replaces external data sources only; validation, filtering, scheduling, lifecycle, and mutation engines remain real. (`e2e/README.md:5-12`, `CLAUDE.md:108-116`)
- A new pipeline data source requires provider-shaped mock data at the existing mock seam; mock mode substitutes data rather than forking production logic. (`CLAUDE.md:116`, `app/api/_mock/fixtures.ts:1-18`, `app/api/_mock/fixtures.ts:1045-1385`)
- Mock geocoding is city-agnostic and therefore cannot prove real second-city geography. (`CLAUDE.md:116`, `CLAUDE.md:289`)
- The documented current gate contains 68 unit suites and 137 mock browser cases; the only allowed baseline exception is the 768 px mobile overlap. (`CLAUDE.md:110`, `DEVLOG.md:21`)
- Mobile tests cover 320, 375, 390, and 768 px and enforce 44 px interactive targets. (`e2e/mobile.spec.ts:5-8`, `e2e/mobile.spec.ts:175-286`)
