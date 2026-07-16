"use client";

import { useEffect, useMemo, useState } from "react";
import {
  buildSchedule,
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
  partialEmptyCategories,
  unmetConstraintReason,
  weatherBlockedReason,
  widenOfferLabel,
} from "./lib/planGuards";
import { ClarifyQuestion, clarifyQuestions, timeWindowForWhenAnswer } from "./lib/clarify";
import type { Selection } from "./api/select/selectVenues";
import type { DropEntry } from "./api/places/search/filter";
import ItineraryMap, { MapHome, MapStop } from "./ItineraryMap";
import ItineraryStrip, { StripHome, StripStop } from "./ItineraryStrip";

interface Place {
  id: string;
  displayName?: { text: string };
  location?: { latitude: number; longitude: number };
  rating?: number;
  priceLevel?: string;
}
type Pools = Record<string, Place[]>;
interface WeatherBlock {
  category: string;
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parseData: any;
  planZone: string;
  hp: { label: string; location: { latitude: number; longitude: number } };
  weather: WeatherHour[] | null;
  pools: Pools;
  sels: Selection[];
  drops: DropEntry[];
  /** replacement category → the requested category whose slot it fills
   * (recovery's follow-up path), so ordering can restore prompt order */
  slots: Record<string, string>;
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

// transit-leg detail line, e.g. "505 Dundas · 11 stops · 22 min"
function legDetail(leg?: TravelLeg | null): string | null {
  if (!leg || leg.mode !== "transit" || !leg.transit) return null;
  const t = leg.transit;
  return `${t.lineName}${t.stopCount ? ` · ${t.stopCount} stops` : ""} · ${leg.totalMinutes} min`;
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
  const [parsedObj, setParsedObj] = useState<Record<string, unknown> | null>(null);
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

  // ambient weather chip — fetched once, independent of the pipeline
  useEffect(() => {
    let cancelled = false;
    fetch("/api/weather")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && Array.isArray(d)) setWeather(d);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const [error, setError] = useState<string | null>(null);
  const [loadingText, setLoadingText] = useState<string | null>(null);
  const busy = loadingText !== null;

  // lightweight clarifying questions (rule-based, pre-search)
  const [clarify, setClarify] = useState<{
    questions: ClarifyQuestion[];
    parsed: Record<string, unknown>;
  } | null>(null);
  const [clarifyWhen, setClarifyWhen] = useState<string | null>(null);
  const [clarifyTime, setClarifyTime] = useState("");
  const [clarifyVibe, setClarifyVibe] = useState("");

  // partial-failure recovery: SOME categories resolved but ≥1 came back
  // empty. Instead of silently dropping it, pause with the honest reason
  // and an offer to widen the search (city-wide) or replace that ONE slot.
  const [recovery, setRecovery] = useState<{
    ctx: PlanCtx;
    empties: { category: string; reason: string }[];
    replaceText: Record<string, string>;
    busy: boolean;
    note: string | null;
  } | null>(null);

  async function runPipeline() {
    const q = prompt.trim();
    if (!q || busy) return;
    setError(null);
    setBanner(null);
    setChangedIds(new Set());
    setOldStarts({});
    setSwapError(null);
    setClarify(null);
    setRecovery(null);
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
      const parseRes = await fetch("/api/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: q }),
      });
      const parseData = await parseRes.json();
      if (!parseRes.ok) throw new Error(parseData.error ?? `parse failed (${parseRes.status})`);
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
        setLoadingText(null);
        return;
      }

      await continuePipeline(parseData);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoadingText(null);
    }
  }

  // clarify answered or skipped → resume the pipeline with final parse
  async function submitClarify(skip: boolean) {
    if (!clarify) return;
    const updated: Record<string, unknown> = { ...clarify.parsed };
    if (!skip) {
      const whenAns = clarifyWhen === "pick a time" ? clarifyTime.trim() : clarifyWhen ?? "";
      if (whenAns) updated.time_window = timeWindowForWhenAnswer(whenAns);
      if (clarifyVibe.trim()) updated.aesthetic = clarifyVibe.trim();
    }
    setClarify(null);
    setParsedObj(updated);
    await continuePipeline(updated);
  }

  // everything from the time check onward — parseData is final here
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function continuePipeline(parseData: any) {
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
      const cityRes = await fetch("/api/geocode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: cityQ }),
      });
      const cityData = await cityRes.json();
      if (!cityRes.ok) {
        return fail(cityData.error ?? `Couldn't find "${cityQ}" — check the spelling?`);
      }
      // the plan's resolved zone (geocoder-derived); fail-soft to Toronto —
      // a missing zone must not block a plan, but it's surfaced (banner + log)
      let planZone: string = cityData.timeZone ?? "America/Toronto";
      let hp: { label: string; location: { latitude: number; longitude: number } } = {
        label: `Start · ${cityQ} centre`,
        location: cityData.location,
      };
      const addrQ = startAddress.trim();
      if (addrQ) {
        const addrRes = await fetch("/api/geocode", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: `${addrQ}, ${cityQ}` }),
        });
        const addrData = await addrRes.json();
        if (!addrRes.ok) {
          return fail(addrData.error ?? `Couldn't find "${addrQ}" — check the spelling?`);
        }
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

      // fail loud on an implausible time, judged in the PLAN's zone (explicit
      // "brunch at 3am" gets a specific reason; a senseless inferred time
      // gets the add-a-time one)
      const check = resolveStartTimeChecked(
        parseData.time_window ?? "",
        new Date(),
        parseData.category_signals ?? [],
        planZone
      );
      if (!check.ok) return fail(check.reason);

      let weather = null;
      try {
        const wr = await fetch(
          `/api/weather?lat=${hp.location.latitude}&lng=${hp.location.longitude}`
        );
        if (wr.ok) {
          weather = await wr.json();
          // the ambient chip should show the PLAN's city, not the default
          if (Array.isArray(weather)) setWeather(weather);
        }
      } catch {
        weather = null;
      }

      setLoadingText("Finding places…");
      const placesRes = await fetch("/api/places/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parsed: parseData, weather, timeZone: planZone }),
      });
      const placesData = await placesRes.json();
      if (!placesRes.ok) throw new Error(placesData.error ?? `places failed (${placesRes.status})`);
      const { _dropLog, _weatherBlocked, ...categories } = placesData;
      const drops: DropEntry[] = Array.isArray(_dropLog) ? _dropLog : [];
      setPools(categories as Pools);
      const wxBlocks = Array.isArray(_weatherBlocked) ? _weatherBlocked : [];
      setWeatherBlocks(wxBlocks);

      // the empty-map net: EVERY pool came back empty → say why, don't
      // render a map with nothing on it
      const poolEntries = Object.entries(categories as Pools);
      const allEmpty =
        poolEntries.length === 0 ||
        poolEntries.every(([, arr]) => !Array.isArray(arr) || arr.length === 0);
      if (allEmpty) {
        return fail(
          wxBlocks.length >= poolEntries.length && wxBlocks.length > 0
            ? weatherBlockedReason(wxBlocks)
            : noVenuesReason(Object.keys(categories), formatStopTime(check.start, new Date(), planZone))
        );
      }

      setLoadingText("Choosing the spots…");
      const selectRes = await fetch("/api/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parsed: parseData, pools: categories }),
      });
      const selectData = await selectRes.json();
      if (!selectRes.ok) throw new Error(selectData.error ?? `select failed (${selectRes.status})`);
      const sels: Selection[] = selectData.selections ?? [];

      // a hard constraint nothing actually meets → fail loud, never a
      // pick with a "check with the venue" hedge
      const unmet = sels.find((s) => s.unmetConstraint);
      if (unmet) return fail(unmetConstraintReason(unmet.category, unmet.unmetConstraint!));

      const ctx: PlanCtx = {
        parseData,
        planZone,
        hp,
        weather,
        pools: categories as Pools,
        sels,
        drops,
        slots: {},
      };

      // partial failure: some categories resolved, ≥1 came back empty.
      // Never drop the empty one silently — pause with the honest reason
      // and an offer to recover (widen / replace) that ONE category. The
      // all-empty case above keeps its own noVenuesReason path.
      const emptyCats = partialEmptyCategories(sels);
      if (emptyCats.length > 0) {
        setRecovery({
          ctx,
          empties: emptyCats.map((c) => ({
            category: c,
            reason: emptyCategoryReason(c, drops, parseData.location),
          })),
          replaceText: {},
          busy: false,
          note: null,
        });
        setLoadingText(null);
        return;
      }

      await finishPipeline(ctx);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoadingText(null);
    }
  }

  // Build the route + schedule from finalized selections, then store the
  // itinerary. Shared by the normal path and by post-recovery resumption,
  // so recovering a category runs the exact same tail — no forked path.
  async function finishPipeline(ctx: PlanCtx) {
    const { parseData, planZone, hp, pools } = ctx;
    // stops must follow the PROMPT's order ("ramen then a bar" = ramen
    // first) — selectVenues appends empty categories last and recovery
    // resolves them in that appended position, so re-order by the parse's
    // category_signals; a replacement category takes its slot's position
    const sels = orderByRequest(ctx.sels, parseData.category_signals, ctx.slots);
    try {
      setPools(pools);
      setParsedObj(parseData);
      setLoadingText("Timing the route…");
      const points = sels
        .filter((s) => s.id !== null)
        .map((s) => (pools[s.category] ?? []).find((p) => p.id === s.id)?.location ?? null);

      let legs: TravelLeg[] = [];
      let hl: TravelLeg | null = null;
      if (points.length >= 1 && points.every(Boolean)) {
        const { startISO } = buildSchedule(sels, parseData.time_window ?? "", new Date(), [], undefined, null, planZone);
        const travelRes = await fetch("/api/schedule/travel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ points: [hp.location, ...points], departureTime: startISO }),
        });
        const travelData = await travelRes.json();
        if (!travelRes.ok) throw new Error(travelData.error ?? `travel failed (${travelRes.status})`);
        const split = splitHomeLeg(travelData.legs ?? []);
        hl = split.homeLeg;
        legs = split.interLegs;
      }

      const { stops } = buildSchedule(sels, parseData.time_window ?? "", new Date(), legs, undefined, hl, planZone);
      setSchedule(stops);
      setTravelLegs(legs);
      setHomeLeg(hl);
      const ms = stopsFromSchedule(stops, pools);
      setMapStops(ms);
      setSelected(ms[0]?.category ?? null);

      // auto-store the itinerary so the live/reroute controls work at once
      await storeItinerary(stops, legs, hl, parseData, pools, "", hp, planZone);
      setLoadingText(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoadingText(null);
    }
  }

  // Re-resolve ONE empty category — widen (drop the neighbourhood, search
  // city-wide) or replace (search a new category the user names) — leaving
  // every other stop untouched. Reuses the places route's categoriesOverride
  // (the same subset-search the reroute engine uses) + the select route.
  async function resolveEmpty(
    category: string,
    opts: { searchCategory: string; dropLocation: boolean }
  ) {
    if (!recovery) return;
    const { ctx } = recovery;
    const searchCategory = opts.searchCategory.trim();
    if (!searchCategory) return;
    setRecovery({ ...recovery, busy: true, note: null });
    try {
      const scopedParsed = {
        ...ctx.parseData,
        ...(opts.dropLocation ? { location: "" } : {}),
      };
      const placesRes = await fetch("/api/places/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parsed: scopedParsed,
          categoriesOverride: [searchCategory],
          weather: ctx.weather,
          timeZone: ctx.planZone,
        }),
      });
      const placesData = await placesRes.json();
      if (!placesRes.ok) throw new Error(placesData.error ?? `places failed (${placesRes.status})`);
      const { _dropLog, _weatherBlocked, ...poolObj } = placesData;
      void _weatherBlocked;
      const newPool: Place[] = (poolObj as Pools)[searchCategory] ?? [];
      const newDrops: DropEntry[] = Array.isArray(_dropLog) ? _dropLog : [];

      let newSel: Selection | undefined;
      if (newPool.length > 0) {
        const selRes = await fetch("/api/select", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parsed: scopedParsed, pools: { [searchCategory]: newPool } }),
        });
        const selData = await selRes.json();
        if (!selRes.ok) throw new Error(selData.error ?? `select failed (${selRes.status})`);
        newSel = (selData.selections as Selection[] | undefined)?.find(
          (s) => s.category === searchCategory
        );
      }

      if (newSel && newSel.id !== null) {
        // resolved — swap the empty entry for the new pick (keeping order),
        // add its pool, and drop it from the outstanding list. A replacement
        // category records which requested slot it fills, so finishPipeline
        // can restore the prompt's order.
        const mergedSels = ctx.sels.map((s) => (s.category === category ? newSel! : s));
        const mergedPools: Pools = { ...ctx.pools, [searchCategory]: newPool };
        const mergedSlots =
          searchCategory === category
            ? ctx.slots
            : { ...ctx.slots, [searchCategory]: ctx.slots[category] ?? category };
        const newCtx: PlanCtx = { ...ctx, sels: mergedSels, pools: mergedPools, slots: mergedSlots };
        const remaining = recovery.empties.filter((e) => e.category !== category);
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
          note: opts.dropLocation
            ? `Still no ${searchCategory} city-wide — tell me what you'd like there instead?`
            : `${stillReason} Try another?`,
        });
      }
    } catch (err) {
      setRecovery((r) =>
        r ? { ...r, busy: false, note: err instanceof Error ? err.message : String(err) } : r
      );
    }
  }

  // user declined to recover the empty category(ies) — build the plan
  // without them (they stay skipped, as before, but now by explicit choice)
  async function planWithoutEmpties() {
    if (!recovery) return;
    const ctx = recovery.ctx;
    setRecovery(null);
    await finishPipeline(ctx);
  }

  async function storeItinerary(
    sched: ScheduledStop[],
    legs: TravelLeg[],
    hl: TravelLeg | null,
    parsed: Record<string, unknown>,
    poolsIn: Pools,
    simValue: string,
    home?: { label: string; location: { latitude: number; longitude: number } } | null,
    timeZone?: string
  ) {
    const enriched = sched.map((st) => {
      const loc = st.id ? (poolsIn[st.category] ?? []).find((p) => p.id === st.id)?.location : undefined;
      return loc ? { ...st, location: loc } : st;
    });
    const res = await fetch("/api/itinerary", {
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
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? `itinerary failed (${res.status})`);
      return;
    }
    await refreshItinerary(data.id, simValue);
  }

  async function refreshItinerary(id: string, simValue: string) {
    const nowISO = simValue ? new Date(simValue).toISOString() : "";
    const url = `/api/itinerary/${id}${nowISO ? `?now=${encodeURIComponent(nowISO)}` : ""}`;
    const res = await fetch(url);
    const data: Itinerary = await res.json();
    if (!res.ok) return;
    setItinerary(data);
    const active = data.stops.find((s) => s.status === "active");
    if (active) setSelected(active.category);
  }

  function applyItinerary(it: Itinerary) {
    setItinerary(it);
    setSchedule(it.stops as ScheduledStop[]);
    setMapStops(stopsFromItinerary(it));
    setHomeLeg(it.homeLeg ?? null);
  }

  async function fireDisruption() {
    if (!itinerary) return;
    const timed = itinerary.stops.filter((s) => s.start_time);
    const broken = timed[disruptLeg]?.travelToNext;
    const legName =
      broken?.transit?.lineName ?? (broken?.mode === "transit" ? "The transit leg" : "That leg");

    const nowISO = simNow ? new Date(simNow).toISOString() : undefined;
    const res = await fetch(`/api/itinerary/${itinerary.id}/reroute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        disruption: { type: "transit_cancelled", legIndex: disruptLeg },
        ...(nowISO ? { now: nowISO } : {}),
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? `reroute failed (${res.status})`);
      return;
    }
    if (!data.rerouted) {
      setBannerFlat(true);
      setBanner(`${legName} cancelled — ${data.reason}.`);
      setChangedIds(new Set());
      return;
    }

    const itRes = await fetch(
      `/api/itinerary/${itinerary.id}${nowISO ? `?now=${encodeURIComponent(nowISO)}` : ""}`
    );
    const updated: Itinerary = await itRes.json();

    // capture pre-reroute starts for the strike-through, keyed by venue id
    const olds: Record<string, string | null> = {};
    const ids = new Set<string>();
    for (const c of data.changed as { stopIndex: number; before: { start: string | null } }[]) {
      const st = updated.stops[c.stopIndex];
      if (st.id) {
        ids.add(st.id);
        olds[st.id] = c.before.start;
      }
    }
    applyItinerary(updated);
    setChangedIds(ids);
    setOldStarts(olds);
    // surface the change: expand the first replanned stop so its new venue
    // and settled time are the hero of the moment
    const firstChanged = (data.changed as { stopIndex: number }[])[0];
    if (firstChanged) setSelected(updated.stops[firstChanged.stopIndex].category);

    // the banner shows the instant the new chain actually departs from —
    // for an unstarted plan that's the kept stop's committed end, not `now`
    const floorLabel = formatStopTime(data.anchor_time ?? data.floor_time, new Date(), itinerary.timeZone ?? planZone);
    const kept = updated.stops.find((s) => s.status === "active" || s.status === "completed");
    setBannerFlat(false);
    setBanner(
      `${legName} cancelled. Replanned from ${floorLabel}` +
        (kept ? ` — your ${kept.category}'s unchanged.` : ".")
    );
  }

  // Surgical per-stop swap: replace the selected upcoming stop from its
  // mini-prompt, reusing the reroute reflow visuals for the result.
  async function doSwap() {
    if (!itinerary || !selected) return;
    const refinement = swapText.trim();
    if (!refinement) return;
    const stopIndex = itinerary.stops.findIndex((s) => s.category === selected);
    if (stopIndex < 0) return;

    setSwapping(true);
    setSwapError(null);
    const nowISO = simNow ? new Date(simNow).toISOString() : undefined;
    // pre-swap starts (by id) so downstream shifts can strike-through
    const oldById = Object.fromEntries(
      itinerary.stops.filter((s) => s.id).map((s) => [s.id as string, s.start_time])
    );
    const res = await fetch(`/api/itinerary/${itinerary.id}/swap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stopIndex, refinement, ...(nowISO ? { now: nowISO } : {}) }),
    });
    const data = await res.json();
    setSwapping(false);
    if (!res.ok) {
      setSwapError(data.error ?? `swap failed (${res.status})`);
      return;
    }
    if (!data.swapped) {
      // honest refusal — nothing better found, original kept
      setBannerFlat(true);
      setBanner(data.reason);
      return;
    }

    const itRes = await fetch(
      `/api/itinerary/${itinerary.id}${nowISO ? `?now=${encodeURIComponent(nowISO)}` : ""}`
    );
    const updated: Itinerary = await itRes.json();

    const ids = new Set<string>();
    const olds: Record<string, string | null> = {};
    const swapped = updated.stops[data.stopIndex];
    // the swapped stop: venue changed, slot held → no time strike, just settle
    if (swapped.id) ids.add(swapped.id);
    // downstream shifts: their times moved → strike old, settle new
    for (const di of data.downstreamShifted as number[]) {
      const s = updated.stops[di];
      if (s.id) {
        ids.add(s.id);
        olds[s.id] = oldById[s.id] ?? null;
      }
    }
    applyItinerary(updated);
    setChangedIds(ids);
    setOldStarts(olds);
    setSelected(swapped.category);
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
  }

  // merge live status + changed flags (by venue id) onto the base map stops
  const styledStops = useMemo<MapStop[]>(
    () =>
      mapStops.map((ms) => ({
        ...ms,
        status: itinerary?.stops.find((s) => s.category === ms.category)?.status,
        changed: changedIds.has(ms.id),
        oldStart: oldStarts[ms.id] ?? null,
      })),
    [mapStops, itinerary, changedIds, oldStarts]
  );

  const selectedStop = itinerary?.stops.find((s) => s.category === selected) ?? null;
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
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homeLeg, itinerary, homePoint, displayZone]);

  const wxNow = weather?.[0] ?? null;

  // 1–2 targeted questions before search — inline, minimal, skippable
  const clarifyBlock = clarify && (
    <div className={"clarify" + (itinerary ? " clarify--stage" : "")}>
      {clarify.questions.map((qq) => (
        <div key={qq.id} className="clarify__q">
          <div className="clarify__label">{qq.question}</div>
          <div className="clarify__chips">
            {qq.options.map((o) => (
              <button
                key={o}
                className={
                  "chipbtn " +
                  ((qq.id === "when" ? clarifyWhen === o : clarifyVibe === o) ? "chipbtn--on" : "")
                }
                onClick={() => (qq.id === "when" ? setClarifyWhen(o) : setClarifyVibe(o))}
              >
                {o}
              </button>
            ))}
            {qq.id === "when" && clarifyWhen === "pick a time" && (
              <input
                className="clarify__input"
                value={clarifyTime}
                onChange={(e) => setClarifyTime(e.target.value)}
                placeholder="7pm"
                aria-label="Pick a time"
                autoFocus
              />
            )}
            {qq.id === "vibe" && (
              <input
                className="clarify__input"
                value={clarifyVibe}
                onChange={(e) => setClarifyVibe(e.target.value)}
                placeholder="or type one…"
                aria-label="Describe the vibe"
              />
            )}
          </div>
        </div>
      ))}
      <div className="clarify__actions">
        <button className="clarify__go" onClick={() => submitClarify(false)}>
          Go
        </button>
        <button className="clarify__skip" onClick={() => submitClarify(true)}>
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
    recovery.ctx.parseData.location &&
    String(recovery.ctx.parseData.location).trim() &&
    String(recovery.ctx.parseData.location).trim().toLowerCase() !== "unspecified"
  );
  const recoveryBlock = recovery && (
    <div className={"clarify recover" + (itinerary ? " clarify--stage" : "")}>
      {recovery.empties.map((e) => (
        <div key={e.category} className="clarify__q">
          <div className="clarify__label recover__reason">{e.reason}</div>
          <div className="clarify__chips">
            {recoveryCanWiden && (
              <button
                className="chipbtn recover__widen"
                disabled={recovery.busy}
                onClick={() => resolveEmpty(e.category, { searchCategory: e.category, dropLocation: true })}
              >
                {widenOfferLabel(recovery.ctx.parseData.location)}
              </button>
            )}
            <input
              className="clarify__input recover__input"
              value={recovery.replaceText[e.category] ?? ""}
              onChange={(ev) =>
                setRecovery((r) =>
                  r ? { ...r, replaceText: { ...r.replaceText, [e.category]: ev.target.value } } : r
                )
              }
              onKeyDown={(ev) => {
                if (ev.key === "Enter" && recovery.replaceText[e.category]?.trim())
                  resolveEmpty(e.category, {
                    searchCategory: recovery.replaceText[e.category],
                    dropLocation: false,
                  });
              }}
              placeholder={`or try something else there…`}
              aria-label={`Replace ${e.category}`}
            />
            <button
              className="chipbtn recover__go"
              disabled={recovery.busy || !recovery.replaceText[e.category]?.trim()}
              onClick={() =>
                resolveEmpty(e.category, {
                  searchCategory: recovery.replaceText[e.category],
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
      <div className="clarify__actions">
        <button className="clarify__skip recover__skip" disabled={recovery.busy} onClick={planWithoutEmpties}>
          Plan without it
        </button>
      </div>
    </div>
  );

  // ── empty state ──
  if (!itinerary) {
    return (
      <main className="empty">
        <div className="empty__mark">Itinerary</div>
        <h1 className="empty__title">Plan your day</h1>
        <div className="wherebar">
          <input
            className="where__input"
            value={city}
            onChange={(e) => setCity(e.target.value)}
            placeholder="City"
            aria-label="City"
          />
          <input
            className="where__input where__input--addr"
            value={startAddress}
            onChange={(e) => setStartAddress(e.target.value)}
            placeholder="Starting address (optional — city centre)"
            aria-label="Starting address"
          />
        </div>
        <div className="prompt">
          <input
            className="prompt__input"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") runPipeline();
            }}
            placeholder="ramen then a quiet bar in Ossington"
            aria-label="Describe your evening"
            autoFocus
          />
          <button
            className="prompt__go"
            onClick={runPipeline}
            disabled={busy || !prompt.trim() || !city.trim()}
          >
            {busy ? loadingText : "Plan it"}
          </button>
        </div>
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
          submitting: swapping,
          error: swapError,
          canSwap,
        }}
      />

      <div className="topbar">
        <span className="topbar__mark">Itinerary</span>
        <span className="topbar__rule" />
        <input
          className="topbar__input"
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
              value={simNow}
              onChange={(e) => {
                setSimNow(e.target.value);
                refreshItinerary(itinerary.id, e.target.value);
              }}
            />
            <button
              className="ghost"
              onClick={() => {
                setSimNow("");
                refreshItinerary(itinerary.id, "");
              }}
            >
              real
            </button>
          </div>
          <div className="dev__row">
            <label>leg</label>
            <select value={disruptLeg} onChange={(e) => setDisruptLeg(Number(e.target.value))}>
              {timedStops.slice(0, -1).map((s, i) => (
                <option key={i} value={i}>
                  {s.name} → {timedStops[i + 1]?.name} ({s.travelToNext?.mode ?? "?"})
                </option>
              ))}
            </select>
            <button onClick={fireDisruption}>cancel</button>
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
