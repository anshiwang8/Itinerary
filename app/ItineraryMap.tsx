"use client";

import { useEffect, useRef } from "react";
import { importLibrary, setOptions } from "@googlemaps/js-api-loader";

// Map rendering for the final schedule. Straight polylines between
// stops by design — no Directions/Routes geometry in this step.

export interface MapStop {
  name: string;
  lat: number;
  lng: number;
  category: string;
  startTime: string | null;
  endTime: string | null;
  reason?: string;
  /** mode of the travel leg departing this stop (undefined on the last) */
  legModeToNext?: "transit" | "walk" | "unknown";
  /** live itinerary status — markers restyle when set */
  status?: "upcoming" | "active" | "completed" | "skipped";
}

type Libs = [google.maps.MapsLibrary, google.maps.MarkerLibrary];

// Load the Maps JS API once, lazily — first mount of this component is
// the first time the API is requested at all.
let libsPromise: Promise<Libs> | null = null;
function loadMapLibs(): Promise<Libs> {
  if (!libsPromise) {
    setOptions({
      // The ONE browser-side key, protected by referrer restriction.
      key: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "",
      v: "weekly",
    });
    libsPromise = Promise.all([
      importLibrary("maps"),
      importLibrary("marker"),
    ]);
  }
  return libsPromise;
}

const STROKE = "#3d8294";

export default function ItineraryMap({ stops }: { stops: MapStop[] }) {
  const divRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const overlaysRef = useRef<{
    markers: google.maps.marker.AdvancedMarkerElement[];
    lines: google.maps.Polyline[];
    info: google.maps.InfoWindow | null;
  }>({ markers: [], lines: [], info: null });

  useEffect(() => {
    if (stops.length === 0) return;
    let cancelled = false;

    (async () => {
      const [mapsLib, markerLib] = await loadMapLibs();
      if (cancelled || !divRef.current) return;
      const { Map, InfoWindow, Polyline } = mapsLib;
      const { AdvancedMarkerElement, PinElement } = markerLib;

      if (!mapRef.current) {
        mapRef.current = new Map(divRef.current, {
          center: { lat: stops[0].lat, lng: stops[0].lng },
          zoom: 15,
          // AdvancedMarkerElement requires SOME mapId; DEMO_MAP_ID is
          // Google's sanctioned zero-config value — default styling,
          // no cloud styling setup.
          mapId: "DEMO_MAP_ID",
        });
      }
      const map = mapRef.current;

      // clear overlays from a previous run
      overlaysRef.current.markers.forEach((m) => (m.map = null));
      overlaysRef.current.lines.forEach((l) => l.setMap(null));
      overlaysRef.current.info?.close();
      const info = new InfoWindow();
      overlaysRef.current = { markers: [], lines: [], info };

      const fmt = (iso: string | null) =>
        iso
          ? new Date(iso).toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit",
            })
          : "?";

      // numbered markers in stop order, restyled by itinerary status
      stops.forEach((s, i) => {
        const style =
          s.status === "active"
            ? { background: "#e8873d", borderColor: "#fff", scale: 1.3, opacity: "1" }
            : s.status === "completed"
            ? { background: "#b9c6cb", borderColor: "#9aa7ac", scale: 0.9, opacity: "0.55" }
            : { background: STROKE, borderColor: "#2a5f70", scale: 1, opacity: "1" };
        const pin = new PinElement({
          glyph: String(i + 1),
          glyphColor: "#fff",
          background: style.background,
          borderColor: style.borderColor,
          scale: style.scale,
        });
        pin.element.style.opacity = style.opacity;
        const marker = new AdvancedMarkerElement({
          map,
          position: { lat: s.lat, lng: s.lng },
          content: pin.element,
          title: s.name,
          zIndex: s.status === "active" ? 10 : 1,
        });
        marker.addListener("click", () => {
          info.setContent(
            `<div style="font-family:sans-serif;font-size:13px;max-width:220px">` +
              `<strong>${s.name}</strong><br/>` +
              `be here ${fmt(s.startTime)} – ${fmt(s.endTime)}` +
              (s.reason ? `<br/><em>${s.reason}</em>` : "") +
              `</div>`
          );
          info.open({ map, anchor: marker });
        });
        overlaysRef.current.markers.push(marker);
      });

      // straight legs: solid = walk, dashed = transit
      for (let i = 0; i < stops.length - 1; i++) {
        const path = [
          { lat: stops[i].lat, lng: stops[i].lng },
          { lat: stops[i + 1].lat, lng: stops[i + 1].lng },
        ];
        const mode = stops[i].legModeToNext ?? "unknown";
        const line =
          mode === "transit"
            ? new Polyline({
                map,
                path,
                strokeOpacity: 0,
                icons: [
                  {
                    icon: {
                      path: "M 0,-1 0,1",
                      strokeOpacity: 1,
                      strokeColor: STROKE,
                      strokeWeight: 3,
                      scale: 3,
                    },
                    offset: "0",
                    repeat: "16px",
                  },
                ],
              })
            : new Polyline({
                map,
                path,
                strokeColor: STROKE,
                strokeOpacity: 0.9,
                strokeWeight: 3,
              });
        overlaysRef.current.lines.push(line);
      }

      if (stops.length === 1) {
        map.setCenter({ lat: stops[0].lat, lng: stops[0].lng });
        map.setZoom(15);
      } else {
        const bounds = new google.maps.LatLngBounds();
        stops.forEach((s) => bounds.extend({ lat: s.lat, lng: s.lng }));
        map.fitBounds(bounds, 60);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [stops]);

  if (stops.length === 0) return null;
  return (
    <div
      ref={divRef}
      style={{ height: 400, marginTop: 10, borderRadius: 10, overflow: "hidden" }}
    />
  );
}
