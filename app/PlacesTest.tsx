"use client";

import { useMemo, useState } from "react";
import {
  buildSchedule,
  resolveStartTimeChecked,
  ScheduledStop,
} from "./api/schedule/schedule";
import { TravelLeg } from "./api/schedule/travel";
import { HOME, splitHomeLeg } from "./api/schedule/home";
import { Itinerary, StopStatus } from "./api/itinerary/store";
import ItineraryMap, { MapHome, MapStop } from "./ItineraryMap";
import { formatStopRange, formatStopTime } from "./lib/timeLabels";

// Throwaway harness proving the parse → places pipeline works end to
// end: one button runs /api/parse, then feeds the result straight into
// /api/places/search and renders the per-category candidate pools.
// Plain list, no styling polish — delete once real UI exists.

interface Place {
  id: string;
  displayName?: { text: string };
  location?: { latitude: number; longitude: number };
  rating?: number;
  priceLevel?: string;
  currentOpeningHours?: { openNow?: boolean };
  businessStatus?: string;
}

type GroupedPlaces = Record<string, Place[]>;

interface DropEntry {
  category: string;
  name: string;
  id: string;
  rule: string;
  detail: string;
}

interface Selection {
  category: string;
  id: string | null;
  reason: string;
  fallback?: boolean;
  name?: string;
  rating?: number;
}

interface WeatherBlock {
  category: string;
  weatherBlocked: true;
  reason: string;
}

export default function PlacesTest() {
  const [prompt, setPrompt] = useState("");
  const [parsed, setParsed] = useState<string | null>(null);
  const [parsedObj, setParsedObj] = useState<Record<string, unknown> | null>(null);
  const [grouped, setGrouped] = useState<GroupedPlaces | null>(null);
  const [dropLog, setDropLog] = useState<DropEntry[]>([]);
  const [weatherBlocks, setWeatherBlocks] = useState<WeatherBlock[]>([]);
  const [selections, setSelections] = useState<Selection[] | null>(null);
  const [schedule, setSchedule] = useState<ScheduledStop[] | null>(null);
  const [mapStops, setMapStops] = useState<MapStop[]>([]);
  const [travelLegs, setTravelLegs] = useState<TravelLeg[]>([]);
  const [homeLeg, setHomeLeg] = useState<TravelLeg | null>(null);
  const [itinerary, setItinerary] = useState<Itinerary | null>(null);
  const [simNow, setSimNow] = useState(""); // dev time control (datetime-local)
  const [disruptLeg, setDisruptLeg] = useState(0);
  const [banner, setBanner] = useState<string | null>(null);
  const [changedCategories, setChangedCategories] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<
    "idle" | "parsing" | "searching" | "selecting" | "routing"
  >("idle");

  async function runPipeline() {
    setError(null);
    setParsed(null);
    setGrouped(null);
    setDropLog([]);
    setWeatherBlocks([]);
    setSelections(null);
    setSchedule(null);
    setMapStops([]);
    setTravelLegs([]);
    setHomeLeg(null);
    setItinerary(null);
    setSimNow("");
    setParsedObj(null);
    setBanner(null);
    setChangedCategories(new Set());
    try {
      setStage("parsing");
      const parseRes = await fetch("/api/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const parseData = await parseRes.json();
      if (!parseRes.ok) {
        throw new Error(
          (parseData.error ?? `parse HTTP ${parseRes.status}`) +
            (parseData.raw ? `\nraw: ${parseData.raw}` : "")
        );
      }
      setParsed(JSON.stringify(parseData, null, 2));
      setParsedObj(parseData);

      // Fail loud on implausible inferred start times (e.g. a bare
      // "axe throwing" at 4 AM) BEFORE burning Places/Groq calls on a
      // target hour nobody meant.
      const timeCheck = resolveStartTimeChecked(
        parseData.time_window ?? "",
        new Date(),
        parseData.category_signals ?? []
      );
      if (!timeCheck.ok) {
        setError(timeCheck.reason);
        setStage("idle");
        return;
      }

      // Weather is best-effort: failure just skips the weather gate.
      let weather = null;
      try {
        const weatherRes = await fetch("/api/weather");
        if (weatherRes.ok) weather = await weatherRes.json();
      } catch {
        weather = null;
      }

      setStage("searching");
      const placesRes = await fetch("/api/places/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parsed: parseData, weather }),
      });
      const placesData = await placesRes.json();
      if (!placesRes.ok) {
        throw new Error(
          (placesData.error ?? `places HTTP ${placesRes.status}`) +
            (placesData.details ? `\ndetails: ${placesData.details}` : "")
        );
      }
      // Split meta keys off the response — only real category pools
      // render as venue sections.
      const { _dropLog, _weatherBlocked, ...categories } = placesData;
      setDropLog(Array.isArray(_dropLog) ? _dropLog : []);
      setWeatherBlocks(Array.isArray(_weatherBlocked) ? _weatherBlocked : []);
      setGrouped(categories);

      setStage("selecting");
      const selectRes = await fetch("/api/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parsed: parseData, pools: categories }),
      });
      const selectData = await selectRes.json();
      if (!selectRes.ok) {
        throw new Error(
          (selectData.error ?? `select HTTP ${selectRes.status}`) +
            (selectData.raw ? `\nraw: ${selectData.raw}` : "")
        );
      }
      setSelections(selectData.selections ?? []);

      // Look up each pick's coordinates in its category pool (pools stay
      // keyed by unique category — matching invariant), then fetch real
      // transit/walk legs and build the timed schedule around them.
      setStage("routing");
      const sels: Selection[] = selectData.selections ?? [];
      const points = sels
        .filter((s) => s.id !== null)
        .map((s) => {
          const pool: Place[] = (categories as GroupedPlaces)[s.category] ?? [];
          return pool.find((p) => p.id === s.id)?.location ?? null;
        });

      let legs: TravelLeg[] = [];
      let hl: TravelLeg | null = null;
      if (points.length >= 1 && points.every(Boolean)) {
        // home is the origin waypoint: leg 0 = home → first stop, then
        // the usual consecutive venue pairs. startISO (the resolved
        // outing start) is the leave-home time.
        const { startISO } = buildSchedule(sels, parseData.time_window ?? "");
        const travelRes = await fetch("/api/schedule/travel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            points: [HOME.location, ...points],
            departureTime: startISO,
          }),
        });
        const travelData = await travelRes.json();
        if (!travelRes.ok) {
          throw new Error(
            (travelData.error ?? `travel HTTP ${travelRes.status}`) +
              (travelData.details ? `\ndetails: ${travelData.details}` : "")
          );
        }
        const split = splitHomeLeg(travelData.legs ?? []);
        hl = split.homeLeg;
        legs = split.interLegs;
      }
      setHomeLeg(hl);

      const { stops } = buildSchedule(
        sels,
        parseData.time_window ?? "",
        new Date(),
        legs,
        undefined,
        hl
      );
      setSchedule(stops);
      setTravelLegs(legs);

      // Map input: timed stops with coords from their category pools.
      // Null-id picks (blocked/empty pools) have no coords — skipped.
      setMapStops(
        stops
          .filter((st) => st.id !== null)
          .map((st): MapStop | null => {
            const pool: Place[] = (categories as GroupedPlaces)[st.category] ?? [];
            const loc = pool.find((p) => p.id === st.id)?.location;
            if (!loc) return null;
            return {
              name: st.name ?? "(unnamed)",
              lat: loc.latitude,
              lng: loc.longitude,
              category: st.category,
              startTime: st.start_time,
              endTime: st.end_time,
              reason: st.reason,
              legModeToNext: st.travelToNext?.mode,
              polylineToNext: st.travelToNext?.encodedPolyline ?? null,
            };
          })
          .filter((x): x is MapStop => x !== null)
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStage("idle");
    }
  }

  async function refreshItinerary(id: string, simValue: string) {
    const nowISO = simValue ? new Date(simValue).toISOString() : "";
    const url = `/api/itinerary/${id}${nowISO ? `?now=${encodeURIComponent(nowISO)}` : ""}`;
    const res = await fetch(url);
    const data = await res.json();
    if (res.ok) setItinerary(data);
  }

  async function startItinerary() {
    if (!schedule) return;
    // enrich stops with venue coordinates — the reroute engine needs
    // them for inbound travel legs
    const enriched = schedule.map((st) => {
      const loc = st.id
        ? (grouped?.[st.category] ?? []).find((p) => p.id === st.id)?.location
        : undefined;
      return loc ? { ...st, location: loc } : st;
    });
    const res = await fetch("/api/itinerary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stops: enriched,
        legs: travelLegs,
        parsed: parsedObj,
        homeLeg,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? `itinerary HTTP ${res.status}`);
      return;
    }
    await refreshItinerary(data.id, simNow);
  }

  // Rebuild the rendered schedule/picks/map from the stored itinerary —
  // after a reroute the server-side stops are the source of truth.
  function applyItinerary(it: Itinerary) {
    setItinerary(it);
    setSchedule(it.stops);
    setHomeLeg(it.homeLeg ?? null);
    setSelections(
      it.stops.map((s) => ({
        category: s.category,
        id: s.id,
        reason: s.reason ?? "",
        fallback: s.fallback,
        name: s.name,
        rating: s.rating,
      }))
    );
    setMapStops(
      it.stops
        .filter((s) => s.id !== null && s.location)
        .map((s) => ({
          name: s.name ?? "(unnamed)",
          lat: s.location!.latitude,
          lng: s.location!.longitude,
          category: s.category,
          startTime: s.start_time,
          endTime: s.end_time,
          reason: s.reason,
          legModeToNext: s.travelToNext?.mode,
          polylineToNext: s.travelToNext?.encodedPolyline ?? null,
        }))
    );
  }

  async function fireDisruption() {
    if (!itinerary) return;
    // capture the cancelled leg's label before the replan overwrites it
    const timed = itinerary.stops.filter((s) => s.start_time);
    const brokenLeg = timed[disruptLeg]?.travelToNext;
    const legName =
      brokenLeg?.transit?.lineName ??
      (brokenLeg?.mode === "transit" ? "transit leg" : "leg");

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
      setError(data.error ?? `reroute HTTP ${res.status}`);
      return;
    }
    if (!data.rerouted) {
      setBanner(`${legName} cancelled — ${data.reason}`);
      setChangedCategories(new Set());
      return;
    }
    // refetch, rebuild the UI from the updated itinerary, diff-highlight
    const itRes = await fetch(
      `/api/itinerary/${itinerary.id}${nowISO ? `?now=${encodeURIComponent(nowISO)}` : ""}`
    );
    const updated: Itinerary = await itRes.json();
    applyItinerary(updated);
    const changedCats = new Set<string>(
      data.changed.map((c: { stopIndex: number }) => updated.stops[c.stopIndex].category)
    );
    setChangedCategories(changedCats);
    const keptStop = updated.stops.find(
      (s) => s.status === "active" || s.status === "completed"
    );
    const floorLabel = formatStopTime(data.floor_time);
    setBanner(
      `${legName} cancelled — replanned from ${floorLabel}` +
        (keptStop ? `, your ${keptStop.category} is unchanged` : "")
    );
  }

  const statusFor = (category: string): StopStatus | undefined =>
    itinerary?.stops.find((s) => s.category === category)?.status;

  // map markers restyle by live status once an itinerary is active
  const styledMapStops = useMemo(
    () =>
      itinerary
        ? mapStops.map((ms) => ({ ...ms, status: statusFor(ms.category) }))
        : mapStops,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mapStops, itinerary]
  );

  // memoized so the map effect doesn't re-fire on unrelated re-renders
  const mapHome = useMemo<MapHome | null>(
    () =>
      homeLeg
        ? {
            label: HOME.label,
            lat: HOME.location.latitude,
            lng: HOME.location.longitude,
            legModeToNext: homeLeg.mode,
            polylineToNext: homeLeg.encodedPolyline,
          }
        : null,
    [homeLeg]
  );

  // one leg-detail formatter for the home leg and every inter-stop leg
  const legLabel = (leg: TravelLeg): string =>
    leg.mode === "transit"
      ? leg.transit
        ? `${leg.transit.lineName}${leg.transit.headsign ? ` ${leg.transit.headsign}` : ""} · ${
            leg.transit.stopCount ?? "?"
          } stops · from ${leg.transit.departStop} stop · ${leg.totalMinutes} min incl. ${
            leg.marginMinutes
          } min buffer`
        : `transit · ${leg.totalMinutes} min incl. ${leg.marginMinutes} min buffer`
      : leg.mode === "walk"
      ? `walk · ${leg.totalMinutes} min`
      : "travel time unavailable";

  const BADGE_COLORS: Record<StopStatus, string> = {
    upcoming: "#8ab8c4",
    active: "#e8873d",
    completed: "#7aa47a",
    skipped: "#aaa",
  };

  return (
    <div
      style={{
        position: "fixed",
        bottom: 16,
        right: 16,
        zIndex: 200,
        background: "rgba(255,255,255,0.95)",
        border: "1px solid #ccc",
        borderRadius: 10,
        padding: 12,
        maxWidth: 380,
        maxHeight: "70vh",
        overflowY: "auto",
        fontSize: 13,
      }}
    >
      <input
        type="text"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") runPipeline(); }}
        placeholder="e.g. chill coffee afternoon for two"
        style={{ width: "100%", marginBottom: 6, padding: 4 }}
      />
      <button onClick={runPipeline} disabled={stage !== "idle" || !prompt.trim()}>
        {stage === "parsing"
          ? "Parsing…"
          : stage === "searching"
          ? "Searching places…"
          : stage === "selecting"
          ? "Selecting venues…"
          : stage === "routing"
          ? "Fetching travel times…"
          : "Test Parse → Places → Select"}
      </button>

      {selections && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>Final picks</div>
          {banner && (
            <div
              style={{
                marginTop: 6,
                padding: "7px 10px",
                borderRadius: 8,
                background: "#fdeeea",
                border: "1px solid #e5b8a8",
                color: "#9a4a2e",
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              {banner}
            </div>
          )}
          {homeLeg &&
            (() => {
              // leave-home time = first timed stop's start − the home
              // leg's travel; rolled-forward plans show its date too.
              const firstTimed = schedule?.find((s) => s.start_time);
              const leaveHome = firstTimed?.start_time
                ? new Date(
                    new Date(firstTimed.start_time).getTime() -
                      homeLeg.totalMinutes * 60_000
                  )
                : null;
              return (
                <div
                  style={{
                    margin: "6px 0 0 18px",
                    fontSize: 12,
                    color: "#688",
                    borderLeft: "2px dotted #9cc4d0",
                    paddingLeft: 8,
                  }}
                >
                  from <b>{HOME.label}</b>
                  {leaveHome && <> — leave by {formatStopTime(leaveHome)}</>} ·{" "}
                  {legLabel(homeLeg)}
                </div>
              );
            })()}
          {selections.map((s) => {
            const stop = schedule?.find((t) => t.category === s.category);
            const leg = stop?.travelToNext;
            const block = weatherBlocks.find((b) => b.category === s.category);
            const wasRerouted = changedCategories.has(s.category);
            return (
              <div key={s.category}>
              <div
                style={{
                  marginTop: 6,
                  padding: "8px 10px",
                  border: wasRerouted
                    ? "2px solid #e8873d"
                    : block
                    ? "1px solid #e0d2b8"
                    : "1px solid #d5e5ea",
                  borderRadius: 8,
                  background: wasRerouted ? "#fdf3ea" : block ? "#fdf9ef" : "#f6fbfc",
                  transition: "border 0.4s ease, background 0.4s ease",
                }}
              >
                <div style={{ fontSize: 11, textTransform: "uppercase", color: "#679" }}>
                  {s.category}
                  {s.fallback && " · fallback"}
                  {itinerary && statusFor(s.category) && (
                    <span
                      style={{
                        marginLeft: 6,
                        padding: "1px 7px",
                        borderRadius: 9,
                        fontSize: 10,
                        fontWeight: 700,
                        color: "#fff",
                        background: BADGE_COLORS[statusFor(s.category)!],
                        textTransform: "lowercase",
                      }}
                    >
                      {statusFor(s.category)}
                    </span>
                  )}
                </div>
                {block ? (
                  <em style={{ color: "#96803e" }}>
                    {s.category} skipped — {block.reason}
                  </em>
                ) : s.id === null ? (
                  <em>{s.reason}</em>
                ) : (
                  <>
                    <strong>{s.name}</strong>
                    {s.rating != null && <> · {s.rating}★</>}
                    <div style={{ color: "#557", marginTop: 2 }}>{s.reason}</div>
                    {stop?.start_time && stop?.end_time && (
                      <div style={{ marginTop: 3, fontWeight: 600, color: "#367" }}>
                        be here {formatStopRange(stop.start_time, stop.end_time)}
                      </div>
                    )}
                  </>
                )}
              </div>
              {leg && (
                <div
                  style={{
                    margin: "4px 0 0 18px",
                    fontSize: 12,
                    color: "#688",
                    borderLeft: "2px dotted #9cc4d0",
                    paddingLeft: 8,
                  }}
                >
                  {legLabel(leg)}
                </div>
              )}
              </div>
            );
          })}
          {schedule && !itinerary && (
            <button onClick={startItinerary} style={{ marginTop: 8 }}>
              Start this itinerary
            </button>
          )}
          {itinerary && (
            <div style={{ marginTop: 8, fontSize: 12 }}>
              <div>
                itinerary <code>{itinerary.id.slice(0, 8)}</code> ·{" "}
                <b>{itinerary.status}</b>
              </div>
              <div
                style={{
                  marginTop: 6,
                  padding: "6px 8px",
                  border: "1px dashed #c9a227",
                  borderRadius: 8,
                  background: "#fdf9ec",
                }}
              >
                <label style={{ fontWeight: 700, color: "#8a6d1a" }}>
                  DEV · simulate time:{" "}
                </label>
                <input
                  type="datetime-local"
                  value={simNow}
                  onChange={(e) => {
                    setSimNow(e.target.value);
                    refreshItinerary(itinerary.id, e.target.value);
                  }}
                  style={{ fontSize: 12 }}
                />
                <button
                  onClick={() => {
                    setSimNow("");
                    refreshItinerary(itinerary.id, "");
                  }}
                  style={{ marginLeft: 6, fontSize: 11 }}
                >
                  real time
                </button>
                <div style={{ marginTop: 6 }}>
                  <label style={{ fontWeight: 700, color: "#8a6d1a" }}>
                    DEV · simulate disruption:{" "}
                  </label>
                  <select
                    value={disruptLeg}
                    onChange={(e) => setDisruptLeg(Number(e.target.value))}
                    style={{ fontSize: 11, maxWidth: 170 }}
                  >
                    {itinerary.stops
                      .filter((s) => s.start_time)
                      .slice(0, -1)
                      .map((s, i, arr) => {
                        const timed = itinerary.stops.filter((t) => t.start_time);
                        const next = timed[i + 1];
                        return (
                          <option key={i} value={i}>
                            leg {i}: {s.name} → {next?.name} (
                            {s.travelToNext?.mode ?? "?"})
                          </option>
                        );
                      })}
                  </select>
                  <button onClick={fireDisruption} style={{ marginLeft: 6, fontSize: 11 }}>
                    cancel transit
                  </button>
                </div>
              </div>
            </div>
          )}
          {styledMapStops.length > 0 && (
            <ItineraryMap stops={styledMapStops} home={mapHome} />
          )}
        </div>
      )}

      {error && (
        <pre style={{ color: "#b00", whiteSpace: "pre-wrap", marginTop: 6 }}>
          Error: {error}
        </pre>
      )}

      {parsed && (
        <details style={{ marginTop: 8 }}>
          <summary style={{ fontWeight: 600 }}>Parsed</summary>
          <pre style={{ whiteSpace: "pre-wrap", marginTop: 4 }}>{parsed}</pre>
        </details>
      )}

      {grouped &&
        Object.entries(grouped).map(([category, places]) => {
          const drops = dropLog.filter((d) => d.category === category);
          return (
            <div key={category} style={{ marginTop: 8 }}>
              <details>
                <summary style={{ fontWeight: 600 }}>
                  {category} — {places.length} surviving
                </summary>
                {places.length === 0 && <p>No places survived the filter.</p>}
                <ul style={{ paddingLeft: 18, marginTop: 4 }}>
                  {places.map((p) => (
                    <li key={p.id} style={{ marginBottom: 6 }}>
                      <strong>{p.displayName?.text ?? "(unnamed)"}</strong>
                      <br />
                      rating: {p.rating ?? "n/a"} · price: {p.priceLevel ?? "n/a"}
                      <br />
                      {p.currentOpeningHours?.openNow == null
                        ? "open now: n/a"
                        : p.currentOpeningHours.openNow
                        ? "open now"
                        : "closed now"}{" "}
                      · {p.businessStatus ?? "status n/a"}
                    </li>
                  ))}
                </ul>
              </details>
              <details style={{ marginTop: 2, color: "#777" }}>
                <summary>dropped ({drops.length})</summary>
                <ul style={{ paddingLeft: 18, marginTop: 4 }}>
                  {drops.map((d, i) => (
                    <li key={`${d.id}-${i}`}>
                      {d.name} — <em>{d.rule}</em> ({d.detail})
                    </li>
                  ))}
                </ul>
              </details>
            </div>
          );
        })}
    </div>
  );
}
