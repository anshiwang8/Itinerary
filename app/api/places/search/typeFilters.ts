// Category -> Google Places `includedType` (+ strictTypeFiltering). Pure.
//
// WHY THIS EXISTS. `searchQuery` is spliced verbatim into a Places Text Search,
// and free-text relevance alone happily matches a BUSINESS NAME: "gallery" found
// "The Gallery Consulting Group", "further" found a marketing consultancy, and a
// live plan offered the neighbourhood landmark "The Distillery District" as a
// dinner restaurant. The category-shape guard (planner.ts) stops a bare abstract
// word; this closes the deeper gap, a well-formed, legitimate category that
// coincidentally text-matches a non-venue.
//
// THE RULE THIS FILE IS BUILT AROUND: A TYPE FILTER DELETES, IT DOES NOT ERROR.
// `strictTypeFiltering: true` silently removes every place that lacks the type,
// so a wrong or too-narrow mapping is invisible: the pool just comes back small,
// and the user meets it as an empty category. That is the `max_price` lesson
// (CLAUDE.md, OpenRouter section) applied to Places. So:
//   - a category is mapped ONLY when its whole phrase is one unambiguous kind
//     (an anchored head noun, optionally with a small closed set of soft
//     adjectives); anything else falls back to NO restriction, which is exactly
//     today's behaviour. A missing entry costs a possible lookalike; a wrong
//     entry costs real venues.
//   - the GENERIC classic type is preferred over a narrower, newer one
//     (`bar`, not `cocktail_bar`; `cafe`, not `coffee_shop`; `restaurant`, not
//     `italian_restaurant`): Google keeps the general type on the specific
//     places, so the general type is the one that cannot cost recall.
//   - the boundary cases people argue about are listed in UNMAPPED_ON_PURPOSE
//     and pinned by a test, so nobody "helpfully" adds a guess.
//
// EXISTING FILTERS ARE UNTOUCHED. `park` and `casino` were live-verified as
// non-strict biases and keep their exact request shape (no strictTypeFiltering).
// Making them strict is a separate, owner-visible change.
//
// LIVE-PROBE ITEMS (unprovable offline, see REPORT-places-type-allowlist.md):
//   1. every type string here is accepted by Google (a test checks each against
//      a snapshot of Table A, and searchText degrades a 400 to an untyped retry);
//   2. Google's Text Search docs do not say whether `includedType` matches a
//      place's PRIMARY type or ANY of its `types`; the generic-type choice above
//      is what makes the table safe under either reading, but the recall of e.g.
//      "italian restaurant" -> `restaurant` should be eyeballed once live.

import { isParkLike } from "../../../lib/categoryTraits";

export interface TypeFilter {
  /** a Places Table A type */
  includedType: string;
  /** send `strictTypeFiltering: true`. false = the type only BIASES ranking. */
  strict: boolean;
}

/** Soft adjectives a planner or a user puts in front of a kind without
 *  changing what kind it is. Deliberately closed: an unlisted modifier means
 *  the phrase is not a confident match, and we fall back to no restriction. */
const SOFT =
  "good|nice|great|best|local|nearby|neighbou?rhood|cozy|cosy|quiet|casual|lively|fancy|classy|upscale|trendy|romantic|cheap|popular|small|independent|hidden gem|late night";

/** `(?:(?:a|b)\s+)*` */
const mods = (words: string) => `(?:(?:${words})\\s+)*`;

interface KindRule {
  /** matched against the NORMALIZED, location-stripped phrase */
  pattern: RegExp;
  type: string;
}

// Ordered; first match wins. Every pattern is anchored at both ends: the WHOLE
// phrase must be the kind. Types are all classic Table A names.
const KIND_RULES: KindRule[] = [
  // A restaurant is a restaurant whatever the cuisine in front of it. The
  // GENERIC type is what keeps "ramen restaurant" and "vegan restaurant" whole.
  { pattern: /^(?:[a-z0-9 ]+ )?restaurants?$/, type: "restaurant" },
  { pattern: /^dinner(?: spots?| places?)?$/, type: "restaurant" },

  // The bar family collapses to the one classic type every bar carries. The
  // closed modifier set is what keeps "sushi bar", "salad bar", "oyster bar",
  // "snack bar" and "juice bar" (all restaurants or shops) out of it.
  {
    pattern: new RegExp(
      `^${mods(`${SOFT}|dive|rooftop|roof top|patio|beer|craft beer|cocktail|wine|sports|hotel|piano|jazz|whiskey|whisky`)}bars?$`
    ),
    type: "bar",
  },
  { pattern: /^(?:cocktail|wine) lounges?$/, type: "bar" },
  { pattern: /^speakeasys?$/, type: "bar" },
  {
    pattern: new RegExp(
      `^${mods(`${SOFT}|irish|british|english|scottish|craft|gastro|traditional|dive`)}(?:pubs?|gastropubs?)$`
    ),
    type: "pub",
  },
  {
    pattern: new RegExp(
      `^${mods(`${SOFT}|dance|electronic|hip hop|edm`)}(?:night clubs?|nightclubs?|dance clubs?)$`
    ),
    type: "night_club",
  },

  // "cafe" and "coffee shop" both map to the classic `cafe`.
  {
    pattern: new RegExp(
      `^${mods(`${SOFT}|study|work|laptop friendly|specialty|third wave|brunch|patio`)}(?:cafes?|coffee shops?|coffee houses?|coffeehouses?)$`
    ),
    type: "cafe",
  },
  {
    pattern: new RegExp(`^${mods(`${SOFT}|french|artisan`)}(?:bakery|bakeries)$`),
    type: "bakery",
  },
  {
    pattern: new RegExp(
      `^${mods(`${SOFT}|artisan|homemade`)}(?:ice cream(?: shops?| parlou?rs?| stores?)?|gelato(?: shops?)?|gelaterias?)$`
    ),
    type: "ice_cream_shop",
  },

  // Culture. `museum` takes any modifier (a wax museum is still a museum);
  // `gallery` takes a closed set, because a "food gallery" is a food court.
  { pattern: /^(?:[a-z0-9 ]+ )?museums?$/, type: "museum" },
  {
    pattern: new RegExp(
      `^${mods(`${SOFT}|art|photo|photography|contemporary|modern|indie`)}galler(?:y|ies)$`
    ),
    type: "art_gallery",
  },

  // Entertainment.
  {
    pattern: new RegExp(
      `^${mods(`${SOFT}|indie|repertory|imax`)}(?:movie theat(?:er|re)s?|cinemas?|movie houses?)$`
    ),
    type: "movie_theater",
  },
  { pattern: /^(?:movies?|cinemas?)$/, type: "movie_theater" },
  {
    pattern: new RegExp(
      `^${mods(SOFT)}bowling(?: alleys?| lanes?| centers?| centres?)?$`
    ),
    type: "bowling_alley",
  },
  { pattern: new RegExp(`^${mods(SOFT)}zoos?$`), type: "zoo" },
  { pattern: new RegExp(`^${mods(SOFT)}aquariums?$`), type: "aquarium" },
  {
    pattern: new RegExp(`^${mods(SOFT)}(?:tourist attractions?|attractions?)$`),
    type: "tourist_attraction",
  },

  // Shopping and wellness.
  {
    pattern: new RegExp(
      `^${mods(SOFT)}(?:shopping (?:malls?|centers?|centres?)|malls?)$`
    ),
    type: "shopping_mall",
  },
  {
    pattern: new RegExp(
      `^${mods(`${SOFT}|used|second hand|rare`)}book ?(?:stores?|shops?)$`
    ),
    type: "book_store",
  },
  { pattern: new RegExp(`^${mods(`${SOFT}|day|luxury|thermal|nordic`)}spas?$`), type: "spa" },
];

/** Every type the strict rules can emit, derived from the table itself so a
 *  test can check each against Google's published list without a second copy. */
export const STRICT_TYPES_USED: readonly string[] = [
  ...new Set(KIND_RULES.map((rule) => rule.type)),
];

/**
 * Categories that look mappable and are deliberately NOT, each because the
 * honest answer has more than one reasonable reading. Pinned by a test so a
 * future edit cannot quietly guess. A default is chosen for each (no
 * restriction), and the owner can change any of them; none of this is
 * irreversible.
 */
export const UNMAPPED_ON_PURPOSE: readonly string[] = [
  "live music", // dedicated venues AND bars/clubs; `live_music_venue` would drop the bars
  "live music venue", // same, and the preference phrase for the `music` survey option
  "music venue",
  "jazz club",
  "comedy club", // newer type, thinner coverage
  "karaoke",
  "brewery", // brewpubs are typed bar/pub, not brewery
  "arcade", // arcade bars are typed bar/amusement_center; no single type
  "escape room", // no Table A type exists
  "climbing gym", // gym vs sports_activity_location vs sports_club is unclear
  "gym",
  "board game cafe", // a cafe by name, but not reliably typed one
  "dessert", // shop, bakery, restaurant, cafe
  "brunch", // cafes and restaurants both, neither reliably
  "breakfast",
  "lunch",
  "coffee", // roasters, cafes, kiosks
  "shopping", // a mall? boutiques? a market?
  "market",
  "food",
  "things to do", // the general union: it is the ANSWER to "no kind stated"
  "entertainment",
  "late night food",
  "activity",
];

const CONJUNCTION = /(?:^|\s)(?:and|or|then|plus|with|for)(?:\s|$)/;
const PUNCTUATED_LIST = /[&/+,]/;
const LOCATIVE_TAIL =
  /\s(?:in|on|at|near|around|by|along|off|inside|within|close to|next to)\s.+$|\s(?:downtown|nearby)$/;

/**
 * Real searchQueries carry their neighbourhood ("restaurant in the Distillery
 * District", "live music venue on Ossington": both seen live), so the kind is
 * what is left after the locative tail is dropped.
 */
function normalize(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // cafe with an accent
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ") // night-club, children's
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:(?:a|an|the|some|any)\s+)+/, "")
    .replace(LOCATIVE_TAIL, "")
    .trim();
}

function strictKindFor(raw: string): string | undefined {
  // "dinner and drinks" or "bar/restaurant" is TWO kinds: no single type is right.
  if (PUNCTUATED_LIST.test(raw)) return undefined;
  const phrase = normalize(raw);
  if (phrase === "" || CONJUNCTION.test(phrase)) return undefined;
  return KIND_RULES.find((rule) => rule.pattern.test(phrase))?.type;
}

/**
 * The Places type filter for a category, or undefined for "no restriction"
 * (today's behaviour, and the answer whenever there is no confident match).
 *
 * Order matters and is preserved from before this table existed: green space,
 * then casino (both non-strict biases, request shape unchanged), then the
 * strict kinds.
 */
export function typeFilterFor(category: string): TypeFilter | undefined {
  const raw = category ?? "";
  if (isParkLike(raw)) return { includedType: "park", strict: false };
  if (/\bcasinos?\b/i.test(raw)) return { includedType: "casino", strict: false };
  const kind = strictKindFor(raw);
  return kind ? { includedType: kind, strict: true } : undefined;
}
