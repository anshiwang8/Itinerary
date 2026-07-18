// The ONE fallback used when a stored itinerary carries no `parsed` — the
// pre-multi-city plans, and any writer of POST /api/itinerary that omits
// the optional field. Both engines (swap, reroute) need it; it used to be
// copy-pasted verbatim into each, hardcoding `location: "Ossington"` with
// no city, so a fallback re-search for a VANCOUVER plan went looking in
// Toronto's west end (code-audit 2026-07-18 §3.1 / §5.1).
import { ParsedPrompt } from "../places/search/filter";
import { DEFAULT_ZONE } from "../../lib/zoneTime";
import type { Itinerary } from "./store";

/** The refusal shown when a re-search can't know where to look. */
export const UNKNOWN_LOCATION_MESSAGE =
  "This plan is missing the details I'd need to search again — try planning it fresh.";

/**
 * A minimal ParsedPrompt for an itinerary that has none, or null when we
 * genuinely can't tell where to search.
 *
 * It invents NO neighbourhood: `location: ""` searches the city broadly
 * rather than pretending the plan was in Ossington. The CITY is the part
 * we can't fake — `buildQuery` falls back to Toronto when `city` is
 * absent, which is correct only for plans that really are Toronto. A plan
 * whose resolved zone is anything else is knowably NOT Toronto, and there
 * is no city string to recover, so this returns null and the caller
 * refuses honestly instead of searching the wrong city.
 */
export function fallbackParsedFor(itinerary: Itinerary): ParsedPrompt | null {
  const zone = itinerary.timeZone ?? DEFAULT_ZONE;
  if (zone !== DEFAULT_ZONE) return null;
  return {
    time_window: "unspecified",
    stop_count: null,
    aesthetic: "unspecified",
    category_signals: [],
    group_context: "unspecified",
    budget: null,
    constraints: [],
    location: "",
  };
}
