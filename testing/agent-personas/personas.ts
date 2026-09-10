// The persona set.
//
// Each persona is a plain config object. The runner interprets the actions;
// adding a scenario means adding a persona or an action here, never editing
// the run loop.
//
// GROUPING: related scenarios are bundled per persona rather than one persona
// per requirement, so each parallel run covers the whole matrix in eight
// browser contexts instead of twenty. The comment above each persona names
// exactly which requirements it carries.
//
// CITY: every persona plans in Toronto with a real downtown starting address.
// A single city keeps venue availability, transit density and the plan's
// timezone comparable across personas, so a deviation is about the app rather
// than about which city happened to be quiet.
//
// "RIGHT NOW" IS LOAD-BEARING on every persona that tests arrival detection.
// The app marks only the CURRENTLY-ACTIVE stop arrived, and an unstated time
// resolves through CATEGORY_START_DEFAULTS (dinner 19:00) and then rolls
// FORWARD to tomorrow if that hour has passed. A plan whose first stop is
// twenty hours away can never go active, so arrival is unreachable no matter
// how faithfully the device is walked to the door. The raw-prompt immediacy
// floor anchors the start to now, which is what makes the scenario testable at
// all. A persona with no movement to test does not need it.

import type { Persona } from "./types";

const CITY = "Toronto";
// Ossington is the app's own prefilled default neighbourhood, and it is
// chosen here for a concrete reason: the home leg decides how far in the
// future the first stop opens (`buildSchedule` advances its cursor by the
// home leg before the first stop), and arrival can only be tested on a stop
// that is underway. Starting inside a dense restaurant strip keeps that leg
// short enough that `waitUntilStopActive` fits in a test run.
const START = "80 Ossington Ave, Toronto";

export const PERSONAS: Persona[] = [
  // ── 1 ────────────────────────────────────────────────────────────────
  // Plan variety: a SPECIFIC request. Editing: a SAME-CATEGORY venue swap,
  // and removing the LAST stop. Movement: walks the real route ON SCHEDULE
  // and should register arrival. Identity: GUEST. Ending: discard-end.
  {
    name: "specific-diner",
    intent:
      "A specific request, one same-category swap, remove the last stop, arrive on time, end as a guest",
    signedIn: false,
    planPrompt: "dinner right now on Ossington and then a jazz club",
    actions: [
      {
        kind: "plan",
        prompt: "dinner right now on Ossington and then a jazz club",
        city: CITY,
        startAddress: START,
        travelMode: "transit",
        expect: { minStops: 2 },
      },
      {
        // The LAST stop, deliberately. A swap on stop 0 can invoke the
        // documented slot push, which moves the very stop this persona is
        // about to walk to and inflates its wait for no scenario reason.
        kind: "swap",
        target: "last",
        refinement: "somewhere different, same kind of place",
        expect: "same-category",
      },
      { kind: "waitUntilStopActive", target: "first", maxSeconds: 900 },
      { kind: "enableLiveTracking" },
      { kind: "travelToStop", target: "first", pace: "walk" },
      { kind: "dwellAtStop", target: "first", seconds: 75 },
      { kind: "expectArrival", target: "first", expectArrived: true },
      // The LAST stop, which is the removal position no other persona covers.
      { kind: "remove", target: "last" },
      { kind: "end", choice: "discard-end" },
    ],
    expectations: [
      "A guest's plan is fully usable for the whole session without an account",
    ],
  },

  // ── 2 ────────────────────────────────────────────────────────────────
  // Plan variety: a deliberately VAGUE request (this has had real bugs; the
  // question-coverage guarantee should stop it falling to the single-stop
  // deterministic fallback). Editing: a CATEGORY-CHANGING swap, and removing
  // the MIDDLE stop. Movement: deliberately STARTS LATE. Identity: guest.
  {
    name: "vague-wanderer",
    intent:
      "A vague prompt, a category-changing swap, remove the middle stop, and a deliberately late start",
    signedIn: false,
    planPrompt: "something to do right now around Ossington",
    actions: [
      {
        kind: "plan",
        prompt: "something to do right now around Ossington",
        city: CITY,
        startAddress: START,
        travelMode: "transit",
        expect: { minStops: 2, notSingleStopFallback: true },
      },
      {
        kind: "swap",
        target: "last",
        refinement: "board games instead",
        expect: "different-category",
      },
      { kind: "remove", target: "middle" },
      { kind: "waitUntilStopActive", target: "first", maxSeconds: 900 },
      {
        kind: "wait",
        seconds: 180,
        why: "start LATE: the first stop is already underway and the traveller has not set off yet",
      },
      { kind: "reload", why: "re-read the plan so server-derived statuses catch up" },
      { kind: "enableLiveTracking" },
      { kind: "travelToStop", target: "first", pace: "walk" },
      { kind: "dwellAtStop", target: "first", seconds: 75 },
      {
        kind: "note",
        step: "late_start_indicators",
        expected:
          "After arriving late, the plan's own clock indicators (active/'now' pill, done state, the creep caret) reflect the REAL time rather than the original schedule, and arrival is still detected at the venue",
      },
      { kind: "expectArrival", target: "first" },
      { kind: "end", choice: "discard-end" },
    ],
  },

  // ── 3 ────────────────────────────────────────────────────────────────
  // Plan variety: a HARD-CONSTRAINT request (patio + wheelchair accessible).
  // The contract is either an evidenced plan or an honest unmet-constraint
  // refusal, never a suggestion carrying a "worth confirming" hedge.
  // Movement: LINGERS past a stop's window and records what happens.
  {
    name: "patio-constraint",
    intent:
      "A hard-constraint request (patio, wheelchair accessible), then lingering past the stop's window",
    signedIn: false,
    planPrompt: "a drink on a patio right now on Ossington, wheelchair accessible",
    actions: [
      {
        kind: "plan",
        prompt: "a drink on a patio right now on Ossington, wheelchair accessible",
        city: CITY,
        startAddress: START,
        travelMode: "transit",
        expect: {
          minStops: 1,
          constraint: "patio + wheelchair accessible",
        },
      },
      { kind: "waitUntilStopActive", target: "first", maxSeconds: 900 },
      { kind: "enableLiveTracking" },
      { kind: "travelToStop", target: "first", pace: "walk" },
      { kind: "dwellAtStop", target: "first", seconds: 75 },
      { kind: "expectArrival", target: "first" },
      { kind: "dwellAtStop", target: "first", seconds: 240 },
      {
        kind: "note",
        step: "linger_at_stop",
        expected:
          "Staying on at the venue long after arriving does not corrupt the plan: no stop is silently re-timed, no error appears, and the arrival state holds",
      },
      {
        // A whole stop window is hours long and cannot be lived through inside
        // a test run, so the OVERSTAY half is asked of the server directly.
        kind: "probeClock",
        afterStopEndOf: "first",
        minutesPast: 45,
        step: "linger_past_window",
        expected:
          "45 minutes past this stop's scheduled end, the plan is still intact: every venue kept, every committed start time unchanged, and the statuses simply reflect the later hour",
      },
      { kind: "reload", why: "read the plan back after over-staying" },
      { kind: "end", choice: "discard-end" },
    ],
  },

  // ── 4 ────────────────────────────────────────────────────────────────
  // Plan variety: an INDOOR-ONLY constraint. This is the provability-strip
  // regression: a kind of place cannot be proved from the provider's booleans,
  // so if it leaks into plan-level `constraints` it becomes a permanent,
  // self-contradicting whole-plan refusal. Editing: remove the FIRST stop.
  {
    name: "indoor-only",
    intent:
      "An indoor-only constraint must not self-contradict into an unmet-constraint refusal; remove the first stop",
    signedIn: false,
    planPrompt: "indoor things to do tonight, staying out of the cold",
    actions: [
      {
        kind: "plan",
        prompt: "indoor things to do tonight, staying out of the cold",
        city: CITY,
        startAddress: START,
        travelMode: "transit",
        expect: {
          minStops: 2,
          mustNotRefuseCiting: ["indoor", "indoors", "out of the cold"],
        },
      },
      { kind: "remove", target: "first" },
      { kind: "end", choice: "discard-end" },
    ],
  },

  // ── 5 ────────────────────────────────────────────────────────────────
  // Plan variety: a DIETARY constraint. Same provability question as indoor,
  // plus the documented rule that a dietary preference belongs in the search
  // query and never in `constraints`.
  {
    name: "vegan-dietary",
    intent:
      "A dietary constraint plans a real evening instead of refusing itself, and its venues reflect the diet",
    signedIn: false,
    planPrompt: "vegan dinner right now on Ossington then a quiet bar",
    actions: [
      {
        kind: "plan",
        prompt: "vegan dinner right now on Ossington then a quiet bar",
        city: CITY,
        startAddress: START,
        travelMode: "transit",
        expect: {
          minStops: 2,
          constraint: "vegan",
          mustNotRefuseCiting: ["vegan"],
        },
      },
      { kind: "waitUntilStopActive", target: "first", maxSeconds: 900 },
      { kind: "enableLiveTracking" },
      { kind: "travelToStop", target: "first", pace: "walk" },
      { kind: "dwellAtStop", target: "first", seconds: 75 },
      { kind: "expectArrival", target: "first" },
      { kind: "end", choice: "discard-end" },
    ],
  },

  // ── 6 ────────────────────────────────────────────────────────────────
  // Editing: the MID-PLAN MODE SWITCH, both directions. Every venue must
  // survive the switch and every time ahead of the floor must re-price.
  // Movement: drives the real road geometry between switches.
  {
    name: "mode-switcher",
    intent:
      "Switch a live plan transit to driving and back: every venue kept, every time re-priced",
    signedIn: false,
    planPrompt: "dinner and drinks right now on Ossington",
    actions: [
      {
        kind: "plan",
        prompt: "dinner and drinks right now on Ossington",
        city: CITY,
        startAddress: START,
        travelMode: "transit",
        expect: { minStops: 2 },
      },
      { kind: "waitUntilStopActive", target: "first", maxSeconds: 900 },
      { kind: "enableLiveTracking" },
      { kind: "modeSwitch", to: "driving" },
      { kind: "travelToStop", target: "first", pace: "drive" },
      { kind: "dwellAtStop", target: "first", seconds: 75 },
      { kind: "expectArrival", target: "first" },
      { kind: "modeSwitch", to: "transit" },
      { kind: "end", choice: "discard-end" },
    ],
  },

  // ── 7 ────────────────────────────────────────────────────────────────
  // Transit specifics: a cross-town plan whose legs should be real transit
  // rides. Screenshots each transit leg's map state as the persona rides it,
  // and checks the ride badges / board-alight timeline actually render.
  {
    name: "transit-rider",
    intent:
      "A cross-town transit plan: ride each leg and capture the coloured ride lines, badges and board times",
    signedIn: false,
    planPrompt: "dinner in the Distillery District right now then live music on Ossington",
    actions: [
      {
        kind: "plan",
        prompt: "dinner in the Distillery District right now then live music on Ossington",
        city: CITY,
        startAddress: START,
        travelMode: "transit",
        expect: { minStops: 2 },
      },
      { kind: "waitUntilStopActive", target: "first", maxSeconds: 900 },
      { kind: "enableLiveTracking" },
      { kind: "screenshotTransitLegs" },
      { kind: "travelToStop", target: "first", pace: "transit" },
      { kind: "dwellAtStop", target: "first", seconds: 75 },
      { kind: "expectArrival", target: "first" },
      { kind: "travelToStop", target: 1, pace: "transit" },
      { kind: "screenshotTransitLegs" },
      { kind: "end", choice: "discard-end" },
    ],
  },

  // ── 8 ────────────────────────────────────────────────────────────────
  // Identity: SIGNED IN with a saved taste profile. Plan variety: a bare
  // prompt, which is where the stored profile is supposed to fill the aspects
  // the request left open. Ending: BOTH ending scenarios, in order, so one
  // history read proves both at once. Plan A is explicitly DISCARD-ended and
  // must be absent; plan B runs to NATURAL completion with no end action and
  // must be present.
  {
    name: "signed-in-regular",
    intent:
      "A signed-in personalized plan, a discard-end that must not archive, and a natural completion that must",
    signedIn: true,
    planPrompt: "dinner tonight",
    actions: [
      {
        kind: "plan",
        prompt: "dinner tonight",
        city: CITY,
        startAddress: START,
        travelMode: "transit",
        expect: { minStops: 1 },
      },
      {
        kind: "note",
        step: "personalization_is_invisible",
        expected:
          "A signed-in plan is shaped by the stored taste profile with NO visible 'because you like X' anywhere in the UI",
      },
      { kind: "end", choice: "discard-end" },
      { kind: "checkHistory", expect: "omits-current" },
      {
        kind: "plan",
        prompt: "a drink and dessert tonight",
        city: CITY,
        startAddress: START,
        travelMode: "transit",
        expect: { minStops: 1 },
      },
      {
        kind: "advanceClockPastPlanEnd",
        why: "let the plan finish on its own, with no explicit End action",
      },
      { kind: "checkHistory", expect: "contains-current" },
    ],
    expectations: [
      "A discard-ended plan is never written to history; a naturally-completed one is",
    ],
  },
];

export function personaActionCounts(personas: Persona[]) {
  let plans = 0;
  let swaps = 0;
  let removes = 0;
  let modeSwitches = 0;
  let pageLoads = 0;
  for (const persona of personas) {
    for (const action of persona.actions) {
      if (action.kind === "plan") {
        plans++;
        pageLoads++;
      } else if (action.kind === "swap") swaps++;
      else if (action.kind === "remove") removes++;
      else if (action.kind === "modeSwitch") modeSwitches++;
      else if (action.kind === "reload") pageLoads++;
      else if (action.kind === "checkHistory") pageLoads++;
    }
  }
  return { plans, swaps, removes, modeSwitches, pageLoads };
}
