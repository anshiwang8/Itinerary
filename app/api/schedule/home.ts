// Home origin — outings start from the user's home, hardcoded to UofT
// Chestnut Residence (89 Chestnut St, Toronto) for the prototype.
// Home is a starting WAYPOINT, not a stop: no duration, no venue card,
// excluded from stop count / statuses / completion. Venue search stays
// anchored on Ossington — home only shapes leg 0 (home → first stop).
import { LatLng, TravelLeg } from "./travel";

export const HOME: { label: string; location: LatLng } = {
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
