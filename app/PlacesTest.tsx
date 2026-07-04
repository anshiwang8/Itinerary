"use client";

import { useMemo, useState } from "react";
import { buildSchedule, ScheduledStop } from "./api/schedule/schedule";
import { TravelLeg } from "./api/schedule/travel";
import { Itinerary, StopStatus } from "./api/itinerary/store";
import ItineraryMap, { MapStop } from "./ItineraryMap";

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
  const [grouped, setGrouped] = useState<GroupedPlaces | null>(null);
  const [dropLog, setDropLog] = useState<DropEntry[]>([]);
  const [weatherBlocks, setWeatherBlocks] = useState<WeatherBlock[]>([]);
  const [selections, setSelections] = useState<Selection[] | null>(null);
  const [schedule, setSchedule] = useState<ScheduledStop[] | null>(null);
  const [mapStops, setMapStops] = useState<MapStop[]>([]);
  const [travelLegs, setTravelLegs] = useState<TravelLeg[]>([]);
  const [itinerary, setItinerary] = useState<Itinerary | null>(null);
  const [simNow, setSimNow] = useState(""); // dev time control (datetime-local)
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
    setItinerary(null);
    setSimNow("");
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

      let legs = [];
      if (points.length >= 2 && points.every(Boolean)) {
        const { startISO } = buildSchedule(sels, parseData.time_window ?? "");
        const travelRes = await fetch("/api/schedule/travel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ points, departureTime: startISO }),
        });
        const travelData = await travelRes.json();
        if (!travelRes.ok) {
          throw new Error(
            (travelData.error ?? `travel HTTP ${travelRes.status}`) +
              (travelData.details ? `\ndetails: ${travelData.details}` : "")
          );
        }
        legs = travelData.legs ?? [];
      }

      const { stops } = buildSchedule(
        sels,
        parseData.time_window ?? "",
        new Date(),
        legs
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
    const res = await fetch("/api/itinerary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stops: schedule, legs: travelLegs }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? `itinerary HTTP ${res.status}`);
      return;
    }
    await refreshItinerary(data.id, simNow);
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
          {selections.map((s) => {
            const stop = schedule?.find((t) => t.category === s.category);
            const leg = stop?.travelToNext;
            const block = weatherBlocks.find((b) => b.category === s.category);
            return (
              <div key={s.category}>
              <div
                style={{
                  marginTop: 6,
                  padding: "8px 10px",
                  border: block ? "1px solid #e0d2b8" : "1px solid #d5e5ea",
                  borderRadius: 8,
                  background: block ? "#fdf9ef" : "#f6fbfc",
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
                        be here{" "}
                        {new Date(stop.start_time).toLocaleTimeString([], {
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                        {" – "}
                        {new Date(stop.end_time).toLocaleTimeString([], {
                          hour: "numeric",
                          minute: "2-digit",
                        })}
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
                  {leg.mode === "transit"
                    ? `transit · ${leg.totalMinutes} min incl. ${leg.marginMinutes} min buffer`
                    : leg.mode === "walk"
                    ? `walk · ${leg.totalMinutes} min`
                    : "travel time unavailable"}
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
              </div>
            </div>
          )}
          {styledMapStops.length > 0 && <ItineraryMap stops={styledMapStops} />}
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
