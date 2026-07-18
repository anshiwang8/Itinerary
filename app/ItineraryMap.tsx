"use client";

import { useEffect, useRef, useState } from "react";
import { importLibrary, setOptions } from "@googlemaps/js-api-loader";
import { formatStopTime } from "./lib/timeLabels";

// Printed-cartography map: warm-paper Google styling (inline JSON, so no
// Cloud map id), ink-navy route lines, and an HTML overlay layer for the
// chips / editorial cards positioned off the live map projection. Acid
// green is reserved for the active "now" stop and reroute-changed stops.

export interface MapStop {
  id: string;
  category: string;
  name: string;
  lat: number;
  lng: number;
  startTime: string | null;
  endTime: string | null;
  reason?: string;
  legModeToNext?: "transit" | "walk" | "unknown";
  polylineToNext?: string | null;
  /** transit line detail for the leg leaving this stop */
  legLabel?: string | null;
  status?: "upcoming" | "active" | "completed" | "skipped";
  /** replanned in this session → acid green */
  changed?: boolean;
  /** pre-reroute start, shown struck-through while the change is fresh */
  oldStart?: string | null;
  blockedReason?: string | null;
}

export interface MapHome {
  label: string;
  lat: number;
  lng: number;
  legModeToNext?: "transit" | "walk" | "unknown";
  polylineToNext?: string | null;
  legLabel?: string | null;
  leaveBy?: string | null;
}

// Warm-paper cartography — desaturated greys, POIs and transit stripped
// so the cards ARE the points of interest.
const PAPER_STYLE: google.maps.MapTypeStyle[] = [
  { elementType: "geometry", stylers: [{ color: "#e9e6df" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#5c5f57" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#e9e6df" }] },
  { elementType: "labels.icon", stylers: [{ visibility: "off" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#f1ede5" }] },
  { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#7a7d74" }] },
  { featureType: "road.arterial", elementType: "geometry", stylers: [{ color: "#e6e1d6" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#ddd7ca" }] },
  { featureType: "landscape.natural", elementType: "geometry", stylers: [{ color: "#e4e0d5" }] },
  { featureType: "administrative", elementType: "geometry", stylers: [{ visibility: "off" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#d9d5cb" }] },
];

const INK = "#17212E";
const LIVE = "#C8F000";

let libsPromise: Promise<
  [google.maps.MapsLibrary, google.maps.GeometryLibrary]
> | null = null;
function loadMapLibs() {
  if (!libsPromise) {
    setOptions({ key: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "", v: "weekly" });
    libsPromise = Promise.all([
      importLibrary("maps") as Promise<google.maps.MapsLibrary>,
      importLibrary("geometry") as Promise<google.maps.GeometryLibrary>,
    ]);
  }
  return libsPromise;
}

interface Props {
  stops: MapStop[];
  home?: MapHome | null;
  selected: string | null;
  /** the plan's zone — pin times render in it (default Toronto) */
  timeZone?: string;
  /** the selected stop, identified by VENUE ID (two stops can share a
   *  category — see code-audit 2026-07-18 §7.2) */
  onSelect: (stopId: string) => void;
}

export default function ItineraryMap({ stops, home, selected, timeZone = "America/Toronto", onSelect }: Props) {
  const mapDivRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const projRef = useRef<google.maps.MapCanvasProjection | null>(null);
  const linesRef = useRef<google.maps.Polyline[]>([]);
  const rafRef = useRef<number | null>(null);
  const [, setTick] = useState(0);
  const [ready, setReady] = useState(false);

  // one-time map + projection probe
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [maps] = await loadMapLibs();
      if (cancelled || !mapDivRef.current) return;
      if (!mapRef.current) {
        mapRef.current = new maps.Map(mapDivRef.current, {
          center: { lat: 43.6497, lng: -79.4197 },
          zoom: 14,
          styles: PAPER_STYLE,
          disableDefaultUI: true,
          gestureHandling: "greedy",
          backgroundColor: "#e9e6df",
          clickableIcons: false,
        });
        // A projection probe: its draw() fires on every pan/zoom, giving
        // us live container-pixel projection for the HTML overlay layer.
        // The tick is scheduled on the next frame — never call setState
        // synchronously inside draw(), which Google can invoke during a
        // React commit (setState-in-render crash).
        class Probe extends maps.OverlayView {
          onAdd() {}
          onRemove() {}
          draw() {
            projRef.current = this.getProjection();
            if (rafRef.current == null) {
              rafRef.current = requestAnimationFrame(() => {
                rafRef.current = null;
                setTick((t) => t + 1);
              });
            }
          }
        }
        const probe = new Probe();
        probe.setMap(mapRef.current);
        setReady(true);
      }
    })();
    return () => {
      cancelled = true;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // route polylines + fit bounds when the stops change
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    let cancelled = false;
    (async () => {
      const [maps, geometry] = await loadMapLibs();
      if (cancelled) return;
      linesRef.current.forEach((l) => l.setMap(null));
      linesRef.current = [];

      const segs: {
        from: google.maps.LatLngLiteral;
        to: google.maps.LatLngLiteral;
        mode?: "transit" | "walk" | "unknown";
        encoded?: string | null;
        live: boolean;
      }[] = [];

      if (home && stops[0]) {
        segs.push({
          from: { lat: home.lat, lng: home.lng },
          to: { lat: stops[0].lat, lng: stops[0].lng },
          mode: home.legModeToNext,
          encoded: home.polylineToNext,
          live: false,
        });
      }
      for (let i = 0; i < stops.length - 1; i++) {
        segs.push({
          from: { lat: stops[i].lat, lng: stops[i].lng },
          to: { lat: stops[i + 1].lat, lng: stops[i + 1].lng },
          mode: stops[i].legModeToNext,
          encoded: stops[i].polylineToNext,
          // the redrawn inbound leg of a changed stop reads live
          live: !!stops[i + 1].changed,
        });
      }

      for (const seg of segs) {
        const path = seg.encoded
          ? geometry.encoding.decodePath(seg.encoded)
          : [seg.from, seg.to];
        const color = seg.live ? LIVE : INK;
        const line =
          seg.mode === "transit"
            ? new maps.Polyline({
                map,
                path,
                strokeOpacity: 0,
                icons: [
                  {
                    icon: { path: "M 0,-1 0,1", strokeOpacity: 1, strokeColor: color, strokeWeight: 2.5, scale: 3 },
                    offset: "0",
                    repeat: "13px",
                  },
                ],
              })
            : new maps.Polyline({ map, path, strokeColor: color, strokeOpacity: 0.92, strokeWeight: seg.live ? 3.5 : 2.5 });
        linesRef.current.push(line);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stops, home, ready]);

  // Fit bounds only when the geography actually changes (initial plan or a
  // reroute swapping a venue) — NOT on every status tick, which would yank
  // the view around each time the dev clock moves.
  const fitKey =
    stops.map((s) => `${s.lat.toFixed(5)},${s.lng.toFixed(5)}`).join("|") +
    (home ? `#${home.lat.toFixed(5)},${home.lng.toFixed(5)}` : "");
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const pts: google.maps.LatLngLiteral[] = stops.map((s) => ({ lat: s.lat, lng: s.lng }));
    if (home) pts.push({ lat: home.lat, lng: home.lng });
    if (pts.length === 1) {
      map.setCenter(pts[0]);
      map.setZoom(15);
    } else if (pts.length > 1) {
      const bounds = new google.maps.LatLngBounds();
      pts.forEach((p) => bounds.extend(p));
      map.fitBounds(bounds, { top: 130, bottom: 90, left: 80, right: 80 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, ready]);

  const px = (lat: number, lng: number) => {
    const proj = projRef.current;
    if (!proj) return null;
    const p = proj.fromLatLngToContainerPixel(new google.maps.LatLng(lat, lng));
    return p ? { x: p.x, y: p.y } : null;
  };
  const midPx = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) =>
    px((a.lat + b.lat) / 2, (a.lng + b.lng) / 2);

  // transit leg labels pinned to each leg's midpoint (home leg + inter-stop)
  const legLabels: { key: string; x: number; y: number; text: string }[] = [];
  if (home && stops[0] && home.legLabel) {
    const p = midPx(home, stops[0]);
    if (p) legLabels.push({ key: "home", x: p.x, y: p.y, text: home.legLabel });
  }
  for (let i = 0; i < stops.length - 1; i++) {
    if (stops[i].legLabel) {
      const p = midPx(stops[i], stops[i + 1]);
      if (p) legLabels.push({ key: stops[i].id, x: p.x, y: p.y, text: stops[i].legLabel! });
    }
  }

  return (
    <div className="mapwrap">
      <div ref={mapDivRef} className="map" aria-label="Map of your evening in Ossington" />
      <div className="ov-layer">
        {legLabels.map((l) => (
          <div key={l.key} className="leglab" style={{ left: l.x, top: l.y }}>
            {l.text}
          </div>
        ))}
        {home &&
          (() => {
            const p = px(home.lat, home.lng);
            if (!p) return null;
            return (
              <div className="mk mk--home" style={{ left: p.x, top: p.y }}>
                <div className="mk__dot" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <path d="M12 3 3 10v11h6v-6h6v6h6V10z" />
                  </svg>
                </div>
                {home.leaveBy && <div className="mk__tag">leave {home.label.replace(/^Home · /, "")} · {home.leaveBy}</div>}
              </div>
            );
          })()}

        {stops.map((s, i) => {
          const p = px(s.lat, s.lng);
          if (!p) return null;
          // Chartreuse marker is reserved for the live "now" stop. A
          // swap-changed upcoming stop keeps its ink marker (with a subtle
          // changed ring); its just-changed signal is the settling time /
          // redrawn route, not a "now" pin.
          // Chartreuse marker is reserved for the live "now" stop. A
          // swap-changed upcoming stop keeps its ink marker (chartreuse
          // ring). The venue detail now lives in the top strip — the map
          // shows compact pin tags only, highlighted when selected.
          const live = s.status === "active";
          const changed = !!s.changed;
          const isSel = selected === s.id;
          const mkClass =
            "mk " +
            (live ? "mk--live" : changed ? "mk--changed" : s.status === "completed" ? "mk--done" : "");
          return (
            <div key={s.id}>
              <div className={mkClass} style={{ left: p.x, top: p.y }} aria-hidden="true">
                <div className="mk__dot" />
              </div>
              <button
                className={
                  "chip" +
                  (isSel ? " chip--selected" : "") +
                  (s.status === "active" ? " chip--live" : "") +
                  (s.status === "completed" ? " chip--done" : "") +
                  (s.changed ? " chip--changed" : "")
                }
                style={{ left: p.x, top: p.y, zIndex: isSel ? 9 : s.changed ? 8 : undefined }}
                onClick={() => onSelect(s.id)}
              >
                <span className="chip__num">{i + 1}</span>
                <span className="chip__name">{s.name}</span>
                {s.startTime && (
                  <span className="chip__time">
                    {s.changed && s.oldStart ? (
                      <>
                        <span className="old-time">{formatStopTime(s.oldStart, new Date(), timeZone)}</span>
                        <span className="new-time">{formatStopTime(s.startTime, new Date(), timeZone)}</span>
                      </>
                    ) : (
                      formatStopTime(s.startTime, new Date(), timeZone)
                    )}
                  </span>
                )}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
