"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildSchedule,
  checkWindowFit,
  ScheduledStop,
  WINDOW_UNDERFILL_LOG_MINUTES,
} from "./api/schedule/schedule";
import { TravelLeg } from "./api/schedule/travel";
import { HOME, splitHomeLeg } from "./api/schedule/home";
import { Itinerary } from "./api/itinerary/store";
import { formatStopTime } from "./lib/timeLabels";
import {
  contradictionReason,
  degeneratePromptReason,
  emptyCategoryReason,
  emptyParseReason,
  noVenuesReason,
  orderByRequest,
  partialEmptySelections,
  narrowedSlotReason,
  closedOnArrivalReason,
  unmetConstraintReason,
  weatherBlockedReason,
  widenOfferLabel,
  windowOverrunMessage,
  windowTooTightReason,
} from "./lib/planGuards";
import {
  planStartInstant,
  type PlanIntent,
  type PlannerAnswer,
  type PlannerQuestion,
} from "./api/parse/planner";
import type { Selection } from "./api/select/selectVenues";
import type { DropEntry, ParsedPrompt } from "./api/places/search/filter";
import type { GeocodeCandidate } from "./api/geocode/geocode";
import { isOpenAtInstant, type CurrentOpeningHours } from "./api/places/search/hours";
import { ClientFetchError, fetchJson } from "./lib/clientFetch";
import {
  parseCreatePayload,
  parseGeocodePayload,
  parseItineraryPayload,
  parsePlacesPayload,
  parsePlanPayload,
  parseReroutePayload,
  parseSelectionsPayload,
  parseSwapPayload,
  parseTravelPayload,
  parseWeatherPayload,
} from "./lib/clientPayloads";
import {
  arrivalForRow,
  mergeFinalArrivals,
  mergePlacePools,
  provisionalArrivals,
  usedIdsOutsideRow,
} from "./lib/recoverySlots";
import { shouldShowDevControls } from "./lib/devControls";
import { useAuth } from "./lib/useAuth";
import { userInitials, userLabel } from "./lib/authUser";
import LoginScreen from "./LoginScreen";
import ItineraryMap, { MapHome, MapStop } from "./ItineraryMap";
import ItineraryStrip, {
  StripFocusRequest,
  StripHome,
  StripStop,
} from "./ItineraryStrip";

const SHOW_DEV_CONTROLS = shouldShowDevControls(
  process.env.NODE_ENV,
  process.env.NEXT_PUBLIC_ENABLE_DEV_CONTROLS
);

interface Place {
  id: string;
  displayName?: { text: string };
  location?: { latitude: number; longitude: number };
  rating?: number;
  priceLevel?: string;
  /** opening hours as Places returns them — needed for the post-schedule
   * arrival re-check (§1.4), which asks "is this open when I ARRIVE?" */
  currentOpeningHours?: CurrentOpeningHours;
  /** one-line blurb; carried so an adapted replacement keeps its card text */
  editorialSummary?: { text: string };
}
type Pools = Record<string, Place[]>;
interface WeatherBlock {
  category: string;
  slot?: number;
  weatherBlocked: true;
  reason: string;
}
interface WeatherHour {
  hourISO: string;
  tempC: number | null;
  precipProbability: number | null;
  condition: string | null;
}

/** Resolved geocoder choices carried through a paused pipeline. Ambiguous
 * city/address results resume with the exact candidate the user selected,
 * rather than issuing the same ambiguous query and taking index zero. */
interface PipelineGeocode {
  city?: GeocodeCandidate;
  address?: GeocodeCandidate;
}

/**
 * The plan's resolved PLACE context. The geocode now runs BEFORE the parse,
 * because the planner reasons about "tonight" against the plan's own clock
 * and therefore has to be told the zone — which only the geocode knows.
 * Carrying the chosen candidates lets a paused pipeline resume without
 * re-issuing an ambiguous query.
 */
interface ResolvedPlace {
  planZone: string;
  hp: { label: string; location: { latitude: number; longitude: number } };
  /** the formatted city, which rides on parsed.city into every Places query */
  cityLabel: string;
  geocode: PipelineGeocode;
}

// everything the tail of the pipeline needs to build + store a plan —
// captured so a partial-failure recovery can pause and resume without
// re-deriving geocode/zone/weather/pools
interface PlanCtx {
  /** the PLANNER's proposal — the activity set, its per-activity duration
   * estimates, and the time intent whose window code validates after the
   * real travel legs are known. `parseData` below is its projection onto
   * the currency the rest of the pipeline speaks. */
  plan: PlanIntent;
  /** the parse, plus the two fields the APP injects after it (city, home)
   * — both already optional on ParsedPrompt. This object is mutated in
   * place and threaded through the whole client pipeline, so it was the
   * single most-travelled untyped value in the app (code-audit §4.2). */
  parseData: ParsedPrompt;
  planZone: string;
  hp: { label: string; location: { latitude: number; longitude: number } };
  weather: WeatherHour[] | null;
  /** The plan's one resolved anchor. Slot-aware recovery starts here, then
   * uses arrivalBySlot rather than re-resolving time from one category. */
  startInstant: Date;
  /** Best known arrival for each original requested slot. Provisional
   * duration-only targets are replaced by exact scheduled starts once the
   * first route pass exists. */
  arrivalBySlot: Record<number, string>;
  pools: Pools;
  sels: Selection[];
  drops: DropEntry[];
  /** replacement category → the requested category whose slot it fills
   * (recovery's follow-up path), so ordering can restore prompt order */
  slots: Record<string, string>;
}

/** One unfilled slot in the recovery panel. `slot` is present whenever the
 *  plan knows which requested stop this is — two stops can share a category
 *  ("a drink, then another drink"), so the category alone is not an
 *  identity and resolving one must not overwrite the other (§7.1/§7.2). */
interface EmptyRow {
  category: string;
  slot?: number;
  reason: string;
  noWiden?: boolean;
}

/** Stable per-row identity: the slot when known, else the category. */
const rowKey = (e: { category: string; slot?: number }): string =>
  e.slot != null ? `${e.category}#${e.slot}` : e.category;

/** Does this selection fill the given row's slot? */
const matchesRow = (s: Selection, e: { category: string; slot?: number }): boolean =>
  e.slot != null ? s.slot === e.slot : s.category === e.category;

function clientErrorMessage(error: unknown, fallback = "Something went wrong. Please try again."): string {
  if (error instanceof ClientFetchError) return error.message;
  return error instanceof Error && error.message ? error.message : fallback;
}

function WeatherIcon({ condition, precip }: { condition: string | null; precip: number | null }) {
  const c = (condition ?? "").toLowerCase();
  if ((precip != null && precip > 50) || /rain|shower|drizzle/.test(c)) {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M17.5 15a4.5 4.5 0 0 0-.9-8.9A6 6 0 0 0 5 8.5 4 4 0 0 0 6 16h11a1 1 0 0 0 .5-1zM8 18l-1 3m4-3-1 3m4-3-1 3" />
      </svg>
    );
  }
  if (/cloud|overcast/.test(c)) {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M17.5 18a4.5 4.5 0 0 0-.9-8.9A6 6 0 0 0 5 11.5 4 4 0 0 0 6 19h11a1 1 0 0 0 .5-1z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0-14v2m0 14v2M3 12h2m14 0h2M5.6 5.6l1.4 1.4m10 10 1.4 1.4m0-12.8-1.4 1.4m-10 10-1.4 1.4" />
    </svg>
  );
}

// transit-leg detail line, e.g. "505 Dundas · 11 stops · 22 min" — or,
// on a multi-ride leg, "1 transfer · 47 min": the first ride's line name
// and stop count would misread as the whole journey's (the bubbles carry
// the line identities)
function legDetail(leg?: TravelLeg | null): string | null {
  if (!leg || leg.mode !== "transit" || !leg.transit) return null;
  const n = leg.transitSegments?.length ?? 1;
  if (n > 1) return `${n - 1} transfer${n > 2 ? "s" : ""} · ${leg.totalMinutes} min`;
  const t = leg.transit;
  return `${t.lineName}${t.stopCount ? ` · ${t.stopCount} stops` : ""} · ${leg.totalMinutes} min`;
}

// the map label's bubble row — pre-segments stored plans fall back to
// the single ride, exactly like the strip
function legSegments(leg?: TravelLeg | null) {
  if (!leg || leg.mode !== "transit") return null;
  return leg.transitSegments ?? (leg.transit ? [leg.transit] : null);
}

function stopsFromSchedule(sched: ScheduledStop[], pools: Pools): MapStop[] {
  const out: MapStop[] = [];
  for (const st of sched) {
    if (st.id === null) continue;
    const loc = (pools[st.category] ?? []).find((p) => p.id === st.id)?.location ?? st.location;
    if (!loc) continue;
    out.push({
      id: st.id,
      category: st.category,
      name: st.name ?? "(unnamed)",
      lat: loc.latitude,
      lng: loc.longitude,
      startTime: st.start_time,
      endTime: st.end_time,
      reason: st.reason,
      legModeToNext: st.travelToNext?.mode,
      polylineToNext: st.travelToNext?.encodedPolyline ?? null,
      legLabel: legDetail(st.travelToNext),
      legSegments: legSegments(st.travelToNext),
    });
  }
  return out;
}

function stopsFromItinerary(it: Itinerary): MapStop[] {
  return it.stops
    .filter((s) => s.id !== null && s.location)
    .map((s) => ({
      id: s.id!,
      category: s.category,
      name: s.name ?? "(unnamed)",
      lat: s.location!.latitude,
      lng: s.location!.longitude,
      startTime: s.start_time,
      endTime: s.end_time,
      reason: s.reason,
      legModeToNext: s.travelToNext?.mode,
      polylineToNext: s.travelToNext?.encodedPolyline ?? null,
      legLabel: legDetail(s.travelToNext),
      legSegments: legSegments(s.travelToNext),
    }));
}

export default function Home() {
  // ── accounts (Stage 1A login; Stage 1B identity + resume) ──
  // Every visitor now has a uid: signed-in users their real one, guests an
  // ANONYMOUS one created silently on load. One id path, not two branches.
  // The app still behaves identically for both — the uid buys a plan that
  // survives a refresh, and (for real accounts only) a history entry when the
  // plan concludes. Nothing here gates a feature.
  const auth = useAuth();
  const [loginOpen, setLoginOpen] = useState(false);
  // A real account, as opposed to a silently-signed-in guest. This is what
  // the account chip keys off — showing "Signed in" to someone who never
  // signed in would be a lie the anonymous uid makes easy to tell.
  const signedInForReal = auth.status === "signed-in" && auth.user?.isAnonymous === false;
  // Guards the one-shot resume so a re-render or a token refresh cannot
  // yank a user back to a plan they have already moved on from.
  const resumeAttempted = useRef(false);
  // Mirrors `itinerary` for the resume effect, which must be able to check
  // "is the user already looking at a plan" without taking `itinerary` as a
  // dependency — that would re-run it on every mutation.
  const itineraryRef = useRef<Itinerary | null>(null);

  const { getIdToken } = auth;
  /** Authorization header for our own API, or undefined when there is no
   *  session. Undefined is a supported state everywhere: routes treat an
   *  unauthenticated request as guest-level rather than rejecting it, which
   *  is also what keeps mock e2e (no Firebase at all) working unchanged. */
  const authHeaders = useCallback(async (): Promise<Record<string, string> | undefined> => {
    const token = await getIdToken();
    return token ? { Authorization: `Bearer ${token}` } : undefined;
  }, [getIdToken]);

  const [prompt, setPrompt] = useState("");
  // plain query inputs — NOT location services (deliberately deferred).
  // City prefilled visibly (never a silent fallback); address optional,
  // defaulting to the city centre.
  const [city, setCity] = useState("Toronto");
  const [startAddress, setStartAddress] = useState("");
  const [homePoint, setHomePoint] = useState<{ label: string; location: { latitude: number; longitude: number } } | null>(null);
  // the plan's resolved IANA zone — all scheduling + labels use it
  const [planZone, setPlanZone] = useState("America/Toronto");
  const [pools, setPools] = useState<Pools>({});
  const [parsedObj, setParsedObj] = useState<ParsedPrompt | null>(null);
  const [schedule, setSchedule] = useState<ScheduledStop[] | null>(null);
  const [travelLegs, setTravelLegs] = useState<TravelLeg[]>([]);
  const [homeLeg, setHomeLeg] = useState<TravelLeg | null>(null);
  const [mapStops, setMapStops] = useState<MapStop[]>([]);
  const [itinerary, setItinerary] = useState<Itinerary | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [stripFocusRequest, setStripFocusRequest] =
    useState<StripFocusRequest | null>(null);
  const stripFocusNonce = useRef(0);
  const [weatherBlocks, setWeatherBlocks] = useState<WeatherBlock[]>([]);

  const [simNow, setSimNow] = useState("");
  const [disruptLeg, setDisruptLeg] = useState(0);
  const [banner, setBanner] = useState<string | null>(null);
  const [bannerFlat, setBannerFlat] = useState(false);
  // "changed" is keyed by venue id (a swap can change a stop's category)
  const [changedIds, setChangedIds] = useState<Set<string>>(new Set());
  const [oldStarts, setOldStarts] = useState<Record<string, string | null>>({});
  const [devOpen, setDevOpen] = useState(true);
  const [swapText, setSwapText] = useState("");
  const [swapping, setSwapping] = useState(false);
  const [swapError, setSwapError] = useState<string | null>(null);
  const [weather, setWeather] = useState<WeatherHour[] | null>(null);

  // The weather chip renders ONLY the plan's own forecast, fetched with the
  // plan's coordinates in continuePipeline. There used to be a parameterless
  // fetch on mount, which fell back to the route's hardcoded Ossington
  // coordinates — so a user who typed "Vancouver" saw a Toronto forecast
  // under a Vancouver label until the plan ran (code-audit 2026-07-18 §3.2).
  // The chip only appears on the map stage, where plan weather always
  // exists, so there is nothing to fetch ambiently.

  const [error, setError] = useState<string | null>(null);
  const [loadingText, setLoadingText] = useState<string | null>(null);

  // ONE round of clarifying questions, AUTHORED BY THE PLANNER. The old
  // rule table in clarify.ts (GENERIC_RULES / kindQuestion / when-vibe-
  // distribution) is gone: deciding what is worth asking about a request is
  // a semantic judgment, and a fixed table could never generalise past the
  // shapes someone had already thought of. Answers go back to the planner
  // for a second pass; skipping still plans.
  const [clarify, setClarify] = useState<{
    questions: PlannerQuestion[];
    /** the original prompt — the second planner pass re-reads it alongside
     *  the answers, rather than the client patching a parse in place */
    prompt: string;
    place: ResolvedPlace;
  } | null>(null);
  /** answers keyed by question id; the free-text box and the chips write to
   *  the same slot, so typing simply overrides a tapped chip */
  const [clarifyAnswers, setClarifyAnswers] = useState<Record<string, string>>({});

  // The interactive-recovery panel — one component, three triggers:
  //  - "geocode": a city or starting address has multiple factual matches
  //    → show formatted-address candidates and resume with the exact choice.
  //    Never select provider result zero implicitly.
  //  - "empty": SOME categories came back empty → honest reason + widen /
  //    replace that slot. Rows flagged noWiden suppress the widen offer (a
  //    weather problem isn't a radius problem — widening can't fix rain).
  //  - "weather-gate": a category came back empty specifically because the
  //    WEATHER blocked it while others survived → the honest reason plus
  //    the same real choice ("still want it" retries that category with
  //    ONLY the weather gate off; "something else" moves to replacing the
  //    slot) — never the useless widen offer.
  //
  // A fourth mode, "time-gate", was removed with the plausibility gate
  // (2026-07-27): it existed only to offer a choice about an hour a
  // hardcoded table disliked, and there is no such verdict any more.
  const [recovery, setRecovery] = useState<
    | {
        mode: "geocode";
        /** the raw prompt, not a parse: the geocode now runs BEFORE the
         *  planner call, so there is no parse yet when this pauses */
        prompt: string;
        queryType: "city" | "address";
        message: string;
        candidates: GeocodeCandidate[];
        geocode: PipelineGeocode;
      }
    | {
        mode: "empty";
        ctx: PlanCtx;
        empties: EmptyRow[];
        replaceText: Record<string, string>;
        busy: boolean;
        note: { kind: "status" | "error"; text: string } | null;
      }
    | {
        mode: "weather-gate";
        ctx: PlanCtx;
        blocks: { category: string; slot?: number; reason: string }[];
        /** generically-empty categories waiting behind the gate — carried
         * through so they get their normal recovery rows afterwards */
        pendingEmpties: EmptyRow[];
        busy: boolean;
      }
    | null
  >(null);

  // One user-owned operation at a time. State-derived disabled flags make
  // that visible, while the ref closes the same-tick gap before React has
  // rendered the new busy state (double Enter/click and cross-action races).
  const activeOperation = useRef<symbol | null>(null);
  const recoveryBusy =
    recovery?.mode === "empty" || recovery?.mode === "weather-gate"
      ? recovery.busy
      : false;
  const busy = loadingText !== null || swapping || recoveryBusy;
  const beginOperation = (): symbol | null => {
    if (activeOperation.current) return null;
    const token = Symbol("client-operation");
    activeOperation.current = token;
    return token;
  };
  const endOperation = (token: symbol) => {
    if (activeOperation.current === token) activeOperation.current = null;
  };
  const requestStripFocus = (stopId: string) => {
    stripFocusNonce.current += 1;
    setStripFocusRequest({ stopId, nonce: stripFocusNonce.current });
  };

  async function runPipeline() {
    const q = prompt.trim();
    if (!q) return;
    const operation = beginOperation();
    if (!operation) return;
    setError(null);
    setBanner(null);
    setChangedIds(new Set());
    setOldStarts({});
    setStripFocusRequest(null);
    setSwapError(null);
    setClarify(null);
    setRecovery(null);
    // A new attempt never inherits another plan's forecast or skip notes.
    // If this attempt's weather read fails, unknown is more honest than
    // stale weather from a different city or time.
    setWeather(null);
    setWeatherBlocks([]);
    try {
      // nonsense never reaches the LLM ("." / "asdfghjkl")
      const degenerate = degeneratePromptReason(q);
      if (degenerate) {
        setError(degenerate);
        setLoadingText(null);
        return;
      }
      // GEOCODE FIRST (reordered for the planner). The planner resolves
      // "tonight" / "in an hour" against a real clock, so it has to be told
      // WHICH clock — and only the geocode knows the plan's zone. Before
      // this, parse ran first and knew nothing about now, which is exactly
      // why every relative-time decision had to be hardcoded downstream.
      const place = await resolvePlace(q, {});
      if (!place) return; // paused on ambiguity, or already failed loud
      await planFrom(q, place);
    } catch (err) {
      setError(clientErrorMessage(err));
    } finally {
      setLoadingText(null);
      endOperation(operation);
    }
  }

  /**
   * Resolve the city (and optional starting address) to coordinates + a
   * timezone. Returns null when the pipeline PAUSED on an ambiguous result
   * (the geocode recovery panel is now showing) or failed loud. Never
   * silently falls back: a city the geocoder can't place is an error.
   */
  async function resolvePlace(
    rawPrompt: string,
    existing: PipelineGeocode
  ): Promise<ResolvedPlace | null> {
    const fail = (reason: string) => {
      setError(reason);
      setLoadingText(null);
      return null;
    };
    setLoadingText("Finding your city…");
    const cityQ = city.trim();
    if (!cityQ) return fail("Add a city so I know where to plan.");

    let cityData = existing.city;
    if (!cityData) {
      const cityOutcome = await fetchJson("/api/geocode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: cityQ, kind: "city" }),
        parse: parseGeocodePayload,
      });
      if (cityOutcome.outcome === "ambiguous") {
        setRecovery({
          mode: "geocode",
          prompt: rawPrompt,
          queryType: "city",
          message: cityOutcome.message,
          candidates: cityOutcome.candidates,
          geocode: {},
        });
        setLoadingText(null);
        return null;
      }
      cityData = cityOutcome;
    }

    // Once the user/provider has resolved an ambiguous city, carry its
    // formatted locality/region/country into every Places query. Keeping
    // the original bare "London" here would reintroduce ambiguity later.
    let planZone: string = cityData.timeZone;
    let hp: { label: string; location: { latitude: number; longitude: number } } = {
      label: `Start · ${cityData.formattedAddress} centre`,
      location: cityData.location,
    };
    const geocode: PipelineGeocode = { city: cityData };

    const addrQ = startAddress.trim();
    if (addrQ) {
      let addrData = existing.address;
      if (!addrData) {
        setLoadingText("Finding your starting address…");
        const addressOutcome = await fetchJson("/api/geocode", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: addrQ, kind: "address", cityContext: cityData }),
          parse: parseGeocodePayload,
        });
        if (addressOutcome.outcome === "ambiguous") {
          setRecovery({
            mode: "geocode",
            prompt: rawPrompt,
            queryType: "address",
            message: addressOutcome.message,
            candidates: addressOutcome.candidates,
            geocode,
          });
          setLoadingText(null);
          return null;
        }
        addrData = addressOutcome;
      }
      geocode.address = addrData;
      hp = { label: `Start · ${addrData.formattedAddress}`, location: addrData.location };
      planZone = addrData.timeZone;
    }

    setHomePoint(hp);
    setPlanZone(planZone);
    return { planZone, hp, cityLabel: cityData.formattedAddress, geocode };
  }

  /**
   * THE PLANNER CALL. One request, two possible passes: without answers it
   * may come back with questions; with answers it is final. The response
   * carries both the plan (activities, duration estimates, time intent) and
   * its projection onto ParsedPrompt, which the rest of the pipeline
   * consumes unchanged.
   */
  async function planFrom(
    rawPrompt: string,
    place: ResolvedPlace,
    answers?: PlannerAnswer[]
  ) {
    const fail = (reason: string) => {
      setError(reason);
      setLoadingText(null);
    };
    setLoadingText("Shaping your day…");
    const { plan, parsed } = await fetchJson("/api/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: rawPrompt,
        timeZone: place.planZone,
        // the app already resolves start times from the browser clock
        // everywhere else; sending it keeps the planner on the SAME clock
        // (and keeps the e2e time-freeze seam working)
        nowISO: new Date().toISOString(),
        city: place.cityLabel,
        ...(answers && answers.length > 0 ? { answers } : {}),
      }),
      parse: parsePlanPayload,
    });

    // the city is app-supplied input, never LLM-inferred — it rides on the
    // parse so swap/reroute re-searches inherit it from the store
    parsed.city = place.cityLabel;
    parsed.home = place.hp.location;
    setParsedObj(parsed);

    // planner extracted nothing AND the prompt is degenerate → "couldn't
    // understand"; a sincere-but-vague prompt falls through to the general
    // "things to do" pool instead of a rejection
    const unparseable = emptyParseReason(parsed, rawPrompt);
    if (unparseable) return fail(unparseable);

    // "cheap fancy dinner" — contradictory, not impossible: say so
    const contradiction = contradictionReason(rawPrompt, parsed);
    if (contradiction) return fail(contradiction);

    // ONE round. `answers` present means this WAS the second pass, so any
    // questions that come back anyway are ignored rather than re-asked.
    if (!answers && plan.questions.length > 0) {
      setClarify({ questions: plan.questions, prompt: rawPrompt, place });
      setClarifyAnswers({});
      setLoadingText(null);
      return;
    }

    await continuePipeline(plan, parsed, place);
  }

  // clarify answered or skipped → a SECOND planner pass, or the first plan
  // as-is. Chosen over a structured client-side merge because the answers
  // are free-form semantics ("something quieter", "Italian", "9ish") and
  // folding them onto searchQueries and the time intent is the same
  // judgment the planner just made — doing it twice, in two languages, is
  // how the old rule table grew. Skipping costs nothing: the first pass
  // already produced a complete, plannable proposal.
  async function submitClarify(skip: boolean) {
    if (!clarify) return;
    const operation = beginOperation();
    if (!operation) return;
    const { prompt: rawPrompt, place, questions } = clarify;
    try {
      const answers: PlannerAnswer[] = skip
        ? []
        : questions
            .map((q) => ({
              question: q.question,
              answer: (clarifyAnswers[q.id] ?? "").trim(),
            }))
            .filter((a) => a.answer !== "");
      setError(null);
      setClarify(null);
      await planFrom(rawPrompt, place, answers);
    } catch (err) {
      setError(clientErrorMessage(err));
    } finally {
      setLoadingText(null);
      endOperation(operation);
    }
  }

  // everything from the planner onward — the plan and parse are final here.
  async function continuePipeline(
    plan: PlanIntent,
    parseData: ParsedPrompt,
    place: ResolvedPlace
  ) {
    const { planZone, hp } = place;
    const fail = (reason: string) => {
      setError(reason);
      setLoadingText(null);
    };
    try {
      // THE plan's one anchor. It came from the planner, which resolved it
      // against a real clock in this zone; code owns only the fallback for
      // a plan whose time was never stated and never answered.
      const startInstant: Date = planStartInstant(plan, new Date(), planZone);

      let weather: WeatherHour[] | null = null;
      try {
        weather = await fetchJson(
          `/api/weather?lat=${hp.location.latitude}&lng=${hp.location.longitude}`,
          { parse: parseWeatherPayload }
        );
        // the ambient chip should show the PLAN's city, not the default
        setWeather(weather);
      } catch {
        weather = null;
        setWeather(null);
      }

      setLoadingText("Finding places…");
      const {
        pools: categories,
        drops,
        weatherBlocks: wxBlocks,
      } = await fetchJson("/api/places/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parsed: parseData,
          weather,
          timeZone: planZone,
          // THE plan's resolved anchor, passed explicitly. `time_window`
          // is prose on the planner path, so the hours filter must never
          // re-derive an instant from it — one anchor, shared by search,
          // the hours filter, the weather gate and the schedule.
          targetTime: startInstant.toISOString(),
        }),
        parse: parsePlacesPayload,
      });
      setPools(categories);
      setWeatherBlocks(wxBlocks);

      // the empty-map net: EVERY pool came back empty → say why, don't
      // render a map with nothing on it. This is also where an impossible
      // HOUR now lands: with the plausibility gate gone, "brunch at 3am"
      // isn't refused up front — it runs, every venue drops on `hours`, and
      // noVenuesReason names that as the dominant cause. An honest fact
      // instead of a table's opinion.
      const poolEntries = Object.entries(categories);
      const allEmpty =
        poolEntries.length === 0 ||
        poolEntries.every(([, arr]) => !Array.isArray(arr) || arr.length === 0);
      if (allEmpty) {
        return fail(
          wxBlocks.length >= poolEntries.length && wxBlocks.length > 0
            ? weatherBlockedReason(wxBlocks)
            : noVenuesReason(Object.keys(categories), formatStopTime(startInstant, new Date(), planZone), drops)
        );
      }

      setLoadingText("Choosing the spots…");
      const { selections: sels } = await fetchJson("/api/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parsed: parseData,
          pools: categories,
          // the requested stops in order, duplicates intact — a category asked
          // for twice is TWO stops sharing one pool (code-audit §7.1)
          slots: (parseData.category_signals ?? []).length > 0 ? parseData.category_signals : undefined,
          // the planner's pre-venue duration estimates. The selector refines
          // each one now that it knows the actual place — folded into the
          // SAME Groq round-trip rather than a second call, because an extra
          // model round-trip per plan is real latency for a judgment the
          // selector is already making with the venue in front of it.
          plannedMinutes:
            (parseData.category_signals ?? []).length > 0
              ? plan.activities.map((a) => a.estimatedMinutes)
              : undefined,
        }),
        parse: parseSelectionsPayload,
      });

      // a hard constraint nothing actually meets → fail loud, never a
      // pick with a "check with the venue" hedge
      const unmet = sels.find((s) => s.unmetConstraint);
      if (unmet) return fail(unmetConstraintReason(unmet.category, unmet.unmetConstraint!));

      const requestedCategories =
        parseData.category_signals.length > 0
          ? parseData.category_signals
          : sels.map((selection) => selection.category);
      const ctx: PlanCtx = {
        plan,
        parseData,
        planZone,
        hp,
        weather,
        startInstant,
        arrivalBySlot: provisionalArrivals(
          requestedCategories,
          startInstant,
          sels
        ),
        pools: categories,
        sels,
        drops,
        slots: {},
      };

      // partial failure: some categories resolved, ≥1 came back empty.
      // Never drop the empty one silently — pause with the honest reason
      // and an offer to recover (widen / replace) that ONE category. The
      // all-empty case above keeps its own noVenuesReason path.
      const emptySels = partialEmptySelections(sels);
      if (emptySels.length > 0) {
        // split WEATHER-blocked empties from genuinely-empty ones — they
        // need different offers: widening can't fix rain, but an informed
        // "still want it" (weather gate off, every other filter intact)
        // genuinely can. Weather-blocked → the weather-gate panel first,
        // carrying any generic empties behind it.
        const wxByCat = new Map(wxBlocks.map((b) => [b.category, b.reason]));
        const blocked = emptySels.filter((s) => wxByCat.has(s.category));
        const generic = emptySels.filter((s) => !wxByCat.has(s.category));
        const genericEmpties: EmptyRow[] = generic.map((s) => ({
          category: s.category,
          slot: s.slot,
          // a NARROWED slot isn't an empty pool — the venue exists, it's
          // just already in the plan, so say that instead (§7.1)
          reason: s.narrowed
            ? narrowedSlotReason(s.category, parseData.location)
            : emptyCategoryReason(s.category, drops, parseData.location),
        }));
        if (blocked.length > 0) {
          setRecovery({
            mode: "weather-gate",
            ctx,
            blocks: blocked.map((s) => ({
              category: s.category,
              slot: s.slot,
              reason: wxByCat.get(s.category)!,
            })),
            pendingEmpties: genericEmpties,
            busy: false,
          });
          setLoadingText(null);
          return;
        }
        setRecovery({
          mode: "empty",
          ctx,
          empties: genericEmpties,
          replaceText: {},
          busy: false,
          note: null,
        });
        setLoadingText(null);
        return;
      }

      await finishPipeline(ctx);
    } catch (err) {
      setError(clientErrorMessage(err));
    } finally {
      setLoadingText(null);
    }
  }

  // Build the route + schedule from finalized selections, then store the
  // itinerary. Shared by the normal path and by post-recovery resumption,
  // so recovering a category runs the exact same tail — no forked path.
  // opts.skipArrivalCheck: set when the user has already been shown the
  // arrival problems and chose to move on — the failing slots were emptied
  // when the panel opened, so re-checking would find nothing anyway; the
  // flag makes that termination explicit rather than incidental.
  async function finishPipeline(ctx: PlanCtx, opts: { skipArrivalCheck?: boolean } = {}) {
    const { parseData, planZone, hp, pools } = ctx;
    // stops must follow the PROMPT's order ("ramen then a bar" = ramen
    // first) — selectVenues appends empty categories last and recovery
    // resolves them in that appended position, so re-order by the parse's
    // category_signals; a replacement category takes its slot's position
    const orderedSels = orderByRequest(ctx.sels, parseData.category_signals, ctx.slots);
    const fail = (reason: string) => {
      setError(reason);
      setLoadingText(null);
    };
    try {
      setPools(pools);
      setParsedObj(parseData);
      setLoadingText("Timing the route…");

      // Route + schedule ONE candidate selection set. Called twice at most:
      // the arrival check below can adapt a venue, which moves the times,
      // so the schedule has to be rebuilt against the new pick.
      const planOnce = async (sels: Selection[]) => {
        const points = sels
          .filter((s) => s.id !== null)
          .map((s) => (pools[s.category] ?? []).find((p) => p.id === s.id)?.location ?? null);

        let legs: TravelLeg[] = [];
        let hl: TravelLeg | null = null;
        if (points.length >= 1 && points.every(Boolean)) {
          const dry = buildSchedule(sels, "", new Date(), [], ctx.startInstant, null, planZone);
          const { startISO } = dry;
          // how long we stay at each point, so every leg can be routed at
          // its own departure instant (§1.5). Index 0 is home — no dwell.
          const dwellMinutes = [
            0,
            ...dry.stops.filter((st) => st.id !== null).map((st) => st.durationMinutes?.total ?? 0),
          ];
          const travelData = await fetchJson("/api/schedule/travel", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              points: [hp.location, ...points],
              departureTime: startISO,
              dwellMinutes,
            }),
            parse: parseTravelPayload,
          });
          const split = splitHomeLeg(travelData.legs ?? []);
          hl = split.homeLeg;
          legs = split.interLegs;
        }
        const { stops } = buildSchedule(
          sels,
          "",
          new Date(),
          legs,
          // the SAME anchor the hours filter and weather gate used
          ctx.startInstant,
          hl,
          planZone
        );
        return { stops, legs, hl };
      };

      // ── window validation (Part 5) ───────────────────────────────────
      // THE moment code checks the planner's arithmetic. The planner
      // proposed how much fits between the stated start and end; only now,
      // with real travel legs folded into real end times, is that checkable.
      // Runs BEFORE the arrival re-check on purpose: no point adapting a
      // venue we're about to drop, and it keeps the common case at one
      // routing pass.
      const validateWindow = async (
        sels: Selection[],
        stops: ScheduledStop[]
      ): Promise<
        | { ok: true; sels: Selection[]; stops: ScheduledStop[]; legs: TravelLeg[]; hl: TravelLeg | null }
        | { ok: false; reason: string }
        | null
      > => {
        const fit = checkWindowFit(stops, ctx.plan.timeIntent.endISO);
        if (!fit) return null; // no stated end — nothing to validate against
        const windowLabel =
          ctx.plan.timeIntent.label && ctx.plan.timeIntent.label !== "unspecified"
            ? ctx.plan.timeIntent.label
            : null;

        if (fit.fits) {
          // A big gap at the end means the planner UNDER-filled the window.
          // Acceptable for now, and deliberately NOT filled here — that
          // would be a second planning mechanism in the wrong language.
          // Logged so the shortfall is visible.
          if (fit.unfilledMinutes >= WINDOW_UNDERFILL_LOG_MINUTES) {
            console.info(
              "[window-fit]",
              JSON.stringify({
                verdict: "underfilled",
                unfilledMinutes: fit.unfilledMinutes,
                stops: fit.timed,
                endISO: ctx.plan.timeIntent.endISO,
              })
            );
          }
          return null;
        }

        // Nothing fits — there is no activity to drop that rescues this.
        if (fit.keep === 0) {
          console.info(
            "[window-fit]",
            JSON.stringify({ verdict: "impossible", overrunMinutes: fit.overrunMinutes })
          );
          return { ok: false, reason: windowTooTightReason(windowLabel) };
        }

        // Drop the trailing activities that genuinely don't fit, and SAY SO.
        const timedSels = sels.filter((s) => s.id !== null);
        const dropped = timedSels.slice(fit.keep);
        const droppedIds = new Set(dropped.map((s) => s.id));
        const trimmed = sels.filter((s) => s.id === null || !droppedIds.has(s.id));
        console.info(
          "[window-fit]",
          JSON.stringify({
            verdict: "trimmed",
            overrunMinutes: fit.overrunMinutes,
            kept: fit.keep,
            of: fit.timed,
            dropped: dropped.map((s) => s.category),
          })
        );
        setLoadingText("Fitting your window…");
        const replanned = await planOnce(trimmed);
        setBannerFlat(true);
        setBanner(
          windowOverrunMessage(
            windowLabel,
            fit.keep,
            fit.timed,
            dropped.map((s) => s.category)
          )
        );
        return { ok: true, sels: trimmed, ...replanned };
      };

      // ── arrival re-check (§1.4) ──────────────────────────────────────
      // The objective filter judges EVERY category at the plan's single
      // anchor instant, because per-stop arrival times don't exist yet at
      // that point. They exist now, so re-check each stop's own venue at
      // its own start_time: a bar that passed as "open at 7pm" may well be
      // shut by the 9:20pm you'd actually arrive.
      const closedOnArrival = (stops: ScheduledStop[]) =>
        stops.filter((st) => {
          if (!st.id || !st.start_time) return false;
          const place = (pools[st.category] ?? []).find((p) => p.id === st.id);
          return (
            isOpenAtInstant(place?.currentOpeningHours, new Date(st.start_time), planZone) === false
          );
        });

      let sels = orderedSels;
      let { stops, legs, hl } = await planOnce(sels);
      const adaptedNames: string[] = [];

      const windowed = await validateWindow(sels, stops);
      if (windowed && !windowed.ok) return fail(windowed.reason);
      if (windowed) ({ sels, stops, legs, hl } = windowed);

      if (!opts.skipArrivalCheck) {
        let closed = closedOnArrival(stops);
        if (closed.length > 0) {
          // TRY → ADAPT → NOTIFY, the same ladder the swap engine uses.
          // The pool is already in hand, so before bothering the user, look
          // for a venue in the SAME category that IS open on arrival.
          const used = new Set(sels.map((s) => s.id).filter((id): id is string => !!id));
          const adapted = sels.map((s) => {
            const bad = closed.find((c) => c.id === s.id && c.category === s.category);
            if (!bad || !bad.start_time) return s;
            const replacement = (pools[s.category] ?? [])
              .filter(
                (p) =>
                  !used.has(p.id) &&
                  isOpenAtInstant(p.currentOpeningHours, new Date(bad.start_time!), planZone) !== false
              )
              .sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1))[0];
            if (!replacement) return s;
            used.add(replacement.id);
            adaptedNames.push(replacement.displayName?.text ?? s.category);
            return {
              ...s,
              id: replacement.id,
              name: replacement.displayName?.text,
              rating: replacement.rating,
              priceLevel: replacement.priceLevel,
              description: replacement.editorialSummary?.text,
              reason: `Open when you get there — the earlier pick had closed.`,
            };
          });

          if (adaptedNames.length > 0) {
            setLoadingText("Adjusting for opening hours…");
            sels = adapted;
            ({ stops, legs, hl } = await planOnce(sels));
            closed = closedOnArrival(stops);
          }

          // NOTIFY: nothing in the pool works at that hour — hand it to the
          // recovery panel rather than shipping a plan that can't be run.
          if (closed.length > 0) {
            const rows: EmptyRow[] = closed.map((st) => ({
              category: st.category,
              slot: st.slot,
              reason: closedOnArrivalReason(
                st.category,
                st.name,
                formatStopTime(st.start_time!, new Date(), planZone)
              ),
            }));
            // empty the failing slots so "Plan without it" drops them rather
            // than shipping a closed venue — and so the check terminates
            // instead of re-opening the panel forever
            const clearedSels = sels.map((s) =>
              rows.some((r) => matchesRow(s, r))
                ? { ...s, id: null, reason: "closed by the time you'd arrive" }
                : s
            );
            setRecovery({
              mode: "empty",
              ctx: {
                ...ctx,
                sels: clearedSels,
                arrivalBySlot: mergeFinalArrivals(ctx.arrivalBySlot, stops),
              },
              empties: rows,
              replaceText: {},
              busy: false,
              note: null,
            });
            setLoadingText(null);
            return;
          }
        }
      }

      setSchedule(stops);
      setTravelLegs(legs);
      setHomeLeg(hl);
      const ms = stopsFromSchedule(stops, pools);
      setMapStops(ms);
      setSelected(ms[0]?.id ?? null);
      // the adapt is a real change to what they asked for — say so
      if (adaptedNames.length > 0) {
        setBannerFlat(true);
        setBanner(
          `Swapped in ${adaptedNames.join(" and ")} — the first pick would have been closed by the time you got there.`
        );
      }

      // auto-store the itinerary so the live/reroute controls work at once
      await storeItinerary(stops, legs, hl, parseData, pools, "", hp, planZone);
    } catch (err) {
      setError(clientErrorMessage(err));
    } finally {
      setLoadingText(null);
    }
  }

  // Search + select ONE category slot — the shared core under both the
  // recovery panel's widen/replace and the weather-gate's override.
  // ignoreWeather sends weather:null, which skips ONLY the weather gate
  // (keep-on-missing) — hours, rating, price, business status all still
  // run for real.
  async function searchSlot(
    ctx: PlanCtx,
    row: { category: string; slot?: number },
    searchCategory: string,
    opts: { dropLocation?: boolean; ignoreWeather?: boolean }
  ): Promise<{
    sel?: Selection;
    pool: Place[];
    drops: DropEntry[];
    onlyUsed: boolean;
    weatherReason?: string;
  }> {
    const scopedParsed = {
      ...ctx.parseData,
      // Selection is for this ONE recovery slot. Passing the original
      // whole-plan category list makes the production selector look for
      // those old categories and omit a newly named replacement entirely.
      // Keep the original time/budget/constraints, but scope the requested
      // slot identity just as categoriesOverride scopes the Places search.
      category_signals: [searchCategory],
      stop_count: 1,
      ...(opts.dropLocation ? { location: "" } : {}),
    };
    const targetTime = arrivalForRow(
      ctx.arrivalBySlot,
      row,
      ctx.startInstant
    );
    const {
      pools: poolObj,
      drops,
      weatherBlocks,
    } = await fetchJson("/api/places/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parsed: scopedParsed,
        categoriesOverride: [searchCategory],
        weather: opts.ignoreWeather ? null : ctx.weather,
        timeZone: ctx.planZone,
        // Filter against this slot's own provisional or scheduled arrival,
        // never the whole plan's opening anchor.
        targetTime: targetTime.toISOString(),
      }),
      parse: parsePlacesPayload,
    });
    const pool = poolObj[searchCategory] ?? [];
    const usedIds = usedIdsOutsideRow(ctx.sels, row);
    const availablePool = pool.filter((place) => !usedIds.has(place.id));
    const onlyUsed = pool.length > 0 && availablePool.length === 0;
    const weatherReason = weatherBlocks.find(
      (block) => block.category === searchCategory
    )?.reason;

    let sel: Selection | undefined;
    if (availablePool.length > 0) {
      const { selections } = await fetchJson("/api/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parsed: scopedParsed,
          pools: { [searchCategory]: availablePool },
          slots: [searchCategory],
        }),
        parse: parseSelectionsPayload,
      });
      sel = selections.find(
        (s) => s.category === searchCategory
      );
    }
    return { sel, pool, drops, onlyUsed, weatherReason };
  }

  /** Merge a resolved slot back into the plan context (prompt order is
   *  restored later by orderByRequest via the slots map). */
  function mergeSlot(
    ctx: PlanCtx,
    row: { category: string; slot?: number },
    sel: Selection,
    pool: Place[]
  ): PlanCtx {
    // Replace ONLY the slot being resolved. Matching on category alone
    // overwrote a filled twin when the request repeated a category (§7.1).
    const mergedSels = ctx.sels.map((s) =>
      matchesRow(s, row) ? { ...sel, slot: s.slot ?? sel.slot } : s
    );
    const mergedPools: Pools = {
      ...ctx.pools,
      [sel.category]: mergePlacePools(ctx.pools[sel.category], pool),
    };
    const mergedSlots =
      sel.category === row.category
        ? ctx.slots
        : { ...ctx.slots, [sel.category]: ctx.slots[row.category] ?? row.category };
    const requestedCategories =
      ctx.parseData.category_signals.length > 0
        ? ctx.parseData.category_signals
        : mergedSels.map((selection) => selection.category);
    return {
      ...ctx,
      sels: mergedSels,
      pools: mergedPools,
      slots: mergedSlots,
      arrivalBySlot: provisionalArrivals(
        requestedCategories,
        ctx.startInstant,
        mergedSels
      ),
    };
  }

  // Re-resolve ONE empty category — widen (drop the neighbourhood, search
  // city-wide) or replace (search a new category the user names) — leaving
  // every other stop untouched. Reuses the places route's categoriesOverride
  // (the same subset-search the reroute engine uses) + the select route.
  async function resolveEmpty(
    row: EmptyRow,
    opts: { searchCategory: string; dropLocation: boolean }
  ) {
    if (recovery?.mode !== "empty") return;
    const { ctx } = recovery;
    const searchCategory = opts.searchCategory.trim();
    if (!searchCategory) return;
    const operation = beginOperation();
    if (!operation) return;
    setRecovery({ ...recovery, busy: true, note: null });
    try {
      const {
        sel: newSel,
        pool: newPool,
        drops: newDrops,
        onlyUsed,
        weatherReason,
      } = await searchSlot(ctx, row, searchCategory, {
        dropLocation: opts.dropLocation,
      });

      if (newSel && newSel.id !== null) {
        // resolved — swap the empty entry for the new pick (keeping order),
        // add its pool, and drop it from the outstanding list
        const newCtx = mergeSlot(ctx, row, newSel, newPool);
        const remaining = recovery.empties.filter((e) => rowKey(e) !== rowKey(row));
        if (remaining.length === 0) {
          setRecovery(null);
          await finishPipeline(newCtx);
        } else {
          setRecovery({ ...recovery, ctx: newCtx, empties: remaining, busy: false });
        }
      } else {
        // still nothing — honest note, keep the panel so they can try again
        const stillReason = emptyCategoryReason(
          searchCategory,
          newDrops,
          opts.dropLocation ? null : ctx.parseData.location
        );
        setRecovery({
          ...recovery,
          busy: false,
          note: {
            kind: "status",
            text: onlyUsed
              ? `${narrowedSlotReason(searchCategory, opts.dropLocation ? null : ctx.parseData.location)} Try a different kind of stop?`
              : weatherReason
                ? `${weatherReason.charAt(0).toUpperCase()}${weatherReason.slice(1)} — ${searchCategory} does not fit this slot right now. Try another?`
                : opts.dropLocation
                  ? `Still no ${searchCategory} city-wide — tell me what you'd like there instead?`
                  : `${stillReason} Try another?`,
          },
        });
      }
    } catch (err) {
      setRecovery((r) =>
        r && r.mode === "empty"
          ? {
              ...r,
              busy: false,
              note: { kind: "error", text: clientErrorMessage(err) },
            }
          : r
      );
    } finally {
      setRecovery((current) =>
        current?.mode === "empty" && current.busy
          ? { ...current, busy: false }
          : current
      );
      endOperation(operation);
    }
  }

  // user declined to recover the empty category(ies) — build the plan
  // without them (they stay skipped, as before, but now by explicit choice)
  async function planWithoutEmpties() {
    if (recovery?.mode !== "empty") return;
    const operation = beginOperation();
    if (!operation) return;
    const ctx = recovery.ctx;
    try {
      setRecovery(null);
      // the arrival check already ran for this plan and the user has decided
      // — the failing slots are emptied, so don't re-litigate them (§1.4)
      await finishPipeline(ctx, { skipArrivalCheck: true });
    } finally {
      endOperation(operation);
    }
  }

  // ── geocode-choice action ─────────────────────────────────────────────
  // Resume the exact paused pipeline with the chosen provider candidate.
  // The next run does not repeat that query, so ambiguity cannot loop.
  async function chooseGeocodeCandidate(candidate: GeocodeCandidate) {
    if (recovery?.mode !== "geocode") return;
    const operation = beginOperation();
    if (!operation) return;
    const gate = recovery;
    const geocode: PipelineGeocode =
      gate.queryType === "city"
        ? { city: candidate }
        : { ...gate.geocode, address: candidate };
    try {
      if (gate.queryType === "city") setCity(candidate.formattedAddress);
      else setStartAddress(candidate.formattedAddress);
      setRecovery(null);
      setError(null);
      // The geocode now pauses BEFORE the planner call, so resuming means
      // finishing the place resolution and then planning — not resuming a
      // parse that never happened.
      const place = await resolvePlace(gate.prompt, geocode);
      if (!place) return;
      await planFrom(gate.prompt, place);
    } catch (err) {
      setError(clientErrorMessage(err));
    } finally {
      setLoadingText(null);
      endOperation(operation);
    }
  }

  // ── weather-gate actions ──────────────────────────────────────────────
  // "Still want it": retry the blocked category(ies) with ONLY the weather
  // gate off (weather:null → the gate is skipped by keep-on-missing);
  // hours, rating, price, business status all still apply. A pick merges
  // into the plan; still-nothing becomes a normal empty slot and lands in
  // the EXISTING generic recovery flow — never a third dead end.
  async function overrideWeatherGate() {
    if (recovery?.mode !== "weather-gate") return;
    const operation = beginOperation();
    if (!operation) return;
    const gate = recovery;
    setRecovery({ ...gate, busy: true });
    setLoadingText("Checking anyway…");
    try {
      let ctx = gate.ctx;
      const resolved = new Set<string>();
      const stillEmpty: EmptyRow[] = [];
      for (const b of gate.blocks) {
        const { sel, pool, drops, onlyUsed } = await searchSlot(
          ctx,
          b,
          b.category,
          { ignoreWeather: true }
        );
        if (sel && sel.id !== null) {
          ctx = mergeSlot(ctx, b, sel, pool);
          resolved.add(rowKey(b));
        } else {
          // empty even with weather ignored — a real availability problem
          // now, so the normal empty-slot reasons (and widen) apply
          stillEmpty.push({
            category: b.category,
            slot: b.slot,
            reason: onlyUsed
              ? narrowedSlotReason(b.category, ctx.parseData.location)
              : emptyCategoryReason(b.category, drops, ctx.parseData.location),
          });
        }
      }
      // a planned stop is no longer "skipped" — drop its stale weather note
      // (unresolved/declined blocks keep theirs; those stay honestly skipped)
      if (resolved.size > 0) {
        const blockedCategories = new Set(gate.blocks.map((block) => block.category));
        const unresolvedCategories = new Set(
          stillEmpty.map((block) => block.category)
        );
        setWeatherBlocks((prev) =>
          prev.filter(
            (block) =>
              !blockedCategories.has(block.category) ||
              unresolvedCategories.has(block.category)
          )
        );
      }
      const remaining = [...stillEmpty, ...gate.pendingEmpties];
      if (remaining.length === 0) {
        setRecovery(null);
        await finishPipeline(ctx);
      } else {
        setRecovery({
          mode: "empty",
          ctx,
          empties: remaining,
          replaceText: {},
          busy: false,
          note: null,
        });
        setLoadingText(null);
      }
    } catch (err) {
      setError(clientErrorMessage(err));
    } finally {
      setRecovery((current) =>
        current?.mode === "weather-gate" && current.busy
          ? { ...current, busy: false }
          : current
      );
      setLoadingText(null);
      endOperation(operation);
    }
  }

  // "Something else": they don't want the weather-blocked thing — move to
  // replacing that slot via the existing recovery rows. The widen offer is
  // suppressed for these rows (rain isn't a radius problem); the replace
  // input is the "different direction" affordance, and "Plan without it"
  // stays available since other stops survived.
  function weatherGateSomethingElse() {
    if (recovery?.mode !== "weather-gate" || activeOperation.current) return;
    const gate = recovery;
    setRecovery({
      mode: "empty",
      ctx: gate.ctx,
      empties: [
        ...gate.blocks.map((b) => ({
          category: b.category,
          slot: b.slot,
          reason: `${b.reason.charAt(0).toUpperCase()}${b.reason.slice(1)} — pick something else for this stop?`,
          noWiden: true,
        })),
        ...gate.pendingEmpties,
      ],
      replaceText: {},
      busy: false,
      note: null,
    });
  }

  async function storeItinerary(
    sched: ScheduledStop[],
    legs: TravelLeg[],
    hl: TravelLeg | null,
    parsed: ParsedPrompt,
    poolsIn: Pools,
    simValue: string,
    home?: { label: string; location: { latitude: number; longitude: number } } | null,
    timeZone?: string
  ) {
    const enriched = sched.map((st) => {
      const loc = st.id ? (poolsIn[st.category] ?? []).find((p) => p.id === st.id)?.location : undefined;
      return loc ? { ...st, location: loc } : st;
    });
    try {
      const data = await fetchJson("/api/itinerary", {
        method: "POST",
        // The token is what lets the server stamp an owner and remember this
        // plan for the next refresh. Without it the plan is simply unowned —
        // exactly how plans behaved before this slice.
        headers: { "Content-Type": "application/json", ...((await authHeaders()) ?? {}) },
        body: JSON.stringify({
          stops: enriched,
          legs,
          parsed,
          homeLeg: hl,
          ...(home ? { home } : {}),
          ...(timeZone ? { timeZone } : {}),
        }),
        parse: parseCreatePayload,
      });
      const stored = await readItinerary(data.id, simValue);
      setItinerary(stored);
      const active = stored.stops.find((stop) => stop.status === "active");
      if (active?.id) setSelected(active.id);
    } catch (err) {
      // the plan is already rendered at this point, but without a stored id
      // there is no swapping or rerouting it — say so rather than leaving a
      // map whose controls quietly do nothing (§6.4)
      throw new Error(
        `${clientErrorMessage(err)} — the plan is shown but can't be swapped or rerouted; try planning again.`
      );
    }
  }

  async function readItinerary(id: string, simValue: string): Promise<Itinerary> {
    const nowISO = simValue ? new Date(simValue).toISOString() : "";
    const url = `/api/itinerary/${id}${nowISO ? `?now=${encodeURIComponent(nowISO)}` : ""}`;
    return fetchJson<Itinerary>(url, {
      // Carries identity so the server can archive on conclusion. Absent when
      // there is no session; the route treats that as guest-level, so this is
      // additive rather than a new requirement.
      headers: await authHeaders(),
      parse: parseItineraryPayload,
    });
  }

  async function refreshItinerary(id: string, simValue: string) {
    try {
      const data = await readItinerary(id, simValue);
      setItinerary(data);
      const active = data.stops.find((s) => s.status === "active");
      if (active?.id) setSelected(active.id);
      return data;
    } catch (err) {
      // a silent return left the strip and map showing state the store no
      // longer agrees with — including right after a swap or reroute that
      // actually succeeded server-side (code-audit 2026-07-18 §6.4)
      setError(
        `Couldn't refresh the plan — what you see may be out of date. (${clientErrorMessage(err)})`
      );
      return null;
    }
  }

  async function updateSimulationTime(value: string) {
    if (!itinerary) return;
    const operation = beginOperation();
    if (!operation) return;
    setSimNow(value);
    setLoadingText("Refreshing the simulated time…");
    try {
      await refreshItinerary(itinerary.id, value);
    } finally {
      setLoadingText(null);
      endOperation(operation);
    }
  }

  function applyItinerary(it: Itinerary) {
    setItinerary(it);
    setSchedule(it.stops as ScheduledStop[]);
    setMapStops(stopsFromItinerary(it));
    setHomeLeg(it.homeLeg ?? null);
  }

  useEffect(() => {
    itineraryRef.current = itinerary;
  }, [itinerary]);

  // ── resume the caller's active plan on load ──
  //
  // THE BUG THIS FIXES, precisely: the plan was never lost. It sits in Redis
  // for seven days. `itinerary` lived in React state and nothing else, so a
  // refresh forgot which ID it was showing and fell back to the landing page.
  // The server now records uid → current plan id, and this asks for it.
  //
  // Identical for guests and signed-in users — persistence is core function,
  // never gated on having an account.
  useEffect(() => {
    // Wait for auth to settle: firing before the anonymous sign-in lands
    // would send no token and resume nothing.
    if (auth.status !== "signed-in") return;
    if (resumeAttempted.current) return;
    resumeAttempted.current = true;
    // Never stomp on work in progress — someone who started planning while
    // the token was resolving keeps what they are doing.
    if (itineraryRef.current) return;

    let cancelled = false;
    void (async () => {
      try {
        const headers = await authHeaders();
        if (!headers) return;
        const data = await fetchJson<{ itinerary: unknown }>("/api/itinerary", { headers });
        if (cancelled || !data.itinerary) return;
        const stored = parseItineraryPayload(data.itinerary);
        if (itineraryRef.current) return;
        applyItinerary(stored);
        const active = stored.stops.find((s) => s.status === "active");
        if (active?.id) setSelected(active.id);
      } catch {
        // A failed resume leaves the landing page — the pre-1B behaviour, and
        // a working app. Never an error banner for something the user did not
        // ask for.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [auth.status, authHeaders]);

  function mutationOutcomeMayBeAmbiguous(err: unknown): boolean {
    if (!(err instanceof ClientFetchError)) return true;
    return (
      err.status === null ||
      err.code === "invalid_json" ||
      err.code === "invalid_payload" ||
      (err.status != null && err.status >= 500)
    );
  }

  async function fireDisruption() {
    if (!itinerary) return;
    const operation = beginOperation();
    if (!operation) return;
    const timed = itinerary.stops.filter((s) => s.start_time);
    const broken = timed[disruptLeg]?.travelToNext;
    const legName =
      broken?.transit?.lineName ?? (broken?.mode === "transit" ? "The transit leg" : "That leg");
    let focusTargetId =
      timed[disruptLeg + 1]?.id ?? timed[disruptLeg]?.id ?? selected;

    const nowISO = simNow ? new Date(simNow).toISOString() : undefined;
    let mutationApplied = false;
    setError(null);
    setBanner(null);
    setLoadingText("Replanning the route…");
    try {
      const data = await fetchJson(
        `/api/itinerary/${itinerary.id}/reroute`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            disruption: { type: "transit_cancelled", legIndex: disruptLeg },
            version: itinerary.version,
            ...(nowISO ? { now: nowISO } : {}),
          }),
          parse: parseReroutePayload,
        }
      );
      if (!data.rerouted) {
        setBannerFlat(true);
        setBanner(`${legName} cancelled — ${data.reason}.`);
        setChangedIds(new Set());
        return;
      }
      mutationApplied = true;
      const updated = await readItinerary(itinerary.id, nowISO ?? "");

      // capture pre-reroute starts for the strike-through, keyed by venue id
      const olds: Record<string, string | null> = {};
      const ids = new Set<string>();
      for (const changed of data.changed) {
        const stop = updated.stops[changed.stopIndex];
        if (stop?.id) {
          ids.add(stop.id);
          olds[stop.id] = changed.before.start;
        }
      }
      applyItinerary(updated);
      setChangedIds(ids);
      setOldStarts(olds);
      // surface the change: expand the first replanned stop so its new venue
      // and settled time are the hero of the moment
      const firstChanged = data.changed[0];
      if (firstChanged) {
        const changedId = updated.stops[firstChanged.stopIndex]?.id ?? null;
        setSelected(changedId);
        focusTargetId = changedId ?? focusTargetId;
      }

      // the banner shows the instant the new chain actually departs from —
      // for an unstarted plan that's the kept stop's committed end, not `now`
      const floorLabel = formatStopTime(
        data.anchor_time,
        new Date(),
        itinerary.timeZone ?? planZone
      );
      const kept = updated.stops.find(
        (stop) => stop.status === "active" || stop.status === "completed"
      );
      setBannerFlat(false);
      setBanner(
        `${legName} cancelled. Replanned from ${floorLabel}` +
          (kept ? ` — your ${kept.category}'s unchanged.` : ".")
      );
    } catch (err) {
      const detail = clientErrorMessage(err);
      if (!mutationApplied && mutationOutcomeMayBeAmbiguous(err)) {
        try {
          const latest = await readItinerary(itinerary.id, nowISO ?? "");
          applyItinerary(latest);
          const checkStop =
            latest.stops.filter((stop) => stop.start_time)[disruptLeg + 1] ?? null;
          if (checkStop?.id) {
            setSelected(checkStop.id);
            focusTargetId = checkStop.id;
          }
          setError(
            `The reroute response was interrupted, so the latest saved plan was refreshed. Check the route before retrying. (${detail})`
          );
        } catch (refreshErr) {
          setError(
            `The reroute response was interrupted and the saved plan could not be refreshed; what you see may be out of date. (${clientErrorMessage(refreshErr)})`
          );
        }
        return;
      }
      setError(
        mutationApplied
          ? `Couldn't refresh the replanned itinerary — what you see may be out of date. (${detail})`
          : detail
      );
    } finally {
      setLoadingText(null);
      endOperation(operation);
      if (focusTargetId) requestStripFocus(focusTargetId);
    }
  }

  // Surgical per-stop swap: replace the selected upcoming stop from its
  // mini-prompt, reusing the reroute reflow visuals for the result.
  async function doSwap() {
    if (!itinerary || !selected) return;
    const refinement = swapText.trim();
    if (!refinement) return;
    // stops are identified by VENUE ID: two stops can share a category, and
    // findIndex by category always returned the FIRST one (§7.2)
    const stopIndex = itinerary.stops.findIndex((s) => s.id === selected);
    if (stopIndex < 0) return;
    const operation = beginOperation();
    if (!operation) return;
    let focusTargetId = itinerary.stops[stopIndex]?.id ?? selected;

    setSwapping(true);
    setSwapError(null);
    setError(null);
    setBanner(null);
    const nowISO = simNow ? new Date(simNow).toISOString() : undefined;
    let mutationApplied = false;
    // pre-swap starts (by id) so downstream shifts can strike-through
    const oldById = Object.fromEntries(
      itinerary.stops.filter((s) => s.id).map((s) => [s.id as string, s.start_time])
    );
    try {
      const data = await fetchJson(`/api/itinerary/${itinerary.id}/swap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stopIndex,
          refinement,
          version: itinerary.version,
          ...(nowISO ? { now: nowISO } : {}),
        }),
        parse: parseSwapPayload,
      });
      if (!data.swapped) {
        // honest refusal — nothing better found, original kept
        setBannerFlat(true);
        setBanner(data.reason);
        return;
      }
      mutationApplied = true;
      const updated = await readItinerary(itinerary.id, nowISO ?? "");

      const ids = new Set<string>();
      const olds: Record<string, string | null> = {};
      const swapped = updated.stops[data.stopIndex];
      if (!swapped) {
        throw new Error("The service returned an unexpected response. Please try again.");
      }
      // the swapped stop: venue changed, slot held → no time strike, just settle
      if (swapped.id) ids.add(swapped.id);
      // downstream shifts: their times moved → strike old, settle new
      for (const downstreamIndex of data.downstreamShifted) {
        const stop = updated.stops[downstreamIndex];
        if (stop?.id) {
          ids.add(stop.id);
          olds[stop.id] = oldById[stop.id] ?? null;
        }
      }
      applyItinerary(updated);
      setChangedIds(ids);
      setOldStarts(olds);
      setSelected(swapped.id ?? null);
      focusTargetId = swapped.id ?? focusTargetId;
      setSwapText("");
      setBannerFlat(false);
      // time/duration reasons are self-contained ("Moved dinner to 7:29 PM",
      // "Extended dinner to 2 hours"); venue reasons describe the pick, so
      // they get the "Swapped" lead.
      setBanner(
        data.path === "time" || data.path === "duration"
          ? data.reason
          : `Swapped ${data.before.category} — ${data.reason}`
      );
    } catch (err) {
      const detail = clientErrorMessage(err);
      if (!mutationApplied && mutationOutcomeMayBeAmbiguous(err)) {
        try {
          const latest = await readItinerary(itinerary.id, nowISO ?? "");
          applyItinerary(latest);
          const refreshedId = latest.stops[stopIndex]?.id ?? null;
          setSelected(refreshedId);
          focusTargetId = refreshedId ?? focusTargetId;
          setSwapError(
            `The swap response was interrupted, so the latest saved plan was refreshed. Check this stop before retrying. (${detail})`
          );
        } catch (refreshErr) {
          setSwapError(
            `The swap response was interrupted and the saved plan could not be refreshed; what you see may be out of date. (${clientErrorMessage(refreshErr)})`
          );
        }
        return;
      }
      setSwapError(
        mutationApplied
          ? `The swap finished, but the follow-up refresh failed; what you see may be out of date. (${detail})`
          : detail
      );
    } finally {
      setSwapping(false);
      endOperation(operation);
      if (focusTargetId) requestStripFocus(focusTargetId);
    }
  }

  // merge live status + changed flags (by venue id) onto the base map stops
  const styledStops = useMemo<MapStop[]>(
    () =>
      mapStops.map((ms) => ({
        ...ms,
        status: itinerary?.stops.find((s) => s.id === ms.id)?.status,
        changed: changedIds.has(ms.id),
        oldStart: oldStarts[ms.id] ?? null,
      })),
    [mapStops, itinerary, changedIds, oldStarts]
  );

  const selectedStop = itinerary?.stops.find((s) => s.id === selected) ?? null;
  const canSwap = !!selectedStop && selectedStop.status === "upcoming" && selectedStop.id !== null;

  // the plan's origin: per-itinerary geocoded home, else the classic default
  const homeOrigin = itinerary?.home ?? homePoint ?? HOME;
  // the zone every label on this plan renders in (persisted zone wins)
  const displayZone = itinerary?.timeZone ?? planZone;

  const mapHome = useMemo<MapHome | null>(() => {
    if (!homeLeg) return null;
    const first = (schedule ?? []).find((s) => s.start_time);
    const leaveBy =
      first?.start_time != null
        ? formatStopTime(new Date(new Date(first.start_time).getTime() - homeLeg.totalMinutes * 60_000), new Date(), displayZone)
        : null;
    return {
      label: homeOrigin.label,
      lat: homeOrigin.location.latitude,
      lng: homeOrigin.location.longitude,
      legModeToNext: homeLeg.mode,
      polylineToNext: homeLeg.encodedPolyline,
      legLabel: legDetail(homeLeg),
      legSegments: legSegments(homeLeg),
      leaveBy,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homeLeg, schedule, homeOrigin.label, homeOrigin.location.latitude, homeOrigin.location.longitude, displayZone]);

  const timedStops = itinerary?.stops.filter((s) => s.start_time) ?? [];

  // price is only known from the pools; look it up by venue id
  const priceById = useMemo(() => {
    const m: Record<string, string> = {};
    for (const arr of Object.values(pools)) {
      for (const p of arr) if (p.priceLevel) m[p.id] = p.priceLevel;
    }
    return m;
  }, [pools]);

  // strip cards, left→right: home leg card handled separately
  const stripStops = useMemo<StripStop[]>(() => {
    if (!itinerary) return [];
    const venues = itinerary.stops.filter((s) => s.id !== null);
    return venues.map((s, i) => {
      const next = venues[i + 1];
      const leg = s.travelToNext;
      return {
        id: s.id!,
        category: s.category,
        name: s.name ?? "(unnamed)",
        start: s.start_time,
        end: s.end_time,
        rating: s.rating ?? null,
        // the stop's own price wins — the pools lookup goes stale the
        // moment a swap/reroute picks a venue that was never in them
        price: s.priceLevel ?? priceById[s.id!] ?? null,
        description: s.description ?? null,
        reason: s.reason ?? null,
        status: s.status,
        changed: changedIds.has(s.id!),
        oldStart: oldStarts[s.id!] ?? null,
        legToNext: leg
          ? {
              mode: leg.mode,
              totalMinutes: leg.totalMinutes,
              marginMinutes: leg.marginMinutes,
              lineName: leg.transit?.lineName ?? null,
              headsign: leg.transit?.headsign ?? null,
              stopCount: leg.transit?.stopCount ?? null,
              departStop: leg.transit?.departStop ?? null,
              boardISO: s.end_time,
              arriveISO: next?.start_time ?? null,
              // pre-segments stored plans fall back to the single ride
              segments: leg.transitSegments ?? (leg.transit ? [leg.transit] : null),
            }
          : null,
      };
    });
  }, [itinerary, priceById, changedIds, oldStarts]);

  const stripHome = useMemo<StripHome | null>(() => {
    if (!homeLeg || !itinerary) return null;
    const first = itinerary.stops.find((s) => s.start_time && s.id !== null);
    const leaveISO =
      first?.start_time != null
        ? new Date(new Date(first.start_time).getTime() - homeLeg.totalMinutes * 60_000).toISOString()
        : null;
    return {
      label: (itinerary.home ?? homePoint ?? HOME).label,
      leaveBy: leaveISO ? formatStopTime(leaveISO, new Date(), displayZone) : null,
      leg: {
        mode: homeLeg.mode,
        totalMinutes: homeLeg.totalMinutes,
        marginMinutes: homeLeg.marginMinutes,
        lineName: homeLeg.transit?.lineName ?? null,
        headsign: homeLeg.transit?.headsign ?? null,
        stopCount: homeLeg.transit?.stopCount ?? null,
        departStop: homeLeg.transit?.departStop ?? null,
        boardISO: leaveISO,
        arriveISO: first?.start_time ?? null,
        segments: homeLeg.transitSegments ?? (homeLeg.transit ? [homeLeg.transit] : null),
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homeLeg, itinerary, homePoint, displayZone]);

  const wxNow = weather?.[0] ?? null;

  // Up to three planner-authored questions before search — inline,
  // minimal, skippable. The shapes are uniform now (question + chips +
  // free text) because the questions are no longer a fixed set of ids the
  // UI could special-case; every one is keyed by its own id.
  const clarifyBlock = clarify && (
    <div className={"clarify" + (itinerary ? " clarify--stage" : "")}>
      {clarify.questions.map((qq, questionIndex) => {
        const questionLabelId = `clarify-question-${questionIndex}`;
        const answer = clarifyAnswers[qq.id] ?? "";
        const setAnswer = (value: string) =>
          setClarifyAnswers((m) => ({ ...m, [qq.id]: value }));
        // "pick a time" is a prompt for the text box, not an answer on its
        // own — selecting it opens the box rather than submitting the words
        const isPlaceholderChip = (o: string) => /^pick a time$/i.test(o);
        return (
          <div
            key={qq.id}
            className="clarify__q"
            role="group"
            aria-labelledby={questionLabelId}
          >
            <div id={questionLabelId} className="clarify__label">
              {qq.question}
            </div>
            <div className="clarify__chips">
              {qq.options.map((o) => {
                const pressed = answer === o;
                return (
                  <button
                    key={o}
                    type="button"
                    className={`chipbtn ${pressed ? "chipbtn--on" : ""}`}
                    aria-pressed={pressed}
                    disabled={busy}
                    onClick={() => setAnswer(o)}
                  >
                    {o}
                  </button>
                );
              })}
              <input
                className="clarify__input"
                value={isPlaceholderChip(answer) ? "" : answer}
                disabled={busy}
                onChange={(e) => setAnswer(e.target.value)}
                placeholder="or type one…"
                aria-label={qq.question}
              />
            </div>
          </div>
        );
      })}
      <div className="clarify__actions">
        <button
          type="button"
          className="clarify__go"
          disabled={busy}
          onClick={() => submitClarify(false)}
        >
          Go
        </button>
        <button
          type="button"
          className="clarify__skip"
          disabled={busy}
          onClick={() => submitClarify(true)}
        >
          Skip — just plan it
        </button>
      </div>
    </div>
  );

  // partial-failure recovery — one category came back empty; name the
  // reason, offer to widen (city-wide) or replace it. Reuses the clarify
  // panel's look; the widen offer only shows when there's a neighbourhood
  // to drop (an already-city-wide search can't be widened).
  const recoveryCanWiden = !!(
    recovery &&
    recovery.mode === "empty" &&
    recovery.ctx.parseData.location &&
    String(recovery.ctx.parseData.location).trim() &&
    String(recovery.ctx.parseData.location).trim().toLowerCase() !== "unspecified"
  );
  // gate variants of the SAME panel: a real choice — push past a weather
  // block, or change direction — never a dead-end refusal string
  const recoveryBlock =
    recovery && recovery.mode === "geocode" ? (
      <div
        className={"clarify recover recover--gate" + (itinerary ? " clarify--stage" : "")}
        role="group"
        aria-label={
          recovery.queryType === "city"
            ? "Choose the city you meant"
            : "Choose your starting address"
        }
      >
        <div className="clarify__q">
          <div className="clarify__label recover__reason">{recovery.message}</div>
          <div className="clarify__chips recover__geocodechoices">
            {recovery.candidates.map((candidate) => (
              <button
                key={
                  candidate.placeId ??
                  `${candidate.formattedAddress}:${candidate.location.latitude}:${candidate.location.longitude}`
                }
                className="chipbtn recover__geocode"
                disabled={busy}
                aria-label={`Use ${candidate.formattedAddress}`}
                onClick={() => chooseGeocodeCandidate(candidate)}
              >
                {candidate.formattedAddress}
              </button>
            ))}
          </div>
        </div>
      </div>
    ) : recovery && recovery.mode === "weather-gate" ? (
      <div className={"clarify recover recover--gate" + (itinerary ? " clarify--stage" : "")}>
        {recovery.blocks.map((b) => (
          <div key={rowKey(b)} className="clarify__q">
            <div className="clarify__label recover__reason">
              {b.reason.charAt(0).toUpperCase() + b.reason.slice(1)} — {b.category} might not be
              great right now. Still want it, or something else?
            </div>
          </div>
        ))}
        <div className="clarify__chips">
          <button className="chipbtn recover__override" disabled={busy} onClick={overrideWeatherGate}>
            Still want it
          </button>
          <button className="chipbtn recover__else" disabled={busy} onClick={weatherGateSomethingElse}>
            Something else
          </button>
        </div>
      </div>
    ) : recovery && (
    <div className={"clarify recover" + (itinerary ? " clarify--stage" : "")}>
      {recovery.busy && (
        <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          Finding another place for this stop…
        </div>
      )}
      {recovery.empties.map((e) => (
        <div key={rowKey(e)} className="clarify__q">
          <div className="clarify__label recover__reason">{e.reason}</div>
          <div className="clarify__chips">
            {recoveryCanWiden && !e.noWiden && (
              <button
                className="chipbtn recover__widen"
                disabled={busy}
                onClick={() => resolveEmpty(e, { searchCategory: e.category, dropLocation: true })}
              >
                {widenOfferLabel(recovery.ctx.parseData.location)}
              </button>
            )}
            <input
              className="clarify__input recover__input"
              disabled={busy}
              value={recovery.replaceText[rowKey(e)] ?? ""}
              onChange={(ev) =>
                setRecovery((r) =>
                  r && r.mode === "empty"
                    ? { ...r, replaceText: { ...r.replaceText, [rowKey(e)]: ev.target.value } }
                    : r
                )
              }
              onKeyDown={(ev) => {
                if (ev.key === "Enter" && !busy && recovery.replaceText[rowKey(e)]?.trim())
                  resolveEmpty(e, {
                    searchCategory: recovery.replaceText[rowKey(e)],
                    dropLocation: false,
                  });
              }}
              placeholder={`or try something else there…`}
              aria-label={`Replace ${e.category}`}
            />
            <button
              className="chipbtn recover__go"
              disabled={busy || !recovery.replaceText[rowKey(e)]?.trim()}
              onClick={() =>
                resolveEmpty(e, {
                  searchCategory: recovery.replaceText[rowKey(e)],
                  dropLocation: false,
                })
              }
            >
              Go
            </button>
          </div>
        </div>
      ))}
      {recovery.note && (
        <div
          className="clarify__label recover__note"
          role={recovery.note.kind === "error" ? "alert" : "status"}
          aria-live={recovery.note.kind === "status" ? "polite" : undefined}
        >
          {recovery.note.text}
        </div>
      )}
      {/* "Plan without it" only makes sense when something ELSE was
          actually picked — an all-empty panel (post-override) has nothing
          to plan around, so recovering or redirecting are the options */}
      {recovery.ctx.sels.some((s) => s.id !== null) && (
        <div className="clarify__actions">
          <button className="clarify__skip recover__skip" disabled={busy} onClick={planWithoutEmpties}>
            Plan without it
          </button>
        </div>
      )}
    </div>
  );

  // ── empty state ──
  if (!itinerary) {
    return (
      <main className="empty">
        {/* decorative sky layers — the horizon curve and reflection band
            live in CSS (.empty::before/::after); this is the wordmark glow */}
        <div className="empty__glow" aria-hidden="true" />
        <div className="empty__mark" aria-hidden="true">Itinerary</div>
        {/* Account corner — mirrors the wordmark across the hero. It is an
            ENTRY POINT, never a gate: the app has always worked with no
            account and still does, so nothing below is locked behind it.
            While auth is still resolving we render nothing rather than a
            "Sign in" that might flip to a name a moment later. */}
        {signedInForReal && auth.user ? (
          <div className="acct">
            <div className="acct__who">
              {auth.user.photoURL ? (
                // eslint-disable-next-line @next/next/no-img-element -- provider avatar on an unconfigurable remote host
                <img
                  className="acct__avatar"
                  src={auth.user.photoURL}
                  alt=""
                  referrerPolicy="no-referrer"
                />
              ) : (
                <span className="acct__initials" aria-hidden="true">
                  {userInitials(auth.user)}
                </span>
              )}
              <span className="acct__name">{userLabel(auth.user)}</span>
            </div>
            <button type="button" className="acct__out" onClick={() => void auth.signOut()}>
              Sign out
            </button>
          </div>
        ) : auth.status !== "loading" ? (
          // A guest is now signed in ANONYMOUSLY rather than not signed in at
          // all, so this can no longer key off "signed-out" — that state is
          // reached only when Firebase is unavailable. Both cases offer the
          // same thing: a way in, with nothing gated behind it.
          <div className="acct">
            <button
              type="button"
              className="acct__signin"
              onClick={() => {
                auth.clearError();
                setLoginOpen(true);
              }}
            >
              Sign in
            </button>
          </div>
        ) : null}
        {loginOpen && <LoginScreen auth={auth} onDismiss={() => setLoginOpen(false)} />}
        <h1 className="empty__title">Itinerary</h1>
        <div className="empty__sub">life moves simpler.</div>
        {/* ONE pill, three labelled sections. Exactly the same three inputs,
            state, validation and submit trigger as before — only the
            presentation changed from three separate controls to one. */}
        <form
          className="prompt"
          onSubmit={(event) => {
            event.preventDefault();
            void runPipeline();
          }}
        >
          <div className="prompt__sec prompt__sec--search">
            <label className="prompt__label" htmlFor="q-search">
              Search
            </label>
            <input
              id="q-search"
              className="prompt__input"
              disabled={busy}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="ramen then a quiet bar in Ossington"
              aria-label="Describe your evening"
              autoFocus
            />
          </div>
          <div className="prompt__sec">
            <label className="prompt__label" htmlFor="q-city">
              City
            </label>
            <input
              id="q-city"
              className="where__input"
              disabled={busy}
              value={city}
              onChange={(e) => setCity(e.target.value)}
              placeholder="City"
              aria-label="City"
            />
          </div>
          <div className="prompt__sec">
            <label className="prompt__label" htmlFor="q-start">
              Starting location
            </label>
            <input
              id="q-start"
              className="where__input where__input--addr"
              disabled={busy}
              value={startAddress}
              onChange={(e) => setStartAddress(e.target.value)}
              placeholder="optional — city centre"
              aria-label="Starting address"
            />
          </div>
          <button
            type="submit"
            className="prompt__go"
            disabled={busy || !prompt.trim() || !city.trim()}
            aria-label={busy ? loadingText ?? "Planning" : "Plan it"}
            title={busy ? loadingText ?? "Planning" : "Plan it"}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.5-3.5" />
            </svg>
          </button>
        </form>
        {busy && loadingText && (
          <div
            className="empty__status"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {loadingText}
          </div>
        )}
        {clarifyBlock}
        {recoveryBlock}
        {error && <div className="empty__err" role="alert">{error}</div>}
      </main>
    );
  }

  // ── map stage ──
  return (
    <main className={"stage" + (banner ? " stage--banner" : "")}>
      <h1 className="sr-only">Your itinerary</h1>
      <ItineraryMap stops={styledStops} home={mapHome} selected={selected} timeZone={displayZone} onSelect={(c) => setSelected((cur) => (cur === c ? cur : c))} />

      {wxNow && (
        <div className="weather" aria-label={`Current weather — ${city.trim() || "Toronto"}`}>
          <WeatherIcon condition={wxNow.condition} precip={wxNow.precipProbability} />
          <span className="weather__temp">{wxNow.tempC != null ? `${Math.round(wxNow.tempC)}°` : "—"}</span>
          {wxNow.condition && <span className="weather__cond">{wxNow.condition}</span>}
        </div>
      )}

      <ItineraryStrip
        home={stripHome}
        stops={stripStops}
        selected={selected}
        timeZone={displayZone}
        onSelect={(c) => setSelected(c)}
        focusRequest={stripFocusRequest}
        onFocusHandled={(nonce) =>
          setStripFocusRequest((current) =>
            current?.nonce === nonce ? null : current
          )
        }
        swap={{
          text: swapText,
          onText: setSwapText,
          onSubmit: doSwap,
          submitting: swapping,
          disabled: busy,
          error: swapError,
          canSwap,
        }}
      />

      <form
        className="topbar"
        onSubmit={(event) => {
          event.preventDefault();
          void runPipeline();
        }}
      >
        <span className="topbar__mark">Itinerary</span>
        <span className="topbar__rule" aria-hidden="true" />
        <input
          className="topbar__input"
          disabled={busy}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          aria-label="Describe your evening"
        />
        <button type="submit" className="topbar__go" disabled={busy || !prompt.trim()}>
          {busy ? "…" : "Replan"}
        </button>
      </form>

      {loadingText && (
        <div className="loading" role="status" aria-live="polite" aria-atomic="true">
          {loadingText}
        </div>
      )}

      {clarifyBlock}
      {recoveryBlock}

      {banner && (
        <div
          className={"banner banner--show" + (bannerFlat ? " banner--flat" : "")}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {banner}
        </div>
      )}
      {error && <div className="stage__err" role="alert">{error}</div>}

      {weatherBlocks.length > 0 && (
        <div style={{ position: "absolute", bottom: 70, left: 16, zIndex: 19, display: "flex", flexDirection: "column", gap: 6 }}>
          {weatherBlocks.map((b) => (
            <div
              key={b.category}
              style={{
                background: "var(--card)",
                border: "1px solid var(--rule)",
                borderLeft: "3px solid var(--ink-soft)",
                borderRadius: "0 9px 9px 0",
                padding: "7px 12px",
                fontFamily: "var(--grot)",
                fontSize: 12.5,
                color: "var(--ink-soft)",
              }}
            >
              Skipped the {b.category} — {b.reason}.
            </div>
          ))}
        </div>
      )}

      {/* Development-only time + disruption simulators. Production gets no
          control unless the explicit public build-time flag opts in. */}
      {SHOW_DEV_CONTROLS && (devOpen ? (
        <div className="dev" role="region" aria-label="Development controls">
          <div className="dev__title">
            <span>Dev</span>
            <button
              type="button"
              className="ghost"
              style={{ marginLeft: "auto", padding: "2px 7px" }}
              aria-label="Hide development controls"
              onClick={() => setDevOpen(false)}
            >
              hide
            </button>
          </div>
          <div className="dev__row">
            <label htmlFor="dev-time">time</label>
            <input
              id="dev-time"
              type="datetime-local"
              disabled={busy}
              value={simNow}
              onChange={(e) => void updateSimulationTime(e.target.value)}
            />
            <button
              type="button"
              className="ghost"
              disabled={busy}
              aria-label="Use real time"
              onClick={() => void updateSimulationTime("")}
            >
              real
            </button>
          </div>
          <div className="dev__row">
            <label htmlFor="dev-leg">leg</label>
            <select
              id="dev-leg"
              value={disruptLeg}
              disabled={busy}
              onChange={(e) => setDisruptLeg(Number(e.target.value))}
            >
              {timedStops.slice(0, -1).map((s, i) => (
                <option key={i} value={i}>
                  {s.name} → {timedStops[i + 1]?.name} ({s.travelToNext?.mode ?? "?"})
                </option>
              ))}
            </select>
            <button type="button" disabled={busy} onClick={fireDisruption}>
              cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="dev dev__collapsed"
          aria-label="Show development controls"
          onClick={() => setDevOpen(true)}
        >
          Dev
        </button>
      ))}
    </main>
  );
}
