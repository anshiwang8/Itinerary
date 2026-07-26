"use client";

import { useMemo, useRef, useState } from "react";
import {
  buildSchedule,
  resolveStartTime,
  resolveStartTimeChecked,
  ScheduledStop,
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
} from "./lib/planGuards";
import {
  applyNarrowAnswer,
  categoriesForKindAnswer,
  ClarifyQuestion,
  clarifyQuestions,
  kindQuestion,
  timeWindowForWhenAnswer,
} from "./lib/clarify";
import {
  finalizeRequestedSlots,
  resolveRequestedSlots,
  slotsFromDistributionAnswer,
} from "./lib/planSlots";
import type { Selection } from "./api/select/selectVenues";
import type { DropEntry, ParsedPrompt } from "./api/places/search/filter";
import { isOpenAtInstant, type CurrentOpeningHours } from "./api/places/search/hours";
import { ClientFetchError, fetchJson } from "./lib/clientFetch";
import {
  parseCreatePayload,
  parseGeocodePayload,
  parseItineraryPayload,
  parseParsedPayload,
  parsePlacesPayload,
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
import ItineraryMap, { MapHome, MapStop } from "./ItineraryMap";
import ItineraryStrip, { StripHome, StripStop } from "./ItineraryStrip";

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

// everything the tail of the pipeline needs to build + store a plan —
// captured so a partial-failure recovery can pause and resume without
// re-deriving geocode/zone/weather/pools
interface PlanCtx {
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

  // lightweight clarifying questions (rule-based, pre-search)
  const [clarify, setClarify] = useState<{
    questions: ClarifyQuestion[];
    parsed: ParsedPrompt;
  } | null>(null);
  const [clarifyWhen, setClarifyWhen] = useState<string | null>(null);
  const [clarifyTime, setClarifyTime] = useState("");
  const [clarifyVibe, setClarifyVibe] = useState("");
  const [clarifyKind, setClarifyKind] = useState("");
  const [clarifyDistribution, setClarifyDistribution] = useState("");
  // narrowing answers for GENERIC categories ("restaurant" -> "Italian"),
  // keyed by the category each narrow question targets — there can be
  // several in one clarify round ("dinner and drinks" is two)
  const [clarifyNarrow, setClarifyNarrow] = useState<Record<string, string>>({});

  // The interactive-recovery panel — one component, three triggers:
  //  - "empty": SOME (or, after an override, ALL) categories came back
  //    empty → honest reason + widen / replace that slot. Rows flagged
  //    noWiden suppress the widen offer (a weather problem isn't a radius
  //    problem — widening can't fix rain).
  //  - "time-gate" (batch 4b): the user typed NO time and our own inferred
  //    slot landed outside a known category band → a real choice ("still
  //    want it" bypasses the gate; "something else" re-opens the kind
  //    picker) instead of a dead-end refusal string.
  //  - "weather-gate": a category came back empty specifically because the
  //    WEATHER blocked it while others survived → the honest reason plus
  //    the same real choice ("still want it" retries that category with
  //    ONLY the weather gate off; "something else" moves to replacing the
  //    slot) — never the useless widen offer.
  const [recovery, setRecovery] = useState<
    | {
        mode: "empty";
        ctx: PlanCtx;
        empties: EmptyRow[];
        replaceText: Record<string, string>;
        busy: boolean;
        note: string | null;
      }
    | {
        mode: "time-gate";
        parsed: ParsedPrompt;
        reason: string;
        category: string;
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

  async function runPipeline() {
    const q = prompt.trim();
    if (!q) return;
    const operation = beginOperation();
    if (!operation) return;
    setError(null);
    setBanner(null);
    setChangedIds(new Set());
    setOldStarts({});
    setSwapError(null);
    setClarify(null);
    setRecovery(null);
    // A new attempt never inherits another plan's forecast or skip notes.
    // If this attempt's weather read fails, unknown is more honest than
    // stale weather from a different city or time.
    setWeather(null);
    setWeatherBlocks([]);
    // THE fail-loud surface: every degenerate/impossible/contradictory
    // input lands here with a reason + a suggested fix — never an empty
    // map, never a borrowed error from the wrong branch.
    const fail = (reason: string) => {
      setError(reason);
      setLoadingText(null);
    };
    try {
      // nonsense never reaches the LLM ("." / "asdfghjkl")
      const degenerate = degeneratePromptReason(q);
      if (degenerate) return fail(degenerate);

      setLoadingText("Reading your evening…");
      const parseData = await fetchJson<ParsedPrompt>("/api/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: q }),
        parse: parseParsedPayload,
      });
      // the city is app-supplied input, never LLM-inferred — it rides on
      // the parse so swap/reroute re-searches inherit it from the store
      parseData.city = city.trim();
      setParsedObj(parseData);

      // parse extracted nothing AND the prompt is degenerate → "couldn't
      // understand"; a sincere-but-vague prompt falls through to the
      // general "things to do" pool instead of a rejection
      const unparseable = emptyParseReason(parseData, q);
      if (unparseable) return fail(unparseable);

      // "cheap fancy dinner" — contradictory, not impossible: say so
      const contradiction = contradictionReason(q, parseData);
      if (contradiction) return fail(contradiction);

      // thin prompt → 1–2 targeted questions before spending search calls;
      // answering or skipping continues with the (possibly updated) parse
      const questions = clarifyQuestions(parseData);
      if (questions.length > 0) {
        setClarify({ questions, parsed: parseData });
        setClarifyWhen(null);
        setClarifyTime("");
        setClarifyVibe("");
        setClarifyKind("");
        setClarifyDistribution("");
        setClarifyNarrow({});
        setLoadingText(null);
        return;
      }

      await continuePipeline(parseData);
    } catch (err) {
      setError(clientErrorMessage(err));
    } finally {
      setLoadingText(null);
      endOperation(operation);
    }
  }

  // clarify answered or skipped → resume the pipeline with final parse
  async function submitClarify(skip: boolean) {
    if (!clarify) return;
    const operation = beginOperation();
    if (!operation) return;
    try {
      let updated: ParsedPrompt = { ...clarify.parsed };
      const distribution = clarify.questions.find((question) => question.id === "distribution");
      if (!skip) {
        const whenAns = clarifyWhen === "pick a time" ? clarifyTime.trim() : clarifyWhen ?? "";
        if (whenAns) updated.time_window = timeWindowForWhenAnswer(whenAns);
        if (clarifyVibe.trim()) updated.aesthetic = clarifyVibe.trim();
      // the KIND answer narrows an ultra-vague prompt to a real category;
      // an uncounted "something to do" keeps the general pool, while a
      // counted request materializes one broad kind so it can expand to
      // exactly the requested number of slots.
      if (clarifyKind.trim()) {
        const beforeKind = resolveRequestedSlots(updated);
        const cats = categoriesForKindAnswer(clarifyKind, {
          materializeGeneral: beforeKind.kind === "needs-kind",
        });
        if (cats.length > 0) updated.category_signals = cats;
      }
      if (distribution) {
        const count = updated.stop_count;
        const slots =
          typeof count === "number"
            ? slotsFromDistributionAnswer(
                clarifyDistribution,
                updated.category_signals,
                count
              )
            : null;
        if (!slots) {
          setError(
            `Describe all ${count ?? "requested"} stops, for example "${distribution.options[0] ?? "2 dinner + 1 drinks"}".`
          );
          setLoadingText(null);
          return;
        }
        updated.category_signals = slots;
      }
      // narrow answers fold back onto EXACTLY the generic signal each
      // question targeted; untouched signals (and duplicate slots of the
      // same category) pass through applyNarrowAnswer identically
      if (Object.values(clarifyNarrow).some((v) => v.trim())) {
        updated.category_signals = (updated.category_signals ?? []).map((c) => {
          const a = clarifyNarrow[c]?.trim();
          return a ? applyNarrowAnswer(c, a) : c;
        });
      }
    }
      const finalizedSlots = finalizeRequestedSlots(updated);
      if (!finalizedSlots.ok) {
        setError(finalizedSlots.reason);
        setLoadingText(null);
        return;
      }
      updated = finalizedSlots.parsed;
      setError(null);
      setClarify(null);
      setParsedObj(updated);
      await continuePipeline(updated);
    } finally {
      endOperation(operation);
    }
  }

  // everything from the time check onward — parseData is final here.
  // opts.overrideTimeGate: the user pressed "still want it" on the
  // time-gate panel — an explicit, informed confirmation — so the
  // inferred-time band check is bypassed for THIS run only.
  async function continuePipeline(
    parseData: ParsedPrompt,
    opts: { overrideTimeGate?: boolean } = {}
  ) {
    const fail = (reason: string) => {
      setError(reason);
      setLoadingText(null);
    };
    try {
      setLoadingText("Reading your evening…");
      // ── geocode the city + starting address FIRST (plain text queries —
      // real location services are deliberately future work). This resolves
      // the plan's timezone, which the plausibility check below needs — a
      // Vancouver lunch must be judged against Vancouver's clock. Never
      // silently fall back: a city the geocoder can't place fails loud. ──
      setLoadingText("Finding your city…");
      const cityQ = city.trim();
      if (!cityQ) return fail("Add a city so I know where to plan.");
      const cityData = await fetchJson("/api/geocode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: cityQ }),
        parse: parseGeocodePayload,
      });
      // the plan's resolved zone (geocoder-derived); fail-soft to Toronto —
      // a missing zone must not block a plan, but it's surfaced (banner + log)
      let planZone: string = cityData.timeZone ?? "America/Toronto";
      let hp: { label: string; location: { latitude: number; longitude: number } } = {
        label: `Start · ${cityQ} centre`,
        location: cityData.location,
      };
      const addrQ = startAddress.trim();
      if (addrQ) {
        const addrData = await fetchJson("/api/geocode", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: `${addrQ}, ${cityQ}` }),
          parse: parseGeocodePayload,
        });
        hp = { label: `Start · ${addrData.label ?? addrQ}`, location: addrData.location };
        if (addrData.timeZone) planZone = addrData.timeZone;
      }
      if (!cityData.timeZone) {
        // fail-soft, but never silent
        console.warn(`[timezone] no zone resolved for "${cityQ}" — defaulting to America/Toronto`);
      }
      setHomePoint(hp);
      setPlanZone(planZone);
      // the plan's starting point rides on the parse (like parsed.city) so
      // select can weigh each candidate's code-computed distance from it —
      // and swap/reroute re-searches inherit the same anchor from the store
      parseData.home = hp.location;

      // fail loud on an implausible time, judged in the PLAN's zone.
      // Explicit impossible requests ("brunch at 3am") stay HARD fails.
      // The inferred case (user typed no time; our own guess landed
      // outside a known band) is OVERRIDABLE: it opens the time-gate
      // panel, and "still want it" re-enters here with the override set.
      const check = resolveStartTimeChecked(
        parseData.time_window ?? "",
        new Date(),
        parseData.category_signals ?? [],
        planZone
      );
      let startInstant: Date;
      if (check.ok) {
        startInstant = check.start;
      } else if (check.overridable && opts.overrideTimeGate) {
        // informed override — keep the same inferred instant, skip the gate
        startInstant = resolveStartTime(
          parseData.time_window ?? "",
          new Date(),
          parseData.category_signals ?? [],
          planZone
        );
      } else if (check.overridable) {
        setRecovery({
          mode: "time-gate",
          parsed: parseData,
          reason: check.reason,
          category: check.category ?? "that",
        });
        setLoadingText(null);
        return;
      } else {
        return fail(check.reason);
      }

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
        body: JSON.stringify({ parsed: parseData, weather, timeZone: planZone }),
        parse: parsePlacesPayload,
      });
      setPools(categories);
      setWeatherBlocks(wxBlocks);

      // the empty-map net: EVERY pool came back empty → say why, don't
      // render a map with nothing on it. After a time-gate OVERRIDE the
      // plain string would be a brand-new dead end — the user just chose
      // to push past one — so that case routes into the SAME recovery
      // panel instead (widen / try something else), with synthesized
      // null-id selections since select never ran.
      const poolEntries = Object.entries(categories);
      const allEmpty =
        poolEntries.length === 0 ||
        poolEntries.every(([, arr]) => !Array.isArray(arr) || arr.length === 0);
      if (allEmpty) {
        if (opts.overrideTimeGate && poolEntries.length > 0) {
          const requestedSlots =
            parseData.category_signals.length > 0
              ? parseData.category_signals
              : poolEntries.map(([category]) => category);
          const emptySels: Selection[] = requestedSlots.map((category, slot) => ({
            category,
            slot,
            id: null,
            reason: "no venues survived filtering",
          }));
          const arrivalBySlot = provisionalArrivals(
            requestedSlots,
            startInstant,
            emptySels
          );
          setRecovery({
            mode: "empty",
            ctx: {
              parseData,
              planZone,
              hp,
              weather,
              startInstant,
              arrivalBySlot,
              pools: categories,
              sels: emptySels,
              drops,
              slots: {},
            },
            empties: requestedSlots.map((category, slot) => ({
              category,
              slot,
              reason: emptyCategoryReason(category, drops, parseData.location),
            })),
            replaceText: {},
            busy: false,
            note: null,
          });
          setLoadingText(null);
          return;
        }
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
          const dry = buildSchedule(sels, parseData.time_window ?? "", new Date(), [], undefined, null, planZone);
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
        const { stops } = buildSchedule(sels, parseData.time_window ?? "", new Date(), legs, undefined, hl, planZone);
        return { stops, legs, hl };
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
          note: onlyUsed
            ? `${narrowedSlotReason(searchCategory, opts.dropLocation ? null : ctx.parseData.location)} Try a different kind of stop?`
            : weatherReason
            ? `${weatherReason.charAt(0).toUpperCase()}${weatherReason.slice(1)} — ${searchCategory} does not fit this slot right now. Try another?`
            : opts.dropLocation
            ? `Still no ${searchCategory} city-wide — tell me what you'd like there instead?`
            : `${stillReason} Try another?`,
        });
      }
    } catch (err) {
      setRecovery((r) =>
        r && r.mode === "empty"
          ? { ...r, busy: false, note: clientErrorMessage(err) }
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

  // ── time-gate actions (batch 4b) ──────────────────────────────────────
  // "Still want it": the user read the window and confirmed — re-run the
  // pipeline with the band gate bypassed for this one run. Whatever the
  // hours data then says is honest (venues with no listed hours survive
  // via keep-on-missing; nothing surviving lands in the recovery panel).
  async function overrideTimeGate() {
    if (recovery?.mode !== "time-gate") return;
    const operation = beginOperation();
    if (!operation) return;
    const parsed = recovery.parsed;
    try {
      setRecovery(null);
      await continuePipeline(parsed, { overrideTimeGate: true });
    } finally {
      endOperation(operation);
    }
  }

  // "Something else": swap direction without retyping — re-open the kind
  // picker (batch 4's clarify question) on the same prompt, categories
  // cleared so the answer genuinely steers the plan. CRUCIALLY (batch 4c)
  // the continuation carries an explicit "now": reaching the gate at all
  // means no time was typed and our own right-now guess was the problem —
  // the person is clearly asking about tonight. Without this, the new
  // kind fell through to its category default (bar → 20:00), which had
  // already passed and rolled the plan to TOMORROW 8 PM. Same semantics
  // as answering the original When question with "now" — including its
  // consequences: a category that's genuinely closed right now gets the
  // explicit-window refusal, exactly like now+that-category typed fresh.
  function timeGateSomethingElse() {
    if (recovery?.mode !== "time-gate" || activeOperation.current) return;
    const parsed = {
      ...recovery.parsed,
      category_signals: [],
      time_window: timeWindowForWhenAnswer("now"),
    };
    setRecovery(null);
    setClarify({ questions: [kindQuestion()], parsed });
    setClarifyKind("");
    setClarifyDistribution("");
    setClarifyWhen(null);
    setClarifyTime("");
    setClarifyVibe("");
    setClarifyNarrow({});
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
        headers: { "Content-Type": "application/json" },
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
    return fetchJson<Itinerary>(url, { parse: parseItineraryPayload });
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

    const nowISO = simNow ? new Date(simNow).toISOString() : undefined;
    let mutationApplied = false;
    setError(null);
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
        setSelected(updated.stops[firstChanged.stopIndex]?.id ?? null);
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

    setSwapping(true);
    setSwapError(null);
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
          setSelected(latest.stops[stopIndex]?.id ?? null);
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

  // 1–2 targeted questions before search — inline, minimal, skippable
  const clarifyBlock = clarify && (
    <div className={"clarify" + (itinerary ? " clarify--stage" : "")}>
      {clarify.questions.map((qq) => (
        <div key={qq.id === "narrow" ? `narrow:${qq.category}` : qq.id} className="clarify__q">
          <div className="clarify__label">{qq.question}</div>
          <div className="clarify__chips">
            {qq.options.map((o) => (
              <button
                key={o}
                className={
                  "chipbtn " +
                  ((qq.id === "when"
                    ? clarifyWhen === o
                    : qq.id === "kind"
                    ? clarifyKind === o
                    : qq.id === "distribution"
                    ? clarifyDistribution === o
                    : qq.id === "narrow"
                    ? clarifyNarrow[qq.category ?? ""] === o
                    : clarifyVibe === o)
                    ? "chipbtn--on"
                    : "")
                }
                disabled={busy}
                onClick={() =>
                  qq.id === "when"
                    ? setClarifyWhen(o)
                    : qq.id === "kind"
                    ? setClarifyKind(o)
                    : qq.id === "distribution"
                    ? setClarifyDistribution(o)
                    : qq.id === "narrow"
                    ? setClarifyNarrow((m) => ({ ...m, [qq.category ?? ""]: o }))
                    : setClarifyVibe(o)
                }
              >
                {o}
              </button>
            ))}
            {qq.id === "when" && clarifyWhen === "pick a time" && (
              <input
                className="clarify__input"
                value={clarifyTime}
                disabled={busy}
                onChange={(e) => setClarifyTime(e.target.value)}
                placeholder="7pm"
                aria-label="Pick a time"
                autoFocus
              />
            )}
            {qq.id === "narrow" && (
              <input
                className="clarify__input"
                value={clarifyNarrow[qq.category ?? ""] ?? ""}
                disabled={busy}
                onChange={(e) =>
                  setClarifyNarrow((m) => ({ ...m, [qq.category ?? ""]: e.target.value }))
                }
                placeholder="or type one…"
                aria-label={qq.question}
              />
            )}
            {qq.id === "kind" && (
              <input
                className="clarify__input"
                value={clarifyKind}
                disabled={busy}
                onChange={(e) => setClarifyKind(e.target.value)}
                placeholder="or type one… (bowling, live music)"
                aria-label="What kind of thing"
              />
            )}
            {qq.id === "distribution" && (
              <input
                className="clarify__input"
                value={clarifyDistribution}
                disabled={busy}
                onChange={(e) => setClarifyDistribution(e.target.value)}
                placeholder={qq.options[0] ?? "2 dinner + 1 drinks"}
                aria-label="How to split the stops"
              />
            )}
            {qq.id === "vibe" && (
              <input
                className="clarify__input"
                value={clarifyVibe}
                disabled={busy}
                onChange={(e) => setClarifyVibe(e.target.value)}
                placeholder="or type one…"
                aria-label="Describe the vibe"
              />
            )}
          </div>
        </div>
      ))}
      <div className="clarify__actions">
        <button className="clarify__go" disabled={busy} onClick={() => submitClarify(false)}>
          Go
        </button>
        <button className="clarify__skip" disabled={busy} onClick={() => submitClarify(true)}>
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
  // time-gate variant of the SAME panel (batch 4b): a real choice —
  // override the inferred-time gate, or change direction — never a
  // dead-end refusal string
  const recoveryBlock =
    recovery && recovery.mode === "time-gate" ? (
      <div className={"clarify recover recover--gate" + (itinerary ? " clarify--stage" : "")}>
        <div className="clarify__q">
          <div className="clarify__label recover__reason">
            {recovery.reason} Still want to try one, or do something else?
          </div>
          <div className="clarify__chips">
            <button className="chipbtn recover__override" disabled={busy} onClick={overrideTimeGate}>
              Still want it
            </button>
            <button className="chipbtn recover__else" disabled={busy} onClick={timeGateSomethingElse}>
              Something else
            </button>
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
      {recovery.note && <div className="clarify__label recover__note">{recovery.note}</div>}
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
        <div className="empty__glow" />
        <div className="empty__mark">Itinerary</div>
        <h1 className="empty__title">Itinerary</h1>
        <div className="empty__sub">life moves simpler.</div>
        {/* ONE pill, three labelled sections. Exactly the same three inputs,
            state, validation and submit trigger as before — only the
            presentation changed from three separate controls to one. */}
        <div className="prompt">
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
              onKeyDown={(e) => {
                if (e.key === "Enter") runPipeline();
              }}
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
              onKeyDown={(e) => {
                if (e.key === "Enter") runPipeline();
              }}
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
              onKeyDown={(e) => {
                if (e.key === "Enter") runPipeline();
              }}
              placeholder="optional — city centre"
              aria-label="Starting address"
            />
          </div>
          <button
            className="prompt__go"
            onClick={runPipeline}
            disabled={busy || !prompt.trim() || !city.trim()}
            aria-label={busy ? loadingText ?? "Planning" : "Plan it"}
            title={busy ? loadingText ?? "Planning" : "Plan it"}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.5-3.5" />
            </svg>
          </button>
        </div>
        {busy && loadingText && <div className="empty__status">{loadingText}</div>}
        {clarifyBlock}
        {recoveryBlock}
        {error && <div className="empty__err">{error}</div>}
      </main>
    );
  }

  // ── map stage ──
  return (
    <main className={"stage" + (banner ? " stage--banner" : "")}>
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
        swap={{
          text: swapText,
          onText: setSwapText,
          onSubmit: doSwap,
          submitting: swapping || busy,
          error: swapError,
          canSwap,
        }}
      />

      <div className="topbar">
        <span className="topbar__mark">Itinerary</span>
        <span className="topbar__rule" />
        <input
          className="topbar__input"
          disabled={busy}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") runPipeline();
          }}
          aria-label="Describe your evening"
        />
        <button className="topbar__go" onClick={runPipeline} disabled={busy || !prompt.trim()}>
          {busy ? "…" : "Replan"}
        </button>
      </div>

      {loadingText && <div className="loading">{loadingText}</div>}

      {clarifyBlock}
      {recoveryBlock}

      {banner && (
        <div className={"banner banner--show" + (bannerFlat ? " banner--flat" : "")} role="status">
          {banner}
        </div>
      )}
      {error && !banner && <div className="stage__err">{error}</div>}

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

      {/* discreet dev strip — time + disruption simulators for the demo */}
      {devOpen ? (
        <div className="dev">
          <div className="dev__title">
            <span>Dev</span>
            <button className="ghost" style={{ marginLeft: "auto", padding: "2px 7px" }} onClick={() => setDevOpen(false)}>
              hide
            </button>
          </div>
          <div className="dev__row">
            <label>time</label>
            <input
              type="datetime-local"
              disabled={busy}
              value={simNow}
              onChange={(e) => void updateSimulationTime(e.target.value)}
            />
            <button
              className="ghost"
              disabled={busy}
              onClick={() => void updateSimulationTime("")}
            >
              real
            </button>
          </div>
          <div className="dev__row">
            <label>leg</label>
            <select
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
            <button disabled={busy} onClick={fireDisruption}>cancel</button>
          </div>
        </div>
      ) : (
        <button className="dev dev__collapsed" onClick={() => setDevOpen(true)}>
          Dev
        </button>
      )}
    </main>
  );
}
