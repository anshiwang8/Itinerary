// Home origin — outings start from the user's starting address (geocoded
// per plan, stored as itinerary.home). Home is a starting WAYPOINT, not a
// stop: no duration, no venue card, excluded from stop count / statuses /
// completion. Home only shapes leg 0 (home → first stop).
import { LatLng, TravelLeg } from "./travel";

/** A per-itinerary origin point (geocoded starting address or city centre). */
export interface HomePoint {
  label: string;
  location: LatLng;
}

// The DEFAULT origin — used only when an itinerary carries no per-request
// `home` (pre-multi-city itineraries, tests): the original prototype
// anchor, UofT Chestnut Residence.
export const HOME: HomePoint = {
  label: "Home · Chestnut Residence",
  location: { latitude: 43.6547, longitude: -79.3862 },
};

/** Sentinel fromIndex for the home leg — its origin is home, not a timed stop. */
export const HOME_LEG_INDEX = -1;

/**
 * Split the legs returned by getTravelLegs([HOME.location, ...venues])
 * into the home leg (fromIndex → HOME_LEG_INDEX sentinel) and the
 * inter-stop legs re-indexed back to 0-based timed pairs — the indexing
 * buildSchedule and the reroute engine already expect. Pure.
 */
export function splitHomeLeg(legs: TravelLeg[]): {
  homeLeg: TravelLeg | null;
  interLegs: TravelLeg[];
} {
  if (legs.length === 0) return { homeLeg: null, interLegs: [] };
  const [first, ...rest] = legs;
  return {
    homeLeg: { ...first, fromIndex: HOME_LEG_INDEX },
    interLegs: rest.map((l) => ({ ...l, fromIndex: l.fromIndex - 1 })),
  };
}
