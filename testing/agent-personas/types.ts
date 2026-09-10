// Shared vocabulary for the persona harness.
//
// NOTHING here is imported by the application. This directory is a testing
// tool that drives the REAL deployed app through a real browser; it must
// never become a dependency of `app/`, and it is deliberately outside `e2e/`
// so `npm run test:e2e` (the mock suite) can never pick it up.

/** How a persona's simulated device moves along a leg. */
export type Pace = "walk" | "drive" | "transit";

/** Which stop an action targets. Positional rather than by name, because a
 *  live plan's venue names are not known until the plan exists. */
export type StopTarget = "first" | "middle" | "last" | number;

/** One declarative step in a persona's scenario. The runner interprets these;
 *  adding a scenario means adding actions here, never editing the run loop. */
export type PersonaAction =
  | {
      kind: "plan";
      prompt: string;
      city?: string;
      /** Left blank uses the app's own default (the city centre). */
      startAddress?: string;
      travelMode?: "transit" | "driving";
      /** What this persona expects the plan to look like. */
      expect?: PlanExpectation;
    }
  | { kind: "expectPlanFailsLoud"; expect: string }
  | { kind: "enableLiveTracking" }
  /**
   * Wait out the home leg so the target stop is genuinely UNDERWAY, then
   * reload so the server re-derives its status.
   *
   * Even an immediacy prompt does not start the first stop now:
   * `buildSchedule` advances its cursor by the home leg before the first stop,
   * so "right now" means "leave now", and the first stop opens once you could
   * actually have got there. Arrival is only ever marked on the ACTIVE stop,
   * so without this the scenario is unreachable. Beyond `maxSeconds` the step
   * reports itself as not exercised rather than burning the run's budget.
   */
  | { kind: "waitUntilStopActive"; target: StopTarget; maxSeconds: number }
  /**
   * Ask the server what this plan looks like at an instant past a stop's end,
   * through the app's own documented `?now=` control. The read-only half of
   * "what happens when reality diverges from the plan": a full stop window is
   * hours long and cannot be lived through inside a test run.
   */
  | {
      kind: "probeClock";
      afterStopEndOf: StopTarget;
      minutesPast: number;
      step: string;
      expected: string;
    }
  | { kind: "travelToStop"; target: StopTarget; pace?: Pace }
  | { kind: "dwellAtStop"; target: StopTarget; seconds?: number }
  | { kind: "expectArrival"; target: StopTarget; expectArrived?: boolean }
  | { kind: "wait"; seconds: number; why: string }
  | { kind: "reload"; why: string }
  | {
      kind: "swap";
      target: StopTarget;
      refinement: string;
      /** "same" = the slot keeps its kind; "category" = it should change kind. */
      expect: "same-category" | "different-category" | "refusal";
    }
  | {
      kind: "remove";
      target: StopTarget;
      /** Omitted means the removal is expected to succeed, which is what
       *  every pre-expansion persona wants. "refused" is the deliberate
       *  down-to-zero guard (`LAST_STOP_MESSAGE`): the plan must survive. */
      expect?: "removed" | "refused";
    }
  | { kind: "modeSwitch"; to: "transit" | "driving" }
  | { kind: "screenshotTransitLegs" }
  | { kind: "advanceClockPastPlanEnd"; why: string }
  | { kind: "end"; choice: "save-end" | "discard-end" }
  | { kind: "checkHistory"; expect: "contains-current" | "omits-current" }
  | { kind: "note"; step: string; expected: string }
  /**
   * "Whatever just happened, the app is still an app."
   *
   * The one shared check behind every adversarial persona. It reads the
   * screen for a RAW failure — an unhandled runtime error, a framework
   * crash page, a leaked `[object Object]`/`Invalid Date` — plus any
   * JavaScript dialog that fired and any page error the recorder caught,
   * and it records the plan's actual shape (stops and their times) beside
   * it for eyeball review. A refusal is not a failure here; a stack trace
   * is.
   */
  | { kind: "expectGraceful"; step: string; expected: string }
  /**
   * The documented short-hop relabel, checked against real provider
   * distances: on a DRIVING plan, a hop under `DRIVING_SHORT_LEG_WALK_METERS`
   * (700 m, `app/api/schedule/travel.ts`) is relabelled to WALK, so no leg
   * should come back `mode: "driving"` under that distance. The one
   * documented exception — a short drive whose WALK route failed to price —
   * is named in the recorded expectation rather than silently allowed.
   */
  | { kind: "expectShortDriveLegsWalk" }
  /**
   * Press End a SECOND time. The UI half is that the control is simply gone
   * (the topbar goes with the plan), so the honest way to reach the
   * double-submit is to re-issue the app's own POST with the app's own
   * captured Authorization header — the same seam `probeClock` uses for
   * `?now=`. The server's end path is idempotent by construction
   * (`if (proposal.endedAt) return { changed: false }`) and its archive is
   * guarded by `hasBeenArchived`, so a second end must neither error nor
   * write a second history document.
   */
  | { kind: "endAgain" }
  /**
   * Reload the page while a swap POST is still in flight. The browser's
   * request dies with the document; the server finishes and commits through
   * CAS regardless. Either outcome is fine — what must not happen is a stuck
   * spinner, a half-applied plan, or a plan that will not come back.
   */
  | { kind: "reloadDuringSwap"; target: StopTarget; refinement: string }
  /**
   * Drive the starting-location field's one dropdown row. With geolocation
   * denied (`denyGeolocation`), the documented contract is that the field
   * stays fully usable for typing and the row names a way out.
   */
  | { kind: "useCurrentLocation"; expect: "denied" | "filled" }
  /**
   * Turn live tracking on with the permission refused. `computeYouMarker`
   * returns null for `status: "denied"`, so there must be NO you-marker at
   * all — never a stale-looking or invented one — and the app's own
   * `LIVE_TRACKING_DENIED_NOTE` should say why.
   */
  | { kind: "expectLiveTrackingDenied" }
  /**
   * The structural half of "a guest signs in mid-session": the sign-in
   * affordance lives inside `if (!itinerary)` in `page.tsx`, so while a plan
   * is on screen there is no sign-in control to press. Recorded as the
   * documented design, with the OAuth half reported as NOT EXERCISED.
   */
  | { kind: "expectNoSignInWhilePlanning" }
  /**
   * Open the SAME session in a second browser context and let the app's own
   * resume read (`GET /api/itinerary`, keyed on the verified caller's uid)
   * find the plan. The state is copied with `indexedDB: true`, because
   * Firebase Auth keeps its session there.
   */
  | { kind: "resumeInSecondContext" };

export interface PlanExpectation {
  /** Minimum number of timed stops the plan should contain. */
  minStops?: number;
  /**
   * Upper bound on timed stops. The app's own ceiling is `MAX_ACTIVITIES`
   * (8, `app/api/parse/planner.ts`, the same number as
   * `planSlots.MAX_PLAN_STOPS`), which is what "20 things to do tonight"
   * must be capped to; a stated 30-minute window has a much lower sensible
   * ceiling of its own. Asserting a COUNT, never a venue.
   */
  maxStops?: number;
  /** The plan must NOT fall to the deterministic single-stop fallback. */
  notSingleStopFallback?: boolean;
  /** A constraint the plan must either satisfy or refuse honestly, never
   *  suggest-with-a-hedge. Free text, recorded for the report. */
  constraint?: string;
  /** The plan must not fail loud citing this word as unmet (the
   *  provability-strip regression: an unprovable kind leaking into
   *  `constraints` turns into a permanent whole-plan refusal). */
  mustNotRefuseCiting?: string[];
  /**
   * A refusal is a LEGITIMATE outcome for this prompt, so a plan that does
   * not appear is recorded rather than counted as a deviation. Used wherever
   * the honest answer depends on live data (nothing open at 6 AM) or on the
   * model's own judgement, and the thing actually under test is that the
   * refusal is graceful and says why.
   */
  refusalIsAcceptable?: boolean;
  /**
   * When it DOES refuse, the message must contain one of these fragments —
   * the app's OWN documented wording, so an improvised or borrowed error is
   * still a deviation. Fragments are matched case-insensitively.
   */
  refusalMustMention?: string[];
  /**
   * A plan must NEVER come back for this prompt. Set only where CODE, not
   * the model, decides: the degenerate-prompt guard
   * (`degeneratePromptReason`) and the contradiction guard
   * (`contradictionReason`) are both pure, deterministic and pre-model.
   */
  mustRefuse?: boolean;
}

export interface Persona {
  /** Stable slug: names the screenshot folder and the report section. */
  name: string;
  /** One line describing what this persona is for. */
  intent: string;
  /** Requires a saved signed-in storage state. Absent/failed → the persona
   *  is REPORTED AS SKIPPED, never silently downgraded to a guest. */
  signedIn: boolean;
  /**
   * Build this persona's context WITHOUT the geolocation permission, so the
   * browser refuses every position request exactly as it does for a user who
   * said no. Only the two personas that test refusal set it; every other
   * persona keeps the granted permission that makes movement simulation
   * possible at all.
   */
  denyGeolocation?: boolean;
  planPrompt: string;
  actions: PersonaAction[];
  /** Cross-cutting expectations recorded once at the end. */
  expectations?: string[];
}

export interface CheckRecord {
  persona: string;
  step: string;
  expected: string;
  actual: string;
  pass: boolean;
  /** Not a pass and not a deviation: the scenario could not be exercised. */
  skipped?: boolean;
  evidence: string[];
  at: string;
}

export interface PersonaResult {
  persona: string;
  intent: string;
  signedIn: boolean;
  startedAt: string;
  finishedAt: string;
  checks: CheckRecord[];
  /** Fatal harness error (not an app deviation) that stopped the persona. */
  harnessError?: string;
  timedOut: boolean;
  consoleErrors: string[];
  networkErrors: string[];
  planIds: string[];
}

/** Minimal structural view of the stored itinerary the harness reads back
 *  off the wire. Deliberately loose: the harness must not break when the
 *  app's own types grow, and it never writes any of this back. */
export interface ObservedLeg {
  legId?: string;
  fromIndex: number;
  mode: "transit" | "walk" | "driving" | "unknown";
  totalMinutes: number;
  distanceMeters: number | null;
  encodedPolyline: string | null;
  pathSegments?: { mode: "walk" | "transit"; encodedPolyline: string }[];
  transitSegments?: unknown[];
}

export interface ObservedStop {
  id: string | null;
  name?: string;
  category?: string;
  status: string;
  locked?: boolean;
  start_time: string | null;
  end_time: string | null;
  location?: { latitude: number; longitude: number } | null;
  travelToNext?: ObservedLeg;
}

export interface ObservedItinerary {
  id: string;
  version: number;
  status: string;
  timeZone?: string;
  travelMode?: "transit" | "driving";
  plannedEndISO?: string;
  stops: ObservedStop[];
  legs: ObservedLeg[];
  homeLeg?: ObservedLeg;
  home?: { label?: string; location: { latitude: number; longitude: number } };
}
