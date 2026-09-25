// typeFilterFor unit tests: the category -> Places type table is a FILTER THAT
// DELETES, so what it must NOT map matters as much as what it maps.
// Run with: npx tsx app/api/places/search/typeFilters.test.ts
import assert from "node:assert";
import { STRICT_TYPES_USED, typeFilterFor, UNMAPPED_ON_PURPOSE } from "./typeFilters";

// The types this module may emit, checked against Google's published Table A
// (https://developers.google.com/maps/documentation/places/web-service/place-types,
// fetched 2026-09-25; only the sections our types live in are copied). A typo
// here does not fail loudly in production: Google answers 400, searchText
// degrades to an untyped retry, and the filter silently stops doing its job.
// So a wrong name has to fail HERE.
const TABLE_A_SNAPSHOT = new Set(
  `art_gallery art_museum art_studio auditorium castle cultural_landmark fountain
  historical_place history_museum monument museum performing_arts_theater sculpture
  adventure_sports_center amphitheatre amusement_center amusement_park aquarium banquet_hall
  barbecue_area botanical_garden bowling_alley casino childrens_camp city_park comedy_club
  community_center concert_hall convention_center cultural_center cycling_park dance_hall dog_park
  event_venue ferris_wheel garden go_karting_venue hiking_area historical_landmark
  indoor_playground internet_cafe karaoke live_music_venue marina miniature_golf_course
  movie_rental movie_theater national_park night_club observation_deck off_roading_area
  opera_house paintball_center park philharmonic_hall picnic_ground planetarium plaza
  roller_coaster skateboard_park state_park tourist_attraction video_arcade vineyard
  visitor_center water_park wedding_venue wildlife_park wildlife_refuge zoo
  acai_shop bagel_shop bakery bar bar_and_grill beer_garden bistro brewery brewpub cafe cafeteria
  cake_shop candy_store cat_cafe chocolate_factory chocolate_shop cocktail_bar coffee_roastery
  coffee_shop coffee_stand confectionery deli dessert_restaurant dessert_shop diner dog_cafe
  donut_shop food_court gastropub hookah_bar ice_cream_shop irish_pub juice_shop lounge_bar
  meal_delivery meal_takeaway pastry_shop pub restaurant salad_shop sandwich_shop snack_bar
  sports_bar tea_house wine_bar winery
  massage massage_spa sauna spa wellness_center yoga_studio
  book_store department_store farmers_market flea_market gift_shop market shopping_mall store
  thrift_store`
    .split(/\s+/)
    .filter(Boolean)
);

const MAPPED: Array<[string, string]> = [
  // restaurants: any cuisine in front keeps the GENERIC type
  ["restaurant", "restaurant"],
  ["restaurants", "restaurant"],
  ["a restaurant", "restaurant"],
  ["italian restaurant", "restaurant"],
  ["japanese restaurant", "restaurant"],
  ["vegetarian restaurant", "restaurant"],
  ["late night restaurant", "restaurant"],
  // real searchQueries carry their neighbourhood (both seen live in persona runs)
  ["restaurant in the Distillery District", "restaurant"],
  ["restaurant in Distillery District Toronto", "restaurant"],
  ["dinner", "restaurant"],
  ["dinner spot", "restaurant"],
  // bars collapse to the one classic type
  ["bar", "bar"],
  ["bars", "bar"],
  ["cocktail bar", "bar"],
  ["wine bar", "bar"],
  ["sports bar", "bar"],
  ["dive bar", "bar"],
  ["rooftop bar", "bar"],
  ["bar on Ossington", "bar"],
  ["cocktail lounge", "bar"],
  ["speakeasy", "bar"],
  ["pub", "pub"],
  ["irish pub", "pub"],
  ["gastropub", "pub"],
  ["night club", "night_club"],
  ["nightclub", "night_club"],
  ["night-club", "night_club"],
  ["dance club", "night_club"],
  // cafes
  ["cafe", "cafe"],
  ["café", "cafe"],
  ["coffee shop", "cafe"],
  ["coffee house", "cafe"],
  ["quiet cafe", "cafe"],
  ["bakery", "bakery"],
  ["bakeries", "bakery"],
  ["ice cream", "ice_cream_shop"],
  ["ice cream shop", "ice_cream_shop"],
  ["gelato", "ice_cream_shop"],
  // culture
  ["museum", "museum"],
  ["art museum", "museum"],
  ["science museum", "museum"],
  ["art gallery", "art_gallery"],
  ["gallery", "art_gallery"],
  ["galleries", "art_gallery"],
  ["contemporary art gallery", "art_gallery"],
  // entertainment
  ["movie theater", "movie_theater"],
  ["movie theatre", "movie_theater"],
  ["cinema", "movie_theater"],
  ["movie", "movie_theater"],
  ["bowling", "bowling_alley"],
  ["bowling alley", "bowling_alley"],
  ["zoo", "zoo"],
  ["aquarium", "aquarium"],
  ["tourist attraction", "tourist_attraction"],
  ["tourist attractions", "tourist_attraction"],
  // shopping and wellness
  ["shopping mall", "shopping_mall"],
  ["mall", "shopping_mall"],
  ["book store", "book_store"],
  ["bookstore", "book_store"],
  ["used bookstore", "book_store"],
  ["spa", "spa"],
  ["day spa", "spa"],
];

// Phrases that LOOK like a mapped kind and must fall back to no restriction.
// Each one is a real way the table could go wrong: a restaurant filed under a
// bar, a food court under a gallery, two kinds forced into one type.
const MUST_STAY_UNRESTRICTED = [
  // a bar by name, a restaurant or shop in fact
  "sushi bar",
  "salad bar",
  "oyster bar",
  "snack bar",
  "juice bar",
  "coffee bar",
  "tapas bar",
  "ramen bar",
  // more than one kind, or a kind plus a qualifier
  "dinner and drinks",
  "bar and grill",
  "bar/restaurant",
  "bar, restaurant",
  "restaurant with a patio",
  "place for dinner",
  "cafe then museum",
  "restaurant or bar",
  // gallery is a closed modifier set: a food gallery is a food court
  "food gallery",
  "shopping gallery",
  // a cafe by name, not reliably typed one
  "board game cafe",
  "cat cafe",
  "boardwalk cafe",
  // abstract or empty: the category-shape guard's territory, never a type
  "",
  "   ",
  "further",
  "activity",
  "place",
  "spot",
  "something",
];

const cases: Array<[string, () => void]> = [
  [
    "every mapped category resolves to its classic type, STRICT",
    () => {
      for (const [category, type] of MAPPED) {
        const filter = typeFilterFor(category);
        assert.ok(filter, `"${category}" should be mapped`);
        assert.strictEqual(filter!.includedType, type, `"${category}"`);
        assert.strictEqual(filter!.strict, true, `"${category}" must be strict`);
      }
    },
  ],
  [
    "the two existing filters keep their exact NON-strict request shape",
    () => {
      // live-verified as biases; making them strict is a separate decision
      for (const category of ["park", "park walk", "garden", "quiet trail", "bench", "green space"]) {
        assert.deepStrictEqual(typeFilterFor(category), { includedType: "park", strict: false }, category);
      }
      for (const category of ["casino", "casinos", "casino night"]) {
        assert.deepStrictEqual(typeFilterFor(category), { includedType: "casino", strict: false }, category);
      }
    },
  ],
  [
    "existing precedence is preserved: green space wins over a kind that merely mentions a park",
    () => {
      // pre-existing behaviour, pinned so this change cannot alter it silently
      assert.deepStrictEqual(typeFilterFor("cafe in the park"), { includedType: "park", strict: false });
      assert.deepStrictEqual(typeFilterFor("restaurant near the park"), { includedType: "park", strict: false });
      // and a casino is still not a nightclub
      assert.notStrictEqual(typeFilterFor("nightclub")?.includedType, "casino");
    },
  ],
  [
    "phrases that look mappable but are not confident stay UNRESTRICTED",
    () => {
      for (const category of MUST_STAY_UNRESTRICTED) {
        assert.strictEqual(typeFilterFor(category), undefined, `"${category}" must not be typed`);
      }
    },
  ],
  [
    "every boundary category is deliberately unmapped and no NEW strict filter appears for it",
    () => {
      assert.ok(UNMAPPED_ON_PURPOSE.length >= 20, "the list is the audit trail: do not shrink it silently");
      for (const category of UNMAPPED_ON_PURPOSE) {
        const filter = typeFilterFor(category);
        assert.strictEqual(filter, undefined, `"${category}" is a documented judgment call, not a guess`);
      }
      // the four the task named as the honest ambiguities
      for (const category of ["spa", "shopping", "arcade"]) {
        // spa IS mapped (flagged default); shopping and arcade are not
        if (category === "spa") assert.strictEqual(typeFilterFor(category)?.includedType, "spa");
        else assert.strictEqual(typeFilterFor(category), undefined, category);
      }
    },
  ],
  [
    "the general union: only its bar query is a confident kind",
    () => {
      // "things to do" is the ANSWER to "no kind stated", so it must not be typed
      for (const q of ["things to do", "live music", "late night food", "entertainment"]) {
        assert.strictEqual(typeFilterFor(q), undefined, q);
      }
      assert.deepStrictEqual(typeFilterFor("bar"), { includedType: "bar", strict: true });
    },
  ],
  [
    "every type the strict rules can emit is in Google's published Table A",
    () => {
      assert.ok(STRICT_TYPES_USED.length >= 15);
      for (const type of STRICT_TYPES_USED) {
        assert.ok(TABLE_A_SNAPSHOT.has(type), `"${type}" is not a Places Table A type (Google would answer 400)`);
      }
      // and every mapped sample resolves to a type from that same set
      for (const [, type] of MAPPED) assert.ok(TABLE_A_SNAPSHOT.has(type), type);
      // the two non-strict filters use valid names too
      assert.ok(TABLE_A_SNAPSHOT.has("park") && TABLE_A_SNAPSHOT.has("casino"));
    },
  ],
  [
    "hostile and degenerate input never throws and never hangs",
    () => {
      for (const junk of [
        undefined as unknown as string,
        null as unknown as string,
        "((((((",
        "[a-z]+.*$",
        "\u0000\u0007\u001b",
        "restaurant".repeat(200),
        "a ".repeat(3000),
      ]) {
        const started = Date.now();
        assert.doesNotThrow(() => typeFilterFor(junk));
        assert.ok(Date.now() - started < 500, "a category must never cost real time");
      }
      // long but well-formed still maps, without pathological backtracking
      assert.strictEqual(typeFilterFor(`${"tasty ".repeat(40)}restaurant`)?.includedType, "restaurant");
    },
  ],
  [
    "the marketing-consultancy shape: a bare 'gallery' is now art_gallery, never free text",
    () => {
      // the planner.ts comment's own example ("The Gallery Consulting Group")
      assert.deepStrictEqual(typeFilterFor("gallery"), { includedType: "art_gallery", strict: true });
      // and 'further' (the live Further Capital Partners collision) stays the
      // shape guard's job: it is never typed
      assert.strictEqual(typeFilterFor("further"), undefined);
    },
  ],
];

let failed = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err instanceof Error ? err.message : err}`);
  }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
if (failed > 0) process.exit(1);
