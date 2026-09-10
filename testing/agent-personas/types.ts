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
  | { kind: "remove"; target: StopTarget }
  | { kind: "modeSwitch"; to: "transit" | "driving" }
  | { kind: "screenshotTransitLegs" }
  | { kind: "advanceClockPastPlanEnd"; why: string }
  | { kind: "end"; choice: "save-end" | "discard-end" }
  | { kind: "checkHistory"; expect: "contains-current" | "omits-current" }
  | { kind: "note"; step: string; expected: string };

export interface PlanExpectation {
  /** Minimum number of timed stops the plan should contain. */
  minStops?: number;
  /** The plan must NOT fall to the deterministic single-stop fallback. */
  notSingleStopFallback?: boolean;
  /** A constraint the plan must either satisfy or refuse honestly, never
   *  suggest-with-a-hedge. Free text, recorded for the report. */
  constraint?: string;
  /** The plan must not fail loud citing this word as unmet (the
   *  provability-strip regression: an unprovable kind leaking into
   *  `constraints` turns into a permanent whole-plan refusal). */
  mustNotRefuseCiting?: string[];
}

export interface Persona {
  /** Stable slug: names the screenshot folder and the report section. */
  name: string;
  /** One line describing what this persona is for. */
  intent: string;
  /** Requires a saved signed-in storage state. Absent/failed → the persona
   *  is REPORTED AS SKIPPED, never silently downgraded to a guest. */
  signedIn: boolean;
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
