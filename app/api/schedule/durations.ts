// Stop-duration lookup (step 6a). Pure code — no LLM, no Routes API.
// Tune the table freely; resolver maps parse's free-vocab categories
// onto table keys.

import { isParkLike } from "../../lib/categoryTraits";

export interface StopDuration {
  baseMinutes: number;
  bufferMinutes: number;
}

export const DURATION_TABLE = {
  "coffee shop": { baseMinutes: 50, bufferMinutes: 10 },
  restaurant: { baseMinutes: 90, bufferMinutes: 15 },
  bar: { baseMinutes: 60, bufferMinutes: 10 },
  dessert: { baseMinutes: 30, bufferMinutes: 10 },
  museum: { baseMinutes: 105, bufferMinutes: 15 },
  park: { baseMinutes: 40, bufferMinutes: 5 },
  // TODO: placeholder — a real movie runtime needs external data
  // (showtimes/runtime API); 120+30 approximates feature + trailers.
  movie: { baseMinutes: 120, bufferMinutes: 30 },
  default: { baseMinutes: 60, bufferMinutes: 10 },
} as const satisfies Record<string, StopDuration>;

export type DurationKey = keyof typeof DURATION_TABLE;

// Keyword → table-key rules, checked in order. Narrow categories come
// before broad ones (dessert/bakery must win over generic food words;
// restaurant is last because its cuisine list is the broadest net).
const RESOLVER_RULES: Array<[DurationKey, RegExp]> = [
  ["coffee shop", /coffee|caf[eé]|espresso|matcha|tea\s*(house|room|shop)/i],
  ["dessert", /dessert|ice\s*cream|gelato|bakery|pastr|cake|donut|doughnut|sweet|creamery|patisserie/i],
  ["movie", /movie|cinema|film/i],
  ["museum", /museum|galler|exhibit/i],
  ["bar", /\bbar\b|\bbars\b|cocktail|pub|brewery|wine|drink|lounge|club|speakeasy/i],
  [
    "restaurant",
    /restaurant|dinner|dining|lunch|brunch|breakfast|food|eat|ramen|sushi|pizza|taco|burger|bbq|barbecue|noodle|pho|curry|pasta|steak|dumpling|shawarma|bistro|diner|izakaya|grill|kitchen|eatery/i,
  ],
];

/** Map a free-vocab category ("ramen", "fine dining") to a table key. */
export function resolveCategory(raw: string): DurationKey {
  const s = (raw ?? "").trim();
  if (!s) return "default";
  // green space comes from the shared traits table (§5.3) so "bench" and
  // "green space" get the park duration too, and a "boardwalk cafe" —
  // which the old substring rule called a park — stays a cafe. Checked
  // in the same position the local park rule occupied.
  for (const [key, pattern] of RESOLVER_RULES) {
    if (key === "museum" && isParkLike(s)) return "park";
    if (pattern.test(s)) return key;
  }
  if (isParkLike(s)) return "park";
  return "default";
}

/** Duration for a raw category, resolver included. */
export function getDuration(rawCategory: string): StopDuration {
  return DURATION_TABLE[resolveCategory(rawCategory)];
}
