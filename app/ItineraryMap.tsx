"use client";

import { useEffect, useRef, useState } from "react";
import { importLibrary, setOptions } from "@googlemaps/js-api-loader";
import { formatStopTime } from "./lib/timeLabels";
import { originDisplayLabel } from "./lib/locationLabels";
import {
  BubbleSegment,
  bubbleDisplayColors,
  bubbleLabel,
  groupBubbleUnits,
} from "./lib/transitBubbles";
import { RideDetail, transferPoints } from "./lib/transitDetail";
import type { PathSegment } from "./api/schedule/travel";
import { createRetryableLoader } from "./lib/retryableLoader";
import { displayableRouteMode } from "./lib/mapRoutePolicy";
import { transitRideColor } from "./lib/transitRidePalette";
import { travelLegVisible } from "./lib/travelLegVisibility";

// Printed-cartography map: pale-blue Google styling (inline JSON, so no
// Cloud map id), occurrence-coloured transit lines, and an HTML overlay layer
// for the chips / editorial cards positioned off the live map projection.
// Acid green is reserved for the active "now" stop and changed pin accents.

export interface MapStop {
  id: string;
  category: string;
  name: string;
  lat: number;
  lng: number;
  startTime: string | null;
  endTime: string | null;
  reason?: string;
  legModeToNext?: "transit" | "walk" | "driving" | "unknown";
  legIdToNext?: string | null;
  polylineToNext?: string | null;
  /** the same leg step by step, in travel order — the provider's own
   * geometry for each walk and each ride. Transit rides draw separately;
   * consecutive connected walk steps draw as one dotted run. */
  pathSegmentsToNext?: PathSegment[] | null;
  /** transit line detail for the leg leaving this stop */
  legLabel?: string | null;
  /** every ride of that leg, in order — the bubbles, and the provider's
   * own stop coordinates that place the transfer markers */
  legSegments?: RideDetail[] | null;
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
  legModeToNext?: "transit" | "walk" | "driving" | "unknown";
  legIdToNext?: string | null;
  polylineToNext?: string | null;
  pathSegmentsToNext?: PathSegment[] | null;
  legLabel?: string | null;
  legSegments?: RideDetail[] | null;
  leaveBy?: string | null;
}

/**
 * A nonce-keyed request to pan/zoom the camera onto one stop, mirroring
 * `StripFocusRequest` (ItineraryStrip.tsx): the map instance is local to this
 * component and unreachable from page.tsx, so a click routes here declaratively
 * instead of lifting the `google.maps.Map` object up. The nonce is what makes
 * clicking the SAME stop twice re-center — an unchanged `stopId` alone would
 * not re-trigger a memo/effect keyed on it.
 */
export interface MapFocusRequest {
  stopId: string;
  nonce: number;
}

// Pale-blue cartography — cool desaturated tones, POIs and transit labels
// stripped so the cards ARE the points of interest. The stripping rules are
// unchanged from the original warm-paper theme; only the colours moved.
const PAPER_STYLE: google.maps.MapTypeStyle[] = [
  { elementType: "geometry", stylers: [{ color: "#dfeaf1" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#6b8797" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#eaf3f8" }] },
  { elementType: "labels.icon", stylers: [{ visibility: "off" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#f4fafd" }] },
  { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#87a3b2" }] },
  { featureType: "road.arterial", elementType: "geometry", stylers: [{ color: "#e9f2f7" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#d8e8f0" }] },
  { featureType: "landscape.natural", elementType: "geometry", stylers: [{ color: "#dbebe8" }] },
  { featureType: "administrative", elementType: "geometry", stylers: [{ visibility: "off" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#bcdcea" }] },
];

// Route lines: a deep teal that reads on the pale map. It is the fallback
// when an agency does not publish a usable transit-line colour.
const INK = "#2E6F8A";
// The map-label gray is the established neutral on this pale-blue canvas.
// Walking stays semantically neutral instead of borrowing a route colour.
const WALK_GRAY = "#4F6F7E";
const PROVIDER_HEX_COLOR = /^#[\da-f]{6}$/i;

/**
 * Google encoded polylines use an E5 coordinate grid: one diagonal grid
 * cell is at most ~1.6 m at the equator (less in Toronto). Two metres admits
 * that rounding-scale boundary mismatch plus floating noise, while remaining
 * about one pixel even at an ordinary close itinerary zoom. Anything farther
 * is a real gap and starts a separate run — no connector is invented.
 */
const WALK_BOUNDARY_TOLERANCE_METERS = 2;
// Sub-half-metre cumulative paths are repeated-point / rounding noise, not a
// meaningful walk instruction. computeLength is used so a small loop is not
// mistaken for zero merely because its endpoints happen to meet.
const WALK_MIN_PATH_METERS = 0.5;
const WALK_DOT_REPEAT = "12px";

function transitStrokeColor(color?: string | null): string {
  const candidate = color?.trim();
  return candidate && PROVIDER_HEX_COLOR.test(candidate) ? candidate : INK;
}

function usableDecodedPath(value: unknown): google.maps.LatLng[] | null {
  if (!Array.isArray(value) || value.length < 2) return null;

  for (const point of value) {
    if (!point || typeof point !== "object") return null;
    const latMember = (point as { lat?: unknown }).lat;
    const lngMember = (point as { lng?: unknown }).lng;
    const lat = typeof latMember === "function" ? latMember.call(point) : latMember;
    const lng = typeof lngMember === "function" ? lngMember.call(point) : lngMember;
    if (
      typeof lat !== "number" ||
      typeof lng !== "number" ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      lat < -90 ||
      lat > 90 ||
      lng < -180 ||
      lng > 180
    ) {
      return null;
    }
  }

  return value as google.maps.LatLng[];
}

const loadMapLibs = createRetryableLoader(async () => {
    const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY?.trim();
    if (!key) throw new Error("The browser Maps key is unavailable.");
    setOptions({ key, v: "weekly" });
    return Promise.all([
      importLibrary("maps") as Promise<google.maps.MapsLibrary>,
      importLibrary("geometry") as Promise<google.maps.GeometryLibrary>,
    ]);
});

type MapPoint = { x: number | string; y: number | string };
const MAX_MAP_RETRIES = 2;

/**
 * How far the START may sit from the day's stops and still be folded into
 * the opening fit. A start outside the city is legitimate now — the
 * geocoder allows one up to 75 km away, because people commute in — but a
 * far home and a downtown cluster of stops cannot share one readable
 * frame: fitting both squeezes the whole outing, which is the thing the
 * user came to look at, into a smudge at one corner.
 *
 * The test is RELATIVE, because "too far" is a fact about the plan's own
 * size rather than a number of kilometres: home may sit a few times the
 * stops' own radius away, with a floor so a compact plan (or a single
 * stop, radius zero) still keeps a sensible allowance. A live plan from
 * Oakville — 35 km out, inside the geocoder's cap — is what set these:
 * an absolute 40 km ceiling admitted it and the two downtown stops landed
 * on top of each other.
 *
 * Past the threshold the view fits the STOPS. The home marker is still
 * drawn at its real coordinates and is one zoom-out away — it is off the
 * opening frame, not missing, and nothing about where it sits is faked to
 * keep it on screen.
 */
const HOME_FIT_RADIUS_MULTIPLE = 3;
const HOME_FIT_MIN_RADIUS_METERS = 1_500;

/**
 * Zoom level for an explicit stop focus: "see the building and its block" —
 * street names render and the venue reads unambiguous against the pale
 * `PAPER_STYLE`, without cropping the surrounding context the way one more
 * step in (18) does on this style. One step out (16) reads noticeably wider
 * than street level. Picked by eyeballing this exact map style, not measured.
 */
const STOP_FOCUS_ZOOM = 17;

/** Would including home still leave the stops readable? Measured from the
 *  stops' own centre — the thing the frame exists to show. Uses the Maps
 *  geometry library, already loaded here, rather than a second copy of the
 *  haversine in `travel.ts` (which is server-only and cannot be imported
 *  into a client component). */
function homeFitsWithStops(
  home: google.maps.LatLngLiteral,
  stops: google.maps.LatLngLiteral[]
): boolean {
  if (stops.length === 0) return true;
  const bounds = new google.maps.LatLngBounds();
  stops.forEach((p) => bounds.extend(p));
  const centre = bounds.getCenter();
  const { computeDistanceBetween } = google.maps.geometry.spherical;
  const stopsRadius = Math.max(
    ...stops.map((stop) => computeDistanceBetween(centre, stop))
  );
  const allowance =
    Math.max(stopsRadius, HOME_FIT_MIN_RADIUS_METERS) *
    HOME_FIT_RADIUS_MULTIPLE;
  return computeDistanceBetween(centre, home) <= allowance;
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
  visibleTravelLegIds?: readonly string[];
  legacyTransitVisibility?: boolean;
  /** an explicit request to pan/zoom onto one stop — fires ONLY on a real
   *  user click (see MapFocusRequest); never derived from `selected`, which
   *  also changes on programmatic selection (auto-select-stop-0 on plan
   *  load, a swap/reroute/remove's own reselect, …) that must not yank the
   *  camera. */
  focusRequest?: MapFocusRequest | null;
}

export default function ItineraryMap({ stops, home, selected, timeZone = "America/Toronto", onSelect, visibleTravelLegIds = [], legacyTransitVisibility = true, focusRequest = null }: Props) {
  const mapDivRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const projRef = useRef<google.maps.MapCanvasProjection | null>(null);
  const linesRef = useRef<google.maps.Polyline[]>([]);
  const visibleTravelKey = visibleTravelLegIds.join("|");
  const rafRef = useRef<number | null>(null);
  const [, setTick] = useState(0);
  const [mapState, setMapState] = useState<"loading" | "ready" | "failed">("loading");
  const [retryCount, setRetryCount] = useState(0);
  const [dismissedRetry, setDismissedRetry] = useState<number | null>(null);

  // one-time map + projection probe
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setMapState("loading");
      try {
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
        }
        setMapState("ready");
      } catch {
        if (!cancelled) {
          projRef.current = null;
          setMapState("failed");
        }
      }
    })();
    return () => {
      cancelled = true;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [retryCount]);

  // Route overlays. Each effect invocation owns exactly the polylines it
  // creates so a stale async cleanup can never detach a newer render's lines.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || mapState !== "ready") return;
    let cancelled = false;
    const ownedLines: google.maps.Polyline[] = [];
    const visibleTravelIds = visibleTravelKey.split("|").filter(Boolean);

    const removeOwnedLines = () => {
      ownedLines.forEach((line) => line.setMap(null));
      if (linesRef.current === ownedLines) {
        linesRef.current = [];
      } else if (ownedLines.length > 0) {
        const owned = new Set(ownedLines);
        linesRef.current = linesRef.current.filter((line) => !owned.has(line));
      }
    };

    // Normally the previous invocation's cleanup already did this. Keeping
    // the ownership ref empty at setup also covers a map-state transition
    // that disposed the old effect before its async loader resolved.
    linesRef.current.forEach((line) => line.setMap(null));
    linesRef.current = [];

    (async () => {
      try {
        const [maps, geometry] = await loadMapLibs();
        if (cancelled || mapRef.current !== map) return;

        const segs: {
          from: google.maps.LatLngLiteral;
          to: google.maps.LatLngLiteral;
          mode?: "transit" | "walk" | "driving" | "unknown";
          encoded?: string | null;
          pathSegments?: PathSegment[] | null;
          changed: boolean;
          legId?: string | null;
          origin: "home" | "interstop";
        }[] = [];

        if (home && stops[0]) {
          segs.push({
            from: { lat: home.lat, lng: home.lng },
            to: { lat: stops[0].lat, lng: stops[0].lng },
            mode: home.legModeToNext,
            encoded: home.polylineToNext,
            pathSegments: home.pathSegmentsToNext,
            changed: false,
            legId: home.legIdToNext,
            origin: "home",
          });
        }
        for (let i = 0; i < stops.length - 1; i++) {
          segs.push({
            from: { lat: stops[i].lat, lng: stops[i].lng },
            to: { lat: stops[i + 1].lat, lng: stops[i + 1].lng },
            mode: stops[i].legModeToNext,
            encoded: stops[i].polylineToNext,
            pathSegments: stops[i].pathSegmentsToNext,
            // A changed destination marks its inbound leg as changed.
            changed: !!stops[i + 1].changed,
            legId: stops[i].legIdToNext,
            origin: "interstop",
          });
        }

        const addLine = (options: google.maps.PolylineOptions) => {
          const line = new maps.Polyline(options);
          ownedLines.push(line);
          linesRef.current = ownedLines;
        };

        const addHalo = (
          path: google.maps.LatLng[] | google.maps.LatLngLiteral[],
          color: string,
          strokeWeight: number
        ) => {
          addLine({
            map,
            path,
            clickable: false,
            strokeColor: color,
            strokeOpacity: 0.22,
            strokeWeight: strokeWeight + 5,
            zIndex: 1,
          });
        };

        const addWalkRun = (
          path: google.maps.LatLng[],
          changed: boolean
        ) => {
          const addDots = (
            scale: number,
            fillOpacity: number,
            zIndex: number
          ) => {
            addLine({
              map,
              path,
              clickable: false,
              // Both layers are genuinely dotted. A zero-opacity base stroke
              // prevents changed emphasis from turning walking into a solid
              // route, while the repeated native circle symbol stays crisp.
              strokeOpacity: 0,
              zIndex,
              icons: [
                {
                  icon: {
                    path: google.maps.SymbolPath.CIRCLE,
                    fillColor: WALK_GRAY,
                    fillOpacity,
                    scale,
                    strokeOpacity: 0,
                  },
                  offset: "0",
                  repeat: WALK_DOT_REPEAT,
                },
              ],
            });
          };

          // Changed walking keeps its neutral meaning: larger, lighter dots
          // underneath the unchanged primary rather than a semantic recolour.
          if (changed) addDots(3.6, 0.24, 1);
          addDots(2.0, 0.88, 2);
        };

        for (const seg of segs) {
          const mode = displayableRouteMode(seg.mode);
          if (!mode) continue;
          if (!travelLegVisible({
            mode,
            legId: seg.legId,
            origin: seg.origin,
            visibleLegIds: visibleTravelIds,
            legacyTransitVisibility,
          })) continue;

          if (mode === "transit" && Array.isArray(seg.pathSegments)) {
            // This accumulator is deliberately scoped to ONE itinerary leg.
            // A new outer segment can never inherit or join the previous
            // leg's final walk, even when their decoded endpoints coincide.
            let walkRun: google.maps.LatLng[] | null = null;
            const flushWalkRun = () => {
              if (walkRun) addWalkRun(walkRun, seg.changed);
              walkRun = null;
            };

            for (const pathSegment of seg.pathSegments) {
              if (pathSegment.mode === "walk") {
                let path: google.maps.LatLng[] | null = null;
                if (pathSegment.encodedPolyline) {
                  try {
                    const decoded = usableDecodedPath(
                      geometry.encoding.decodePath(pathSegment.encodedPolyline)
                    );
                    const length = decoded
                      ? geometry.spherical.computeLength(decoded)
                      : Number.NaN;
                    if (
                      decoded &&
                      Number.isFinite(length) &&
                      length > WALK_MIN_PATH_METERS
                    ) {
                      path = decoded;
                    }
                  } catch {
                    // Decode/geometry failures break only this walking gap.
                  }
                }

                // A missing, malformed, degenerate, or throwing walk entry is
                // a hard boundary. Valid geometry on either side must never be
                // silently joined across it.
                if (!path) {
                  flushWalkRun();
                  continue;
                }

                if (!walkRun) {
                  walkRun = path;
                  continue;
                }

                let boundaryMeters = Number.POSITIVE_INFINITY;
                try {
                  boundaryMeters = geometry.spherical.computeDistanceBetween(
                    walkRun[walkRun.length - 1],
                    path[0]
                  );
                } catch {
                  // Treat a distance failure exactly like a disconnected path.
                }

                if (
                  Number.isFinite(boundaryMeters) &&
                  boundaryMeters <= WALK_BOUNDARY_TOLERANCE_METERS
                ) {
                  // The next first point is the same provider boundary at E5
                  // precision. Keep the earlier decoded point and omit the
                  // duplicate/rounding-equivalent one: no tiny bridge edge is
                  // added, and every remaining coordinate is provider-native.
                  walkRun = [...walkRun, ...path.slice(1)];
                } else {
                  // Both shapes are valid but spatially separate. Render two
                  // runs; never draw the straight line between their endpoints.
                  flushWalkRun();
                  walkRun = path;
                }
                continue;
              }

              // Every transit step ends the walking gap BEFORE ride decoding,
              // so even a malformed ride cannot join walks across itself.
              flushWalkRun();
              if (pathSegment.mode !== "transit" || !pathSegment.encodedPolyline) {
                continue;
              }

              let path: google.maps.LatLng[] | null = null;
              try {
                path = usableDecodedPath(
                  geometry.encoding.decodePath(pathSegment.encodedPolyline)
                );
              } catch {
                // One malformed provider step must not hide later valid rides.
              }
              if (!path) continue;

              const color =
                transitRideColor(pathSegment.paletteSlot) ??
                transitStrokeColor(pathSegment.color);
              const strokeWeight = 3.5;
              if (seg.changed) addHalo(path, color, strokeWeight);
              addLine({
                map,
                path,
                clickable: false,
                strokeColor: color,
                strokeOpacity: 0.92,
                strokeWeight,
                zIndex: 2,
              });
            }
            flushWalkRun();
            // The presence of step data is authoritative. Missing/invalid
            // step shapes never fall back to a fabricated whole-leg line.
            continue;
          }

          let path: google.maps.LatLng[] | google.maps.LatLngLiteral[] | null;
          if (seg.encoded) {
            try {
              path = usableDecodedPath(geometry.encoding.decodePath(seg.encoded));
            } catch {
              path = null;
            }
          } else if (mode === "walk") {
            path = [seg.from, seg.to];
          } else {
            // A transit leg without provider geometry has no honest route
            // shape. Never connect its endpoints with a fabricated ride.
            //
            // A DRIVING leg lands here for the same reason and must be
            // treated the same way, NOT like the walk branch above: a
            // straight line between two venues is not a road, and drawn on a
            // street map it reads as one. No geometry, no line.
            continue;
          }
          if (!path) continue;

          // Pre-Piece-1 transit legs retain their existing whole-leg dashed
          // fallback, and ordinary walking legs retain their solid ink line.
          const strokeWeight = 2.5;
          const changedPrimaryLayer = seg.changed ? { zIndex: 2 } : {};
          if (seg.changed) addHalo(path, INK, strokeWeight);
          if (mode === "driving") {
            // The third styling case: a solid ink road line, the same
            // language as a whole-leg walk (this IS real provider geometry),
            // reached only because `seg.encoded` decoded above.
            addLine({
              map,
              path,
              strokeColor: INK,
              strokeOpacity: 0.92,
              strokeWeight,
              ...changedPrimaryLayer,
            });
          } else if (mode === "transit") {
            addLine({
              map,
              path,
              strokeOpacity: 0,
              ...changedPrimaryLayer,
              icons: [
                {
                  icon: {
                    path: "M 0,-1 0,1",
                    strokeOpacity: 1,
                    strokeColor: INK,
                    strokeWeight,
                    scale: 3,
                  },
                  offset: "0",
                  repeat: "13px",
                },
              ],
            });
          } else {
            addLine({
              map,
              path,
              strokeColor: INK,
              strokeOpacity: 0.92,
              strokeWeight,
              ...changedPrimaryLayer,
            });
          }
        }
      } catch {
        removeOwnedLines();
        if (!cancelled) {
          projRef.current = null;
          setMapState("failed");
        }
      }
    })();
    return () => {
      cancelled = true;
      removeOwnedLines();
    };
  }, [stops, home, mapState, visibleTravelKey, legacyTransitVisibility]);

  // Fit bounds only when the geography actually changes (initial plan or a
  // reroute swapping a venue) — NOT on every status tick, which would yank
  // the view around each time the dev clock moves.
  const fitKey =
    stops.map((s) => `${s.lat.toFixed(5)},${s.lng.toFixed(5)}`).join("|") +
    (home ? `#${home.lat.toFixed(5)},${home.lng.toFixed(5)}` : "");
  // The whole-plan reframe: the initial/mutation-driven fitKey effect below
  // and the "show full itinerary" button call this exact same function, so
  // there is one definition of the bounds math, not two.
  const fitAllStops = () => {
    const map = mapRef.current;
    if (!map || mapState !== "ready") return;
    const pts: google.maps.LatLngLiteral[] = stops.map((s) => ({ lat: s.lat, lng: s.lng }));
    // Home joins the fit only while it doesn't take the frame over — see
    // HOME_FIT_MAX_METERS. With no stops yet, home IS the geography.
    if (home) {
      const homePt = { lat: home.lat, lng: home.lng };
      if (homeFitsWithStops(homePt, pts)) pts.push(homePt);
    }
    if (pts.length === 1) {
      map.setCenter(pts[0]);
      map.setZoom(15);
    } else if (pts.length > 1) {
      const bounds = new google.maps.LatLngBounds();
      pts.forEach((p) => bounds.extend(p));
      map.fitBounds(bounds, { top: 130, bottom: 90, left: 80, right: 80 });
    }
  };
  useEffect(() => {
    fitAllStops();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, mapState]);

  // The explicit per-stop camera focus. Keyed ONLY on the request's nonce —
  // never on `selected` or on `stops` — so a programmatic selection (plan
  // load's auto-select-stop-0, a swap/reroute/remove's own reselect) can
  // never yank the view; only an actual click through `focusRequest` can.
  // Re-clicking the same stop still moves the camera because the nonce, not
  // the stopId, is what changed. `stops` is read fresh from this render's
  // closure without being a dependency, the same pattern `fitAllStops` above
  // uses for `fitKey`.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || mapState !== "ready" || !focusRequest) return;
    const target = stops.find((s) => s.id === focusRequest.stopId);
    if (!target) return;
    map.panTo({ lat: target.lat, lng: target.lng });
    map.setZoom(STOP_FOCUS_ZOOM);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest?.nonce, mapState]);

  const fallbackPoints = [
    ...(home ? [{ lat: home.lat, lng: home.lng }] : []),
    ...stops.map(({ lat, lng }) => ({ lat, lng })),
  ].filter(({ lat, lng }) => Number.isFinite(lat) && Number.isFinite(lng));
  const lats = fallbackPoints.map(({ lat }) => lat);
  const lngs = fallbackPoints.map(({ lng }) => lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const fallbackPx = (lat: number, lng: number): MapPoint | null => {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const x = minLng === maxLng ? 50 : 15 + ((lng - minLng) / (maxLng - minLng)) * 70;
    const y = minLat === maxLat ? 50 : 72 - ((lat - minLat) / (maxLat - minLat)) * 48;
    return { x: `${x}%`, y: `${y}%` };
  };

  const px = (lat: number, lng: number): MapPoint | null => {
    const proj = projRef.current;
    if (!proj) return fallbackPx(lat, lng);
    const p = proj.fromLatLngToContainerPixel(new google.maps.LatLng(lat, lng));
    return p ? { x: p.x, y: p.y } : null;
  };
  const midPx = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) =>
    px((a.lat + b.lat) / 2, (a.lng + b.lng) / 2);
  const chipX = (x: number | string): number | string => {
    const width = mapDivRef.current?.clientWidth ?? 0;
    if (width <= 0) return x;
    const projected =
      typeof x === "number" ? x : (Number.parseFloat(x) / 100) * width;
    if (!Number.isFinite(projected)) return x;
    // CSS caps chips at 240px with a 12px viewport gutter. On very narrow
    // screens the two gutters meet in the centre, which is still preferable
    // to placing an interactive target outside the viewport.
    const edge = Math.min(132, width / 2);
    return Math.max(edge, Math.min(width - edge, projected));
  };

  // Complete-leg labels pinned to each leg's midpoint (home leg + inter-stop).
  // The same exact decision that guarded native construction guards these.
  const legLabels: { key: string; x: number | string; y: number | string; text: string; segs: BubbleSegment[] }[] = [];
  const completeLegVisible = (
    mode: MapHome["legModeToNext"],
    legId: string | null | undefined,
    origin: "home" | "interstop"
  ) => travelLegVisible({
    mode,
    legId,
    origin,
    visibleLegIds: visibleTravelLegIds,
    legacyTransitVisibility,
  });
  if (home && stops[0] && home.legLabel && completeLegVisible(home.legModeToNext, home.legIdToNext, "home")) {
    const p = midPx(home, stops[0]);
    if (p) legLabels.push({ key: "home", x: p.x, y: p.y, text: home.legLabel, segs: home.legSegments ?? [] });
  }
  for (let i = 0; i < stops.length - 1; i++) {
    if (stops[i].legLabel && completeLegVisible(stops[i].legModeToNext, stops[i].legIdToNext, "interstop")) {
      const p = midPx(stops[i], stops[i + 1]);
      if (p) legLabels.push({ key: stops[i].id, x: p.x, y: p.y, text: stops[i].legLabel!, segs: stops[i].legSegments ?? [] });
    }
  }

  // Where you CHANGE LINES — pinned at the provider's own coordinate for
  // the stop you get off at (or, failing that, the one you get on at).
  // Deliberately NOT midPx: a leg label is a caption for the whole leg and
  // the midpoint is a fine place to hang one, but a transfer is a REAL
  // PLACE, and putting it anywhere but its own coordinate would be
  // inventing a fact. A transfer with no published coordinate gets no
  // marker at all.
  const transferMarks: {
    key: string;
    x: number | string;
    y: number | string;
    label: string;
  }[] = [];
  const addTransfers = (legKey: string, segs?: RideDetail[] | null) => {
    for (const t of transferPoints(segs)) {
      const p = px(t.latitude, t.longitude);
      if (!p) continue;
      transferMarks.push({
        key: `${legKey}-${t.key}`,
        x: p.x,
        y: p.y,
        label: `change from ${t.fromLine} to ${t.toLine}${t.stopName ? ` at ${t.stopName}` : ""}`,
      });
    }
  };
  if (home && completeLegVisible(home.legModeToNext, home.legIdToNext, "home")) addTransfers("home", home.legSegments);
  for (const stop of stops) {
    if (completeLegVisible(stop.legModeToNext, stop.legIdToNext, "interstop")) addTransfers(stop.id, stop.legSegments);
  }

  return (
    <div className="mapwrap" data-map-state={mapState}>
      <div
        ref={mapDivRef}
        className="map"
        role="img"
        aria-label={`Map of your outing${home?.label ? ` from ${home.label}` : ""}`}
      />
      {mapState === "failed" && dismissedRetry !== retryCount && (
        <div className="mapfallback" role="alert">
          <span>
            The live map is unavailable. Your itinerary and venue pins are still
            usable.
          </span>
          {retryCount < MAX_MAP_RETRIES && (
            <button
              type="button"
              className="mapfallback__retry"
              onClick={() => setRetryCount((count) => count + 1)}
            >
              Retry map
            </button>
          )}
          <button
            type="button"
            className="mapfallback__dismiss"
            aria-label="Dismiss map warning"
            onClick={() => setDismissedRetry(retryCount)}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
      )}
      {/* Reframes to the whole plan — the same fit the effect above runs on
          load and on every geometry-changing mutation, on demand. Camera/
          display only: it never touches which leg is visible or any stop's
          venue/time. */}
      <button
        type="button"
        className="mapctl mapctl--fit"
        aria-label="Show the whole itinerary"
        onClick={fitAllStops}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
        </svg>
      </button>
      <div className="ov-layer">
        {legLabels.map((l) => (
          <div key={l.key} className="leglab" style={{ left: l.x, top: l.y }}>
            {l.segs.length > 0 && (
              <>
                {/* Paired bubbles are intentionally colour-only at this map
                    scale, so publish their authentic riding-order names via
                    the existing screen-reader-only mechanism. */}
                {l.segs.length > 1 && (
                  <span className="sr-only">
                    Routes {l.segs.map((seg) => seg.lineName).join(", then ")}
                  </span>
                )}
                {/* the strip's stacked-bubble treatment at map scale: pairs
                    of small circles, odd leftover full-size. */}
                <span className="leglab__bubbles" aria-hidden="true">
                  {groupBubbleUnits(l.segs).map((unit, i) => (
                    <span key={i} className="leglab__bunit">
                      {unit.map((seg, j) => {
                        const colors = bubbleDisplayColors(seg);
                        return (
                          <span
                            key={j}
                            className={unit.length === 2 ? "leglab__bubble leglab__bubble--sm" : "leglab__bubble"}
                            style={{ background: colors.background, color: colors.foreground }}
                            title={seg.lineName}
                          >
                            {unit.length === 2 ? "" : bubbleLabel(seg)}
                          </span>
                        );
                      })}
                    </span>
                  ))}
                </span>
              </>
            )}
            {l.text}
          </div>
        ))}
        {/* transfer points: hollow ring + change glyph, so it reads as
            "change here" and never as another stop on the day. The full
            "from line → to line at stop" text lives in the strip's
            timeline, which is where a screen reader meets it. */}
        {transferMarks.map((t) => (
          <div
            key={t.key}
            className="mk mk--transfer"
            style={{ left: t.x, top: t.y }}
            title={t.label}
            aria-hidden="true"
          >
            <div className="mk__dot">
              <svg viewBox="0 0 24 24">
                <path d="M7.5 4 3 8.5l4.5 4.5v-3H15V7H7.5zm9 7v3H9v2.5h7.5v3l4.5-4.5z" />
              </svg>
            </div>
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
                {home.leaveBy && (
                  <div className="mk__tag">
                    leave {originDisplayLabel(home.label)} · {home.leaveBy}
                  </div>
                )}
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
                type="button"
                className={
                  "chip" +
                  (isSel ? " chip--selected" : "") +
                  (s.status === "active" ? " chip--live" : "") +
                  (s.status === "completed" ? " chip--done" : "") +
                  (s.changed ? " chip--changed" : "")
                }
                style={{
                  left: chipX(p.x),
                  top: p.y,
                  zIndex: isSel ? 9 : s.changed ? 8 : undefined,
                }}
                aria-label={`Show stop ${i + 1}: ${s.name}`}
                aria-pressed={isSel}
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
