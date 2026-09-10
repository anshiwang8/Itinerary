// One persona, start to finish.
//
// The action list is interpreted here. A deviation is RECORDED and the loop
// CONTINUES: an exploratory report loses most of its value if the first
// mismatch cuts off the rest of that persona's coverage. Only a genuine
// harness fault (a closed context, a crashed page) stops a persona early, and
// that is reported as a harness error rather than as an app deviation.

import fs from "node:fs/promises";
import path from "node:path";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import type {
  Persona,
  PersonaAction,
  PersonaResult,
  StopTarget,
} from "../types";
import type { RunOptions } from "../config";
import { AUTH_STATE_PATH } from "../config";
import { Recorder } from "./recorder";
import { ItineraryProbe, inboundLeg, timedStops } from "./itineraryProbe";
import { crawlPath, dwellAt, legPath, sleep } from "./movement";
import { instantAfterPlanEnd, instantAfterStopEnd, readPlanAt } from "./clock";
import * as app from "./app";

/** A realistic phone fix in a dense downtown: tens of metres, comfortably
 *  inside the app's own 75 m arrival radius so the harness never has to
 *  argue with the accuracy gate to prove arrival detection works. */
const REPORTED_ACCURACY_M = 18;

export async function runPersona(
  browser: Browser,
  persona: Persona,
  run: RunOptions,
  reportDir: string
): Promise<PersonaResult> {
  const startedAt = new Date();
  const screenshotDir = path.join(reportDir, persona.name);
  const recorder = new Recorder(persona.name, screenshotDir, reportDir);
  const probe = new ItineraryProbe();
  const deadline = Date.now() + run.personaTimeoutMs;
  const abort = () => Date.now() > deadline;

  let context: BrowserContext | null = null;
  let harnessError: string | undefined;
  const state: PersonaState = { planLive: false, movementReachable: true, skipNote: null };

  try {
    const storageState = persona.signedIn ? await readAuthState() : undefined;
    if (persona.signedIn && !storageState) {
      recorder.record({
        step: "signed_in_session",
        expected:
          "a saved signed-in browser session so the signed-in scenarios (personalized planning, history) can run",
        actual:
          "no saved session at testing/agent-personas/output/signed-in-state.json — run `npm run test:agents:login` once and sign in with Google. This persona's scenarios were NOT exercised (never silently downgraded to a guest, which would make its history checks meaningless).",
        pass: false,
        skipped: true,
      });
      return finish(persona, recorder, probe, startedAt, false, harnessError);
    }

    // A persona that tests REFUSAL gets no geolocation permission and no
    // starting fix, so Chromium answers every position request the way it
    // answers one for a user who said no. Everyone else keeps the granted
    // permission that makes movement simulation possible at all.
    const denyLocation = persona.denyGeolocation === true;
    context = await browser.newContext({
      // Every `page.goto("/")` in the driver resolves against this, so the
      // persona can never wander off the target deployment.
      baseURL: run.baseURL,
      viewport: { width: 1440, height: 900 },
      permissions: denyLocation ? [] : ["geolocation"],
      // A plausible starting fix so the very first watchPosition callback is
      // a real one. It is overwritten the moment the persona starts moving.
      ...(denyLocation
        ? {}
        : {
            geolocation: {
              latitude: 43.6511,
              longitude: -79.3839,
              accuracy: REPORTED_ACCURACY_M,
            },
          }),
      locale: "en-CA",
      timezoneId: "America/Toronto",
      storageState,
    });

    const page = await context.newPage();
    recorder.observe(page);
    probe.attach(page);

    for (const action of persona.actions) {
      if (abort()) {
        recorder.record({
          step: "persona_timeout",
          expected: "the whole scenario completes inside the per-persona budget",
          actual:
            "the budget of " +
            Math.round(run.personaTimeoutMs / 60_000) +
            " min ran out at action `" +
            action.kind +
            "`; the remaining actions did not run",
          pass: false,
        });
        break;
      }
      await performAction(action, {
        page,
        context,
        browser,
        persona,
        recorder,
        probe,
        run,
        abort,
        state,
      });
    }

    if (persona.expectations) {
      for (const expectation of persona.expectations) {
        recorder.record({
          step: "persona_expectation",
          expected: expectation,
          actual: "recorded; see this persona's individual checks above",
          pass: true,
        });
      }
    }
    return finish(persona, recorder, probe, startedAt, abort(), harnessError);
  } catch (error) {
    // A harness fault, not an app deviation: say so on stdout as it happens
    // rather than leaving a silent, suspiciously fast run to be explained by
    // the report afterwards. ANSI codes from Playwright's call log are
    // stripped so the markdown stays readable.
    harnessError = stripAnsi(String(error)).slice(0, 600);
    process.stdout.write("  [" + persona.name + "] HARNESS ERROR  " + harnessError + "\n");
    return finish(persona, recorder, probe, startedAt, abort(), harnessError);
  } finally {
    if (context && !run.keepOpenOnFailure) await context.close().catch(() => undefined);
  }
}

interface ActionContext {
  page: Page;
  context: BrowserContext;
  /** Only the second-context resume needs this; every other action drives
   *  the persona's own single context. */
  browser: Browser;
  persona: Persona;
  recorder: Recorder;
  probe: ItineraryProbe;
  run: RunOptions;
  abort: () => boolean;
  state: PersonaState;
}

/** Mutable run state, read by the precondition gate below. */
interface PersonaState {
  /** A plan is currently on screen. */
  planLive: boolean;
  /** The movement/arrival chain is still reachable. Cleared when the target
   *  stop will not go active inside this run's budget: the plan is fine, the
   *  scenario simply cannot be lived through, and the EDITING steps after it
   *  should still run. */
  movementReachable: boolean;
  /** Why the last precondition failed, so the skip lines say something true. */
  skipNote: string | null;
}

/** Actions that are meaningless without a plan on screen. When the preceding
 *  plan attempt refused (a legitimate outcome this harness reports), running
 *  these anyway produces a cascade of timeouts that all say the same thing and
 *  bury the one finding that mattered. They are SKIPPED instead: not a pass,
 *  not a deviation, and named as such in the report. */
const NEEDS_A_PLAN = new Set<PersonaAction["kind"]>([
  "enableLiveTracking",
  "waitUntilStopActive",
  "probeClock",
  "travelToStop",
  "dwellAtStop",
  "expectArrival",
  "reload",
  "swap",
  "remove",
  "modeSwitch",
  "screenshotTransitLegs",
  "advanceClockPastPlanEnd",
  "end",
  "expectShortDriveLegsWalk",
  "reloadDuringSwap",
  "expectLiveTrackingDenied",
  "expectNoSignInWhilePlanning",
  "resumeInSecondContext",
]);

/** Actions that additionally need the target stop to be reachable in time.
 *  Kept separate from NEEDS_A_PLAN on purpose: a plan whose first stop opens
 *  in forty minutes is a perfectly good plan, and its swap, removal, mode
 *  switch and ending are all still worth exercising. */
const NEEDS_MOVEMENT = new Set<PersonaAction["kind"]>([
  "travelToStop",
  "dwellAtStop",
  "expectArrival",
]);

async function performAction(action: PersonaAction, ctx: ActionContext): Promise<void> {
  const { page, recorder, probe } = ctx;

  if (!ctx.state.planLive && NEEDS_A_PLAN.has(action.kind)) {
    recorder.record({
      step: "skipped_" + action.kind,
      expected: "this step needs a plan on screen",
      actual:
        ctx.state.skipNote ??
        "no plan was live at this point (the preceding plan attempt did not produce one), so this step was not exercised",
      pass: false,
      skipped: true,
    });
    return;
  }
  if (!ctx.state.movementReachable && NEEDS_MOVEMENT.has(action.kind)) {
    recorder.record({
      step: "skipped_" + action.kind,
      expected: "this step needs the target stop to be underway",
      actual:
        ctx.state.skipNote ??
        "the target stop was not reachable inside this run's budget, so this step was not exercised",
      pass: false,
      skipped: true,
    });
    return;
  }

  switch (action.kind) {
    case "plan":
      return doPlan(action, ctx);

    case "enableLiveTracking": {
      await recorder.check(
        page,
        "live_tracking_enabled",
        "the map's live-location control turns on and the app starts its own watchPosition stream",
        async () => {
          const on = await app.enableLiveTracking(page);
          const state = await app.mapState(page);
          return {
            pass: on,
            actual: on
              ? "control is aria-pressed=true; map state is " + state
              : "the live-location control did not turn on (map state " + state + ")",
          };
        }
      );
      // The distance measurement lives in the map component, so arrival can
      // only ever fire on a map that actually loaded. Worth its own line.
      await recorder.check(
        page,
        "map_ready_for_arrival",
        "the Google map reaches data-map-state=ready, which is what makes the distance-to-active-stop measurement (and therefore arrival detection) possible at all",
        async () => {
          const deadline = Date.now() + 30_000;
          let state = await app.mapState(page);
          while (state !== "ready" && Date.now() < deadline) {
            await page.waitForTimeout(500);
            state = await app.mapState(page);
          }
          return { pass: state === "ready", actual: "data-map-state=" + state };
        }
      );
      return;
    }

    case "waitUntilStopActive":
      return doWaitUntilActive(action, ctx);

    case "probeClock":
      return doProbeClock(action, ctx);

    case "travelToStop":
      return doTravel(action, ctx);

    case "dwellAtStop":
      return doDwell(action, ctx);

    case "expectArrival":
      return doExpectArrival(action, ctx);

    case "wait": {
      const seconds = action.seconds;
      process.stdout.write(
        "  [" + ctx.persona.name + "] waiting " + seconds + "s — " + action.why + "\n"
      );
      const until = Date.now() + seconds * 1000;
      while (Date.now() < until && !ctx.abort()) await sleep(1_000);
      recorder.record({
        step: "deliberate_wait",
        expected: action.why,
        actual: "waited " + seconds + "s of real time",
        pass: true,
      });
      return;
    }

    case "reload": {
      await recorder.check(
        page,
        "reload_resumes_plan",
        "reloading the page resumes the same plan (" + action.why + ")",
        async () => {
          const before = probe.current();
          const reloadedAt = Date.now();
          await page.reload({ waitUntil: "domcontentloaded" });
          await probe.waitForReadAfter(reloadedAt, 45_000);
          await app.expandDesktopItinerary(page);
          const after = probe.current();
          const same = Boolean(before && after && before.id === after.id);
          return {
            pass: same,
            actual: same
              ? "same plan id " + after?.id + " came back, version " + after?.version
              : "expected plan " + (before?.id ?? "none") + ", got " + (after?.id ?? "none"),
          };
        }
      );
      return;
    }

    case "swap":
      return doSwap(action, ctx);

    case "remove":
      return doRemove(action, ctx);

    case "modeSwitch":
      return doModeSwitch(action, ctx);

    case "screenshotTransitLegs":
      return doTransitLegShots(ctx);

    case "advanceClockPastPlanEnd":
      return doAdvanceClock(action, ctx);

    case "end":
      return doEnd(action, ctx);

    case "checkHistory":
      return doCheckHistory(action, ctx);

    case "note": {
      const shot = await recorder.screenshot(page, action.step);
      const names = await app.stopCardNames(page).catch(() => []);
      recorder.record({
        step: action.step,
        expected: action.expected,
        actual:
          "observed state captured. Stops on screen: " +
          (names.length > 0 ? names.join(" | ") : "none") +
          ". Banner: " +
          ((await app.readBanner(page)) ?? "none") +
          ".",
        pass: true,
        evidence: [shot],
      });
      return;
    }

    case "expectGraceful":
      return doExpectGraceful(action, ctx);

    case "expectShortDriveLegsWalk":
      return doShortDriveLegs(ctx);

    case "endAgain":
      return doEndAgain(ctx);

    case "reloadDuringSwap":
      return doReloadDuringSwap(action, ctx);

    case "useCurrentLocation":
      return doUseCurrentLocation(action, ctx);

    case "expectLiveTrackingDenied":
      return doLiveTrackingDenied(ctx);

    case "expectNoSignInWhilePlanning":
      return doNoSignInWhilePlanning(ctx);

    case "resumeInSecondContext":
      return doResumeInSecondContext(ctx);

    case "expectPlanFailsLoud": {
      await recorder.check(page, "plan_fails_loud", action.expect, async () => ({
        pass: false,
        actual: "not implemented for this persona set",
        skipped: true,
      }));
      return;
    }
  }
}

// ── plan ──────────────────────────────────────────────────────────────────

async function doPlan(
  action: Extract<PersonaAction, { kind: "plan" }>,
  ctx: ActionContext
): Promise<void> {
  const { page, recorder, probe } = ctx;
  const outcome = await app.planFromLanding(page, {
    prompt: action.prompt,
    city: action.city,
    startAddress: action.startAddress,
    travelMode: action.travelMode,
  });
  const shot = await recorder.screenshot(page, "plan-created");
  ctx.state.planLive = outcome.ok;

  const expectation = action.expect;
  const refusalAllowed = expectation?.refusalIsAcceptable === true;
  const refusalRequired = expectation?.mustRefuse === true;

  recorder.record({
    step: "plan_created",
    expected: refusalRequired
      ? "the prompt " +
        JSON.stringify(action.prompt) +
        " is REFUSED before it ever reaches the model: this is one of the pure, deterministic guards in planGuards.ts, so the answer does not depend on the day or on the model"
      : refusalAllowed
        ? "the prompt " +
          JSON.stringify(action.prompt) +
          " either produces a real itinerary or is refused with an honest reason. Both are legitimate here, and which one happened is recorded rather than judged."
        : "the prompt " +
          JSON.stringify(action.prompt) +
          " produces a real itinerary on the map",
    actual:
      (outcome.ok
        ? "planned in " + Math.round(outcome.elapsedMs / 1000) + "s"
        : "no plan: " + outcome.failure) +
      (outcome.clarified ? "; a clarifying round appeared and was skipped" : "") +
      (outcome.recovered ? "; " + outcome.recovered : ""),
    pass: refusalRequired ? !outcome.ok : outcome.ok || refusalAllowed,
    evidence: [shot],
  });

  // When it DID refuse, the wording has to be the app's own. An improvised or
  // borrowed message is a deviation even where the refusal itself is right.
  if (!outcome.ok && expectation?.refusalMustMention) {
    const refusal = (outcome.failure ?? "").toLowerCase();
    const matched = expectation.refusalMustMention.filter((fragment) =>
      refusal.includes(fragment.toLowerCase())
    );
    recorder.record({
      step: "refusal_uses_the_app_s_own_wording",
      expected:
        "the refusal is one of the app's own documented messages, containing one of: " +
        expectation.refusalMustMention.map((f) => JSON.stringify(f)).join(", "),
      actual:
        (matched.length > 0
          ? "matched " + matched.map((f) => JSON.stringify(f)).join(", ") + " in: "
          : "matched none of them: ") + JSON.stringify(outcome.failure ?? ""),
      pass: matched.length > 0,
      evidence: [shot],
    });
  }

  if (!outcome.ok) {
    if (expectation?.mustNotRefuseCiting) {
      const refusal = (outcome.failure ?? "").toLowerCase();
      const cited = expectation.mustNotRefuseCiting.filter((word) =>
        refusal.includes(word.toLowerCase())
      );
      recorder.record({
        step: "no_self_contradicting_refusal",
        expected:
          "the request is not refused for the very thing it asked for (" +
          expectation.mustNotRefuseCiting.join(", ") +
          "): a kind of place cannot be proved from provider evidence, so it must never become a plan-level constraint that refuses every venue",
        actual:
          cited.length > 0
            ? "refused citing " + cited.join(", ") + ": " + outcome.failure
            : "refused, but not citing the asked-for terms: " + outcome.failure,
        pass: cited.length === 0,
        evidence: [shot],
      });
    }
    return;
  }

  const plan = await probe.waitForPlan(30_000);
  if (!plan) {
    recorder.record({
      step: "plan_readable",
      expected: "the harness can read the plan's own stored data back off the wire",
      actual:
        "the app rendered an itinerary but no GET /api/itinerary/<id> response was observed",
      pass: false,
      evidence: [shot],
    });
    return;
  }

  const stops = timedStops(plan);
  if (expectation?.minStops !== undefined) {
    recorder.record({
      step: "plan_shape",
      expected: "at least " + expectation.minStops + " timed stops",
      actual:
        stops.length +
        " timed stop(s): " +
        stops.map((stop) => (stop.name ?? "?") + " [" + (stop.category ?? "?") + "]").join(" | "),
      pass: stops.length >= expectation.minStops,
      evidence: [shot],
    });
  }
  if (expectation?.maxStops !== undefined) {
    recorder.record({
      step: "plan_shape_capped",
      expected:
        "at most " +
        expectation.maxStops +
        " timed stops. The app's own hard ceiling is MAX_ACTIVITIES = 8 (app/api/parse/planner.ts, the same number as planSlots.MAX_PLAN_STOPS), enforced by findPlanProblems and its correction retry; a stated window has a lower sensible ceiling of its own.",
      actual:
        stops.length +
        " timed stop(s): " +
        stops
          .map((stop) => (stop.name ?? "?") + " [" + (stop.category ?? "?") + "]")
          .join(" | "),
      pass: stops.length <= expectation.maxStops,
      evidence: [shot],
    });
  }
  if (expectation?.notSingleStopFallback) {
    const categories = new Set(stops.map((stop) => stop.category ?? "?"));
    const looksLikeFallback = stops.length === 1;
    recorder.record({
      step: "not_single_stop_fallback",
      expected:
        "a vague prompt still produces a real multi-stop day rather than the deterministic single-stop fallback (the question-coverage guarantee)",
      actual: looksLikeFallback
        ? "only one stop was planned: " +
          (stops[0]?.name ?? "?") +
          " [" +
          (stops[0]?.category ?? "?") +
          "] — this is what the fallback looks like"
        : stops.length + " stops across categories " + [...categories].join(", "),
      pass: !looksLikeFallback,
      evidence: [shot],
    });
  }
  if (expectation?.constraint) {
    recorder.record({
      step: "hard_constraint_honoured",
      expected:
        "every planned venue genuinely satisfies " +
        JSON.stringify(expectation.constraint) +
        ", or the app refuses outright — never a suggestion carrying a 'worth confirming' hedge",
      actual:
        "planned " +
        stops.map((stop) => stop.name ?? "?").join(" | ") +
        ". The constraint is proved server-side from provider evidence, so this line records WHAT was planned for eyeball verification against " +
        JSON.stringify(expectation.constraint) +
        ".",
      pass: true,
      evidence: [shot],
    });
  }

  if (refusalRequired) {
    recorder.record({
      step: "deterministic_guard_did_not_fire",
      expected:
        "a pure pre-model guard in planGuards.ts refuses this prompt outright, so no itinerary should exist at all",
      actual:
        "an itinerary WAS planned: " +
        stops
          .map((stop) => (stop.name ?? "?") + " [" + (stop.category ?? "?") + "]")
          .join(" | "),
      pass: false,
      evidence: [shot],
    });
  }

  // The whole movement half depends on this, so it gets its own check.
  const withGeometry = stops
    .map((_, index) => legPath(inboundLeg(plan, index)))
    .filter((path) => path.source !== "none");
  recorder.record({
    step: "route_geometry_present",
    expected:
      "the plan carries real provider route geometry for its legs, so the simulated device can be walked along actual streets rather than a straight line",
    actual:
      withGeometry.length +
      " of " +
      stops.length +
      " inbound leg(s) carry geometry (" +
      [...new Set(withGeometry.map((p) => p.source))].join(", ") +
      ")",
    pass: withGeometry.length > 0,
    evidence: [shot],
  });
}

// ── movement ──────────────────────────────────────────────────────────────

function resolveIndex(target: StopTarget, count: number): number {
  if (typeof target === "number") return Math.max(0, Math.min(count - 1, target));
  if (target === "first") return 0;
  if (target === "last") return Math.max(0, count - 1);
  return Math.max(0, Math.min(count - 1, Math.floor(count / 2)));
}

async function doTravel(
  action: Extract<PersonaAction, { kind: "travelToStop" }>,
  ctx: ActionContext
): Promise<void> {
  const { page, recorder, probe, context, run } = ctx;
  const plan = probe.current();
  if (!plan) {
    recorder.record({
      step: "travel_to_stop",
      expected: "walk the real route geometry to the target stop",
      actual: "no plan data available to read geometry from",
      pass: false,
      skipped: true,
    });
    return;
  }
  const stops = timedStops(plan);
  const index = resolveIndex(action.target, stops.length);
  const stop = stops[index];
  const leg = inboundLeg(plan, index);
  const path = legPath(leg);
  const label = "travel_to_stop_" + index + (stop?.name ? " (" + stop.name + ")" : "");

  if (path.source === "none") {
    recorder.record({
      step: "travel_geometry_" + index,
      expected:
        "the leg arriving at stop " +
        index +
        " carries the provider's own encoded geometry to walk along",
      actual:
        leg === null
          ? "no inbound leg is stored for this stop"
          : "leg mode is '" +
            leg.mode +
            "' and it carries no drawable geometry; the app documents an 'unknown' estimate drawing no line, so this is a deviation only if the mode is transit/walk/driving",
      pass: leg !== null && leg.mode === "unknown",
      evidence: [await recorder.screenshot(page, "no-geometry-" + index)],
    });
    // Without a line there is nothing honest to walk. Jump the device to the
    // stop's own coordinate so the later dwell/arrival checks still run, and
    // say so plainly rather than inventing a route.
    if (stop?.location) {
      await context.setGeolocation({
        latitude: stop.location.latitude,
        longitude: stop.location.longitude,
        accuracy: REPORTED_ACCURACY_M,
      });
    }
    return;
  }

  const pace = action.pace ?? (leg?.mode === "driving" ? "drive" : leg?.mode === "transit" ? "transit" : "walk");
  const outcome = await crawlPath(context, path, {
    mode: pace,
    legMinutes: leg?.totalMinutes,
    accuracyM: REPORTED_ACCURACY_M,
    run,
    abort: ctx.abort,
  });
  const shot = await recorder.screenshot(page, "after-" + label.replace(/\W+/g, "-"));

  recorder.record({
    step: "travel_to_stop_" + index,
    expected:
      "the simulated device follows the plan's own " +
      (leg?.mode ?? "?") +
      " leg geometry to " +
      (stop?.name ?? "stop " + index) +
      ", feeding the app's real watchPosition stream",
    actual:
      "walked " +
      Math.round(path.meters) +
      " m of provider geometry (" +
      path.source +
      ") in " +
      Math.round(outcome.wallClockMs / 1000) +
      "s of wall clock across " +
      outcome.fixesDelivered +
      " position updates",
    pass: outcome.fixesDelivered > 1,
    evidence: [shot],
  });

  // The marker is the visible proof the app consumed those fixes.
  await recorder.check(
    page,
    "you_marker_visible_" + index,
    "the app's own 'you are here' marker renders from the simulated fixes (proof the real liveTracking stream, not a harness shortcut, is driving it)",
    async () => {
      const marker = page.locator(app.SEL.youMarker).first();
      const visible = await marker.isVisible().catch(() => false);
      const stale = visible
        ? ((await marker.getAttribute("class")) ?? "").includes("mk--you-stale")
        : false;
      return {
        pass: visible && !stale,
        actual: visible
          ? stale
            ? "marker present but STALE (the app judged the fix stream silent)"
            : "marker present and live"
          : "no .mk--you marker rendered",
      };
    }
  );
}

async function doDwell(
  action: Extract<PersonaAction, { kind: "dwellAtStop" }>,
  ctx: ActionContext
): Promise<void> {
  const { recorder, probe, context, run, persona } = ctx;
  const plan = probe.current();
  const stops = plan ? timedStops(plan) : [];
  if (stops.length === 0) {
    recorder.record({
      step: "dwell_at_stop",
      expected: "stand at the stop's real coordinate while the fix stream stays alive",
      actual: "no plan stops available",
      pass: false,
      skipped: true,
    });
    return;
  }
  const index = resolveIndex(action.target, stops.length);
  const stop = stops[index];
  if (!stop?.location) {
    recorder.record({
      step: "dwell_at_stop_" + index,
      expected: "the stop carries a coordinate to stand at",
      actual: "stop " + index + " has no stored location",
      pass: false,
    });
    return;
  }
  const seconds = action.seconds ?? 75;
  process.stdout.write(
    "  [" + persona.name + "] dwelling " + seconds + "s at " + (stop.name ?? "stop " + index) + "\n"
  );
  const outcome = await dwellAt(
    context,
    { lat: stop.location.latitude, lng: stop.location.longitude },
    { seconds, accuracyM: REPORTED_ACCURACY_M, run, abort: ctx.abort }
  );
  recorder.record({
    step: "dwell_at_stop_" + index,
    expected:
      "stand within the app's arrival radius of " +
      (stop.name ?? "stop " + index) +
      " for " +
      seconds +
      "s of REAL time (its dwell requirement is 45s of real time and is deliberately not compressed)",
    actual:
      "held position for " +
      Math.round(outcome.wallClockMs / 1000) +
      "s across " +
      outcome.fixesDelivered +
      " position updates",
    pass: outcome.wallClockMs >= Math.min(seconds, 45) * 1000 - 2_000,
  });
}

async function doWaitUntilActive(
  action: Extract<PersonaAction, { kind: "waitUntilStopActive" }>,
  ctx: ActionContext
): Promise<void> {
  const { page, recorder, probe, persona } = ctx;
  const plan = probe.current();
  const stops = plan ? timedStops(plan) : [];
  if (stops.length === 0) {
    recorder.record({
      step: "wait_until_stop_active",
      expected: "the target stop's window opens so arrival becomes reachable",
      actual: "no plan stops available",
      pass: false,
      skipped: true,
    });
    return;
  }
  const index = resolveIndex(action.target, stops.length);
  const stop = stops[index];
  const startMs = stop?.start_time ? new Date(stop.start_time).getTime() : NaN;
  if (!Number.isFinite(startMs)) {
    recorder.record({
      step: "wait_until_stop_active_" + index,
      expected: "the target stop has a start time to wait for",
      actual: "stop " + index + " carries no readable start time",
      pass: false,
      skipped: true,
    });
    return;
  }

  // A minute past the start, so the server is unambiguously inside the window
  // when it re-derives the status.
  const targetMs = startMs + 60_000;
  const waitMs = targetMs - Date.now();
  if (waitMs > action.maxSeconds * 1000) {
    recorder.record({
      step: "wait_until_stop_active_" + index,
      expected:
        "the target stop is underway, which is the only state in which the app marks a stop arrived",
      actual:
        (stop?.name ?? "stop " + index) +
        " does not start for another " +
        Math.round(waitMs / 60_000) +
        " min (the home leg pushes it out), beyond this run's " +
        Math.round(action.maxSeconds / 60) +
        "-minute budget, so the movement and arrival steps after this were not exercised. Raise the budget, or start from an address closer to the venues.",
      pass: false,
      skipped: true,
    });
    ctx.state.movementReachable = false;
    // Short, and pointing at the line above rather than restating it: the
    // wait's own entry carries the full explanation, and three near-identical
    // paragraphs after it would bury the deviations section.
    ctx.state.skipNote =
      "the movement chain was not reachable (see wait_until_stop_active_" +
      index +
      "); the plan's editing steps after it still ran";
    return;
  }

  if (waitMs > 0) {
    process.stdout.write(
      "  [" +
        persona.name +
        "] waiting " +
        Math.round(waitMs / 1000) +
        "s for " +
        (stop?.name ?? "stop " + index) +
        " to go active\n"
    );
    const until = Date.now() + waitMs;
    while (Date.now() < until && !ctx.abort()) await sleep(2_000);
  }

  // Statuses are derived server-side per read and this app has no periodic
  // poll, so the page keeps showing the status it was handed at creation. A
  // reload is the ordinary user action that asks again. It also resets the
  // live-tracking toggle (React state), which is exactly why this action runs
  // BEFORE `enableLiveTracking` in every persona that uses it.
  const reloadedAt = Date.now();
  await page.reload({ waitUntil: "domcontentloaded" });
  await probe.waitForReadAfter(reloadedAt, 45_000);
  await app.expandDesktopItinerary(page);

  const after = probe.current();
  const afterStop = after ? timedStops(after)[index] : undefined;
  recorder.record({
    step: "wait_until_stop_active_" + index,
    expected:
      "after its start time passes, a reload shows " +
      (stop?.name ?? "stop " + index) +
      " as the ACTIVE stop (server-derived status, no client-side ticking)",
    actual: "stop " + index + " status after reload: " + (afterStop?.status ?? "unknown"),
    pass: afterStop?.status === "active",
    evidence: [await recorder.screenshot(page, "stop-" + index + "-active")],
  });
}

async function doProbeClock(
  action: Extract<PersonaAction, { kind: "probeClock" }>,
  ctx: ActionContext
): Promise<void> {
  const { page, recorder, probe, run } = ctx;
  const plan = probe.current();
  const stops = plan ? timedStops(plan) : [];
  if (!plan || stops.length === 0) {
    recorder.record({
      step: action.step,
      expected: action.expected,
      actual: "no plan data available to probe",
      pass: false,
      skipped: true,
    });
    return;
  }
  const index = resolveIndex(action.afterStopEndOf, stops.length);
  const instant = instantAfterStopEnd(stops[index]?.end_time ?? null, action.minutesPast);
  if (!instant) {
    recorder.record({
      step: action.step,
      expected: action.expected,
      actual: "stop " + index + " carries no readable end time to probe past",
      pass: false,
      skipped: true,
    });
    return;
  }

  const startsBefore = stops.map((stop) => stop.start_time);
  const result = await readPlanAt(page, run.baseURL, plan.id, instant, probe.authHeader());
  const probed = result.plan ? timedStops(result.plan) : [];
  const startsAfter = probed.map((stop) => stop.start_time);
  const venuesKept =
    probed.length === stops.length && probed.every((stop, i) => stop.id === stops[i]?.id);
  const timesKept =
    startsAfter.length === startsBefore.length &&
    startsAfter.every((start, i) => start === startsBefore[i]);

  recorder.record({
    step: action.step,
    expected: action.expected,
    actual: result.ok
      ? "asked the server for this plan at " +
        instant +
        " (" +
        action.minutesPast +
        " min past " +
        (stops[index]?.name ?? "stop " + index) +
        "'s end, via the app's own ?now= control): plan status " +
        (result.plan?.status ?? "?") +
        "; statuses [" +
        probed.map((stop) => stop.status).join(", ") +
        "]; every venue " +
        (venuesKept ? "kept" : "CHANGED") +
        "; committed start times " +
        (timesKept ? "unchanged" : "MOVED")
      : result.detail,
    pass: result.ok && venuesKept && timesKept,
    evidence: [],
  });
}

async function doExpectArrival(
  action: Extract<PersonaAction, { kind: "expectArrival" }>,
  ctx: ActionContext
): Promise<void> {
  const { page, recorder, probe } = ctx;
  const plan = probe.current();
  const stops = plan ? timedStops(plan) : [];
  const index = resolveIndex(action.target, Math.max(1, stops.length));
  const expectArrived = action.expectArrived ?? true;

  await app.expandDesktopItinerary(page);
  const card = app.cardByIndex(page, index);
  const classes = ((await card.getAttribute("class").catch(() => null)) ?? "").trim();
  const arrived = classes.includes("lstrip__stop--arrived");
  const isActive = classes.includes("lstrip__stop--live");
  const shot = await recorder.screenshot(page, "arrival-stop-" + index);
  const storedStatus = stops[index]?.status ?? "unknown";

  // PRECONDITION, not a verdict. The app marks ONLY the currently-active stop
  // arrived, by design: `arrived` is computed as
  // `status === "active" && arrivedStopId === id`. If the target stop's window
  // has not opened (or has closed), arrival is not merely absent, it is
  // unreachable — so this is recorded as NOT EXERCISED rather than as a
  // deviation, which would be blaming the app for the scenario's own setup.
  if (!isActive) {
    recorder.record({
      step: "arrival_detection_stop_" + index,
      expected:
        "after standing at the venue's coordinate past the dwell requirement, its card carries the arrival state (a chartreuse wash on the active card)",
      actual:
        "stop " +
        index +
        " was not the ACTIVE stop at this moment (stored status: " +
        storedStatus +
        "), and the app only ever marks the active stop arrived, so arrival could not be reached. Plan a prompt whose first stop is underway (an immediacy prompt) to exercise this.",
      pass: false,
      skipped: true,
      evidence: [shot],
    });
    return;
  }

  recorder.record({
    step: "arrival_detection_stop_" + index,
    expected:
      "after standing at the ACTIVE stop's coordinate past the dwell requirement, its card carries the arrival state (a chartreuse wash on the active card)",
    actual: "card classes: " + (classes || "(none)") + "; stored stop status: " + storedStatus,
    pass: arrived === expectArrived,
    evidence: [shot],
  });
}

// ── mutations ─────────────────────────────────────────────────────────────

async function doSwap(
  action: Extract<PersonaAction, { kind: "swap" }>,
  ctx: ActionContext
): Promise<void> {
  const { page, recorder, probe } = ctx;
  const before = probe.current();
  const beforeNames = await app.stopCardNames(page).catch(() => []);
  const count = beforeNames.length || (before ? timedStops(before).length : 1);
  const index = resolveIndex(action.target, count);
  const beforeStop = before ? timedStops(before)[index] : undefined;

  let outcome: app.MutationOutcome;
  try {
    outcome = await app.swapStopByIndex(page, index, action.refinement);
  } catch (error) {
    recorder.record({
      step: "swap_stop_" + index,
      expected: "the inline swap control accepts " + JSON.stringify(action.refinement),
      actual: "could not drive the swap control: " + String(error).slice(0, 240),
      pass: false,
      evidence: [await recorder.screenshot(page, "swap-control-failed-" + index)],
    });
    return;
  }

  await probe.waitForVersionAfter(before?.version ?? 0, 20_000);
  const after = probe.current();
  const afterStop = after ? timedStops(after)[index] : undefined;
  const shot = await recorder.screenshot(page, "after-swap-" + index);

  const venueChanged =
    Boolean(beforeStop?.id) && Boolean(afterStop?.id) && beforeStop?.id !== afterStop?.id;
  const categoryChanged =
    Boolean(beforeStop?.category) &&
    Boolean(afterStop?.category) &&
    beforeStop?.category !== afterStop?.category;

  const expected =
    action.expect === "same-category"
      ? "the stop gets a DIFFERENT venue while keeping its kind and its slot"
      : action.expect === "different-category"
        ? "the stop changes KIND to what was asked for, taking the new kind's own length, with the rest of the day re-timed around it"
        : "the swap is refused with an honest reason and the plan is left untouched";

  // A REFUSAL is a legitimate engine outcome, not a malfunction: the swap
  // engine declines when nothing usable can be reached in the slot, and it
  // says why. The scenario still did not happen, so it is reported, but the
  // wording has to separate "the app refused, with this reason" from "the app
  // silently did nothing" — those need very different follow-up.
  const refusedWithReason = !venueChanged && Boolean(outcome.banner ?? outcome.inlineError);
  const actual =
    "HTTP " +
    outcome.status +
    "; venue " +
    (beforeStop?.name ?? "?") +
    " -> " +
    (afterStop?.name ?? "?") +
    "; category " +
    (beforeStop?.category ?? "?") +
    " -> " +
    (afterStop?.category ?? "?") +
    (refusedWithReason
      ? "; the engine REFUSED and said why: " + (outcome.banner ?? outcome.inlineError)
      : "; banner: " + (outcome.banner ?? "none")) +
    (outcome.inlineError && refusedWithReason ? "" : outcome.inlineError ? "; inline error: " + outcome.inlineError : "");

  const pass =
    action.expect === "same-category"
      ? venueChanged && !categoryChanged
      : action.expect === "different-category"
        ? categoryChanged
        : outcome.status !== null && !venueChanged;

  recorder.record({
    step: "swap_stop_" + index + "_" + action.expect,
    expected,
    actual,
    pass,
    evidence: [shot],
  });
}

async function doRemove(
  action: Extract<PersonaAction, { kind: "remove" }>,
  ctx: ActionContext
): Promise<void> {
  const { page, recorder, probe } = ctx;
  const before = probe.current();
  const beforeNames = await app.stopCardNames(page).catch(() => []);
  const count = beforeNames.length || (before ? timedStops(before).length : 1);
  const index = resolveIndex(action.target, count);
  const beforeStops = before ? timedStops(before) : [];
  const doomed = beforeStops[index];

  let outcome: app.MutationOutcome;
  try {
    outcome = await app.removeStopByIndex(page, index);
  } catch (error) {
    recorder.record({
      step: "remove_stop_" + index,
      expected: "the arm-then-confirm remove control removes stop " + index,
      actual: "could not drive the remove control: " + String(error).slice(0, 240),
      pass: false,
      evidence: [await recorder.screenshot(page, "remove-control-failed-" + index)],
    });
    return;
  }

  await probe.waitForVersionAfter(before?.version ?? 0, 20_000);
  const after = probe.current();
  const afterStops = after ? timedStops(after) : [];
  const shot = await recorder.screenshot(page, "after-remove-" + index);

  const gone = !afterStops.some((stop) => stop.id && stop.id === doomed?.id);
  const survivorsKeptVenues = afterStops.every((stop) =>
    beforeStops.some((original) => original.id === stop.id)
  );
  const refused = beforeStops.length === afterStops.length;

  // THE DOWN-TO-ZERO GUARD. `removeStop.ts` refuses BEFORE the splice when
  // no stop with a venue would survive, and points at End instead, because an
  // empty `stops` array reads as a FINISHED outing: `[].every(...)` is
  // vacuously true, so the plan would report `completed`, clear the owner's
  // resume pointer and file a blank record in history, none of it looking
  // like an error. A persona asking for this expects the plan to SURVIVE.
  if (action.expect === "refused") {
    const saidWhy = (outcome.banner ?? outcome.inlineError ?? "").toLowerCase();
    const pointsAtEnd = saidWhy.includes("end");
    recorder.record({
      step: "remove_last_stop_is_refused",
      expected:
        "removing the ONLY remaining stop is refused and the plan survives intact, with the refusal pointing at the End control (LAST_STOP_MESSAGE). Deleting your way to zero would make the plan report itself completed, clear the resume pointer and archive a blank record, and none of that would look like an error.",
      actual:
        "HTTP " +
        outcome.status +
        "; " +
        beforeStops.length +
        " stop(s) before, " +
        afterStops.length +
        " after; the plan " +
        (refused ? "SURVIVED" : "was emptied") +
        "; remaining: [" +
        afterStops.map((stop) => stop.name ?? "?").join(" | ") +
        "]; the app said: " +
        JSON.stringify(outcome.banner ?? outcome.inlineError ?? "nothing") +
        (pointsAtEnd ? "" : " (which does not mention End)"),
      pass: refused && afterStops.length === beforeStops.length && afterStops.length > 0,
      evidence: [shot],
    });
    return;
  }

  recorder.record({
    step: "remove_stop_" + index + "_" + String(action.target),
    expected:
      "removing " +
      (doomed?.name ?? "stop " + index) +
      " (" +
      String(action.target) +
      ") splices it out and closes the gap, WITHOUT swapping any surviving stop's venue",
    actual:
      "HTTP " +
      outcome.status +
      "; " +
      beforeStops.length +
      " stops -> " +
      afterStops.length +
      (refused ? " (refused)" : "") +
      "; remaining: " +
      afterStops.map((stop) => stop.name ?? "?").join(" | ") +
      "; banner: " +
      (outcome.banner ?? "none"),
    pass: gone && survivorsKeptVenues && !refused,
    evidence: [shot],
  });

  if (!survivorsKeptVenues) {
    recorder.record({
      step: "remove_kept_every_other_venue_" + index,
      expected:
        "removing one stop must never change another stop's VENUE, only its time (the load-bearing rule of the remove engine)",
      actual:
        "a surviving stop's venue changed: before [" +
        beforeStops.map((s) => s.name ?? "?").join(", ") +
        "], after [" +
        afterStops.map((s) => s.name ?? "?").join(", ") +
        "]",
      pass: false,
      evidence: [shot],
    });
  }
}

async function doModeSwitch(
  action: Extract<PersonaAction, { kind: "modeSwitch" }>,
  ctx: ActionContext
): Promise<void> {
  const { page, recorder, probe } = ctx;
  const before = probe.current();
  const beforeStops = before ? timedStops(before) : [];
  const beforeStarts = beforeStops.map((stop) => stop.start_time);

  let outcome: app.MutationOutcome;
  try {
    outcome = await app.switchMode(page, action.to);
  } catch (error) {
    recorder.record({
      step: "mode_switch_to_" + action.to,
      expected: "the topbar travel-mode control switches the live plan to " + action.to,
      actual: "could not drive the mode control: " + String(error).slice(0, 240),
      pass: false,
      evidence: [await recorder.screenshot(page, "mode-control-failed")],
    });
    return;
  }

  await probe.waitForVersionAfter(before?.version ?? 0, 25_000);
  const after = probe.current();
  const afterStops = after ? timedStops(after) : [];
  const shot = await recorder.screenshot(page, "after-mode-" + action.to);

  const sameVenues =
    beforeStops.length === afterStops.length &&
    beforeStops.every((stop, i) => stop.id === afterStops[i]?.id);
  const timesMoved = afterStops.some((stop, i) => stop.start_time !== beforeStarts[i]);
  const storedMode = after?.travelMode ?? "transit";

  recorder.record({
    step: "mode_switch_to_" + action.to,
    expected:
      "switching to " +
      action.to +
      " keeps EVERY venue and re-prices the times ahead of the floor (absent travelMode means transit)",
    actual:
      "HTTP " +
      outcome.status +
      "; stored travelMode is now " +
      storedMode +
      "; venues " +
      (sameVenues ? "unchanged" : "CHANGED") +
      "; times " +
      (timesMoved ? "re-priced" : "unchanged") +
      "; banner: " +
      (outcome.banner ?? "none"),
    pass: sameVenues && storedMode === action.to,
    evidence: [shot],
  });

  if (!sameVenues) {
    recorder.record({
      step: "mode_switch_never_changes_a_venue",
      expected:
        "a mode switch changes every stop's TIME and never any stop's VENUE (the whole point of the guard that refuses a replacement rather than substituting)",
      actual:
        "before [" +
        beforeStops.map((s) => s.name ?? "?").join(", ") +
        "], after [" +
        afterStops.map((s) => s.name ?? "?").join(", ") +
        "]",
      pass: false,
      evidence: [shot],
    });
  }
}

// ── transit specifics ─────────────────────────────────────────────────────

async function doTransitLegShots(ctx: ActionContext): Promise<void> {
  const { page, recorder, probe } = ctx;
  await app.expandDesktopItinerary(page);
  const plan = probe.current();
  const transitLegs = plan
    ? [plan.homeLeg, ...plan.legs].filter(
        (leg): leg is NonNullable<typeof leg> => Boolean(leg) && leg!.mode === "transit"
      )
    : [];

  const legButtons = page.locator(app.SEL.legSelect);
  const buttonCount = await legButtons.count().catch(() => 0);
  const evidence: string[] = [];

  for (let i = 0; i < buttonCount; i++) {
    if (ctx.abort()) break;
    await legButtons.nth(i).click().catch(() => undefined);
    await page.waitForTimeout(900);
    evidence.push(await recorder.screenshot(page, "transit-leg-" + i));
  }

  const timelineCount = await page.locator(app.SEL.timeline).count().catch(() => 0);
  const badgeCount = await page.locator(app.SEL.routeBadge).count().catch(() => 0);

  recorder.record({
    step: "transit_leg_rendering",
    expected:
      "each transit leg is selectable and renders its own ride identity: a coloured route line on the map, a route badge, and the provider's board/alight times when they are fresh enough to show",
    actual:
      transitLegs.length +
      " stored transit leg(s); " +
      buttonCount +
      " selectable leg control(s) in the itinerary; " +
      timelineCount +
      " board/alight timeline(s) open; " +
      badgeCount +
      " route badge cell(s) rendered",
    pass: transitLegs.length === 0 || buttonCount > 0,
    evidence,
  });

  if (transitLegs.length === 0) {
    recorder.record({
      step: "transit_legs_present",
      expected:
        "a cross-town plan on a transit day contains at least one real transit leg (a short hop legitimately relabels to walk, so this is context, not necessarily a fault)",
      actual:
        "no leg came back with mode 'transit'; leg modes were [" +
        (plan ? [plan.homeLeg, ...plan.legs].filter(Boolean).map((l) => l!.mode).join(", ") : "") +
        "]",
      pass: false,
      skipped: true,
    });
  }
}

// ── clock, ending, history ────────────────────────────────────────────────

async function doAdvanceClock(
  action: Extract<PersonaAction, { kind: "advanceClockPastPlanEnd" }>,
  ctx: ActionContext
): Promise<void> {
  const { page, recorder, probe, run } = ctx;
  const plan = probe.current();
  if (!plan) {
    recorder.record({
      step: "natural_completion",
      expected: action.why,
      actual: "no plan data available to compute an end instant from",
      pass: false,
      skipped: true,
    });
    return;
  }
  const authorization = probe.authHeader();
  const instant = instantAfterPlanEnd(plan);
  const result = await readPlanAt(page, run.baseURL, plan.id, instant, authorization);

  recorder.record({
    step: "natural_completion",
    expected:
      "with every stop's window past, the plan concludes on its own — no End action — and the server records it as completed (" +
      action.why +
      ")",
    actual:
      "asked the server for this plan at the simulated instant " +
      instant +
      " (the app's own documented ?now= time control, carrying the persona's real Authorization header): " +
      result.detail,
    pass: result.ok && result.plan?.status === "completed",
    evidence: [],
  });
  // A concluded plan is no longer resumable, so nothing after this can edit it.
  ctx.state.planLive = false;
}

async function doEnd(
  action: Extract<PersonaAction, { kind: "end" }>,
  ctx: ActionContext
): Promise<void> {
  const { page, recorder, probe } = ctx;
  const planId = probe.current()?.id ?? null;
  const names = await app.stopCardNames(page).catch(() => []);
  const before = await recorder.screenshot(page, "before-end");

  const outcome = await app.endPlan(page, action.choice);
  // Whether it succeeded or not, the plan is no longer reliably on screen.
  ctx.state.planLive = false;
  await page.waitForTimeout(2_500);
  const after = await recorder.screenshot(page, "after-end");
  const backOnLanding = await page
    .locator(app.SEL.promptInput)
    .isVisible()
    .catch(() => false);

  recorder.record({
    step: "end_plan_" + action.choice,
    expected:
      "the End control opens its confirmation and " +
      (action.choice === "save-end" ? "'Save & end'" : "the discard option") +
      " concludes the plan, returning to the landing page",
    actual:
      (outcome.opened ? "dialog opened; clicked " + (outcome.clicked ?? "nothing") : "the End control was not available") +
      "; back on landing: " +
      backOnLanding +
      "; plan was " +
      (planId ?? "unknown") +
      " with stops [" +
      names.join(" | ") +
      "]",
    pass: outcome.opened && outcome.clicked !== null && backOnLanding,
    evidence: [before, after],
  });
}

async function doCheckHistory(
  action: Extract<PersonaAction, { kind: "checkHistory" }>,
  ctx: ActionContext
): Promise<void> {
  const { page, recorder, probe, persona } = ctx;
  const plan = probe.current();
  const names = plan
    ? timedStops(plan)
        .map((stop) => stop.name)
        .filter((name): name is string => Boolean(name))
    : [];

  if (!(await page.locator(app.SEL.promptInput).isVisible().catch(() => false))) {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3_000);
  }
  const opened = await app.openHistory(page);
  await page.waitForTimeout(1_500);
  const text = await app.historyText(page);
  const shot = await recorder.screenshot(page, "history-" + action.expect);

  if (!opened) {
    recorder.record({
      step: "history_" + action.expect,
      expected:
        "the history panel opens so the archive can be inspected (" + action.expect + ")",
      actual: "the history panel did not open",
      pass: false,
      evidence: [shot],
    });
    return;
  }

  const present = names.length > 0 && names.some((name) => text.includes(name));
  const wantPresent = action.expect === "contains-current";

  recorder.record({
    step: "history_" + action.expect,
    expected:
      wantPresent
        ? "the plan that just concluded on its own appears in history (a naturally-completed plan is archived)"
        : "the plan that was explicitly DISCARD-ended does NOT appear in history (the discard veto)",
    actual:
      "looked for [" +
      names.join(" | ") +
      "] in the history panel; " +
      (present ? "found" : "not found") +
      ". Panel text starts: " +
      JSON.stringify(text.slice(0, 220)),
    pass: present === wantPresent,
    evidence: [shot],
  });

  // Close it again so a following action starts from a clean landing page.
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForTimeout(500);
  void persona;
}

// -- adversarial, geography and session additions ------------------------

/**
 * "The app is still an app."
 *
 * The shared check behind every adversarial persona. A REFUSAL is not what
 * this looks for: the app's fail-loud surface writes whole sentences and
 * none of them match a raw-error signature. What it looks for is the app
 * BREAKING rather than answering: a framework crash page, an unhandled
 * runtime error, a value that escaped its formatter, a JavaScript dialog
 * that actually ran (the injection persona's real finding), or a page error
 * the recorder caught.
 *
 * The plan's own shape is recorded beside the verdict, times included, so a
 * reader can eyeball what a hostile prompt actually produced without the
 * check having to assert on a venue.
 */
async function doExpectGraceful(
  action: Extract<PersonaAction, { kind: "expectGraceful" }>,
  ctx: ActionContext
): Promise<void> {
  const { page, recorder, probe } = ctx;
  const raw = await app.findRawError(page);
  const dialogs = [...recorder.dialogs];
  const pageErrors = recorder.consoleErrors.filter((line) => line.startsWith("[pageerror]"));
  const banner = await app.readBanner(page).catch(() => null);
  const plan = probe.current();
  const stops = plan ? timedStops(plan) : [];
  const shape =
    stops.length === 0
      ? "no timed stops"
      : stops
          .map(
            (stop) =>
              (stop.name ?? "?") +
              " [" +
              (stop.category ?? "?") +
              "] " +
              (stop.start_time ?? "?") +
              " to " +
              (stop.end_time ?? "?")
          )
          .join(" | ");
  const errorText = await page
    .locator(app.SEL.landingError + ", " + app.SEL.stageError)
    .first()
    .innerText()
    .catch(() => null);

  const ok = !raw.found && dialogs.length === 0 && pageErrors.length === 0;
  recorder.record({
    step: action.step,
    expected: action.expected,
    actual:
      (ok
        ? "handled gracefully: no raw error text, no JavaScript dialog, no unhandled page error"
        : "RAW FAILURE" +
          (raw.found ? ", on-screen text: " + JSON.stringify(raw.sample) : "") +
          (dialogs.length > 0 ? ", dialog(s) fired: " + dialogs.join("; ") : "") +
          (pageErrors.length > 0 ? ", page error(s): " + pageErrors.join("; ") : "")) +
      ". The app said: " +
      JSON.stringify((errorText ?? banner ?? "nothing").slice(0, 300)) +
      ". Plan shape: " +
      shape +
      ".",
    pass: ok,
    evidence: [await recorder.screenshot(page, action.step)],
  });
}

/**
 * The documented short-hop relabel, checked against real provider distances.
 *
 * `buildDrivingLeg` relabels a drive under `DRIVING_SHORT_LEG_WALK_METERS`
 * (700 m) to WALK, so a stored leg that is still `mode: "driving"` under that
 * distance means the relabel did not happen. There IS one documented reason
 * for that (a short drive whose WALK route failed to price stays a drive),
 * and the harness cannot see which happened, so that caveat travels with the
 * finding instead of being silently allowed.
 *
 * The number is transcribed from `app/api/schedule/travel.ts` rather than
 * imported: this directory must never become a dependency of `app/`.
 */
const DRIVING_SHORT_LEG_WALK_METERS = 700;

async function doShortDriveLegs(ctx: ActionContext): Promise<void> {
  const { page, recorder, probe } = ctx;
  const plan = probe.current();
  if (!plan) {
    recorder.record({
      step: "short_drive_legs_relabel_to_walk",
      expected: "a driving plan's short hops are relabelled to WALK",
      actual: "no plan data available to read leg distances from",
      pass: false,
      skipped: true,
    });
    return;
  }
  const legs = [plan.homeLeg, ...plan.legs].filter(
    (leg): leg is NonNullable<typeof leg> => Boolean(leg)
  );
  const described = legs
    .map(
      (leg) =>
        leg.mode +
        " " +
        (leg.distanceMeters === null ? "?" : Math.round(leg.distanceMeters) + " m")
    )
    .join(", ");
  const shortDrives = legs.filter(
    (leg) =>
      leg.mode === "driving" &&
      leg.distanceMeters !== null &&
      leg.distanceMeters < DRIVING_SHORT_LEG_WALK_METERS
  );
  const shortWalks = legs.filter(
    (leg) =>
      leg.mode === "walk" &&
      leg.distanceMeters !== null &&
      leg.distanceMeters < DRIVING_SHORT_LEG_WALK_METERS
  );

  recorder.record({
    step: "short_drive_legs_relabel_to_walk",
    expected:
      "on a DRIVING plan, no leg comes back mode 'driving' under " +
      DRIVING_SHORT_LEG_WALK_METERS +
      " m: buildDrivingLeg relabels a short hop to WALK. The one documented exception is a short drive whose WALK route did not price, which stays a drive.",
    actual:
      "stored travelMode is " +
      (plan.travelMode ?? "transit (absent)") +
      "; legs were [" +
      described +
      "]; " +
      shortWalks.length +
      " short hop(s) relabelled to walk; " +
      shortDrives.length +
      " leg(s) still driving under the threshold",
    pass: shortDrives.length === 0,
    evidence: [await recorder.screenshot(page, "short-drive-legs")],
  });

  if (shortWalks.length === 0 && shortDrives.length === 0) {
    recorder.record({
      step: "short_hop_present",
      expected:
        "at least one hop under " +
        DRIVING_SHORT_LEG_WALK_METERS +
        " m, so the relabel rule is actually exercised",
      actual:
        "every leg this plan produced is longer than the threshold, so the relabel had nothing to act on: " +
        described,
      pass: false,
      skipped: true,
    });
  }
}

/**
 * End a SECOND time.
 *
 * The UI half first: after a successful end the topbar goes with the plan,
 * so there is no control left to press, and that IS the app's answer to a
 * double-submit. Reaching the server's own idempotency then needs the app's
 * own POST re-issued with the app's own captured Authorization header, the
 * same seam `probeClock` uses. The end route returns `changed: false` for a
 * plan that already carries `endedAt` and guards its archive with
 * `hasBeenArchived`, so a graceful answer with no second history document is
 * the expectation.
 */
async function doEndAgain(ctx: ActionContext): Promise<void> {
  const { page, recorder, probe, run } = ctx;
  const planId = probe.seenPlanIds[probe.seenPlanIds.length - 1] ?? null;

  await recorder.check(
    page,
    "end_control_gone_after_ending",
    "once a plan has ended the End control is no longer on screen, so the UI itself cannot submit a second end",
    async () => {
      const visible = await page
        .locator(app.SEL.endButton)
        .first()
        .isVisible()
        .catch(() => false);
      const onLanding = await page
        .locator(app.SEL.promptInput)
        .isVisible()
        .catch(() => false);
      return {
        pass: !visible,
        actual: "End control visible: " + visible + "; back on the landing page: " + onLanding,
      };
    }
  );

  if (!planId) {
    recorder.record({
      step: "double_end_is_idempotent",
      expected: "a second end request neither errors nor writes a second history document",
      actual: "no plan id was observed, so the second request could not be addressed",
      pass: false,
      skipped: true,
    });
    return;
  }

  const authorization = probe.authHeader();
  let status: number | null = null;
  let body: unknown = null;
  try {
    const response = await page.request.post(
      run.baseURL + "/api/itinerary/" + planId + "/end",
      {
        headers: {
          "Content-Type": "application/json",
          ...(authorization ? { Authorization: authorization } : {}),
        },
        data: { choice: "discard-end" },
        timeout: 45_000,
      }
    );
    status = response.status();
    body = await response.json().catch(() => null);
  } catch (error) {
    status = null;
    body = String(error).slice(0, 200);
  }

  const archived =
    typeof body === "object" && body !== null && "archived" in body
      ? (body as { archived?: unknown }).archived === true
      : null;
  // A 404 is the app's own indistinguishable answer for "not yours / not
  // there" and is a perfectly graceful second end; a 2xx is the idempotent
  // path. What must not happen is a 5xx, or an archive on the second pass.
  const graceful = status !== null && status < 500;

  recorder.record({
    step: "double_end_is_idempotent",
    expected:
      "re-issuing the app's OWN end request for an already-ended plan (same Authorization header the app sent) is handled gracefully and archives nothing a second time: the route returns changed:false for a plan that already carries endedAt, and its archive is guarded by hasBeenArchived",
    actual:
      "second POST /api/itinerary/" +
      planId +
      "/end answered HTTP " +
      String(status) +
      "; body " +
      JSON.stringify(body).slice(0, 200) +
      "; archived-on-this-pass: " +
      String(archived),
    pass: graceful && archived !== true,
    evidence: [],
  });
}

/**
 * Reload while a swap POST is still in flight.
 *
 * The browser's request dies with the document; the server finishes and
 * commits through CAS regardless, so BOTH outcomes are legitimate: the swap
 * landed, or it did not. What must not happen is a plan that will not come
 * back, a half-applied stop list, or a stuck busy state.
 */
async function doReloadDuringSwap(
  action: Extract<PersonaAction, { kind: "reloadDuringSwap" }>,
  ctx: ActionContext
): Promise<void> {
  const { page, recorder, probe } = ctx;
  const before = probe.current();
  const beforeStops = before ? timedStops(before) : [];
  const index = resolveIndex(action.target, Math.max(1, beforeStops.length));

  try {
    await app.selectStopByIndex(page, index);
    const card = app.cardByIndex(page, index);
    const input = card.locator(app.SEL.swapInput);
    await input.waitFor({ state: "visible", timeout: 20_000 });
    await input.fill(action.refinement);
    // Fire and DO NOT await: the reload below is the point.
    void card
      .locator(app.SEL.swapGo)
      .click()
      .catch(() => undefined);
  } catch (error) {
    recorder.record({
      step: "reload_during_swap",
      expected: "a swap is submitted and the page is reloaded before its response returns",
      actual: "could not submit the swap: " + String(error).slice(0, 240),
      pass: false,
      evidence: [await recorder.screenshot(page, "reload-during-swap-setup-failed")],
    });
    return;
  }

  // Long enough that the POST is genuinely on the wire, short enough that it
  // cannot have come back: a real swap runs a model call plus Places and
  // Routes and takes seconds, never milliseconds.
  await sleep(1_200);
  const reloadedAt = Date.now();
  await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
  await probe.waitForReadAfter(reloadedAt, 60_000);
  await app.expandDesktopItinerary(page).catch(() => undefined);

  const after = probe.current();
  const afterStops = after ? timedStops(after) : [];
  const raw = await app.findRawError(page);
  const samePlan = Boolean(before && after && before.id === after.id);
  const coherent =
    afterStops.length > 0 &&
    afterStops.every((stop) => Boolean(stop.id) && Boolean(stop.start_time));
  const swapLanded = Boolean(after && before && after.version > before.version);

  recorder.record({
    step: "reload_during_swap",
    expected:
      "reloading mid-swap recovers to a consistent state: the same plan comes back, every stop still has a venue and a time, and nothing is left half-applied. Whether the swap LANDED is not the question, since the server commits through CAS independently of the browser; only that the plan is coherent either way.",
    actual:
      (samePlan
        ? "same plan " + after?.id
        : "plan " + (before?.id ?? "?") + " became " + (after?.id ?? "none")) +
      "; version " +
      (before?.version ?? "?") +
      " to " +
      (after?.version ?? "?") +
      " (the swap " +
      (swapLanded ? "landed server-side" : "had not landed by the time the reload read") +
      "); " +
      beforeStops.length +
      " stops to " +
      afterStops.length +
      " [" +
      afterStops.map((stop) => stop.name ?? "?").join(" | ") +
      "]" +
      (raw.found ? "; RAW ERROR on screen: " + JSON.stringify(raw.sample) : ""),
    pass: samePlan && coherent && !raw.found,
    evidence: [await recorder.screenshot(page, "after-reload-during-swap")],
  });
}

/**
 * The starting-location dropdown's one row, with the permission refused.
 *
 * The documented contract on every failure path is that the field stays
 * fully usable for typing and the row NAMES the way out. The exact note
 * depends on how the browser refuses (denied outright, or the module's own
 * 15 s timeout), so both are accepted; what is checked is that a note
 * appeared, that it points at typing an address, and that the field is still
 * editable and was NOT filled with a guessed location.
 */
async function doUseCurrentLocation(
  action: Extract<PersonaAction, { kind: "useCurrentLocation" }>,
  ctx: ActionContext
): Promise<void> {
  const { page, recorder } = ctx;
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page
    .locator(app.SEL.promptInput)
    .waitFor({ state: "visible", timeout: 30_000 })
    .catch(() => undefined);

  const outcome = await app.useCurrentLocationRow(page);
  const shot = await recorder.screenshot(page, "use-current-location-" + action.expect);

  if (!outcome.used) {
    recorder.record({
      step: "use_current_location_" + action.expect,
      expected: "the starting location field offers its 'Use current location' row",
      actual: "the dropdown did not present a row to press",
      pass: false,
      evidence: [shot],
    });
    return;
  }

  if (action.expect === "denied") {
    const note = outcome.note ?? "";
    const namesAWayOut = /type a starting address/i.test(note);
    recorder.record({
      step: "use_current_location_denied",
      expected:
        "with location permission refused, the row explains itself and names typing an address as the way out, the field stays editable, and nothing is guessed into it",
      actual:
        "note: " +
        JSON.stringify(note || "(none)") +
        "; field now holds " +
        JSON.stringify(outcome.fieldValue) +
        "; field editable: " +
        outcome.fieldEditable,
      pass: note.length > 0 && namesAWayOut && outcome.fieldEditable,
      evidence: [shot],
    });
    // The point of the refusal is that the field still works. Prove it.
    await recorder.check(
      page,
      "typing_still_works_after_refusal",
      "after a refused location read the field accepts a typed address exactly as it always did (the manual path is untouched by this feature)",
      async () => {
        const field = page.locator(app.SEL.startInput);
        await field.fill("80 Ossington Ave, Toronto");
        await page.keyboard.press("Escape");
        const value = await field.inputValue().catch(() => "");
        return {
          pass: value.includes("Ossington"),
          actual: "field holds " + JSON.stringify(value) + " after typing",
        };
      }
    );
    return;
  }

  recorder.record({
    step: "use_current_location_filled",
    expected: "the row reads the device once and fills the field with a name for that point",
    actual:
      "field now holds " +
      JSON.stringify(outcome.fieldValue) +
      "; note: " +
      JSON.stringify(outcome.note ?? "(none)"),
    pass: outcome.fieldValue.trim().length > 0,
    evidence: [shot],
  });
}

/**
 * Live tracking with the permission refused.
 *
 * `computeYouMarker` returns null for `status: "denied"`, so the honest
 * outcome is NO you-marker at all, never a stale-looking or invented one,
 * plus the app's own `LIVE_TRACKING_DENIED_NOTE` in the shared banner.
 */
async function doLiveTrackingDenied(ctx: ActionContext): Promise<void> {
  const { page, recorder } = ctx;
  const pressed = await app.enableLiveTracking(page).catch(() => false);
  // The refusal travels through the module's status machine and the page's
  // own effect before the banner appears.
  await page.waitForTimeout(6_000);

  const markerCount = await page.locator(app.SEL.youMarker).count().catch(() => 0);
  const banner = await app.readBanner(page).catch(() => null);
  const shot = await recorder.screenshot(page, "live-tracking-denied");

  recorder.record({
    step: "live_tracking_denied_shows_no_marker",
    expected:
      "with location permission refused, the map shows NO 'you are here' marker at all, not a stale one and not a guessed one, because computeYouMarker returns null without a real fix",
    actual:
      "the live control " +
      (pressed ? "turned on" : "did not report itself on") +
      "; " +
      markerCount +
      " .mk--you marker(s) rendered",
    pass: markerCount === 0,
    evidence: [shot],
  });

  const saysWhy = /location permission is off/i.test(banner ?? "");
  recorder.record({
    step: "live_tracking_denied_says_why",
    expected:
      "the app says why in its own words (LIVE_TRACKING_DENIED_NOTE: 'Location permission is off. Turn it on in your browser settings to see yourself on the map.') rather than failing silently or blaming the user",
    actual: "banner: " + JSON.stringify(banner ?? "none"),
    pass: saysWhy,
    evidence: [shot],
  });
}

/**
 * The structural half of "a guest signs in mid-session".
 *
 * `page.tsx` mounts the account corner (the sign-in entry point, the History
 * pill and the account menu) inside `if (!itinerary)`. So while a plan is on
 * screen there is NO sign-in control to press, by construction and by design
 * (the same reasoning that makes the preferences editor landing-only). The
 * OAuth half cannot be automated at all, and is reported as not exercised
 * rather than guessed at.
 */
async function doNoSignInWhilePlanning(ctx: ActionContext): Promise<void> {
  const { page, recorder } = ctx;
  const visible = await app.signInAffordanceVisible(page);
  const shot = await recorder.screenshot(page, "sign-in-affordance-during-plan");

  recorder.record({
    step: "no_sign_in_control_while_a_plan_is_live",
    expected:
      "the sign-in entry point is landing-only: page.tsx mounts the account corner inside `if (!itinerary)`, so a plan on screen has no sign-in control to press. Signing in mid-plan is unreachable by construction, not merely hidden.",
    actual: visible
      ? "a .acct__signin control WAS visible over a live plan"
      : "no sign-in control is present while the plan is showing",
    pass: !visible,
    evidence: [shot],
  });

  recorder.record({
    step: "guest_upgrades_to_an_account_mid_session",
    expected:
      "a guest who signs in keeps the plan they were in the middle of. In code: signIn() calls linkWithPopup for an anonymous user precisely because linking KEEPS the uid, so an in-progress plan stays owned; a RETURNING account instead hits auth/credential-already-in-use and falls to signInWithCredential, which mints a different uid and deliberately leaves the guest's plan with the guest.",
    actual:
      "NOT EXERCISED, for two independent reasons, both structural rather than incidental. (1) The only sign-in is Google's OAuth popup, which cannot be automated, the same wall that makes `npm run test:agents:login` a manual interactive step. (2) The control is landing-only, as the check above proves, so there is no in-app path from a live plan to a sign-in at all. Verifying the uid-preserving upgrade needs a person at a real browser: sign in from the landing page as a brand-new account, then confirm the plan created as a guest still resumes.",
    pass: false,
    skipped: true,
    evidence: [shot],
  });
}

/**
 * Open the SAME session in a second browser context.
 *
 * Resume is `GET /api/itinerary`, keyed on the VERIFIED caller's uid, so a
 * second context carrying the same Firebase session must find the same plan.
 * `indexedDB: true` is load-bearing when copying that state: Firebase Auth
 * keeps its session there and not in cookies.
 */
async function doResumeInSecondContext(ctx: ActionContext): Promise<void> {
  const { page, recorder, probe, context, browser, run } = ctx;
  const expected = probe.current();
  if (!expected) {
    recorder.record({
      step: "resume_in_second_context",
      expected: "the same session opened elsewhere resumes the same plan",
      actual: "no plan was observed to resume",
      pass: false,
      skipped: true,
    });
    return;
  }

  let second: BrowserContext | null = null;
  try {
    const state = await context.storageState({ indexedDB: true });
    second = await browser.newContext({
      baseURL: run.baseURL,
      viewport: { width: 1440, height: 900 },
      permissions: ["geolocation"],
      geolocation: {
        latitude: 43.6511,
        longitude: -79.3839,
        accuracy: REPORTED_ACCURACY_M,
      },
      locale: "en-CA",
      timezoneId: "America/Toronto",
      storageState: state,
    });
    const secondPage = await second.newPage();
    const secondProbe = new ItineraryProbe();
    secondProbe.attach(secondPage);
    const openedAt = Date.now();
    await secondPage.goto("/", { waitUntil: "domcontentloaded" });
    await secondProbe.waitForReadAfter(openedAt, 45_000);
    await app.expandDesktopItinerary(secondPage).catch(() => undefined);

    const resumed = secondProbe.current();
    const names = await app.stopCardNames(secondPage).catch(() => []);
    const shot = await recorder.screenshot(secondPage, "second-context-resume");

    recorder.record({
      step: "resume_in_second_context",
      expected:
        "the same session opened in a second browser context resumes the SAME plan: GET /api/itinerary is keyed on the verified caller's uid, and a guest's anonymous Firebase session is part of the state being copied",
      actual:
        "expected plan " +
        expected.id +
        "; the second context resumed " +
        (resumed ? resumed.id + " at version " + resumed.version : "nothing") +
        "; stops on screen: " +
        (names.length > 0 ? names.join(" | ") : "none"),
      pass: Boolean(resumed && resumed.id === expected.id),
      evidence: [shot],
    });
  } catch (error) {
    recorder.record({
      step: "resume_in_second_context",
      expected: "the same session opened elsewhere resumes the same plan",
      actual: "could not open a second context: " + stripAnsi(String(error)).slice(0, 240),
      pass: false,
      evidence: [await recorder.screenshot(page, "second-context-failed")],
    });
  } finally {
    if (second) await second.close().catch(() => undefined);
  }
}

// ── plumbing ──────────────────────────────────────────────────────────────

/** Playwright's call log is ANSI-coloured; the report is markdown. */
const ANSI = /\u001B\[[0-9;]*m/g;

function stripAnsi(value: string): string {
  return value.replace(ANSI, "");
}

async function readAuthState(): Promise<string | undefined> {
  try {
    await fs.access(AUTH_STATE_PATH);
    return AUTH_STATE_PATH;
  } catch {
    return undefined;
  }
}

function finish(
  persona: Persona,
  recorder: Recorder,
  probe: ItineraryProbe,
  startedAt: Date,
  timedOut: boolean,
  harnessError: string | undefined
): PersonaResult {
  return {
    persona: persona.name,
    intent: persona.intent,
    signedIn: persona.signedIn,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    checks: recorder.checks,
    harnessError,
    timedOut,
    consoleErrors: recorder.consoleErrors,
    networkErrors: recorder.networkErrors,
    planIds: probe.seenPlanIds,
  };
}
