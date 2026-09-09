# Itinerary audit findings

## Verification Summary

**Second pass, 2026-08-30.** Every finding below was re-checked independently against the working tree rather than taken on trust: each cited file and line was opened, each "dead" claim got its own repo-wide reference trace (tests, config, scripts, dynamically built class names, dynamic module resolution, barrel re-exports), each cost claim was checked against the flow it describes, and each finding was read against CLAUDE.md, AGENTS.md and DEVLOG.md directly rather than via Codex's summary of them. Codex's own exclusion list was spot-checked too. Verdict markers are added beneath each finding; **nothing Codex wrote has been deleted or rewritten.**

**Baseline re-confirmed, not assumed.** Working tree clean at `47e31e102e13e6aa748ee7791c5558c37d08c830` (`AUDIT_FINDINGS.md` untracked, as expected), `npx eslint .` reports **0 errors / 8 warnings**, and `npm run test:unit` reports **all 62 unit suites passed**. Tracked-file count is 202, unit test files 62, e2e spec files 16 — all matching. So the line numbers in this document are current, not stale.

**No implementation was performed and no file other than this one was modified.** Two probes ran in a scratch directory outside the repository (a standalone reproduction of D1's unbounded body read, and gzip measurements of the existing build output); neither touched project files.

### Verdict tally

| Verdict | Count | Findings |
| --- | --- | --- |
| **[VERIFIED]** | 10 | A1, A2, A4, C1, C2, D1, D2, D5, D6, D7 |
| **[VERIFIED, WITH CORRECTION]** | 4 | A3, B1, D3, D4 |
| **[FALSE POSITIVE]** | **0** | — |
| **[UNABLE TO CONFIRM]** | 1 (non-finding) | the security-scan result, which was scoped out of this pass as it was out of Codex's |
| Reconsiderations | 3 | R1 **agree**, R2 **agree**, R3 **agree on facts, disagree on priority** |
| Added during verification | 2 | E1, E2 (both low risk, both minor) |

**On zero false positives.** I looked for them specifically and did not manufacture one. The audit was disciplined in the two places this kind of pass usually breaks it: it correctly *excluded* the `lstrip__tlrow--{kind}` classes built by template literal at `ItineraryStrip.tsx:406`, and it did **not** flag `axe-core`, whose only reference is a runtime `nodeRequire.resolve` in an e2e spec. Both would have been confident, wrong findings. Every line number I checked was exact or off by one in a way that pointed at the right code.

### Safe to implement now

Only findings marked **[VERIFIED]** with low risk. Read each finding's verdict block before starting; three carry a specific trap.

1. **A1 — unread React state and dead map fields.** Remove `parsedObj`/`travelLegs` (page.tsx:599, 601) with their three setter calls (1049, 1308, 1550), and `MapStop.reason`/`blockedReason` (ItineraryMap.tsx:39, 57). *Trap:* `blockedReason` is never assigned either, so only `reason` needs its two projection assignments removed (page.tsx:312, 335).
2. **E1 — `nextItineraryStatus`'s unused `t: Date`** (store.ts:569). Same batch as A1; together they clear every non-test unused-declaration lint warning.
3. **A2 — the twenty dead CSS selectors.** *Trap:* delete by selector, never by line range — `.old-time` and `.new-time` at globals.css:501-502 sit inside the dead `.ecard` run and are live reroute UI. In the reduced-motion selector at 1822, remove only the `.ecard` member.
4. **C1 + E2 — setup and deployment documentation.** *This is not only prose:* `.env.example` and DEPLOY.md's env table both omit all three `FIREBASE_ADMIN_*` credentials, so following the guides yields a deployment where ownership, resume, history and personalization silently do nothing. Align the Node prerequisite with `package.json` (22.12.0+, and consider `@types/node`), correct the "only key exposed to the browser" comment, and state the *actual* partial authorization rather than a finished one. E2 adds the reverse direction: CLAUDE.md:82 still flags a `TZ` requirement DEPLOY.md:24 has already dropped.
5. **C2 — the three e2e clocks**, using the existing seam at e2e/scenarios.spec.ts:549. *Expect:* the suite still will not be fully green; `mobile.spec.ts` at 768px is a separate pre-existing failure.
6. **A3, the isolated declarations only** — `parsePromptBody` (schemas.ts:57) and `distributionOptions` (planSlots.ts:165). Both have zero references including tests.
7. **A4, `debug.log` only.** Add a `*.log` rule to `.gitignore`; there is none today. The prototype's disposition stays an owner decision.

### Needs owner judgment — do not implement from this list

- **R1 — by-id authorization.** A product/security contract decision. Note the sharpened stake: the by-id `GET` returns the whole itinerary including `home` (the user's typed starting address and coordinates), and because it verifies no caller, **D3's pointer clear and D5's archive are reachable by anyone holding a plan id**. Whichever way R1 goes, D3 and D5 should be fixed on their own merits.
- **R2 — composed vs. independent staleness.** The arithmetic is confirmed (a fix can read "live" at roughly 2x the 45s threshold), and the composed value already exists as `lastFixAtMs`. But CLAUDE.md documents the two-gate design explicitly, so this is a documented-decision change, and it propagates into arrival detection.
- **R3 — trailing-trim refetch.** Facts confirmed; I disagree on priority and would rank it last. The narrow fix is smaller than described (a slice, not a merge) but the path is rare and it must honour the palette-slot allocator and the dangling-leg rule.
- **The remainder of A3** — retiring the clarification helpers (with their two private helpers, `countFromToken` and `categoryFromText`) means deleting live tests of a retired flow; and `LIVE_TRACKING_LABEL` is *unwired* rather than unused, its text re-spelled as literals in three places, so its disposition is a copy decision.
- **A4's prototype** (`index.html`) — archival decision, as Codex says.
- **The needs-care D-findings** (D1, D2, D3, D4, D5, D6, D7) — all verified as real, none safe to batch. Keep Codex's **D3 → D5 → D4** ordering; verification found a concrete reason for it that the original did not state (fixing D4 first is what would make D5's and D3's mistakes fire on every resume). I would also **raise D4's priority**: because there is no periodic by-id poll, a plan that simply runs to its end and is closed is, in the normal flow, never archived at all.

### False positives removed

**None.** No finding was removed from the actionable list, and nothing has been silently dropped. The four corrections above (A3, B1, D3, D4) sharpen scope, reachability or impact; none of them retracts a finding. The single non-finding I could not confirm is the credential-scan result, which I did not re-run and which Codex had already scoped honestly as "a scoped clean result, not a guarantee".

## 1. Summary

This audit found **14 findings**: four cleanup inventories, one bundle concern, two documentation/test issues, and seven correctness or resilience issues. Five are broadly suitable for a small cleanup/documentation/test batch; the remaining nine need individual review because they involve persisted state, asynchronous UI behavior, provider handling, or compatibility. Three additional proposals are separated under **Reconsider a documented decision**. The size observations and existing backlog inventory are not extra findings.

The codebase is generally disciplined: no orphaned application module or unused dependency was established, no hardcoded credential pattern was found in tracked files, and the shared planning/mutation cores and most failure paths are well covered. The material findings cluster around newer lifecycle integrations, not the scheduling algorithms. Passing tests do not cover several of those integrations.

### Scope and evidence

- Baseline: **main**, commit **47e31e102e13e6aa748ee7791c5558c37d08c830**. The working tree was clean before this audit.
- Read CLAUDE.md, AGENTS.md, and DEVLOG.md in full first, then the two earlier audit reports. Historical findings were treated as leads, not current defects.
- Inventoried all **202 tracked files**. Traced TypeScript imports/aliases/value-symbol references, Next filesystem entry points, configuration/script entry points, test-only consumers, CSS literals, and dynamically constructed class names. No application module was classified dead merely for lacking an ordinary import.
- **Fresh checks:** TypeScript passed with incremental output disabled; ESLint passed with **0 errors / 8 warnings**; **all 62 unit suites passed**.
- Additional probes ran against current source in isolated Node processes, using synthetic itineraries, the in-memory store, and substituted provider/auth/archive dependencies. They made no real provider, Redis, Firebase, or Firestore calls. Auth stubs prove route orchestration only, not token verification.
- Inspected the existing local production bundle for B1; did **not** rebuild it. No browser E2E, live-provider validation, deployment, dependency-advisory lookup, git-history credential scan, or production security assessment was performed.
- No implementation, test, dependency, configuration, instruction, or devlog file was changed. **AUDIT_FINDINGS.md is the only deliverable.** Suggested fixes below are descriptions, not patches.

## 2. Findings

### A. Dead / unused code

#### A1 — Unread React state and unused map-only fields remain after UI changes

**References:** [app/page.tsx:599](C:/Users/anshi/Desktop/itinerary/Itinerary/app/page.tsx:599), [app/page.tsx:601](C:/Users/anshi/Desktop/itinerary/Itinerary/app/page.tsx:601), [app/page.tsx:1049](C:/Users/anshi/Desktop/itinerary/Itinerary/app/page.tsx:1049), [app/page.tsx:1308](C:/Users/anshi/Desktop/itinerary/Itinerary/app/page.tsx:1308), [app/page.tsx:1550](C:/Users/anshi/Desktop/itinerary/Itinerary/app/page.tsx:1550); [app/ItineraryMap.tsx:39](C:/Users/anshi/Desktop/itinerary/Itinerary/app/ItineraryMap.tsx:39), [app/ItineraryMap.tsx:57](C:/Users/anshi/Desktop/itinerary/Itinerary/app/ItineraryMap.tsx:57); map projections at [app/page.tsx:312](C:/Users/anshi/Desktop/itinerary/Itinerary/app/page.tsx:312) and [app/page.tsx:335](C:/Users/anshi/Desktop/itinerary/Itinerary/app/page.tsx:335).

**What / impact:** parsedObj and travelLegs are setter-only state. Their values are never read; the actual flow uses local/PlanCtx values and the stored itinerary. They retain redundant objects and make state ownership harder to follow. The MapStop reason and blockedReason fields also have no map consumer; reason is still copied into both map projections. This is small maintenance/memory waste, not evidence of a visible rendering slowdown.

**Evidence / design check:** Fresh lint independently flags the two state values. Reference tracing distinguishes MapStop.reason from the live StripStop/itinerary reason. The earlier remediation tracker explicitly deferred these cleanup candidates; they remain present. React batching means deleting them should not be advertised as saving a render on every setter call.

**Confidence:** HIGH.  
**Suggested fix:** Remove the unread state declarations and their setters; remove only the unused MapStop fields and projection assignments. Preserve itinerary/selection/strip reasons and the real travel-leg objects.  
**Risk of fixing:** low.

> **[VERIFIED]** — confirmed accurate at every cited line; safe to act on as described. Confidence stays HIGH.
>
> **Independent trace.** `parsedObj` (page.tsx:599) and `travelLegs` (page.tsx:601): a case-sensitive repo-wide grep returns the declaration only. The three setter calls are at 1049, 1308 and 1550 exactly as cited. The `travelLegs` hits in `app/api/schedule/schedule.ts:590/629` are an unrelated local parameter, and `projectedTravelLegs` (page.tsx:2821) is a separate live memo — neither is a consumer. A fresh `npx eslint .` on the clean tree reports exactly these two as unused, among 8 total warnings and 0 errors.
>
> `MapStop.reason` (ItineraryMap.tsx:39) and `MapStop.blockedReason` (ItineraryMap.tsx:57): no read anywhere in `ItineraryMap.tsx` (the three other `reason` hits, at lines 255, 614 and 777, are prose in comments). `MapStop` values are never spread into a sub-component that could consume them; the only spread of a MapStop is `styledStops` (page.tsx:2644), which adds `status`/`changed`/`oldStart` and reads neither field. `MapsHarness.tsx` never mentions `reason` at all.
>
> **One correction, in the implementer's favour.** `blockedReason` is dead on *both* sides: neither `stopsFromSchedule` (page.tsx:298) nor `stopsFromItinerary` (page.tsx:324) ever assigns it, and nothing reads it. So its removal is the interface field alone. Only `reason` needs its two projection assignments deleted (page.tsx:312 and 335).
>
> **Also confirmed:** the batching caveat is right. Deleting setter-only state removes a redundant object, not a render — `setParsedObj`/`setTravelLegs` are each called inside handlers that already set other state in the same tick.

#### A2 — Twenty CSS class names have no current renderer

**References:** [app/globals.css:148](C:/Users/anshi/Desktop/itinerary/Itinerary/app/globals.css:148), [app/globals.css:252](C:/Users/anshi/Desktop/itinerary/Itinerary/app/globals.css:252), [app/globals.css:477](C:/Users/anshi/Desktop/itinerary/Itinerary/app/globals.css:477), [app/globals.css:510](C:/Users/anshi/Desktop/itinerary/Itinerary/app/globals.css:510), [app/globals.css:619](C:/Users/anshi/Desktop/itinerary/Itinerary/app/globals.css:619), [app/globals.css:622](C:/Users/anshi/Desktop/itinerary/Itinerary/app/globals.css:622), [app/globals.css:996](C:/Users/anshi/Desktop/itinerary/Itinerary/app/globals.css:996), [app/globals.css:1805](C:/Users/anshi/Desktop/itinerary/Itinerary/app/globals.css:1805), [app/globals.css:1822](C:/Users/anshi/Desktop/itinerary/Itinerary/app/globals.css:1822).

**What / impact:** The unused classes are `empty__kicker`, `prompt__golabel`, `wx-note`, `wherebar`, `leglab--dim`; `ecard`, `ecard__cat`, `ecard__badge`, `ecard__name`, `ecard__be`, `ecard__reason`, `ecard__meta`, `ecard--live`, `ecard--changed`, `ecard--blocked`; and `swapbar`, `swapbar__label`, `swapbar__input`, `swapbar__go`, `swapbar__err`. Their rules still enter the globally imported stylesheet. The main ecard and swapbar blocks alone occupy about **2.7 KB of source CSS**, before their extra responsive/reduced-motion occurrences. This is modest shipped dead weight.

**Evidence / design check:** Searched all TSX renderers, TS/JS DOM code, tests, and the prototype, including concatenations/templates. The apparently absent lstrip__tlrow--leave/arrive/board/alight classes are **live**, generated from row.kind at [app/ItineraryStrip.tsx:406](C:/Users/anshi/Desktop/itinerary/Itinerary/app/ItineraryStrip.tsx:406), and are excluded. The ecard comment at [app/globals.css:471](C:/Users/anshi/Desktop/itinerary/Itinerary/app/globals.css:471) already says it is dead and was retained because deletion was outside a re-skin; this is a previously deferred cleanup, not disagreement with the palette.

**Confidence:** HIGH.  
**Suggested fix:** Remove only those unused selectors, including their mobile occurrences. In the mixed reduced-motion selector, remove only the ecard member, preserving the live chip/marker/label/banner rule.  
**Risk of fixing:** low.

> **[VERIFIED]** — confirmed. All twenty class names have **zero** references outside `globals.css`. Confidence stays HIGH.
>
> **Independent trace.** Each of the twenty was searched across `app/`, `e2e/`, `scripts/` and `index.html` for `.tsx`/`.ts`/`.js`/`.jsx`/`.html`: all returned 0. I then checked the two ways a static search can be fooled here, and neither applies. There are exactly two template-literal class names in the whole app (`app/ItineraryStrip.tsx:406` and `app/page.tsx:2899`); every other dynamic class is plain concatenation of live literals (10 sites, all of the shape "live-class" plus an optional live modifier); and there is no `export *` barrel anywhere in `app/`.
>
> **Codex's exclusion is correct.** `lstrip__tlrow--{leave,arrive,board,alight}` really is generated from `row.kind` at ItineraryStrip.tsx:406; `TimelineRow.kind` is typed `"leave" | "arrive" | "board" | "alight"` in `app/lib/transitDetail.ts:34-37`, and the matching rules live at globals.css:962-965. Rightly excluded.
>
> **CORRECTION — a real trap in the deletion, not in the finding.** The dead `.ecard*` run at globals.css:477-497 is immediately followed at **globals.css:501-502 by `.old-time` and `.new-time`, which are LIVE** (`ItineraryMap.tsx:1149-1150` and `ItineraryStrip.tsx:739-740` — the reroute strike-through and settled-time pills). They sit inside the same visual block, below the last `.ecard` rule and above the `.leglab` rules. Deleting "the ecard block" by eyeballing its boundaries would take the reroute time pills with it. Delete by selector, never by line range.
>
> **Complete occurrence list, verified:** 148, 252, 471 (the `NOTE:` comment, which should go with the rules it describes), 477, 486, 487, 491, 492, 493, 494, 495, 496, 497, 510, 619, 622, 996, 1003, 1004, 1005, 1009, 1010, 1017, 1018, 1019, 1805 (mobile `.swapbar`), and 1822 (the mixed reduced-motion selector — remove only the `.ecard` member; `.chip`, `.mk__dot`, `.leglab` and `.banner` are all live).

#### A3 — Dormant exports and retired clarification helpers need a selective cleanup

**References:**

| Declaration | Reference result |
| --- | --- |
| parsePromptBody — [app/api/_shared/schemas.ts:57](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/_shared/schemas.ts:57) | No consumer; the route uses parsePlannerBody at line 84. |
| distributionOptions — [app/lib/planSlots.ts:165](C:/Users/anshi/Desktop/itinerary/Itinerary/app/lib/planSlots.ts:165) | No consumer, including tests. |
| finalizeRequestedSlots — [app/lib/planSlots.ts:92](C:/Users/anshi/Desktop/itinerary/Itinerary/app/lib/planSlots.ts:92) | Test-only; its post-clarification client flow was removed. |
| slotsFromDistributionAnswer — [app/lib/planSlots.ts:139](C:/Users/anshi/Desktop/itinerary/Itinerary/app/lib/planSlots.ts:139) | Test-only; likewise belongs to the retired clarification flow. |
| PLAN_TRAVEL_MODES — [app/api/schedule/travel.ts:33](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/schedule/travel.ts:33) | No consumer; the live validator and UI do not read this array. |
| MAX_PROVIDER_CALLS_WITH_GENERAL_POOL — [app/api/places/search/searchPlaces.ts:69](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/places/search/searchPlaces.ts:69) | No consumer; this named ceiling does not itself enforce or test a limit. |
| LIVE_TRACKING_LABEL / LIVE_TRACKING_EXPLAINER — [app/lib/liveTracking.ts:66](C:/Users/anshi/Desktop/itinerary/Itinerary/app/lib/liveTracking.ts:66), [app/lib/liveTracking.ts:75](C:/Users/anshi/Desktop/itinerary/Itinerary/app/lib/liveTracking.ts:75) | No consumer; the current toggle uses other live copy/helpers. |

**What / impact:** These declarations add dormant API surface and, for the old clarification helpers, tests of a flow the product no longer calls. This is maintenance weight; tree shaking may already remove unused browser exports, so it is not a measured bundle saving.

**Evidence / design check:** Compiler-symbol tracing was followed by call-site searches, including scripts and tests. [DEVLOG.md:480](C:/Users/anshi/Desktop/itinerary/Itinerary/DEVLOG.md:480) explicitly records the old client clarification mechanism's removal. However, **planSlots.ts is not a dead file**: parseParsedPrompt calls normalizeStopCountSlots, which calls resolveRequestedSlots. Their count validation and tests remain live. The unconsumed location strings were approved as “locked honest label copy”; do not rewrite that wording as part of cleanup. The numeric ceiling's value is not questioned.

**Confidence:** HIGH on reachability.  
**Suggested fix:** Remove the unused old request parser. Separately review retiring only the old clarification functions, their exclusive private helpers, and corresponding assertions at [app/lib/planSlots.test.ts:64](C:/Users/anshi/Desktop/itinerary/Itinerary/app/lib/planSlots.test.ts:64) and [app/lib/planSlots.test.ts:104](C:/Users/anshi/Desktop/itinerary/Itinerary/app/lib/planSlots.test.ts:104). Preserve the live normalization/validation path. Decide whether the unused policy/copy declarations should remain explicit documentation or be retired; do not invent runtime use just to silence an unused declaration. Coordinate clarification cleanup with the already-recorded raw-count backlog.

**Risk of fixing:** needs-care for the clarification/compatibility portion; the isolated unused parser is low risk.

> **[VERIFIED, WITH CORRECTION]** — every reachability claim is accurate at the exact line cited, and `parsePlannerBody` really is at schemas.ts:84. Four corrections change what an implementer should *do*, not whether the finding is true.
>
> **Independent trace (all eight, repo-wide, tests and scripts included):** `parsePromptBody` schemas.ts:57 — definition only, and no test imports it. `distributionOptions` planSlots.ts:165 — definition only. `finalizeRequestedSlots` planSlots.ts:92 — test-only (planSlots.test.ts:4, 104, 111, 122, 132). `slotsFromDistributionAnswer` planSlots.ts:139 — test-only (planSlots.test.ts:7, 64, 68, 72). `PLAN_TRAVEL_MODES` travel.ts:33 — definition only (the live guard beside it, `isPlanTravelMode` at :35, does not read the array). `MAX_PROVIDER_CALLS_WITH_GENERAL_POOL` searchPlaces.ts:69 — definition only. `LIVE_TRACKING_LABEL` liveTracking.ts:66 and `LIVE_TRACKING_EXPLAINER` liveTracking.ts:75 — definition only.
>
> **Codex's "planSlots.ts is not a dead file" caveat is correct and load-bearing:** `schemas.ts:14` imports `normalizeStopCountSlots`, which calls `resolveRequestedSlots` (planSlots.ts:56). DEVLOG.md:480 does say what Codex quotes, verbatim.
>
> **CORRECTION 1 — name the orphan helpers.** `countFromToken` (planSlots.ts:121) and `categoryFromText` (planSlots.ts:127) are private and used *only* by `slotsFromDistributionAnswer` (at lines 157-158). Retiring that function without them leaves two new unused declarations and two fresh lint warnings.
>
> **CORRECTION 2 — `LIVE_TRACKING_LABEL` is UNWIRED, not merely unused.** Its exact text is re-spelled as a string literal in three places: `app/lib/youMarker.ts:144`, `youMarker.ts:146` ("Live location paused. ...") and `app/page.tsx:3363`. CLAUDE.md records this copy as Piece 0's "locked honest label copy", so the honest options are (a) wire the constant into those sites, or (b) delete it and accept that the locked copy now lives only as literals. Deleting it silently is the one choice that contradicts the documented intent. `LIVE_TRACKING_EXPLAINER` is different: its text appears nowhere else, so it is a genuine unshipped string. The other four copy constants in that block *are* consumed (`WHILE_OPEN_NOTE`, `DENIED_NOTE`, `UNAVAILABLE_NOTE`, `LAST_KNOWN_LABEL`).
>
> **CORRECTION 3 — the numeric ceiling is a documentation-constant pattern, not an oversight.** Its sibling `MAX_PROVIDER_CALLS_PER_SEARCH` (searchPlaces.ts:68) has no runtime consumer either: its only reference is a test assertion (`searchPlaces.test.ts:277`, asserting it equals 16) plus a comment at :172. The file deliberately exports both derived ceilings as checkable documentation of the call bound. Retiring only the untested one makes the pair inconsistent; the better outcomes are a test pinning its value too, or leaving both alone. Not a defect either way.
>
> **CORRECTION 4 — `distributionOptions` is the only one of the eight with literally zero references, tests included.** After `parsePromptBody` it is the cleanest deletion in the group.
>
> **Risk assessment stands:** `parsePromptBody` and `distributionOptions` are low risk; the clarification pair plus its two private helpers is a test-deleting decision, correctly marked needs-care.

#### A4 — A tracked Chromium log and a runtime-dead prototype remain at the root

**References:** [debug.log:1](C:/Users/anshi/Desktop/itinerary/Itinerary/debug.log:1), [index.html:1](C:/Users/anshi/Desktop/itinerary/Itinerary/index.html:1); earlier inventory at [code-audit-2026-07-24-remediation.md:85](C:/Users/anshi/Desktop/itinerary/Itinerary/code-audit-2026-07-24-remediation.md:85).

**What / impact:** debug.log is a 154-byte Chromium GPU error, unrelated to application source or tests. index.html is a 31,533-byte standalone prototype. It is not under public/, is not a Next entry point, and has no runtime/tooling consumer. These add repository noise; **the prototype is not shipped in the Next client bundle**.

**Evidence / design check:** Both are tracked. No source/config/script references were found. The previous audit already left the prototype's archival value for the owner to decide. No tracked docs/research material was found; its absence is intentional. The historical Groq capacity probe is no longer in the tracked tree and is not re-flagged.

**Confidence:** HIGH.  
**Suggested fix:** Remove the accidental debug log and prevent recurrence. For the prototype, make an explicit archival decision: keep it clearly labeled as historical reference, move it to an archive location, or retire it if no longer useful. Do not delete historical audit/devlog documents merely because they describe older code.  
**Risk of fixing:** low; prototype disposition needs an owner decision.

> **[VERIFIED]** — confirmed. Both files are tracked (`git ls-files`), and neither has any source, config or script reference. Confidence stays HIGH.
>
> **Independent trace.** `debug.log` is exactly one line: a Chromium `command_buffer_proxy_impl.cc` GPU `kTransientFailure`, with no application content. `index.html` is referenced by nothing in `app/`, `e2e/`, `scripts/`, `package.json`, `next.config.mjs` or either Playwright config; it is not under `public/`; and the App Router never serves a root `index.html`.
>
> **Supporting detail Codex did not state:** the prototype's class vocabulary (`bg-weather`, `dest-photo`, `ampm-btn`, `picker-footer`, `calendar-grid`, …) shares **nothing** with the shipped app's (`lstrip__*`, `mk--*`, `chip`, `leglab__*`). It is an independent design prototype, not a stale copy of the current UI. That both confirms it is runtime-dead and supports its archival value being a genuine question rather than a formality.
>
> **On "prevent recurrence":** `.gitignore` currently holds `.env`, `node_modules`, `.next/`, `test-results/`, `playwright-report/`, `*.tsbuildinfo` and one research path. There is **no `*.log` rule**, so preventing recurrence means adding one. (Codex's related note that no tracked `docs/research` material exists is confirmed and intentional: `.gitignore` names `docs/research/reddit-demand-analysis.md` explicitly.)

### B. Genuine inefficiency

#### B1 — The server-only coordinate-to-timezone lookup data reaches the browser bundle

**References:** [app/lib/zoneTime.ts:8](C:/Users/anshi/Desktop/itinerary/Itinerary/app/lib/zoneTime.ts:8), [app/lib/zoneTime.ts:17](C:/Users/anshi/Desktop/itinerary/Itinerary/app/lib/zoneTime.ts:17), [app/lib/timeLabels.ts:19](C:/Users/anshi/Desktop/itinerary/Itinerary/app/lib/timeLabels.ts:19), [app/lib/clientPayloads.ts:12](C:/Users/anshi/Desktop/itinerary/Itinerary/app/lib/clientPayloads.ts:12); actual coordinate lookup at [app/api/geocode/geocode.ts:431](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/geocode/geocode.ts:431).

**What / impact:** Client formatting/validation imports zoneTime, whose top-level import loads the CommonJS tz-lookup package. The only production caller of zoneFromLatLng is the server geocoder. The browser needs the resolved zone and zone-aware formatting, not the geographic lookup database.

**Evidence / design check:** The existing local production page manifest loads chunk 416-30d10653f4e2bf1e.js, which contains tz-lookup's database. That chunk is **75,595 bytes raw / 30,830 bytes gzip**; the installed lookup source itself is **73,439 / 29,220 bytes**. These are supporting measurements from the existing build, not a promised exact saving from a fresh build. The documented reason for the offline package is avoiding an API and fitting serverless deployment; no reason was found to send its data to the client.

**Confidence:** MEDIUM — source reachability and an existing built-page payload are verified; a fresh production build was intentionally not generated.  
**Suggested fix:** Isolate/lazily load the geographic lookup dependency on its server-only path so client zone formatting does not eagerly include the database. Preserve the offline lookup, fallback behavior, zoneTime's public contract, and all scheduling/time arithmetic. Verify the resulting production module graph before claiming a saving.  
**Risk of fixing:** needs-care.

> **[VERIFIED, WITH CORRECTION]** — the finding is real, and I would raise its confidence from MEDIUM to **HIGH on both reachability and shipped payload**. The one thing that remains unmeasured is the post-fix build, which is the right thing to hold back.
>
> **Independent trace.** `zoneTime.ts:8` is a top-level `import tzlookup from "tz-lookup"`, so the package loads whenever the module does. The **only** production caller of `zoneFromLatLng` is `app/api/geocode/geocode.ts:431` (server). The browser reaches `zoneTime` through three importers that need only `normalizeZone`/`DEFAULT_ZONE`: `timeLabels.ts:19` (imported by page.tsx:13, ItineraryStrip.tsx:4 and ItineraryMap.tsx:5), `clientPayloads.ts:12`, and `historyView.ts:17` (page.tsx:89).
>
> **Confirmed in the existing build, and stronger than stated.** `.next/server/app/index.html` loads `/_next/static/chunks/416-30d10653f4e2bf1e.js` eagerly in the page's own script list, and `page_client-reference-manifest.js` lists it among `app/page.tsx`'s chunks. That chunk is the only one of the fourteen containing tz-lookup's database — and it contains **no luxon** (the sole luxon hit across all client chunks is elsewhere). At 75,595 bytes raw against tz-lookup's own 73,439-byte source, chunk 416 is essentially the lookup database alone, already isolated. So the plausible saving is close to the whole chunk rather than a fraction of a mixed one.
>
> **CORRECTION — my gzip figures differ slightly, and Codex's are fine.** I measured 30,040 bytes gzip for the chunk and 28,937 for `node_modules/tz-lookup/tz.js`, against Codex's 30,830 and 29,220. That is a gzip-level difference, not a discrepancy in the underlying files (the raw byte counts match exactly). Immaterial either way; treat all four as approximate.
>
> **CORRECTION — a documented constraint Codex did not surface.** Both CLAUDE.md and AGENTS.md state that "Zone math lives ONLY in `app/lib/zoneTime.ts` (luxon + tz-lookup, both offline)". Moving `zoneFromLatLng` to a server-only module is compatible with the *spirit* of that rule (a coordinate-to-zone lookup is a geographic lookup, not zone arithmetic) but contradicts its letter, so the change carries a mandatory one-line doc amendment in **both** files. `app/lib/zoneTime.test.ts:14` also imports `zoneFromLatLng` and moves with it. Neither is hard; both are easy to forget.
>
> **Risk stays needs-care**, and Codex's instruction to verify the resulting module graph before claiming a saving is the right gate.

No unsupported N+1 or expensive-rerender finding is asserted. Requests for consecutive travel legs are dependency-ordered; mode alternatives and independent Places searches already run concurrently. A local microbenchmark of eight existing map time labels averaged about 0.36 ms per batch after warm-up, which does not establish a worthwhile memoization change. The documented trailing-trim refetch is discussed separately in R3.

### C. Structural / organizational

#### C1 — Current setup/deployment instructions still describe the pre-server-auth product

**References:** [README.md:131](C:/Users/anshi/Desktop/itinerary/Itinerary/README.md:131), [README.md:170](C:/Users/anshi/Desktop/itinerary/Itinerary/README.md:170), [README.md:184](C:/Users/anshi/Desktop/itinerary/Itinerary/README.md:184), [DEPLOY.md:27](C:/Users/anshi/Desktop/itinerary/Itinerary/DEPLOY.md:27), [DEPLOY.md:43](C:/Users/anshi/Desktop/itinerary/Itinerary/DEPLOY.md:43), [DEPLOY.md:105](C:/Users/anshi/Desktop/itinerary/Itinerary/DEPLOY.md:105), [.env.example:1](C:/Users/anshi/Desktop/itinerary/Itinerary/.env.example:1). Current implementation: [app/lib/firebaseAdmin.ts:37](C:/Users/anshi/Desktop/itinerary/Itinerary/app/lib/firebaseAdmin.ts:37), [app/api/itinerary/route.ts:73](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/itinerary/route.ts:73), [app/api/parse/route.ts:66](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/parse/route.ts:66); declared Node requirement: [package.json:6](C:/Users/anshi/Desktop/itinerary/Itinerary/package.json:6).

**What / impact:** README/DEPLOY explicitly claim current main has only Stage 1A and no server token verification, ownership, history/archive, or profile use. These features now exist. Neither setup guide nor .env.example documents the three server Admin credentials; the example also lacks the optional Firebase client configuration. Following the guides can yield working sign-in but no owned/resumable plans, history, or personalization. Both guides say Node 20.9+, whereas this repository declares **22.12.0+**.

**Evidence / design check:** These are present-tense setup claims, not dated historical devlog entries. The auth boundary is still partial: correcting the docs must **not** claim that all by-id reads/mutations enforce ownership. AGENTS.md also retains acknowledged stale weather/geolocation statements; current code and CLAUDE's later sections supersede them.

**Confidence:** HIGH.  
**Suggested fix:** Reconcile the current setup/environment/auth sections with source, documenting secret server credentials separately from public Firebase configuration, the anonymous identity path, and the actual remaining authorization limits. Align the prerequisite with package.json. Mark HANDOFF's dated branch snapshot as historical if it remains an entry point; do not rewrite historical evidence as though it described today.  
**Risk of fixing:** low.

> **[VERIFIED]** — confirmed at every cited line, and the impact is **larger than "documentation drift"**. Confidence stays HIGH.
>
> **Independent trace of the stale claims.** README.md:184 reads verbatim: "Stage 1A captures client auth state only. Current `main` has no server-side token verification, owner-only itinerary mutation, account history/archive, or sharing contract." DEPLOY.md:105-108 says the same at greater length. Both are false: `verifyCaller` is called at `app/api/itinerary/route.ts:73` and `app/api/parse/route.ts:66`, `firebaseAdmin.ts:37` reads three Admin credentials, `/end` enforces `ownsItinerary`, and the history reader and profile store are both live. README.md:131 and DEPLOY.md:27 both say Node **20.9+** against `package.json:6`'s `">=22.12.0"`.
>
> **The functional half, which Codex understates.** `.env.example` documents six keys and **none** of `FIREBASE_ADMIN_PROJECT_ID`, `FIREBASE_ADMIN_CLIENT_EMAIL`, `FIREBASE_ADMIN_PRIVATE_KEY`; it omits the six `NEXT_PUBLIC_FIREBASE_*` values entirely. DEPLOY.md's environment table *does* list the six public Firebase values (lines 43-48) but calls them "client-only Google sign-in", and it **also omits all three Admin credentials**. So someone deploying by following DEPLOY.md gets a build where `readCredentials()` returns null, `verifyCaller` never resolves a caller, and ownership, resume, history and taste personalization all silently do nothing — with no error surfaced, because every one of those paths is designed to degrade quietly. That is a deployment defect expressed as a documentation gap, not a cosmetic one.
>
> **Two more inaccuracies in the same files, worth fixing in the same pass:** `.env.example` labels `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` "the only key exposed to the browser", which CLAUDE.md explicitly contradicts ("Two things are deliberately browser-side"). And `package.json:36` pins `"@types/node": "^20"` while `engines` requires 22.12.0+ — worth aligning while the prerequisite is being corrected.
>
> **Codex's caution is correct and must be honoured:** the auth boundary really is partial. `/swap`, `/remove`, `/mode`, `/reroute` and the by-id `GET` do **no** caller verification (verified directly; see R1). The corrected docs must say that plainly rather than claim a finished security feature.

#### C2 — Three mock scenarios still depend on the real planning clock

**References:** [e2e/scenarios.spec.ts:329](C:/Users/anshi/Desktop/itinerary/Itinerary/e2e/scenarios.spec.ts:329), [e2e/scenarios.spec.ts:496](C:/Users/anshi/Desktop/itinerary/Itinerary/e2e/scenarios.spec.ts:496), [e2e/scenarios.spec.ts:519](C:/Users/anshi/Desktop/itinerary/Itinerary/e2e/scenarios.spec.ts:519); browser clock sent at [app/page.tsx:1034](C:/Users/anshi/Desktop/itinerary/Itinerary/app/page.tsx:1034); existing fixed-clock example at [e2e/scenarios.spec.ts:549](C:/Users/anshi/Desktop/itinerary/Itinerary/e2e/scenarios.spec.ts:549); acknowledged at [CLAUDE.md:106](C:/Users/anshi/Desktop/itinerary/Itinerary/CLAUDE.md:106).

**What / impact:** The 5–8 PM end-confirmation, 5–9 PM stated-window, and 7–9 PM overstuffed-window scenarios expect an entire early window while using the current clock. Late runs correctly receive a clamped remaining window and can fail the suite for reasons unrelated to a regression.

**Evidence / design check:** This is the already-documented test defect, reverified in current test setup. No shared hook fixes their clock, whereas a later scenario explicitly freezes it. Browser E2E was not rerun in this audit; the earlier failure trace is historical evidence, not a fresh failure claim.

**Confidence:** HIGH.  
**Suggested fix:** Freeze the browser/planning instant through the existing test seam for these scenarios and ensure any server-derived status expectation uses a compatible instant. Keep their substantive expectations and all production window calculations unchanged.  
**Risk of fixing:** low.

> **[VERIFIED]** — confirmed, at the exact tests named. Confidence stays HIGH.
>
> **Independent trace.** `e2e/scenarios.spec.ts:329` is the 5-8pm end-confirmation test, `:496` the 5-9pm stated-window test, `:519` the 7-9pm over-stuffed test. None calls `page.addInitScript` or otherwise freezes a clock. The working seam Codex points at is real: line 548 declares the `'right away' plans TONIGHT's next full hour` test, and line **549** begins its `page.addInitScript` Date override, so Codex's citation anchors the seam itself rather than the test title — the more useful pointer.
>
> **I independently confirmed there is no shared fix.** `e2e/helpers.ts` contains no `addInitScript` and no clock fixture (its only "clock" mentions are prose in a comment at lines 200-203); `playwright.config.ts` installs none either. So each of the three has to freeze its own instant, exactly as line 549 does.
>
> **Cross-checked against the docs, as instructed.** CLAUDE.md:106 is the `Current counts` bullet, and it carries the full evidence trail for these three, including that the 5-8pm one *times out* at 1.0m rather than failing an assertion, and that all three reproduce identically with changes stashed. That matches the finding.
>
> **One thing to carry into the fix, from CLAUDE.md rather than from Codex:** `mobile.spec.ts` at 768px is a **separate, pre-existing** failure (the dev panel overlapping the map-fallback dismiss button), re-verified on a clean tree at HEAD. Fixing the three clocks will not by itself make `npm run check`'s e2e step green, and an implementer who expects it to will wrongly conclude the fix failed.

#### Size observations — not additional defect findings

| File | Current size | Concrete boundary worth considering |
| --- | --- | --- |
| [app/page.tsx:352](C:/Users/anshi/Desktop/itinerary/Itinerary/app/page.tsx:352) | 3,677 lines / 155,719 bytes | The clarification/recovery render blocks beginning at [app/page.tsx:2872](C:/Users/anshi/Desktop/itinerary/Itinerary/app/page.tsx:2872) are separable presentation. Pass the existing discriminated state and handlers into a component; keep one recovery panel and keep orchestration/state ownership in the page. |
| [app/ItineraryMap.tsx:374](C:/Users/anshi/Desktop/itinerary/Itinerary/app/ItineraryMap.tsx:374) | 1,165 lines / 49,651 bytes | Native route-overlay construction is a recognizable boundary, but its owned-overlay cleanup/cancellation contract makes extraction needs-care. Size alone does not justify doing it. |
| [app/api/itinerary/swap.ts:1910](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/itinerary/swap.ts:1910) | 2,542 lines / 104,612 bytes | No low-risk whole-engine split recommended. removeStop/modeSwitch already import the shared cascade. Moving that dependency-heavy spine just to shorten the file would override documented caution. |
| [app/api/parse/planner.ts:148](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/parse/planner.ts:148) | 1,078 lines / 53,693 bytes | Much is the semantic prompt and explanatory history. No prompt-content or scheduling refactor is recommended. |

These are HIGH-confidence size/boundary observations, with no correctness claim. The first boundary is a low-risk optional presentation extraction; the others need individual review or no action.


> **[VERIFIED]** — sizes confirmed. `page.tsx` 155,719 bytes, `ItineraryMap.tsx` 49,651, `swap.ts` 104,612, `planner.ts` 53,693 — byte counts match exactly. Line counts are each one lower by `wc -l` (3,676 / 1,164 / 2,541 / 1,077), which is a trailing-newline counting difference, not a discrepancy. `clarifyBlock` does begin at page.tsx:2872.
>
> The judgement that only the first boundary is a low-risk optional extraction is sound, and the caution on `ItineraryMap`'s owned-overlay cleanup contract and on `swap.ts`'s exported shared ladder matches what CLAUDE.md documents about both. **No action recommended from this table.** One incidental note for whoever maintains the docs: CLAUDE.md still calls `swap.ts` "a 2379-line engine covered by a 2323-line suite" in the remove-stop section — a historical figure inside a decision record, now 2,541 lines. Not worth changing on its own.

#### Consolidated TODO / deferred-work inventory — not new findings

There is **one literal production TODO and no production FIXME**. Historical mentions of old TODOs are not current comments. Items below retain their existing scope; listing them does not authorize implementation or changes to the scheduler, facts/LLM boundary, constants, or prompts.

| Item | Current evidence and status |
| --- | --- |
| Real movie runtimes/showtimes | [app/api/schedule/durations.ts:19](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/schedule/durations.ts:19), [CLAUDE.md:276](C:/Users/anshi/Desktop/itinerary/Itinerary/CLAUDE.md:276). The sole production TODO; placeholder still present. |
| Reservation/availability integration | [CLAUDE.md:274](C:/Users/anshi/Desktop/itinerary/Itinerary/CLAUDE.md:274), [app/api/itinerary/swap.ts:680](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/itinerary/swap.ts:680). Existing availability seam; provider integration deferred. |
| GTFS/realtime disruption detection, live delay/connection handling, rideshare | [CLAUDE.md:275](C:/Users/anshi/Desktop/itinerary/Itinerary/CLAUDE.md:275), [code-audit-2026-07-24-remediation.md:88](C:/Users/anshi/Desktop/itinerary/Itinerary/code-audit-2026-07-24-remediation.md:88). Real reroute engine, no automatic realtime trigger. Transit-detail/palette rendering is now implemented, so the older queue is only partially outstanding. Driving is also implemented; the old “TRANSIT and WALK only” phrase is stale. |
| One city per plan; location-assisted planning input | [CLAUDE.md:277](C:/Users/anshi/Desktop/itinerary/Itinerary/CLAUDE.md:277), [app/page.tsx:585](C:/Users/anshi/Desktop/itinerary/Itinerary/app/page.tsx:585). Multi-city outings and using device location as the planning origin remain unbuilt. Display-only live tracking exists; geolocation is no longer wholly absent. |
| Dev time picker's viewer-zone interpretation | [CLAUDE.md:278](C:/Users/anshi/Desktop/itinerary/Itinerary/CLAUDE.md:278), [app/page.tsx:1991](C:/Users/anshi/Desktop/itinerary/Itinerary/app/page.tsx:1991). Recorded dev-only limitation; no time-math change proposed. |
| Stop reordering | [CLAUDE.md:279](C:/Users/anshi/Desktop/itinerary/Itinerary/CLAUDE.md:279). Still separate deferred scope; stop removal is implemented. |
| Selection reasons do not see final scheduled times | [CLAUDE.md:280](C:/Users/anshi/Desktop/itinerary/Itinerary/CLAUDE.md:280). Existing stage boundary; no semantic-prompt change proposed. |
| Initial-plan whole-occupancy availability asymmetry | [CLAUDE.md:146](C:/Users/anshi/Desktop/itinerary/Itinerary/CLAUDE.md:146), [app/api/itinerary/swap.ts:845](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/itinerary/swap.ts:845). Explicit follow-up: moved mutation proposals check occupancy, initial filtering remains arrival-oriented. Inventory only. |
| Transit platform wait / underbudgeted elapsed leg | [CLAUDE.md:90](C:/Users/anshi/Desktop/itinerary/Itinerary/CLAUDE.md:90). Explicitly flagged, not implemented. Scheduling work is outside this audit's recommendations. |
| Earlier-shifted provider times can remain monotone but stale | [CLAUDE.md:88](C:/Users/anshi/Desktop/itinerary/Itinerary/CLAUDE.md:88). Documented conservative display limitation, not reclassified as a new bug. |
| Declined/unsolved weather block has no pin | [CLAUDE.md:284](C:/Users/anshi/Desktop/itinerary/Itinerary/CLAUDE.md:284). Deliberate: no venue means no coordinate. Partial weather recovery is implemented. |
| Weather during swaps/reroutes | [CLAUDE.md:281](C:/Users/anshi/Desktop/itinerary/Itinerary/CLAUDE.md:281), [app/api/itinerary/swap.ts:665](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/itinerary/swap.ts:665), [app/api/itinerary/reroute.ts:123](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/itinerary/reroute.ts:123). **Resolved**, not outstanding despite older AGENTS prose. |
| Expanded-card overlap wording | [CLAUDE.md:282](C:/Users/anshi/Desktop/itinerary/Itinerary/CLAUDE.md:282), [app/globals.css:471](C:/Users/anshi/Desktop/itinerary/Itinerary/app/globals.css:471). The expanded map card was retired. Treat this old wording as stale, not proof that the removed card still needs a fix. |
| One-frame native-map/React-overlay lag | [CLAUDE.md:283](C:/Users/anshi/Desktop/itinerary/Itinerary/CLAUDE.md:283). Accepted and deferred. No direct-DOM overlay rewrite recommended here. |
| Second-city geometry/timezone mock coverage | [CLAUDE.md:285](C:/Users/anshi/Desktop/itinerary/Itinerary/CLAUDE.md:285). Mock geocoding deliberately proves plumbing only; real-coordinate checks remain live work. |
| Nested stored travel-leg validation | [CLAUDE.md:92](C:/Users/anshi/Desktop/itinerary/Itinerary/CLAUDE.md:92). Still outstanding; reproduced as D2 below. |
| Raw prompt count and malformed calendar/clock floors | [code-audit-2026-07-24-remediation.md:60](C:/Users/anshi/Desktop/itinerary/Itinerary/code-audit-2026-07-24-remediation.md:60), [code-audit-2026-07-24-remediation.md:63](C:/Users/anshi/Desktop/itinerary/Itinerary/code-audit-2026-07-24-remediation.md:63), [README.md:275](C:/Users/anshi/Desktop/itinerary/Itinerary/README.md:275). Recorded planner-path follow-ups, distinct from the live legacy guard. Not newly implemented or semantically re-audited here. |
| Clock-dependent mock cases | [CLAUDE.md:106](C:/Users/anshi/Desktop/itinerary/Itinerary/CLAUDE.md:106). C2; do not excuse unrelated failures as this known issue. |
| Reported narrow/dev-panel E2E or runner failures | [CLAUDE.md:106](C:/Users/anshi/Desktop/itinerary/Itinerary/CLAUDE.md:106), [scripts/playwrightExitReporter.ts:21](C:/Users/anshi/Desktop/itinerary/Itinerary/scripts/playwrightExitReporter.ts:21). Historical warnings require a fresh matching failure before action. This audit did not reproduce them and does not declare a new harness bug. |
| Real-provider visual, driving, mode-switch and billing/SKU checks | [CLAUDE.md:121](C:/Users/anshi/Desktop/itinerary/Itinerary/CLAUDE.md:121), [HANDOFF.md:318](C:/Users/anshi/Desktop/itinerary/Itinerary/HANDOFF.md:318). Source documents these as pending/partially done. No deployed-state or billing conclusion is asserted here. |
| Taste-biased planner prompt tuning | [CLAUDE.md:121](C:/Users/anshi/Desktop/itinerary/Itinerary/CLAUDE.md:121). Stage 3B's mechanism exists; its preference-bias/explicit-override balance is explicitly unfinished. Inventory only: no prompt-content changes are recommended by this audit. |
| Real-device live-location and arrival checks | [CLAUDE.md:123](C:/Users/anshi/Desktop/itinerary/Itinerary/CLAUDE.md:123). Owner checks of permission prompts, real position/movement, background/resume, stale presentation and arrival remain necessary. Pure reducers and mock Maps tests do not establish real GPS behavior; D6's source-level integration defect is separate. |
| True deferred-loader cancellation scenario | [HANDOFF.md:338](C:/Users/anshi/Desktop/itinerary/Itinerary/HANDOFF.md:338). Explicitly not added because the current harness does not naturally exercise it; existing lifecycle tests are retained. |
| Ownership/sharing/migration/retention product contract | [code-audit-2026-07-24-remediation.md:75](C:/Users/anshi/Desktop/itinerary/Itinerary/code-audit-2026-07-24-remediation.md:75). Parts of Stage 1B shipped, but broad by-id enforcement is still absent. R1 requires an owner decision, not blind implementation of the old proposal. |
| Global abuse controls, key restrictions, quotas, log governance | [DEPLOY.md:182](C:/Users/anshi/Desktop/itinerary/Itinerary/DEPLOY.md:182), [DEPLOY.md:201](C:/Users/anshi/Desktop/itinerary/Itinerary/DEPLOY.md:201), [DEPLOY.md:210](C:/Users/anshi/Desktop/itinerary/Itinerary/DEPLOY.md:210). Per-process guards exist; production dashboard/infrastructure work cannot be established from this checkout. Old dependency-advisory snapshots were not treated as current vulnerabilities. |
| CSP rollout, managed abuse protection and post-deploy quota verification | [DEPLOY.md:214](C:/Users/anshi/Desktop/itinerary/Itinerary/DEPLOY.md:214), [DEPLOY.md:218](C:/Users/anshi/Desktop/itinerary/Itinerary/DEPLOY.md:218), [DEPLOY.md:221](C:/Users/anshi/Desktop/itinerary/Itinerary/DEPLOY.md:221). Existing operational checklist: report-only CSP review before enforcement, WAF/bot handling that preserves ordinary use, and controlled rejection checks against provider dashboards. Not verified from this checkout. |


> **[VERIFIED]** — spot-checked and correct. Confidence HIGH.
>
> **The headline claim holds exactly:** a repo-wide scan of non-test `.ts`/`.tsx` returns **one** literal `TODO` and **zero** `FIXME`, at `app/api/schedule/durations.ts:19`, on the movie placeholder — precisely as stated.
>
> **The "Resolved" row is right, and I verified it rather than trusting it.** Both engines wire the forecast (`swap.ts:665`, `reroute.ts:123`), both fetch it (`swap.ts:722`, `reroute.ts:315`), and **no `weather: null` literal remains in either file**. Worth noting for the C1 documentation pass: AGENTS.md:97 still lists "Reroute AND swap skip the weather gate — both pass `weather: null` to `filterPools`" as an open gap, which is now false, and CLAUDE.md's own citations for the fix (`swap.ts:587`, `reroute.ts:114`) have drifted from the current lines — Codex's numbers are the current ones.
>
> **The inventory's framing is the right one:** these are dated scope records to check against code, not a to-do list this audit authorises. Nothing in the table proposes touching the scheduler, the facts/LLM boundary, a policy constant or a prompt, and nothing should.

### D. Security / correctness scan

#### D1 — Provider deadlines end at headers, leaving response bodies unbounded

**References:** [app/api/_shared/provider.ts:110](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/_shared/provider.ts:110), [app/api/_shared/provider.ts:126](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/_shared/provider.ts:126), [app/api/_shared/provider.ts:134](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/_shared/provider.ts:134), [app/api/_shared/provider.ts:148](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/_shared/provider.ts:148). Affected caller example: [app/api/parse/route.ts:80](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/parse/route.ts:80).

**What / impact:** fetchProvider clears its timeout as soon as fetch resolves. Fetch resolves when headers arrive; readProviderJson subsequently awaits response.text outside that deadline. A provider can return headers promptly and then stall the body, leaving the function busy beyond its advertised provider budget. The browser's separate timeout does not bound that server work.

**Evidence / design check:** An in-memory Response stream returned headers immediately and never finished its body. With the existing helper's timeout argument set to 10 ms, at 40 ms the signal was still un-aborted and the JSON read remained unsettled. The stream was explicitly terminated afterward. This is not a proposal to change the documented 25/45-second limits or model retry policy.

**Confidence:** HIGH.  
**Suggested fix:** Keep one provider deadline and caller-abort lifecycle active through body consumption, with cleanup after consumption/failure. Preserve the existing public error shape and retry classification, and verify a delayed-body timeout rather than only a fetch that never returns headers.  
**Risk of fixing:** needs-care.

> **[VERIFIED]** — confirmed at all four line numbers, and **independently reproduced**. Confidence stays HIGH.
>
> **Independent trace.** `fetchProvider` is at provider.ts:110; its `return await fetch(...)` is at :126; the `clearTimeout(timeout)` sits in a `finally` at :134, so the deadline is released the moment `fetch` resolves — which is when headers arrive, not when the body completes. `readProviderJson`'s `await response.text()` at :148 then runs with no deadline at all. The same `finally` also removes the caller's abort listener (`init.signal?.removeEventListener`, :135), so a caller-side abort stops bounding the body read too — a detail worth carrying into the fix.
>
> **My own reproduction, matching Codex's.** I mirrored `fetchProvider`'s exact structure around a `Response` built on a `ReadableStream` that emits partial JSON and never closes, with the timeout set to **10 ms**. Headers returned at 0 ms; at **68 ms** the `.text()` promise was still unsettled; it settled only when I explicitly closed the stream. So the advertised provider budget genuinely does not cover body consumption.
>
> **Scoping the severity honestly.** Nothing about this is provider-typical (a stalled body is a hostile or badly broken upstream), and on Vercel the platform function timeout is a backstop. But the gap is exactly as described: `PROVIDER_TIMEOUT_MS.openrouter` (45s) is advertised as the server's ceiling and does not bound the read, and `DEFAULT_CLIENT_FETCH_TIMEOUT_MS` (25s) bounds only the browser's wait, never the server's work.
>
> **Cross-checked against the docs.** CLAUDE.md's model-chain section fences the 25s/45s values and the retry classification; this finding touches neither, and Codex says so. Its instruction to verify a *delayed-body* timeout rather than only a never-returning fetch is the right test to demand, since the existing shape already passes the latter.

#### D2 — The stop's copy of a travel leg bypasses the server validator

**References:** [app/api/_shared/schemas.ts:335](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/_shared/schemas.ts:335), [app/api/_shared/schemas.ts:382](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/_shared/schemas.ts:382), [app/api/itinerary/route.ts:47](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/itinerary/route.ts:47), [app/api/itinerary/store.ts:506](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/itinerary/store.ts:506); client check at [app/lib/clientPayloads.ts:601](C:/Users/anshi/Desktop/itinerary/Itinerary/app/lib/clientPayloads.ts:601); known gap at [CLAUDE.md:92](C:/Users/anshi/Desktop/itinerary/Itinerary/CLAUDE.md:92).

**What / impact:** parseScheduledStops validates selected stop fields, then spreads the original entry. It never validates travelToNext. Top-level legs/homeLeg are validated independently, so corrupt nested data can be saved despite the top-level validators; rebuildLegs can then promote that corrupt copy into itinerary.legs.

**Evidence / design check:** A synthetic POST with valid stop fields, empty top-level legs, and a nested walk leg with totalMinutes = -7 returned **200**. The negative nested value survived load and rebuildLegs. The client payload parser rejected the saved result. This reproduces the already-deferred issue; it is not a newly discovered normal-provider failure.

**Confidence:** HIGH.  
**Suggested fix:** Validate/sanitize every stored travel-leg representation through the existing leg validator and enforce agreement with the corresponding top-level/home topology. Preserve all-absent legacy metadata and decorative-path sanitization rules. Do not create a competing validator.  
**Risk of fixing:** needs-care.

> **[VERIFIED]** — confirmed structurally at every cited line. Confidence stays HIGH.
>
> **Independent trace.** `parseScheduledStops` (schemas.ts:335) validates `category`, `id`, both instants, `location` and `durationMinutes`, then returns `{ ...(entry as unknown as ScheduledStop), id, category }` at **schemas.ts:382** — the raw entry is spread wholesale, so `travelToNext` is never examined. `app/api/itinerary/route.ts:47` validates only `body.legs` (and `body.homeLeg` separately at :53); `validateTravelIdentityTopology` at :54 is handed `[homeLeg, ...legs]` and never sees a stop-nested leg. `rebuildLegs` (store.ts:506) then projects `stops[].travelToNext` straight into `itinerary.legs`. The client-side guard Codex cites is genuinely present and genuinely stricter: `clientPayloads.ts:601` runs `isTravelLeg(stop.travelToNext)`.
>
> **One addition to the reachability picture.** `createItinerary` (store.ts:457) spreads each stop verbatim at :472-477, so a corrupt nested leg is persisted at *creation*, before any mutation. `rebuildLegs` promotes it on the first route-changing mutation thereafter.
>
> **Cross-checked against the docs.** CLAUDE.md's `pathSegments` bullet already records this in almost the same words: "FLAGGED, not fixed, and pre-existing: `parseScheduledStops` validates NOTHING on `stops[].travelToNext` … and `rebuildLegs` would copy it back on the next mutation — reachable only by a hand-crafted POST, and the browser's own guard refuses such a plan on read." Codex reproduces the known gap faithfully and does not inflate it into a normal-provider failure. Correctly marked needs-care.

#### D3 — Reading an old completed plan can clear a newer active-plan pointer

**References:** [app/api/itinerary/store.ts:321](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/itinerary/store.ts:321), [app/api/itinerary/[id]/route.ts:35](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/itinerary/[id]/route.ts:35), [app/api/itinerary/[id]/end/route.ts:108](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/itinerary/[id]/end/route.ts:108).

**What / impact:** clearActiveItineraryForOwner unconditionally deletes the owner's pointer. Both completion paths call it using only the owner UID, without checking that the pointer still names the plan being concluded. An old tab reading finished plan A can therefore remove the pointer to newly created plan B. B remains stored, but stops resuming after refresh.

**Evidence / design check:** Using the real in-memory store and by-id GET: saved completed A and future B for one synthetic owner, pointed the owner at B, then read A. The GET returned **200** and the owner pointer became absent. No concurrency or guessed production ID was needed. Repeated reads of already-archived completed plans also reach the unconditional clear.

**Confidence:** HIGH.  
**Suggested fix:** Make pointer clearing conditional on the expected itinerary ID, atomically in Redis and equivalently in memory; pass the concluded plan ID from both callers. Do not clear another plan's pointer on a stale completion/read.  
**Risk of fixing:** needs-care.

> **[VERIFIED, WITH CORRECTION]** — the defect is real and exactly as described at the code level; the correction is to the *reachability story*, which changes how it should be prioritised and tested.
>
> **Independent trace.** `clearActiveItineraryForOwner` is declared at store.ts:321 (Codex's line is exact) and its body is an unconditional `DEL ownerKey(owner)` / `ownerIndex.delete(owner)` — the itinerary id is not a parameter, so it cannot be checked. Both callers pass a uid alone: `[id]/route.ts:35` inside `maybeArchive` (`itinerary.ownerUid`) and `[id]/end/route.ts:108` (`caller.uid`). Confirmed: nothing anywhere compares the stored pointer to the plan being concluded.
>
> **Confirmed ordering detail:** in `maybeArchive` the clear runs **before** `shouldArchive`, so Codex is right that repeated reads of an already-archived completed plan still reach it every time.
>
> **CORRECTION — the UI trigger is narrower than "an old tab reading finished plan A".** There is **no periodic by-id poll**: `page.tsx` contains no `setInterval` at all (consistent with CLAUDE.md's "'Now' DOES NOT TICK"), and `readItinerary` (page.tsx:1990) fires only from plan creation (:1976), each of the four mutations (:2202, :2339, :2477, :2587 plus their read-back retries), and the dev sim-clock change (:2027). So the stale tab has to *do something* before it wipes the newer pointer. That still leaves the case real (a second tab performing any mutation or a dev clock move), and the **broader** trigger is the unauthenticated one: the by-id `GET` verifies no caller at all, so anyone holding a plan id can invoke the clear directly — which is R1's decision surface, not a hypothetical.
>
> **A second instance of the same bug, worth naming explicitly:** the `/end` call site has it too. Ending an *old* plan clears the pointer to whichever plan the owner is currently on. Both call sites need the conditional, not just the read path.
>
> Codex's fix (make the clear compare-and-delete against an expected id, atomically in Redis and equivalently in memory) is the right shape. Risk stays needs-care.

#### D4 — Resume reads skip status persistence and natural-completion archiving

**References:** [app/api/itinerary/route.ts:129](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/itinerary/route.ts:129), [app/api/itinerary/route.ts:136](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/itinerary/route.ts:136), [app/api/itinerary/route.ts:137](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/itinerary/route.ts:137); established read path at [app/api/itinerary/[id]/route.ts:96](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/itinerary/[id]/route.ts:96) and [app/api/itinerary/[id]/route.ts:119](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/itinerary/[id]/route.ts:119); client resume at [app/page.tsx:2121](C:/Users/anshi/Desktop/itinerary/Itinerary/app/page.tsx:2121).

**What / impact:** The active-plan endpoint loads a clone, runs withStatuses, and returns null for a concluded plan. It neither persists status/lock changes through CAS nor runs the by-id read's conclusion/archive lifecycle. If an outing finishes while the page is closed, reopening normally returns the landing page without archiving that outing. The UI then has no by-id read to trigger the missing archive before Redis expiry.

**Evidence / design check:** With a synthetic verified caller and real in-memory store, a past owned plan returned **200 / itinerary:null** while persistence still held status planning, an unlocked stop, no archive marker, and the owner pointer. The null response is appropriate; missing lifecycle work is the issue. This is separate from R1's authorization decision.

**Confidence:** HIGH.  
**Suggested fix:** Have resume and by-id reads share the existing CAS/status/conclusion lifecycle, checking verified ownership before owner-scoped side effects. Continue returning null for unresumable plans, keep archive failures non-fatal, and incorporate D3's conditional pointer clearing. Do not change status/time arithmetic.  
**Risk of fixing:** needs-care.

> **[VERIFIED, WITH CORRECTION]** — confirmed at every cited line, and the **impact is materially understated**. This should be read as higher priority than "reopening after a closed page misses an archive".
>
> **Independent trace.** The resume `GET` at `app/api/itinerary/route.ts:117` loads at :129 through `loadItinerary`, which returns a detached copy in both backends (store.ts:256-264: a fresh parse from Redis, or `cloneItinerary` from the Map). It then calls `withStatuses(stored, new Date())` at :136 with **no `out` parameter and no `updateItinerary`/CAS wrapper**, and returns null at :137 for anything not resumable. The by-id read does the opposite at `[id]/route.ts:96-119`: `withStatuses(proposal, t, touched)` inside `updateItinerary` with `maxAttempts: 3`, then `maybeArchive`. So the asymmetry is exactly as claimed.
>
> **CORRECTION — the missed archive is the ordinary case, not an edge case.** Because there is no periodic by-id poll (see D3), the *only* things that trigger the archive-on-conclude hook are a mutation, a plan creation read-back, or the dev sim clock — all of which require the user to act while the plan is still held in React state. A user who simply lets the outing run to its end and then closes the tab produces: no by-id read at conclusion, then a resume that returns `itinerary: null` without archiving, then Redis TTL expiry. **That plan is never written to history at all.** In practice history appears to fill only via an explicit "Save & end". Codex's phrasing ("if an outing finishes while the page is closed") describes a subset of this.
>
> **Minor addition:** the resume path also does not persist the lock ratchet, since nothing is written back. That is self-correcting on the next by-id read and is not a reason to act on its own, but it is a second consequence of the same missing CAS.
>
> **Ordering — I want to endorse Codex's D3 to D5 to D4 sequence explicitly, and add the reason it did not give.** Fixing D4 first would make the by-id lifecycle run on every resume, which is precisely what turns D5's latent discard-then-archive bug into a *frequent* one and multiplies D3's pointer clearing. The stated order is not merely tidy; it is the safe one. Risk stays needs-care.

#### D5 — “Discard & end” is not remembered by automatic archiving

**References:** [app/api/itinerary/[id]/end/route.ts:83](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/itinerary/[id]/end/route.ts:83), [app/api/itinerary/[id]/end/route.ts:96](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/itinerary/[id]/end/route.ts:96), [app/api/itinerary/ownership.ts:95](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/itinerary/ownership.ts:95), [app/api/itinerary/[id]/route.ts:42](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/itinerary/[id]/route.ts:42); user promise at [app/StopItineraryDialog.tsx:71](C:/Users/anshi/Desktop/itinerary/Itinerary/app/StopItineraryDialog.tsx:71).

**What / impact:** A discard-end request skips its immediate archive, but persistence records only endedAt, not the decision against saving. Once a later by-id read derives completed status, shouldArchive sees an owned, non-anonymous, unarchived plan and writes it to history. “End without saving” can therefore save later.

**Evidence / design check:** In a real route/store probe with substituted identity and archive dependencies, discard-end returned ended:true / archived:false and made zero archive calls. A later GET after the stop's finish made **one archive call**. Existing stopPlan tests verify the immediate decision in isolation, not this end-then-read composition.

**Confidence:** HIGH.  
**Suggested fix:** Persist an explicit end/archive disposition and make the shared archive eligibility decision respect a deliberate discard. Preserve legacy natural-completion behavior and distinguish discarded plans from requested saves whose archive attempt failed.  
**Risk of fixing:** needs-care.

> **[VERIFIED]** — confirmed. The discard decision is genuinely not persisted anywhere, and the later archive genuinely has nothing to consult. Confidence stays HIGH.
>
> **Independent trace.** `resolveStopOutcome` (stopPlan.ts:43-55) returns `shouldArchive: choice === "save-end" && !isAnonymous`. On a discard the `/end` route's `updateItinerary` block (`[id]/end/route.ts:91-99`) sets **only** `proposal.endedAt`; `archivedAt` is written solely when `archivedAt` was produced above, which a discard never produces. `shouldArchive` (ownership.ts:95) then tests four things — status completed, has owner, `ownerIsAnonymous !== false`, not already archived — and **none of them is the user's decision**.
>
> **The step that closes the loop, verified directly:** `nextItineraryStatus` (store.ts:569) derives status purely from the stops' own statuses and **never reads `endedAt`**. So a plan discard-ended at 6pm whose last stop ends at 9pm still derives `completed` on any later read, and `maybeArchive` writes it to history. The user promise it breaks is verbatim at `StopItineraryDialog.tsx:71`: "You can keep a copy in your history, or end without saving."
>
> **Reachability caveat, which cuts both ways.** Today the second half needs a by-id read of that id after conclusion, and per D4 those reads are uncommon — so this may be rarely observed right now. But that is precisely why **D5 must land with or before D4**: sharing the conclusion lifecycle with resume is what would make the discarded plan get read, and archived, on the user's next visit. Codex's ordering already has this right.
>
> Risk stays needs-care: the fix must distinguish a deliberate discard from a requested save whose archive attempt merely failed, which Codex states.

#### D6 — Arrival can be confirmed using a new fix and the previous fix's distance

**References:** [app/ItineraryMap.tsx:788](C:/Users/anshi/Desktop/itinerary/Itinerary/app/ItineraryMap.tsx:788), [app/ItineraryMap.tsx:809](C:/Users/anshi/Desktop/itinerary/Itinerary/app/ItineraryMap.tsx:809), [app/page.tsx:723](C:/Users/anshi/Desktop/itinerary/Itinerary/app/page.tsx:723), [app/page.tsx:2698](C:/Users/anshi/Desktop/itinerary/Itinerary/app/page.tsx:2698), [app/lib/arrivalDetection.ts:187](C:/Users/anshi/Desktop/itinerary/Itinerary/app/lib/arrivalDetection.ts:187).

**What / impact:** The map reports only a number through an effect. The parent stores that distance separately from the current fix's coordinates/accuracy/freshness. On the render that receives a new fix, the parent arrival effect can still read the previous distance. The map's newly measured distance only reaches the subsequent render. If the stale number completes a dwell, the resulting arrived state is sticky and the correct distance cannot retract it.

**Evidence / design check:** Traced the two effects and replayed their samples through the real reducer: inside at 0 s and 30 s; at 46 s, a new accurate outside fix arrives while the parent still holds the old 20 m distance. That fold confirms arrival. The following 200 m sample leaves it confirmed. Feeding the coherent 200 m sample first does not confirm. This is a source/effect-order plus pure-reducer reproduction, not a browser/GPS test.

**Confidence:** HIGH.  
**Suggested fix:** Carry the measurement with the identity of the fix and active stop it describes, and fold only a coherent current sample; alternatively compute the complete observation in one existing geometry-aware boundary. Preserve the distance/dwell constants, sticky-after-valid-arrival rule, display-only scope, and current geometry implementation. Add an integration case for a fix moving outside at the dwell boundary.  
**Risk of fixing:** needs-care.

> **[VERIFIED]** — confirmed at every cited line, and the effect-ordering argument holds under React's actual semantics. Confidence stays HIGH.
>
> **Independent trace of the mechanism.** The map's measurement effect is at `ItineraryMap.tsx:788` and reports through `onYouToActiveStopMeters(...)` at :809. Its dependency array (:812-820) is `[mapState, youLat, youLng, activeStopId, activeStopLat, activeStopLng, onYouToActiveStopMeters]`, and the callback passed from the parent is `setYouToActiveStopM` (page.tsx:3331) — a **stable** React setter. So the effect re-runs precisely when a new fix lands. The parent holds the number in separate state at page.tsx:723 and folds it in the arrival effect at page.tsx:2698, whose sample takes `distanceM` from that state while `stale`, `accuracyM` and `nowMs` all come from values recomputed during the *same* render (`youMarkerView` at :2671, `displayNowMs` at :2669).
>
> **Why the ordering claim is correct.** Passive effects run child-before-parent within one commit, and a `setState` from a child's effect schedules a *new* render — it cannot retroactively change the parent effect's already-captured closure. So on the render that receives a new fix, the parent folds the **previous** fix's distance with the **new** fix's freshness, accuracy and clock. The corrected distance only arrives on the following render. The parent's effect definitely runs on that commit, because `displayNowMs` is recomputed every render and is in its dependency array.
>
> **The reducer half checks out.** `reduceArrival` is sticky at `arrivalDetection.ts:187` (`if (arrivedStopId === activeStopId) return ...`), and the confirming branch (`elapsedMs >= config.dwellMs`, :245-247) sits past every gate, so a mismatched-but-in-range sample really can be the one that confirms, and the subsequent correct 200 m sample cannot retract it.
>
> **Two refinements Codex did not state, both worth having in the fix's test plan.** (1) The incoherence is **symmetric**: an old *outside* distance paired with a new *inside* fix spuriously hits the `distanceM > radiusM` clear branch and restarts the dwell, delaying a legitimate arrival by one fix. A fix that only guards the false-positive direction is half a fix. (2) The carried-over distance is **bounded** by the staleness gate — once the previous fix ages past `LIVE_TRACKING_STALENESS_MS` the sample reads stale and cannot confirm — so the window of incoherence is one fix interval, not unbounded. That bounds the severity without removing the defect.
>
> **Scope is correctly stated:** arrival is display-only per CLAUDE.md's invariant (no `arrivedAt`, no mutation, no scheduling influence), so the blast radius is a chartreuse card. Risk stays needs-care.

#### D7 — Ending bypasses the shared operation lock and can race ongoing work

**References:** [app/page.tsx:825](C:/Users/anshi/Desktop/itinerary/Itinerary/app/page.tsx:825), [app/page.tsx:2070](C:/Users/anshi/Desktop/itinerary/Itinerary/app/page.tsx:2070), [app/page.tsx:2097](C:/Users/anshi/Desktop/itinerary/Itinerary/app/page.tsx:2097), [app/page.tsx:3495](C:/Users/anshi/Desktop/itinerary/Itinerary/app/page.tsx:3495), [app/StopItineraryDialog.tsx:95](C:/Users/anshi/Desktop/itinerary/Itinerary/app/StopItineraryDialog.tsx:95). Established guarded operations: [app/page.tsx:2166](C:/Users/anshi/Desktop/itinerary/Itinerary/app/page.tsx:2166), [app/page.tsx:2292](C:/Users/anshi/Desktop/itinerary/Itinerary/app/page.tsx:2292), [app/page.tsx:2436](C:/Users/anshi/Desktop/itinerary/Itinerary/app/page.tsx:2436).

**What / impact:** chooseStop uses an independent stopBusy flag without acquiring the shared operation token. The End button remains enabled during replan/swap/remove/mode work. The end request can clear the page while an older in-flight handler later calls applyItinerary, displaying the ended plan again; conversely, an old end response can clear a newly finished plan. The dialog also leaves Cancel enabled during submission, although it does not cancel the already-sent ending request.

**Evidence / design check:** These behaviors follow the current event handlers and unconditional completion callbacks. The shared ref-backed lock was specifically introduced to prevent same-tick/cross-action races, and later remove/mode operations adopt it. No documented exception for End was found. This is distinct from cross-tab pointer clearing in D3.

**Confidence:** HIGH on the missing guards and reachable ordering; not browser-reproduced in this audit.  
**Suggested fix:** Bring End into the existing operation lifecycle, gate conflicting controls, and prevent stale completions from applying to another/ended plan. Make pending cancellation truthful rather than offering a Cancel that cannot prevent the committed request. Use the established ambiguous-mutation/read-back pattern if an end response is lost instead of assuming every caught error means no server change.  
**Risk of fixing:** needs-care.

> **[VERIFIED]** — confirmed. `chooseStop` is the only user-initiated operation in `page.tsx` that does not take the shared lock. Confidence stays HIGH on the missing guards.
>
> **Independent trace, and it is stronger than a spot check.** `beginOperation` is called at exactly eleven sites in page.tsx (853, 1082, 1713, 1784, 1802, 1836, 2022, 2166, 2292, 2436, 2553), each paired with an `endOperation` in a `finally`. `chooseStop` (page.tsx:2070) is **not** among them: it guards with the independent `setStopBusy(true)` at :2081 and nothing else. So reroute (:2166), swap (:2292), remove (:2436) and the mode switch (:2553) are all locked and End alone is not.
>
> **The three consequences, each verified.** (1) The End button (page.tsx:3495) carries no `disabled` at all, while the Replan button one line above it at :3488 carries `disabled={busy || !prompt.trim()}` — so End is clickable throughout any in-flight mutation. (2) `applyItinerary` (page.tsx:2034) sets `itinerary`/`schedule`/`mapStops`/`homeLeg` **unconditionally**, with no check that the plan it is applying is still the current one, so a swap resolving after an End re-displays the ended plan. (3) The dialog's Cancel is `disabled={busy && !isCancel}` (`StopItineraryDialog.tsx:95`), i.e. deliberately left enabled during submission — while the `/end` POST it appears to cancel has already been sent.
>
> **Cross-checked against the docs:** I found no documented exception for End in CLAUDE.md, AGENTS.md or DEVLOG.md, and the lock's own comment at page.tsx:816-818 states the intent generally ("One user-owned operation at a time … the ref closes the same-tick gap"). Codex's "no documented exception was found" holds.
>
> **Honest limit, as Codex states:** none of this was reproduced in a browser. The reachability is read off the handlers and is unambiguous; the *observed* symptom is not. Risk stays needs-care.

#### Security scan result

No hardcoded Google/OpenRouter/OpenAI/GitHub/AWS key, private-key block, JWT, or credential-bearing URL pattern was found in the **tracked text files** scanned. The example values are empty; .env, node_modules, and .next are ignored. The private .env was not opened, and commit history was not scanned. This is a scoped clean result, not a guarantee that no secret exists anywhere.

Client-controlled route IDs, coordinate inputs, bounded bodies/collections, provider JSON construction, React text rendering, token-derived profile/history paths, and critical promise catches were reviewed. No direct template/query injection or additional unhandled-rejection finding was established. By-id authorization remains the explicit product decision in R1.


> **[UNABLE TO CONFIRM — accepted as scoped]** — I did not re-run a credential scan, so I neither confirm nor dispute the sweep. What I did verify: `.env.example` holds no real values (every key is an empty assignment), `.gitignore` covers `.env`, `node_modules`, `.next/` and `test-results/`, and I did not open `.env`. Codex's own caveat is the honest one and should stand as written: this is a scoped clean result over tracked text files, not a guarantee, and commit history was not scanned.
>
> The second paragraph's cross-references are accurate — client-controlled route ids are regex-bounded (`/^[A-Za-z0-9-]{1,128}$/` on every by-id route), and by-id authorization really is the open product decision in R1 rather than an oversight in this section.

### E. Added during verification

Two items I tripped over while checking the findings above. Both are small; neither is a new audit category, and I did not go looking for more.

#### E1 — `nextItineraryStatus` takes a `t: Date` it never uses **[ADDED DURING VERIFICATION]**

**References:** [app/api/itinerary/store.ts:569](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/itinerary/store.ts:569); sole call site [app/api/itinerary/store.ts:556](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/itinerary/store.ts:556).

**What / impact:** `function nextItineraryStatus(itinerary: Itinerary, t: Date)` derives the plan status entirely from the stops' already-updated statuses; `t` is never read. It is one of the **8 standing lint warnings** (`'t' is defined but never used`), so it is already visible on every lint run and is the third of the three "unused declaration" warnings that are not test scaffolding — the other two are A1's. The function is private with exactly one caller, inside `withStatuses`, which has its own `t` and uses it.

**Why it surfaced here:** found while verifying D5, which turns on this function ignoring `endedAt`. Dropping the parameter would make that reading obvious rather than something a reader has to check.

**Confidence:** HIGH.  
**Suggested fix:** drop the parameter and the argument at the call site, or keep it and add an explicit comment saying the status is derived from stop statuses alone. Either resolves the warning honestly; inventing a use for it would not.  
**Risk of fixing:** low. Natural companion to A1, since the three together clear every non-test unused-declaration warning.

#### E2 — CLAUDE.md's own `TZ=America/Toronto` flag is stale in the direction C1 does not cover **[ADDED DURING VERIFICATION]**

**References:** [CLAUDE.md:82](C:/Users/anshi/Desktop/itinerary/Itinerary/CLAUDE.md:82) (per-plan timezone bullet, ending "FLAGGED, not resolved: DEPLOY.md still requires `TZ=America/Toronto`"); [CLAUDE.md:101](C:/Users/anshi/Desktop/itinerary/Itinerary/CLAUDE.md:101) and [AGENTS.md:41](C:/Users/anshi/Desktop/itinerary/Itinerary/AGENTS.md:41) (both persistence-seam bullets, "TZ=America/Toronto requirement"); current text at [DEPLOY.md:24](C:/Users/anshi/Desktop/itinerary/Itinerary/DEPLOY.md:24) and the `TZ` row of the environment table.

**What / impact:** CLAUDE.md records an open item that DEPLOY.md has already closed. DEPLOY.md now reads: "`TZ=America/Toronto` may remain as an optional compatibility/logging default, but it is not a correctness requirement for multi-city scheduling", and its env table lists `TZ` as "Optional compatibility/logging default; scheduling correctness does not depend on it". Both instruction files' persistence-seam bullets still describe a "TZ=America/Toronto requirement" living in DEPLOY.md, and AGENTS.md mirrors the stale flag.

**Why it surfaced here:** found while verifying C1's DEPLOY.md citations. C1 is scoped to correcting README/DEPLOY *from* source; this is the opposite direction — an instruction file carrying an open flag that its target already resolved — so it would be missed by C1's stated scope.

**Confidence:** HIGH.  
**Suggested fix:** in the same documentation pass as C1, mark the CLAUDE.md flag resolved and cite DEPLOY.md's current wording; mirror it in AGENTS.md or leave AGENTS.md explicitly unmaintained, as its own header already contemplates. No code change, no scheduling change.  
**Risk of fixing:** low.

## 3. Reconsider a documented decision

These are **not** part of the 14 findings or a ready-to-apply cleanup batch.

### R1 — Owner-bound plans still use the itinerary ID alone for most reads/mutations

**References:** [app/api/itinerary/[id]/remove/route.ts:32](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/itinerary/[id]/remove/route.ts:32), [app/api/itinerary/[id]/swap/route.ts:22](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/itinerary/[id]/swap/route.ts:22), [app/api/itinerary/[id]/route.ts:76](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/itinerary/[id]/route.ts:76), [code-audit-2026-07-24-remediation.md:75](C:/Users/anshi/Desktop/itinerary/Itinerary/code-audit-2026-07-24-remediation.md:75).

**Existing reasoning:** “AUTH follows the swap precedent exactly: none beyond the plan id.” The same comment distinguishes writes to the plan from End's write to personal history. Guest/legacy compatibility is deliberate.

**Counterargument / impact:** Owner identity, home coordinates, and personal history now exist. Anyone who obtains a plan ID can still read or mutate its data, and the by-id read itself can trigger archive/pointer side effects. The distinction “only the plan” is therefore weaker than it was before ownership/history shipped. This is about an obtained ID, not claiming UUIDs can realistically be guessed.

**Confidence:** HIGH on current access behavior.  
**Suggested decision:** Define the intended capability/sharing contract for owned, anonymous, and legacy plans before changing enforcement. Reuse verified identity and preserve a deliberate guest path; do not blindly apply account-only access everywhere.  
**Risk of fixing:** needs-care; owner/product/security decision.

> **[AGREE WITH RECONSIDERATION]** — the access behaviour is exactly as described, and the counterargument holds. This is genuinely an owner decision, not a defect to implement as cleanup.
>
> **Independent verification of the current behaviour.** `[id]/swap/route.ts:22`, `[id]/remove/route.ts:32` and the by-id `GET` (`[id]/route.ts:76`) call no `verifyCaller` at all — the only gate on each is the id regex and the rate limit. `/end` is the sole exception and it does it properly (`verifyCaller`, then `ownsItinerary`, and a deliberate 404 rather than a 403 so id probing learns nothing). The comment Codex quotes is verbatim at remove/route.ts:32-35.
>
> **One thing I would add to the owner's decision, because it sharpens what is at stake.** The by-id `GET` returns the **whole stored itinerary**, which now includes `home` (the user's typed starting address and its coordinates) and `ownerUid`. When the "none beyond the plan id" precedent was set, a plan was venues and times; it now carries a personal location. That is a different disclosure, and it is the strongest version of Codex's "the distinction 'only the plan' is weaker than it was".
>
> **And the concrete coupling to the findings above:** because the by-id `GET` verifies nobody, **D3's pointer clearing and D5's archive-on-read are both reachable by an unauthenticated holder of a plan id** — an id can cause a write to the owner's pointer and to their history. If R1 is decided as "leave it open", D3 and D5 should still be fixed on their own merits, and arguably become more urgent rather than less.
>
> **The counterweight, stated fairly:** ids are `crypto.randomUUID()` (store.ts:468), so they are not enumerable, and Codex explicitly frames this as being about an *obtained* id rather than a guessed one. The guest path is a real product commitment, not an accident. Codex's recommendation — define the capability/sharing contract for owned, anonymous and legacy plans **before** changing enforcement — is the right sequencing. **Owner judgment required; do not implement as part of any batch.**

### R2 — Two independent age checks permit a fix older than the stated freshness threshold

**References:** [app/lib/liveTracking.ts:125](C:/Users/anshi/Desktop/itinerary/Itinerary/app/lib/liveTracking.ts:125), [app/lib/liveTracking.ts:410](C:/Users/anshi/Desktop/itinerary/Itinerary/app/lib/liveTracking.ts:410), [app/lib/liveTracking.ts:515](C:/Users/anshi/Desktop/itinerary/Itinerary/app/lib/liveTracking.ts:515), [app/lib/youMarker.ts:87](C:/Users/anshi/Desktop/itinerary/Itinerary/app/lib/youMarker.ts:87), [app/lib/youMarker.ts:103](C:/Users/anshi/Desktop/itinerary/Itinerary/app/lib/youMarker.ts:103), [CLAUDE.md:258](C:/Users/anshi/Desktop/itinerary/Itinerary/CLAUDE.md:258).

**Existing reasoning:** The threshold comment says `A fix older than this is no longer "current".`, then explicitly applies it to age after receipt and age at receipt. The renderer describes “TWO independent staleness gaps”.

**Counterargument / impact:** Independent comparisons omit their sum. A fix 14 seconds old when received, viewed 32 seconds later, is actually 46 seconds old but remains fresh under the existing 45-second threshold. The real computeYouMarker returned stale:false for that input. This can keep a marker/arrival sample fresh longer than the opening promise suggests. It does not require the extreme stale-on-delivery case that prompted the previous fix.

**Confidence:** HIGH on the calculation; policy interpretation belongs to the owner.  
**Suggested decision:** Decide whether freshness means total observation age or each separately bounded interval. If total age is intended, compose the existing measured ages consistently in tracker and display, preserving unknown/future timestamp handling and every policy constant's value.  
**Risk of fixing:** needs-care.

> **[AGREE WITH RECONSIDERATION]** — the arithmetic is right, and I can strengthen the case. But it is a policy change against a rule CLAUDE.md documents in its current two-gate form, so it needs an explicit owner decision before anyone touches it.
>
> **The calculation, verified by reading the real code.** `computeYouMarker`'s `fresh` (youMarker.ts:103-106) is a conjunction of two *independent* comparisons: `ageMs <= LIVE_TRACKING_STALENESS_MS` and `fixAgeAtReceiptMs <= LIVE_TRACKING_STALENESS_MS`. Codex's example passes both — 14s at receipt, 32s since receipt — and `checkStaleness` (liveTracking.ts:511-515) cannot help, because it only tests `now - lastUpdatedAt > stalenessMs`, i.e. 32 against 45. So `status` stays `"live"` and the marker paints fresh at a genuine total age of 46s. Worst case is roughly **2x the threshold, about 90s**, before either gate fires.
>
> **The threshold's own comment supports Codex's reading.** liveTracking.ts:124-136 opens "A fix older than this is no longer 'current'" — a statement about a fix's total age — and only then says it is "applied two ways". The composed meaning is the one the doc states first.
>
> **A supporting point Codex missed, which makes this cheaper than it looks.** The value needed already exists: `lastFixAtMs` (youMarker.ts:117-120) is computed as `state.lastUpdatedAt - state.fixAgeAtReceiptMs`, i.e. the instant the position was actually recorded on our clock. A total-age gate is therefore `nowMs - lastFixAtMs <= LIVE_TRACKING_STALENESS_MS` — no new constant, no new measurement, no change to the unknown/future-timestamp handling (the `== null` fallbacks stay exactly as written).
>
> **And a consequence worth putting in front of the owner:** this does not stop at the marker. `page.tsx:2692` feeds `youMarkerView.stale` straight into `reduceArrival`, whose stale-asymmetry rule is that a stale fix can never *create* an arrival. Under the current two-gate reading, a fix up to ~90s old can start and complete a 45s dwell.
>
> **Why it still needs a decision rather than a patch.** CLAUDE.md's you-marker invariant spells out the two-gate design explicitly ("'Not fresh' is `status: "stale"`, the retained-fix gap …, AND `status: "live"` whose fix has aged past `LIVE_TRACKING_STALENESS_MS` **since receipt**"), and youMarker.ts:87-102 carries a long comment defending it as "TWO independent staleness gaps". Composing them is a change to a documented rule and would require amending both. My own view is that total age is the more defensible reading of "current" and the change is nearly free — but the constant's value may have been chosen with the two-gate behaviour in mind, and only the owner knows that. **Owner judgment required.**

### R3 — Trimming trailing stops re-fetches already-priced retained legs

**References:** [app/page.tsx:1314](C:/Users/anshi/Desktop/itinerary/Itinerary/app/page.tsx:1314), [app/page.tsx:1411](C:/Users/anshi/Desktop/itinerary/Itinerary/app/page.tsx:1411), [app/page.tsx:1424](C:/Users/anshi/Desktop/itinerary/Itinerary/app/page.tsx:1424), [app/api/schedule/travel.ts:997](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/schedule/travel.ts:997), [DEVLOG.md:470](C:/Users/anshi/Desktop/itinerary/Itinerary/DEVLOG.md:470).

**Existing reasoning:** The implementation deliberately validates the window before adapting venues: “no point adapting a venue we're about to drop.” The devlog explicitly records that after a trim “the plan is re-routed once.”

**Counterargument / impact:** Removing only trailing selections leaves the retained prefix's endpoints, durations, anchor, mode, and sequential departure inputs unchanged. Calling planOnce again repeats those paid route lookups. Keeping k stops repeats k home/inbound legs, normally up to two provider requests each. For three stops trimmed to one, the home-to-first leg is requested again even though its inputs did not change. This is a code-path call count, not measured live billing.

**Confidence:** HIGH on repeated calls; MEDIUM that every compatibility edge can reuse the prefix unchanged.  
**Suggested decision:** Consider preserving already-computed retained-prefix legs for this narrow trailing-trim case, removing the dropped outbound leg, and leaving venue-adaptation re-routing intact. This must preserve exact leg identities/topology and all scheduling/window math; it is not a proposal to parallelize dependent legs or introduce a cross-request provider cache.  
**Risk of fixing:** needs-care; review against the explicitly documented reroute behavior.

> **[AGREE WITH RECONSIDERATION — factually; DISAGREE ON PRIORITY]** — the repeated calls are real and I verified them, but the scope is smaller than the write-up implies in one way and the payoff is smaller in another. I would rank this last of the three R items.
>
> **Verified.** `planOnce` is at page.tsx:1314; the trim computes `trimmed` at :1412 and calls `await planOnce(trimmed)` at **:1424**, which re-issues `/api/schedule/travel` for the whole retained prefix. `getTravelLegs` (travel.ts:997) prices legs in a strictly sequential loop (:1019-1036) accumulating `cursorMs`, and `planOnce` re-derives `startISO` from `buildSchedule(..., ctx.startInstant, ...)` — which does not move when trailing selections are dropped. So the retained prefix's points, dwells and departure instants are genuinely unchanged, and its legs are genuinely re-fetched. DEVLOG.md:470 does contain the "re-routed once" wording verbatim.
>
> **CORRECTION — the narrow fix is simpler than "preserve already-computed legs".** In a pure trailing trim, **no new leg is needed at all**: the retained legs are a literal prefix of the array already fetched, so the operation is a slice plus a local `buildSchedule`, not a partial refetch or a merge. That is a smaller change than Codex's framing suggests.
>
> **CORRECTION — but it has two contracts to honour, which Codex does not name.** (1) `getTravelLegs` ends with `assignTransitPaletteSlots(legs)` (travel.ts:1035), and CLAUDE.md's palette-identity rule says retained slots are reserved before new ones are assigned — a sliced topology must still go through that allocator rather than keep stale slot numbers by accident. (2) The last retained stop must not keep a `travelToNext` pointing at a dropped venue — the same dangling-leg hazard the remove-stop section documents. `buildSchedule` already deletes `travelToNext` from the last timed stop, so this is satisfied by construction, but only if the rebuild actually runs.
>
> **Why I would deprioritise it.** The path is reached only when a **stated** end time overruns past `WINDOW_OVERRUN_TOLERANCE_MINUTES` (30) — a minority of plans, since most carry no `endISO` at all. The saving is the retained prefix's legs, two provider requests each: one leg for the common 3-to-1 trim, three for a 4-to-3. That is a handful of Routes calls on a rare branch, against touching the one place window-fit and routing meet. Codex's own MEDIUM confidence that "every compatibility edge can reuse the prefix unchanged" is the right level of doubt. **Owner judgment; low priority. Not a cleanup-batch item.**

## 4. Explicitly NOT flagged

1. **Separate server/client payload validators.** [app/api/_shared/schemas.ts:703](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/_shared/schemas.ts:703) and [app/lib/clientPayloads.ts:836](C:/Users/anshi/Desktop/itinerary/Itinerary/app/lib/clientPayloads.ts:836) deliberately defend different boundaries. D2 is a missing representation check, not an argument to merge them.
2. **Sequential travel routing and dual-mode queries.** [app/api/schedule/travel.ts:935](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/schedule/travel.ts:935), [app/api/schedule/travel.ts:997](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/schedule/travel.ts:997). Later departure inputs depend on preceding results; walk alternatives are used by documented mode decisions.
3. **Places field mask, request-scoped dedupe, and no cross-request full-payload cache.** [app/api/places/search/searchPlaces.ts:24](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/places/search/searchPlaces.ts:24), [app/api/places/search/searchPlaces.ts:170](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/places/search/searchPlaces.ts:170). Requested facts have consumers, dedupe exists, and freshness/provider-policy tradeoffs are documented.
4. **Policy values and occurrence palette.** [app/lib/transitRidePalette.ts:1](C:/Users/anshi/Desktop/itinerary/Itinerary/app/lib/transitRidePalette.ts:1), [app/lib/arrivalDetection.ts:40](C:/Users/anshi/Desktop/itinerary/Itinerary/app/lib/arrivalDetection.ts:40). No constant value, color, slot allocation, or geometry offset is proposed for change.
5. **Distinct LLM leak guards and semantic prompts.** Their different boundaries are intentional. No consolidation or semantic-prompt change is recommended.
6. **OpenRouter routing/retry configuration and browser/server timeout values.** [app/api/_shared/openrouter.ts:1](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/_shared/openrouter.ts:1), [app/api/_shared/modelFallback.ts:1](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/_shared/modelFallback.ts:1). Throughput sorting, parameter support, pricing ceiling, correction affinity, and retry classes address documented incidents. D1 concerns deadline coverage, not those decisions.
7. **Shared mutation machinery still exported from swap.ts.** [app/api/itinerary/removeStop.ts:63](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/itinerary/removeStop.ts:63), [app/api/itinerary/modeSwitch.ts:78](C:/Users/anshi/Desktop/itinerary/Itinerary/app/api/itinerary/modeSwitch.ts:78). These are real callers. Availability scans and retained legacy helpers are not called dead merely because their only external consumers are tests.
8. **Map projection cadence, visibility filtering, and inexpensive bounded work.** [app/ItineraryMap.tsx:322](C:/Users/anshi/Desktop/itinerary/Itinerary/app/ItineraryMap.tsx:322), [app/ItineraryMap.tsx:481](C:/Users/anshi/Desktop/itinerary/Itinerary/app/ItineraryMap.tsx:481). Hidden routes are filtered before decoding; fit bounds is coordinate-keyed. The documented one-frame overlay lag is not relabeled a new performance defect.
9. **Framework/config/test dependency usage.** Fonts are imported by layout; Maps loader by the map; Firebase client/Admin by their respective boundaries; Luxon/tz-lookup have real uses; Next/React/react-dom have framework uses. Type packages, ESLint/config, TypeScript, tsx, Playwright and axe-core all have compiler/config/runner/test consumers. No npm dependency removal is recommended.
10. **Intentional fixtures, archives, and missing research artifacts.** The mock-only Maps harness remains an active test entry point; the main planSlots guard and legacy transit cases remain live compatibility coverage; historical devlogs/audits are evidence, not scratch. No tracked research artifact or abandoned commented-out executable block was established. Deliberate auth cancellation diagnostics and approved label copy were not treated as unexplained waste.


> **[VERIFIED — spot-checked six of the ten, all correct]** — I did not take this section on trust. Where I checked, Codex's exclusions were right, and two of them required exactly the kind of non-obvious tracing that a weaker audit would have got wrong.
>
> **#2 sequential travel routing** — correct. `getTravelLegs` (travel.ts:1019-1036) accumulates `cursorMs` from each priced leg, so leg *i+1*'s departure genuinely is not known until leg *i* returns; the two mode alternatives already run in `Promise.all` (travel.ts:935-938). Not parallelisable as claimed.
>
> **#3 Places field mask and request-scoped dedupe** — correct. The field-mask rationale is documented per purpose group at searchPlaces.ts:22-33, and `requestScopedSearch` (searchPlaces.ts:176-190) is a per-call `Map` that evicts rejected promises, with the no-cross-request-cache reasoning stated in place.
>
> **#7 shared machinery exported from swap.ts** — correct. `removeStop.ts:50-68` and `modeSwitch.ts:64-83` both import the ladder from `./swap`. Real callers, not dead exports.
>
> **#8 map projection cadence and visibility filtering** — correct, and on the substantive point: `travelLegVisible` is tested at ItineraryMap.tsx:481 **before** any geometry decoding, so a hidden leg really does cost nothing; the projection probe defers its `setState` to `requestAnimationFrame` (ItineraryMap.tsx:322-326), which is the documented rule, not an accident to optimise away.
>
> **#9 dependency usage** — correct, and this one is the good catch: `axe-core` has no static import anywhere. Its only use is `nodeRequire.resolve("axe-core/axe.min.js")` at `e2e/accessibility.spec.ts:7`. An import-graph scan would have reported it as an unused dependency; Codex did not.
>
> **#10 the mock-only Maps harness** — correct, and I went one step further than Codex did. `app/test-harness/maps` is a real Next route reached by `page.goto("/test-harness/maps")` in `e2e/maps-resilience.spec.ts` (ten call sites), so it is live test infrastructure. It also appears in the built client manifest, which raised the question of whether a debug harness ships publicly — it does not: `app/test-harness/maps/page.tsx` calls `notFound()` unless `process.env.E2E_MOCK === "1"`. No finding there.
>
> **Not independently re-derived:** #1, #4, #5 and #6. Each is an argument for leaving a documented decision alone rather than a reachability claim, and I found nothing while working through the D-findings that contradicts any of them.

## 5. Suggested implementation order

### Safe to batch and fix quickly

- **A1 + A2:** unread UI state/map fields and the verified dead CSS selectors. Preserve all live strip reasons, dynamically generated timeline classes, and mixed-selector live members.
- **C1:** current setup/deployment/environment documentation. Record actual partial authorization, not an imagined completed security feature.
- **C2:** fix only the three test clocks through the established seam.
- **A4, debug.log only:** remove the accidental tracked log. The prototype's disposition remains an explicit archival choice.
- **A3, isolated parser only:** removing parsePromptBody is separable from the old clarification/compatibility inventory.

### Needs individual review

1. **D3 → D5 → D4:** first make owner-pointer clearing conditional, then persist discard intent, then share the conclusion/read lifecycle. This order avoids spreading the current pointer/discard mistakes into the resume endpoint.
2. **D1:** repair provider body-deadline coverage, preserving error and fallback behavior.
3. **D6:** make arrival observations coherent across the map/parent boundary; test the outside-at-threshold case.
4. **D7:** integrate End with operation locking and stale/ambiguous completion handling.
5. **D2:** close the already-known nested-leg boundary with legacy/topology regression coverage.
6. **B1:** confirm with a fresh production bundle, then isolate the server lookup data without changing zone behavior.
7. **Remaining A3 and the prototype in A4:** decide what is obsolete versus deliberately retained compatibility/reference material before removal.
8. **R1–R3:** owner decisions first. Do not silently implement these as cleanup.
9. **Size observations and other backlog:** schedule separately only when there is a concrete need; none is a reason to alter the fenced scheduler, facts boundary, policy values, or prompts.

After implementation, rerun the relevant regression suites plus lint/typecheck. Persistence changes need memory and Redis/CAS coverage; UI lifecycle fixes need integration tests that join the real components/handlers, not only their already-passing pure helpers. Run the full production/E2E gates in that implementation session and keep any remaining clock/environment failures precisely identified.


> **[VERIFIED — the order is sound, with two amendments]**
>
> **The "safe to batch" list survives verification**, with these adjustments carried down from the verdicts above:
> - **A1** — add **E1** (`nextItineraryStatus`'s unused `t`). The three together clear every non-test unused-declaration lint warning in one pass. Note that `MapStop.blockedReason` needs no projection edits; only `reason` does.
> - **A2** — delete by selector, not by line range: `.old-time` and `.new-time` at globals.css:501-502 sit **inside** the dead `.ecard` run and are live reroute UI.
> - **C1** — add **E2** (CLAUDE.md's stale `TZ` flag, which DEPLOY.md already resolved) and the three missing `FIREBASE_ADMIN_*` credentials in both `.env.example` and DEPLOY.md's env table. That last part is a deployment gap, not prose.
> - **C2** — no change; the seam at e2e/scenarios.spec.ts:549 is the model to copy. Do not expect the e2e suite to go green: `mobile.spec.ts` at 768px is a separate pre-existing failure.
> - **A3, isolated parser only** — `distributionOptions` is equally isolated (zero references, tests included) and can join the same low-risk step. The clarification pair must take `countFromToken` and `categoryFromText` with it if it goes.
>
> **Amendment 1 — endorse D3 to D5 to D4 emphatically, for a reason not stated.** Fixing D4 first is what would make the by-id conclusion lifecycle run on every resume, which is exactly what converts D5's latent discard-then-archive into a frequent one and multiplies D3's unconditional pointer clear. The order is not stylistic; reversing it would ship the bugs to more users.
>
> **Amendment 2 — D4's priority should rise within "needs individual review".** As verified above, the archive-on-conclude hook has no periodic trigger, so a plan that simply runs to its end and is closed is never archived at all. That is a live product gap, not only a lifecycle asymmetry.
>
> The closing instruction — rerun the gates, cover persistence changes with memory *and* CAS coverage, and test UI lifecycle fixes by joining the real components rather than their already-passing pure helpers — is exactly right, and D6 and D7 in particular cannot be proven by their pure reducers.