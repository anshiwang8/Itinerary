// The persona set.
//
// Each persona is a plain config object. The runner interprets the actions;
// adding a scenario means adding a persona or an action here, never editing
// the run loop.
//
// GROUPING: related scenarios are bundled per persona rather than one persona
// per requirement, so a run covers the whole matrix in far fewer browser
// contexts than it has requirements. The comment above each persona names
// exactly which requirements it carries.
//
// FIFTY-ONE PERSONAS, in seven groups: the original EIGHT (the core
// plan/edit/move/end matrix), then six expansion categories added 2026-09-10 —
// ordinary variety, adversarial input, geography stress, time edges, account
// and session edges, and interaction stress. The README carries the table.
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

/**
 * A deliberately digressive prompt, with one small real request buried in it.
 * The question it asks is whether the planner extracts the request or plans
 * one stop per paragraph — and whether several paragraphs of text survive the
 * round trip at all.
 */
const RAMBLING_PROMPT = [
  "Okay so this is a bit of a long one, sorry. My cousin is visiting from out of town",
  "for the first time in about four years and I genuinely have no idea what to do with",
  "her. She used to live here years ago, before the west end got the way it is now, so",
  "half the places she remembers are gone and the other half she says are too loud.",
  "",
  "She is not really a museum person, or she says she isn't, but I think she'd like one",
  "if it wasn't a whole afternoon of it. Last time she visited we ended up just walking",
  "around for six hours which was honestly fine but my knee is not what it was.",
  "",
  "Anyway. What I actually want is dinner around 7, somewhere quiet enough that we can",
  "hear each other, and then maybe one more thing after that if there's time. Nothing",
  "fancy. She doesn't eat shellfish. That's it really, sorry for the essay.",
].join("\n");

/**
 * Script-tag and SQL-shaped text carried as the literal prompt, with a real
 * request beside it so a plan can still form around it.
 *
 * A LIGHT smoke test for inert handling, deliberately not a penetration test:
 * the whole assertion is that this text behaves like text — no script runs
 * (which the recorder's dialog capture would catch), no internal or database
 * error reaches the screen, and the app plans around it or asks what was meant.
 */
const INJECTION_PROMPT =
  "<script>alert(1)</script> dinner at 7pm'; DROP TABLE itineraries;-- then a bar";

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

  // ══════════════════════════════════════════════════════════════════════
  // EXPANSION, 2026-09-10 — personas 9 to 51, in six categories.
  //
  // TIME EXPRESSIONS ARE THE THING THAT WENT WRONG LAST TIME. The first
  // eight-persona run happened at ~2 AM local, and several "deviations" were
  // the app CORRECTLY refusing because real venues are shut at that hour.
  // The lesson is not "run it earlier"; it is that a persona's expectation
  // has to be right for WHENEVER the run happens. So, below:
  //
  //   - "right now" is used ONLY where movement or arrival is being tested,
  //     because the immediacy floor is what makes a stop go active inside a
  //     test run at all. Those personas are the ones that legitimately care
  //     what time it is.
  //   - Everything else states an explicit clock time or window. An hour
  //     that has already passed ROLLS FORWARD to tomorrow (CLAUDE.md's
  //     "Past times roll forward to next day"), so "brunch at 11am" is a
  //     correct request at 2 AM and at 2 PM alike — it simply lands on a
  //     different day, which is the right answer both times.
  //   - Where the honest outcome genuinely depends on live data (nothing is
  //     open at 6 AM), `refusalIsAcceptable` records WHICH happened instead
  //     of calling one of them a bug.
  //
  // NO PERSONA ASSERTS A VENUE NAME. Venues change. Every expectation below
  // is a shape, a count, or a specific documented guard.
  // ══════════════════════════════════════════════════════════════════════

  // ── CATEGORY 1: ORDINARY VARIETY (9-18) ───────────────────────────────
  // Mundane-to-pleasant requests the original eight never covered. The
  // question each one asks is simply "does a real, sensible day come back
  // for this?" — no movement, so they finish fast and their expectations
  // do not depend on the hour.

  // ── 9 ──
  {
    name: "park-walk",
    intent: "A daytime walk in a park with a coffee after it",
    signedIn: false,
    planPrompt: "a walk in a park at 2pm then a coffee somewhere nearby",
    actions: [
      {
        kind: "plan",
        prompt: "a walk in a park at 2pm then a coffee somewhere nearby",
        city: CITY,
        startAddress: START,
        travelMode: "transit",
        // An outdoor request is also the one ordinary prompt that can meet
        // the weather gate, which is a legitimate outcome rather than a
        // failure — the recovery panel is answered and recorded either way.
        expect: { minStops: 2, refusalIsAcceptable: true },
      },
      {
        kind: "expectGraceful",
        step: "park_walk_is_a_real_day",
        expected:
          "an ordinary daytime request produces a real outing (or an honest weather-gate answer), with no raw error anywhere on screen",
      },
      { kind: "end", choice: "discard-end" },
    ],
  },

  // ── 10 ──
  {
    name: "rainy-day",
    intent: "An indoor afternoon that names the weather as its reason",
    signedIn: false,
    planPrompt: "somewhere indoors to spend a rainy afternoon from 1pm, then an early dinner",
    actions: [
      {
        kind: "plan",
        prompt: "somewhere indoors to spend a rainy afternoon from 1pm, then an early dinner",
        city: CITY,
        startAddress: START,
        travelMode: "transit",
        expect: {
          minStops: 2,
          // Same provability trap as `indoor-only`: "indoors" is a KIND of
          // place, unprovable from the provider's six booleans, so if it
          // leaks into plan-level constraints it refuses every venue there is.
          mustNotRefuseCiting: ["indoor", "indoors", "rainy"],
        },
      },
      {
        kind: "expectGraceful",
        step: "rainy_day_is_a_real_day",
        expected:
          "a weather-motivated indoor request plans a real indoor day rather than refusing itself over the word 'indoors'",
      },
      { kind: "end", choice: "discard-end" },
    ],
  },

  // ── 11 ──
  {
    name: "morning-coffee",
    intent: "A small morning errand: coffee and a pastry, one or two stops",
    signedIn: false,
    planPrompt: "coffee and a pastry at 9am somewhere near Ossington",
    actions: [
      {
        kind: "plan",
        prompt: "coffee and a pastry at 9am somewhere near Ossington",
        city: CITY,
        startAddress: START,
        travelMode: "transit",
        // A modest ask should stay modest. 9am is stated, so it rolls to
        // tomorrow morning if the run is past it — correct either way.
        expect: { minStops: 1, maxStops: 3 },
      },
      {
        kind: "expectGraceful",
        step: "morning_coffee_stays_small",
        expected:
          "a small morning request produces a small plan, not an evening out, and the stated 9am anchors it (rolling to tomorrow morning if that hour has already passed)",
      },
      { kind: "end", choice: "discard-end" },
    ],
  },

  // ── 12 ──
  {
    name: "birthday-celebration",
    intent: "A group celebration: a lively dinner then dessert",
    signedIn: false,
    planPrompt: "a birthday dinner at 7pm for six people somewhere lively, then dessert",
    actions: [
      {
        kind: "plan",
        prompt: "a birthday dinner at 7pm for six people somewhere lively, then dessert",
        city: CITY,
        startAddress: START,
        travelMode: "transit",
        expect: { minStops: 2 },
      },
      {
        kind: "expectGraceful",
        step: "birthday_is_a_real_day",
        expected:
          "a group occasion with a stated vibe and a stated time plans both stops the request names",
      },
      { kind: "end", choice: "discard-end" },
    ],
  },

  // ── 13 ──
  {
    name: "first-date",
    intent: "A low-key first date: a quiet drink and a walk",
    signedIn: false,
    planPrompt: "a relaxed first date at 6:30pm, a quiet drink and then somewhere to walk",
    actions: [
      {
        kind: "plan",
        prompt: "a relaxed first date at 6:30pm, a quiet drink and then somewhere to walk",
        city: CITY,
        startAddress: START,
        travelMode: "transit",
        expect: { minStops: 2 },
      },
      {
        kind: "expectGraceful",
        step: "first_date_is_a_real_day",
        expected:
          "a bare-meridiem 6:30pm resolves to the evening (parseTimeExpr's documented rule) and both named stops appear",
      },
      { kind: "end", choice: "discard-end" },
    ],
  },

  // ── 14 ──
  {
    name: "solo-museum",
    intent: "A solo cultural day with lunch beside it",
    signedIn: false,
    planPrompt: "a museum starting at 11am on my own, with lunch somewhere near it after",
    actions: [
      {
        kind: "plan",
        prompt: "a museum starting at 11am on my own, with lunch somewhere near it after",
        city: CITY,
        startAddress: START,
        travelMode: "transit",
        expect: { minStops: 2 },
      },
      {
        kind: "expectGraceful",
        step: "solo_museum_is_a_real_day",
        expected:
          "a museum is a long stop and lunch is a short one; both should appear with sensible, different lengths rather than one default duration applied twice",
      },
      { kind: "end", choice: "discard-end" },
    ],
  },

  // ── 15 ──
  {
    name: "family-afternoon",
    intent: "An afternoon with young children, then an early dinner",
    signedIn: false,
    planPrompt:
      "an afternoon out with two kids starting at 1pm, somewhere they can run around, then an early dinner",
    actions: [
      {
        kind: "plan",
        prompt:
          "an afternoon out with two kids starting at 1pm, somewhere they can run around, then an early dinner",
        city: CITY,
        startAddress: START,
        travelMode: "transit",
        expect: { minStops: 2, refusalIsAcceptable: true },
      },
      {
        kind: "expectGraceful",
        step: "family_afternoon_is_a_real_day",
        expected:
          "a family request plans somewhere genuinely child-appropriate followed by an early dinner, rather than a bar",
      },
      { kind: "end", choice: "discard-end" },
    ],
  },

  // ── 16 ──
  {
    name: "bar-crawl",
    intent:
      "Several drinking stops in a row — the case where the VARIETY caps are supposed to release",
    signedIn: false,
    planPrompt: "a bar crawl starting at 8pm, three different bars",
    actions: [
      {
        kind: "plan",
        prompt: "a bar crawl starting at 8pm, three different bars",
        city: CITY,
        startAddress: START,
        travelMode: "transit",
        // The prompt's own documented rule: an un-named day gets at most one
        // drinking stop, and the cap RELEASES the moment the request names
        // them ("bar crawl"). Three named bars must not be collapsed to one.
        expect: { minStops: 2, maxStops: 8 },
      },
      {
        kind: "expectGraceful",
        step: "variety_caps_release_when_named",
        expected:
          "the one-drinking-stop variety cap releases for an explicitly named bar crawl, so more than one bar is planned rather than the day being 'varied' against the user's own request",
      },
      { kind: "end", choice: "discard-end" },
    ],
  },

  // ── 17 ──
  {
    name: "errand-run",
    intent:
      "The deliberately unglamorous case: groceries and a coffee, NOT an evening out",
    signedIn: false,
    planPrompt: "groceries and then a coffee, starting at 10am",
    actions: [
      {
        kind: "plan",
        prompt: "groceries and then a coffee, starting at 10am",
        city: CITY,
        startAddress: START,
        travelMode: "transit",
        expect: { minStops: 2, maxStops: 4 },
      },
      {
        kind: "expectGraceful",
        step: "errands_are_a_valid_outing",
        expected:
          "a mundane errand run is planned as itself — a shop and a coffee — rather than being reinterpreted as a night out, which is the failure mode of a planner tuned only on evenings",
      },
      { kind: "end", choice: "discard-end" },
    ],
  },

  // ── 18 ──
  {
    name: "weekend-brunch",
    intent:
      "Brunch on a NAMED weekday, which is also the deterministic weekday floor",
    signedIn: false,
    planPrompt: "brunch on Saturday at 11am then a bookshop",
    actions: [
      {
        kind: "plan",
        prompt: "brunch on Saturday at 11am then a bookshop",
        city: CITY,
        startAddress: START,
        travelMode: "transit",
        expect: { minStops: 2 },
      },
      {
        kind: "expectGraceful",
        step: "named_weekday_lands_on_that_weekday",
        expected:
          "'Saturday' is a FACT, not a judgement: applyWeekdayFloor reads the raw prompt and moves the model's date to the nearest future Saturday when it landed on a different weekday, keeping the stated 11am. The recorded stop times below should fall on a Saturday.",
      },
      { kind: "end", choice: "discard-end" },
    ],
  },

  // ── CATEGORY 2: ADVERSARIAL (19-28) ───────────────────────────────────
  // Each of these tests that the app fails GRACEFULLY, not that it succeeds.
  // They stop at plan creation on purpose: the question is whether hostile
  // input is HANDLED, and dragging a broken plan through the swap/movement
  // chain would only bury that answer under cascading skips.

  // ── 19 ──
  {
    name: "bare-prompt",
    intent: "Almost nothing to go on: a plan, or a clarifying question, never an error",
    signedIn: false,
    planPrompt: "plan something",
    actions: [
      {
        kind: "plan",
        prompt: "plan something",
        city: CITY,
        startAddress: START,
        travelMode: "transit",
        // Two real words, so `degeneratePromptReason` lets it through: it is
        // sincere-but-vague, which the guard documents as deserving the
        // general pool rather than a rejection.
        expect: { minStops: 1, refusalIsAcceptable: true },
      },
      {
        kind: "expectGraceful",
        step: "bare_prompt_handled",
        expected:
          "'plan something' is sincere but vague, which planGuards deliberately does NOT reject: the honest answers are a real general day or a clarifying round. A raw error is not one of them.",
      },
      { kind: "end", choice: "discard-end" },
    ],
  },

  // ── 20 ──
  {
    name: "french-prompt",
    intent: "A prompt in French — whatever the app does with it, it must not break",
    signedIn: false,
    planPrompt: "un dîner sympa ce soir puis un bar tranquille",
    actions: [
      {
        kind: "plan",
        prompt: "un dîner sympa ce soir puis un bar tranquille",
        city: CITY,
        startAddress: START,
        travelMode: "transit",
        // INVESTIGATED, not assumed: there is no language gate anywhere in
        // this codebase. `degeneratePromptReason` only counts letters and
        // checks for keyboard mash, so a French prompt reaches the model like
        // any other and the model decides. Either outcome is legitimate.
        expect: { refusalIsAcceptable: true },
      },
      {
        kind: "expectGraceful",
        step: "french_prompt_handled",
        expected:
          "the app has no language gate, so a French prompt reaches the planner like any other. A plan and an honest refusal are both fine; a crash, a blank screen or an untranslated internal error are not.",
      },
      { kind: "end", choice: "discard-end" },
    ],
  },

  // ── 21 ──
  {
    name: "spanish-prompt",
    intent: "A second non-English prompt, to tell 'handles other languages' from a fluke",
    signedIn: false,
    planPrompt: "cena y luego una copa en un sitio tranquilo esta noche",
    actions: [
      {
        kind: "plan",
        prompt: "cena y luego una copa en un sitio tranquilo esta noche",
        city: CITY,
        startAddress: START,
        travelMode: "transit",
        expect: { refusalIsAcceptable: true },
      },
      {
        kind: "expectGraceful",
        step: "spanish_prompt_handled",
        expected:
          "a second language, so the French result reads as behaviour rather than luck. Same contract: a plan or an honest refusal, never a raw failure.",
      },
      { kind: "end", choice: "discard-end" },
    ],
  },

  // ── 22 ──
  {
    name: "gibberish-prompt",
    intent:
      "Keyboard mash — the one adversarial case whose answer is decided by pure code",
    signedIn: false,
    planPrompt: "asdfghjkl qwertyuiop zxcvbnm",
    actions: [
      {
        kind: "plan",
        prompt: "asdfghjkl qwertyuiop zxcvbnm",
        city: CITY,
        startAddress: START,
        travelMode: "transit",
        // DETERMINISTIC. All three tokens are literal keyboard rows, so
        // `gibberishWord` is true for every one of them and
        // `degeneratePromptReason` returns UNPARSEABLE_MESSAGE BEFORE the
        // model is ever called. No model, no clock, no live data involved.
        expect: {
          mustRefuse: true,
          refusalMustMention: ["couldn't make sense of that"],
        },
      },
      {
        kind: "expectGraceful",
        step: "gibberish_handled",
        expected:
          "keyboard mash never reaches the model: degeneratePromptReason catches it pre-model and returns UNPARSEABLE_MESSAGE, which suggests describing an evening instead",
      },
    ],
  },

  // ── 23 ──
  {
    name: "impossible-request",
    intent: "Something the app cannot possibly do, asked sincerely",
    signedIn: false,
    planPrompt: "book me a flight to Mars this evening and take me to the moon after",
    actions: [
      {
        kind: "plan",
        prompt: "book me a flight to Mars this evening and take me to the moon after",
        city: CITY,
        startAddress: START,
        travelMode: "transit",
        // No code path decides this one; it is a semantic judgement, which is
        // the model's job. So the outcome is RECORDED rather than asserted —
        // what matters is that nothing is invented and nothing breaks.
        expect: { refusalIsAcceptable: true },
      },
      {
        kind: "expectGraceful",
        step: "impossible_request_handled",
        expected:
          "the app either says it cannot do this, or redirects to something real and nearby (a planetarium, a space exhibit) — what it must never do is present a fabricated 'Mars' stop as a real venue, since every venue comes from a Places result with a real id",
      },
      { kind: "end", choice: "discard-end" },
    ],
  },

  // ── 24 ──
  {
    name: "contradiction-stack",
    intent:
      "Two contradictions: one the code catches deterministically, one only the model can judge",
    signedIn: false,
    planPrompt: "a vegan steakhouse dinner tonight",
    actions: [
      {
        kind: "plan",
        prompt: "a vegan steakhouse dinner tonight",
        city: CITY,
        startAddress: START,
        travelMode: "transit",
        // DETERMINISTIC. `contradictionReason`'s DIETARY_VENUE_CONFLICTS
        // table pairs /vegan|vegetarian|plant-based/ against
        // /steak\s?house|steakhouse|.../ and the message NAMES the pair.
        expect: {
          mustRefuse: true,
          refusalMustMention: ["contradictory", "vegan", "steakhouse"],
        },
      },
      {
        kind: "expectGraceful",
        step: "coded_contradiction_handled",
        expected:
          "'vegan steakhouse' is refused by the pure contradiction guard, naming the actual pair rather than returning an empty, silently filtered map",
      },
      // Nothing to end: the guard refused before a plan existed. This is
      // recorded as a skip rather than assumed, so a plan that DID appear
      // cannot silently block the second attempt below.
      { kind: "end", choice: "discard-end" },
      {
        kind: "plan",
        prompt: "somewhere loud and quiet at the same time for a drink at 8pm",
        city: CITY,
        startAddress: START,
        travelMode: "transit",
        // NOT in the contradiction table — "loud" and "quiet" are vibe words,
        // not a budget or a diet — so this one reaches the model, and the
        // model's judgement is what is being observed.
        expect: { refusalIsAcceptable: true },
      },
      {
        kind: "expectGraceful",
        step: "judged_contradiction_handled",
        expected:
          "a contradiction the code does not model reaches the planner. Either answer is defensible — refuse and name it, or pick one side and be clear about which — but a confidently-wrong plan that silently satisfies neither half is not.",
      },
      { kind: "end", choice: "discard-end" },
    ],
  },

  // ── 25 ──
  {
    name: "rambling-prompt",
    intent: "Several paragraphs of context around one small actual request",
    signedIn: false,
    planPrompt: RAMBLING_PROMPT,
    actions: [
      {
        kind: "plan",
        prompt: RAMBLING_PROMPT,
        city: CITY,
        startAddress: START,
        travelMode: "transit",
        expect: { minStops: 1, maxStops: 8, refusalIsAcceptable: true },
      },
      {
        kind: "expectGraceful",
        step: "rambling_prompt_handled",
        expected:
          "a long, digressive prompt is reduced to the request buried in it (dinner around 7, somewhere quiet) rather than timing out, crashing, or planning one stop per paragraph. The planner's own ceiling is 8 activities.",
      },
      { kind: "end", choice: "discard-end" },
    ],
  },

  // ── 26 ──
  {
    name: "injection-text",
    intent:
      "A LIGHT safety smoke test: script- and SQL-shaped text must be inert plain text",
    signedIn: false,
    planPrompt: INJECTION_PROMPT,
    actions: [
      {
        kind: "plan",
        prompt: INJECTION_PROMPT,
        city: CITY,
        startAddress: START,
        travelMode: "transit",
        expect: { refusalIsAcceptable: true },
      },
      {
        // The dialog capture in the recorder is what makes this meaningful:
        // if `<script>alert(1)</script>` had ever run, a dialog would have
        // fired and be listed here. `expectGraceful` fails on a non-empty
        // dialog list, on any raw error text, and on any page error.
        kind: "expectGraceful",
        step: "injection_text_is_inert",
        expected:
          "script-tag and SQL-shaped text is treated as ordinary prompt text: no script executes (no JavaScript dialog fires), no database or internal error leaks to the screen, and the app either plans around the literal gibberish or asks what was meant. This is a smoke test for inert handling, NOT a penetration test.",
      },
      { kind: "end", choice: "discard-end" },
    ],
  },

  // ── 27 ──
  {
    name: "too-many-stops",
    intent: "An unreasonable stop count, which must be capped rather than attempted",
    signedIn: false,
    planPrompt: "20 things to do tonight starting at 6pm",
    actions: [
      {
        kind: "plan",
        prompt: "20 things to do tonight starting at 6pm",
        city: CITY,
        startAddress: START,
        travelMode: "transit",
        // The ceiling is CODE's, not the model's: MAX_ACTIVITIES = 8 in
        // planner.ts (the same number as planSlots.MAX_PLAN_STOPS), enforced
        // by findPlanProblems -> one correction retry -> deterministic
        // fallback. Twenty stops can never reach the scheduler.
        expect: { minStops: 1, maxStops: 8, refusalIsAcceptable: true },
      },
      {
        kind: "expectGraceful",
        step: "stop_count_is_capped",
        expected:
          "twenty stops is capped at the app's own ceiling of 8 activities rather than attempted, and the day that comes back is still a coherent, travellable outing rather than eight stops crammed into an evening",
      },
      { kind: "end", choice: "discard-end" },
    ],
  },

  // ── 28 ──
  {
    name: "zero-duration",
    intent: "A request with no time in it at all to spend",
    signedIn: false,
    planPrompt: "plan something for 0 minutes tonight",
    actions: [
      {
        kind: "plan",
        prompt: "plan something for 0 minutes tonight",
        city: CITY,
        startAddress: START,
        travelMode: "transit",
        // Durations are CLAMPED, not rejected: MIN_ACTIVITY_MINUTES is 15 and
        // MAX is 360, and the planner's own validator fixes arithmetic rather
        // than spending its one correction retry on it. A zero-length WINDOW
        // is a different matter — `endISO <= startISO` is a hard problem —
        // so a refusal is equally legitimate here.
        expect: { maxStops: 8, refusalIsAcceptable: true },
      },
      {
        kind: "expectGraceful",
        step: "zero_duration_handled",
        expected:
          "an impossible duration is clamped to the app's 15-minute floor or refused honestly, never turned into a zero-length or negative stop that the scheduler then has to lay out",
      },
      { kind: "end", choice: "discard-end" },
    ],
  },

  // ── CATEGORY 3: GEOGRAPHY STRESS (29-35) ──────────────────────────────
  // Real thresholds, transcribed from the code rather than guessed:
  //   MAX_START_DISTANCE_FROM_CITY_METERS = 75_000  (app/api/geocode/geocode.ts)
  //   SAME_METRO_METERS                   = 25_000  (same file)
  //   DRIVING_SHORT_LEG_WALK_METERS       = 700     (app/api/schedule/travel.ts)

  // ── 29 ──
  {
    name: "city-radius-edge",
    intent:
      "Both sides of the 75 km start-distance guardrail, measured rather than guessed",
    signedIn: false,
    planPrompt: "dinner at 7pm",
    actions: [
      {
        kind: "plan",
        prompt: "dinner at 7pm",
        city: CITY,
        // ~70.7 km from Toronto's own geocoded centre by the same haversine
        // the app uses — INSIDE the 75 km cap, and in the same province, so
        // neither the distance test nor the secondary region test should
        // refuse it. This is the "people commute in" case the constant's own
        // comment is written about.
        startAddress: "1 Carden Street, Guelph, ON",
        travelMode: "transit",
        expect: { minStops: 1, refusalIsAcceptable: true },
      },
      {
        kind: "expectGraceful",
        step: "start_just_inside_the_cap",
        expected:
          "a start ~70.7 km from the city centre is INSIDE MAX_START_DISTANCE_FROM_CITY_METERS (75 km) and in the same region, so it should plan. If it refuses, the message must be one of the app's own geocode refusals rather than a crash — and the distance is the thing to check first.",
      },
      { kind: "end", choice: "discard-end" },
      {
        kind: "plan",
        prompt: "dinner at 7pm",
        city: CITY,
        // ~92.2 km — PAST the cap. Same province and same country, so the
        // distance test is the only thing that can refuse this, which makes
        // it a clean read on that one rule.
        startAddress: "200 King Street West, Kitchener, ON",
        travelMode: "transit",
        expect: {
          mustRefuse: true,
          refusalMustMention: ["very far from"],
        },
      },
      {
        kind: "expectGraceful",
        step: "start_past_the_cap_is_refused",
        expected:
          "a start ~92.2 km away is past the 75 km cap and must be refused with geocode_far_from_city's own wording ('That address is very far from Toronto, check the city or the address.'). Without this cap a typo becomes a silent multi-hour home leg, because getSingleLeg will happily estimate any distance.",
      },
    ],
  },

  // ── 30 ──
  {
    name: "nonsense-start-address",
    intent: "A starting address that is not an address at all",
    signedIn: false,
    planPrompt: "dinner at 7pm",
    actions: [
      {
        kind: "plan",
        prompt: "dinner at 7pm",
        city: CITY,
        startAddress: "qqqq zzzz vvvv 88888",
        travelMode: "transit",
        // One of the documented geocode refusals: geocode_not_found (404) or
        // geocode_incomplete_address (422), depending on what the provider
        // makes of the text. What must NOT happen is the silent Ossington
        // fallback CLAUDE.md forbids.
        expect: {
          mustRefuse: true,
          refusalMustMention: [
            "couldn't find that location",
            "complete starting address",
            "very far from",
          ],
        },
      },
      {
        kind: "expectGraceful",
        step: "unparseable_start_is_refused",
        expected:
          "an unparseable starting address is refused in the app's own words and NEVER silently replaced with the Ossington/Toronto default — a plan built from a start the user did not give is worse than no plan",
      },
    ],
  },

  // ── 31 ──
  {
    name: "cross-border-start",
    intent: "A starting address in a different country from the selected city",
    signedIn: false,
    planPrompt: "dinner at 7pm",
    actions: [
      {
        kind: "plan",
        prompt: "dinner at 7pm",
        city: CITY,
        // Buffalo is ~94.6 km away AND in a different country. The country
        // check runs FIRST and is hard, so this is a clean read on that rule
        // rather than on the distance one.
        startAddress: "65 Niagara Square, Buffalo, NY",
        travelMode: "transit",
        expect: {
          mustRefuse: true,
          refusalMustMention: ["outside the selected city's country"],
        },
      },
      {
        kind: "expectGraceful",
        step: "wrong_country_start_is_refused",
        expected:
          "the country test is hard and runs before the distance test, so a US address for a Toronto plan is refused with geocode_wrong_country's wording rather than being treated as a long commute",
      },
    ],
  },

  // ── 32 ──
  {
    name: "short-hop-driving",
    intent:
      "The 700 m relabel: two stops close enough that a DRIVING plan should still walk between them",
    signedIn: false,
    planPrompt: "dinner then dessert on the same stretch of Ossington at 7pm",
    actions: [
      {
        kind: "plan",
        prompt: "dinner then dessert on the same stretch of Ossington at 7pm",
        city: CITY,
        startAddress: START,
        travelMode: "driving",
        expect: { minStops: 2 },
      },
      { kind: "expectShortDriveLegsWalk" },
      {
        kind: "expectGraceful",
        step: "driving_plan_is_coherent",
        expected:
          "a driving plan whose stops are a few hundred metres apart is still coherent: short hops read as walks, longer ones as drives, and no leg claims a car ride across one block",
      },
      { kind: "end", choice: "discard-end" },
    ],
  },

  // ── 33 ──
  {
    name: "cross-town-transit",
    intent:
      "A genuinely long cross-town journey: real transit legs, probably with transfers",
    signedIn: false,
    planPrompt: "dinner in Scarborough at 6pm then a bar in the west end",
    actions: [
      {
        kind: "plan",
        prompt: "dinner in Scarborough at 6pm then a bar in the west end",
        city: CITY,
        startAddress: START,
        travelMode: "transit",
        expect: { minStops: 2, refusalIsAcceptable: true },
      },
      // The same per-leg screenshot pass `transit-rider` uses: each leg is
      // selected in turn and the coloured ride lines, route badges and
      // board/alight timelines are captured as they render.
      { kind: "screenshotTransitLegs" },
      {
        kind: "expectGraceful",
        step: "cross_town_transit_renders",
        expected:
          "a long cross-town journey produces real transit legs with provider board/alight times, and the app never presents a 75-minute walk in place of a comparable ride (the walk relabel only wins under 400 m, when walking beats transit and is under 30 min, or when walking is twice as fast)",
      },
      { kind: "end", choice: "discard-end" },
    ],
  },

  // ── 34 ──
  {
    name: "waterfront-detour",
    intent:
      "A plan across water, where the straight line and the real route are very different",
    signedIn: false,
    planPrompt: "somewhere on the waterfront at 4pm then dinner downtown",
    actions: [
      {
        kind: "plan",
        prompt: "somewhere on the waterfront at 4pm then dinner downtown",
        city: CITY,
        startAddress: START,
        travelMode: "transit",
        // Deliberately only ONE stop required: a waterfront request is an
        // outdoor one, so the weather gate can legitimately empty that slot
        // and the recovery panel answers it. The subject here is the ROUTE
        // geometry, not the stop count.
        expect: { minStops: 1, refusalIsAcceptable: true },
      },
      {
        kind: "expectGraceful",
        step: "waterfront_routing_is_real",
        expected:
          "a leg that has to go around water carries the provider's own geometry, so the drawn route follows real streets and ferries rather than cutting across the lake. A leg that could not be priced at all stays 'unknown' and draws NO line, which is the documented behaviour rather than an invented one.",
      },
      { kind: "end", choice: "discard-end" },
    ],
  },

  // ── 35 ──
  {
    name: "second-city-timezone",
    intent:
      "A different city in a DIFFERENT timezone, end to end — the documented live-only gap",
    signedIn: false,
    planPrompt: "dinner at 7pm then a drink",
    actions: [
      {
        kind: "plan",
        prompt: "dinner at 7pm then a drink",
        // Vancouver is America/Vancouver, three hours behind the harness's own
        // America/Toronto context clock. Mock e2e cannot reach any of this:
        // its geocode fixture returns fixed Toronto coordinates for every
        // query, so a second city proves plumbing only there.
        city: "Vancouver, British Columbia",
        startAddress: "800 Robson Street, Vancouver, BC",
        travelMode: "transit",
        expect: { minStops: 2, refusalIsAcceptable: true },
      },
      {
        kind: "expectGraceful",
        step: "second_city_resolves_its_own_zone",
        expected:
          "every plan carries its OWN resolved IANA zone, so a Vancouver plan schedules and labels in America/Vancouver — never the server's clock, never the viewer's browser, and never unconditionally Toronto. '7pm' should be 7pm in Vancouver. The recorded stop times below are the evidence.",
      },
      { kind: "end", choice: "discard-end" },
    ],
  },

  // ── CATEGORY 4: TIME EDGES (36-42) ────────────────────────────────────
  // Every prompt here states its own clock time or window, so the expectation
  // is correct whenever the run happens: a stated hour that has passed rolls
  // forward to the next day rather than becoming wrong.

  // ── 36 ──
  {
    name: "early-morning",
    intent: "5-6 AM, when almost nothing is open",
    signedIn: false,
    planPrompt: "breakfast at 6am then somewhere to walk",
    actions: [
      {
        kind: "plan",
        prompt: "breakfast at 6am then somewhere to walk",
        city: CITY,
        startAddress: START,
        travelMode: "transit",
        // A refusal is very likely the CORRECT answer, and this is exactly the
        // case the first run got wrong by treating one as a deviation. There
        // is no plausibility gate any more: an unusual hour is planned, and
        // the objective hours filter decides what is genuinely open. "Nothing
        // is open at 6am" is a fact; "breakfast isn't plausible at 6am" would
        // be an opinion, and the app deliberately stopped having those.
        expect: {
          refusalIsAcceptable: true,
          refusalMustMention: ["closed at that hour", "couldn't find any"],
        },
      },
      {
        kind: "expectGraceful",
        step: "early_morning_is_honest",
        expected:
          "at 6am the app either plans somewhere genuinely open or says the hour is the problem in the hours-dominant wording ('everything nearby is closed at that hour. Try a different time, or a different kind of place?'). What it must not do is plan a venue that is shut.",
      },
      { kind: "end", choice: "discard-end" },
    ],
  },

  // ── 37 ──
  {
    name: "across-midnight",
    intent: "A window that starts before midnight and ends after it",
    signedIn: false,
    planPrompt: "drinks from 11pm until 1am",
    actions: [
      {
        kind: "plan",
        prompt: "drinks from 11pm until 1am",
        city: CITY,
        startAddress: START,
        travelMode: "transit",
        expect: { minStops: 1, maxStops: 4, refusalIsAcceptable: true },
      },
      {
        kind: "expectGraceful",
        step: "midnight_window_rolls_as_one_unit",
        expected:
          "a stated range rolls as ONE unit, decided by its END: rolling each end independently produces an inverted window that the validator rejects, silently downgrading a good prompt to the single-stop fallback. The recorded times below should run continuously across midnight, not backwards.",
      },
      { kind: "end", choice: "discard-end" },
    ],
  },

  // ── 38 ──
  {
    name: "future-dated",
    intent: "Planning for a named day in the future",
    signedIn: false,
    planPrompt: "dinner next Saturday at 7pm then a bar",
    actions: [
      {
        kind: "plan",
        prompt: "dinner next Saturday at 7pm then a bar",
        city: CITY,
        startAddress: START,
        travelMode: "transit",
        // INVESTIGATED: future-dated planning IS supported. The planner
        // resolves the date itself; `applyWeekdayFloor` corrects the model
        // when it lands on the wrong weekday ("next <weekday>" staying
        // strict); and MAX_PLAN_HORIZON_DAYS = 14 is the only ceiling, which
        // "next Saturday" is comfortably inside. So a real plan is the
        // expectation here, not a graceful redirect.
        expect: { minStops: 2 },
      },
      {
        kind: "expectGraceful",
        step: "future_dated_plan_lands_on_the_right_day",
        expected:
          "'next Saturday' is inside the 14-day planning horizon and resolves to a real future date. The weekday floor abstains when the model already landed on a Saturday and corrects it when it did not, so the recorded stop times must fall on a Saturday, at the stated 7pm.",
      },
      { kind: "end", choice: "discard-end" },
    ],
  },

  // ── 39 ──
  {
    name: "impossible-window",
    intent: "Far more stops than the stated window can hold",
    signedIn: false,
    planPrompt: "8 stops between 9 and 9:30pm",
    actions: [
      {
        kind: "plan",
        prompt: "8 stops between 9 and 9:30pm",
        city: CITY,
        startAddress: START,
        travelMode: "transit",
        // Code owns this arithmetic, not the model: checkWindowFit re-checks
        // the plan against the stated end AFTER real travel legs are folded
        // in. Past WINDOW_OVERRUN_TOLERANCE_MINUTES (30) the trailing stops
        // that do not fit are DROPPED and named in the banner; if not even
        // the first fits, it fails loud. Either way, never eight stops.
        expect: { maxStops: 3, refusalIsAcceptable: true },
      },
      {
        kind: "expectGraceful",
        step: "overstuffed_window_is_trimmed_or_refused",
        expected:
          "a 30-minute window cannot hold 8 stops once real travel is counted. checkWindowFit either drops the trailing stops and NAMES them, or refuses outright with windowTooTightReason. An overstuffed schedule that silently overruns by hours is the failure this guard exists to prevent.",
      },
      { kind: "end", choice: "discard-end" },
    ],
  },

  // ── 40 ──
  {
    name: "tiny-window",
    intent: "Thirty minutes, honestly asked for",
    signedIn: false,
    planPrompt: "something to do between 7:00 and 7:30pm",
    actions: [
      {
        kind: "plan",
        prompt: "something to do between 7:00 and 7:30pm",
        city: CITY,
        startAddress: START,
        travelMode: "transit",
        // Half an hour is two minutes over the 15-minute minimum stop plus a
        // home leg, so one modest stop is the sensible answer and a refusal
        // is legitimate if the travel does not fit.
        expect: { maxStops: 2, refusalIsAcceptable: true },
      },
      {
        kind: "expectGraceful",
        step: "tiny_window_plans_one_thing",
        expected:
          "thirty minutes buys one modest stop, not several. The stop's own length must also respect the app's 15-minute floor rather than being squeezed to fit.",
      },
      { kind: "end", choice: "discard-end" },
    ],
  },

  // ── 41 ──
  {
    name: "long-window",
    intent: "A whole day, which should be paced rather than padded",
    signedIn: false,
    planPrompt: "plan my whole day from 9am to 9pm",
    actions: [
      {
        kind: "plan",
        prompt: "plan my whole day from 9am to 9pm",
        city: CITY,
        startAddress: START,
        travelMode: "transit",
        expect: { minStops: 3, maxStops: 8 },
      },
      {
        kind: "expectGraceful",
        step: "long_window_is_paced",
        expected:
          "twelve hours should produce a paced day of several stops, capped at the app's own 8-activity ceiling. A large UNFILLED gap is the planner under-filling and is logged as [window-fit] rather than being padded in code, which would be a second planning mechanism in the wrong language — so a short plan here is a finding, not a crash.",
      },
      { kind: "end", choice: "discard-end" },
    ],
  },

  // ── 42 ──
  {
    name: "airport-layover",
    intent: "A hard ceiling with somewhere to be afterwards",
    signedIn: false,
    planPrompt: "two hours to kill before a flight, from 2pm to 4pm, somewhere to sit and eat",
    actions: [
      {
        kind: "plan",
        prompt: "two hours to kill before a flight, from 2pm to 4pm, somewhere to sit and eat",
        city: CITY,
        startAddress: START,
        travelMode: "transit",
        expect: { minStops: 1, maxStops: 3 },
      },
      {
        kind: "expectGraceful",
        step: "hard_ceiling_is_respected",
        expected:
          "a stated end is a real ceiling here, because the user has somewhere to be. Inside the 30-minute overrun tolerance nothing happens; past it the trailing stops are dropped and named. The recorded end time should not run far past 4pm.",
      },
      { kind: "end", choice: "discard-end" },
    ],
  },

  // ── CATEGORY 5: ACCOUNT AND SESSION EDGES (43-46) ─────────────────────

  // ── 43 ──
  {
    name: "guest-signs-in-midsession",
    intent:
      "What a guest can and cannot do about signing in once a plan is under way",
    signedIn: false,
    planPrompt: "dinner at 7pm then a drink",
    actions: [
      {
        kind: "plan",
        prompt: "dinner at 7pm then a drink",
        city: CITY,
        startAddress: START,
        travelMode: "transit",
        expect: { minStops: 1 },
      },
      // The structural half, which IS testable: no sign-in control exists
      // while a plan is on screen. The OAuth half is reported as not
      // exercised, with the reason, rather than guessed at.
      { kind: "expectNoSignInWhilePlanning" },
      { kind: "reload", why: "a guest's plan must survive a refresh, account or no account" },
      {
        kind: "expectGraceful",
        step: "guest_plan_survives_a_reload",
        expected:
          "a guest is signed in ANONYMOUSLY rather than not at all, so their plan has a real owner and GET /api/itinerary resumes it on the next load. Nothing about the app is gated on having a real account.",
      },
      { kind: "end", choice: "discard-end" },
    ],
    expectations: [
      "A guest gets the whole app: the only thing an account adds is history and taste preferences",
    ],
  },

  // ── 44 ──
  {
    name: "location-permission-denied",
    intent:
      "'Use current location' with the permission refused — the field must stay usable",
    signedIn: false,
    // The one flag that matters here: this context is built WITHOUT the
    // geolocation permission, so the browser refuses exactly as it does for
    // someone who said no.
    denyGeolocation: true,
    planPrompt: "dinner at 7pm",
    actions: [
      { kind: "useCurrentLocation", expect: "denied" },
      {
        kind: "plan",
        prompt: "dinner at 7pm",
        city: CITY,
        startAddress: START,
        travelMode: "transit",
        expect: { minStops: 1 },
      },
      {
        kind: "expectGraceful",
        step: "refused_location_does_not_block_planning",
        expected:
          "a refused device read costs nothing: the typed path is the primary one and is completely untouched by this feature, so the plan goes ahead from the typed address",
      },
      { kind: "end", choice: "discard-end" },
    ],
  },

  // ── 45 ──
  {
    name: "live-tracking-denied",
    intent:
      "Live tracking with the permission refused — an honest 'off', never a fake marker",
    signedIn: false,
    denyGeolocation: true,
    planPrompt: "dinner right now on Ossington",
    actions: [
      {
        kind: "plan",
        prompt: "dinner right now on Ossington",
        city: CITY,
        startAddress: START,
        travelMode: "transit",
        expect: { minStops: 1 },
      },
      { kind: "expectLiveTrackingDenied" },
      {
        kind: "expectGraceful",
        step: "denied_tracking_leaves_the_plan_alone",
        expected:
          "refusing location turns off an enhancement and nothing else: the plan, the map and every stop time are unaffected, because live tracking is display-only and never touches the stored itinerary or the schedule",
      },
      { kind: "end", choice: "discard-end" },
    ],
  },

  // ── 46 ──
  {
    name: "second-device-resume",
    intent: "The same guest session opened in a second browser context",
    signedIn: false,
    planPrompt: "dinner at 7pm then a drink",
    actions: [
      {
        kind: "plan",
        prompt: "dinner at 7pm then a drink",
        city: CITY,
        startAddress: START,
        travelMode: "transit",
        expect: { minStops: 1 },
      },
      { kind: "resumeInSecondContext" },
      { kind: "end", choice: "discard-end" },
    ],
    expectations: [
      "A plan is stored server-side and found by identity, not held in one tab's React state",
    ],
  },

  // ── CATEGORY 6: INTERACTION STRESS (47-51) ────────────────────────────

  // ── 47 ──
  {
    name: "repeated-swaps",
    intent: "The same stop swapped three times in a row",
    signedIn: false,
    planPrompt: "dinner at 7pm then a bar",
    actions: [
      {
        kind: "plan",
        prompt: "dinner at 7pm then a bar",
        city: CITY,
        startAddress: START,
        travelMode: "transit",
        expect: { minStops: 2 },
      },
      // The LAST stop, deliberately, for the same reason `specific-diner`
      // moved off stop 0: a swap on the first stop can invoke the documented
      // slot push and drag the whole tail with it, which muddies what three
      // consecutive swaps are actually being asked to prove.
      {
        kind: "swap",
        target: "last",
        refinement: "somewhere different, same kind of place",
        expect: "same-category",
      },
      {
        kind: "swap",
        target: "last",
        refinement: "somewhere different again, same kind of place",
        expect: "same-category",
      },
      {
        kind: "swap",
        target: "last",
        refinement: "one more, somewhere else, same kind of place",
        expect: "same-category",
      },
      {
        kind: "expectGraceful",
        step: "three_swaps_leave_a_coherent_plan",
        expected:
          "each swap applies cleanly on top of the last: the version rises every time, the slot keeps its kind and its length, and the plan never ends up with a duplicated venue, a lost stop or a stale time. A refusal is legitimate if nothing usable is reachable in the slot, but it must SAY so.",
      },
      { kind: "end", choice: "discard-end" },
    ],
  },

  // ── 48 ──
  {
    name: "remove-to-one",
    intent:
      "Remove down to a single stop, then try to remove that — the down-to-zero guard",
    signedIn: false,
    planPrompt: "dinner at 6pm, then a drink, then dessert",
    actions: [
      {
        kind: "plan",
        prompt: "dinner at 6pm, then a drink, then dessert",
        city: CITY,
        startAddress: START,
        travelMode: "transit",
        expect: { minStops: 3 },
      },
      { kind: "remove", target: "last" },
      { kind: "remove", target: "last" },
      // The one that must be REFUSED. `removeStop.ts` checks "would a plan
      // still exist after this?" against the ORIGINAL array, BEFORE the
      // splice and before the forecast call, and points at End instead.
      { kind: "remove", target: "last", expect: "refused" },
      {
        kind: "expectGraceful",
        step: "plan_survives_the_refused_removal",
        expected:
          "after the refusal the plan is byte-identical to before it: refusal means changed:false, so no CAS runs and no version is bumped. The one remaining stop is still on screen with its venue and its time.",
      },
      { kind: "end", choice: "discard-end" },
    ],
  },

  // ── 49 ──
  {
    name: "mode-thrash",
    intent: "Four mode switches in a row, with every venue expected to survive all four",
    signedIn: false,
    planPrompt: "dinner at 7pm then a bar",
    actions: [
      {
        kind: "plan",
        prompt: "dinner at 7pm then a bar",
        city: CITY,
        startAddress: START,
        travelMode: "transit",
        expect: { minStops: 2 },
      },
      { kind: "modeSwitch", to: "driving" },
      { kind: "modeSwitch", to: "transit" },
      { kind: "modeSwitch", to: "driving" },
      { kind: "modeSwitch", to: "transit" },
      {
        kind: "expectGraceful",
        step: "venues_survive_four_switches",
        expected:
          "a mode switch changes every stop's TIME and never any stop's VENUE, in both directions and however many times it is done. Transit-to-driving pulls stops EARLIER, where clampEarlierToAvailability holds a stop at its own opening time; driving-to-transit pushes them LATER, where neverReplaceVenue refuses BEFORE the replacement search rather than substituting. Switching to the mode a plan is already in is refused outright and writes nothing.",
      },
      { kind: "end", choice: "discard-end" },
    ],
    expectations: [
      "Re-pricing a day's travel is never allowed to re-pick where the day goes",
    ],
  },

  // ── 50 ──
  {
    name: "double-end",
    intent: "Ending a plan twice",
    signedIn: false,
    planPrompt: "dinner at 7pm",
    actions: [
      {
        kind: "plan",
        prompt: "dinner at 7pm",
        city: CITY,
        startAddress: START,
        travelMode: "transit",
        expect: { minStops: 1 },
      },
      { kind: "end", choice: "discard-end" },
      { kind: "endAgain" },
    ],
  },

  // ── 51 ──
  {
    name: "reload-mid-swap",
    intent: "Refreshing the page before a swap's response comes back",
    signedIn: false,
    planPrompt: "dinner at 7pm then a bar",
    actions: [
      {
        kind: "plan",
        prompt: "dinner at 7pm then a bar",
        city: CITY,
        startAddress: START,
        travelMode: "transit",
        expect: { minStops: 2 },
      },
      { kind: "reloadDuringSwap", target: "last", refinement: "somewhere different" },
      {
        kind: "expectGraceful",
        step: "no_stuck_state_after_a_lost_response",
        expected:
          "a lost response never leaves the app stuck: the plan comes back on reload, the busy state is gone, and the controls work again. The app's own rule for an ambiguous mutation is to READ BACK rather than assume, so whichever way the swap landed, the screen agrees with the store.",
      },
      { kind: "end", choice: "discard-end" },
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
      // A reload mid-swap still SENDS the swap: the server finishes and
      // commits it whether or not the browser is there to read the answer,
      // so it costs exactly what a swap costs, plus the reload's map load.
      else if (action.kind === "reloadDuringSwap") {
        swaps++;
        pageLoads++;
      } else if (action.kind === "remove") removes++;
      else if (action.kind === "modeSwitch") modeSwitches++;
      else if (action.kind === "reload") pageLoads++;
      else if (action.kind === "checkHistory") pageLoads++;
      // Each of these opens the app fresh, so each is one more dynamic map
      // load: the landing page for the location row, a whole second context
      // for the resume check.
      else if (action.kind === "useCurrentLocation") pageLoads++;
      else if (action.kind === "resumeInSecondContext") pageLoads++;
    }
  }
  return { plans, swaps, removes, modeSwitches, pageLoads };
}
