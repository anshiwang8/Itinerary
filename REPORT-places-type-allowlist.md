# Report: the Places `includedType` allowlist

Branch `places-type-allowlist`, 2026-09-25. Built, tested offline, **not verified
against the live Places API** (this session may not spend money). Every defaulted
judgment call is flagged below so it can be changed; none is irreversible, and a
category with no confident mapping falls back to today's unrestricted search.

## What this closes

`searchQuery` is spliced into a Places Text Search. The category-shape guard
(2026-09-14) stops a bare abstract word ("further"). It cannot stop a well-formed
category that text-matches a *business name*: "gallery" surfacing "The Gallery
Consulting Group", or the neighbourhood landmark "The Distillery District"
appearing as a dinner restaurant (seen in a live persona run, 2026-09-10 02:13,
first stop, 3:44 AM). The fix is a category to `includedType` mapping sent with
`strictTypeFiltering: true`, so a non-venue business cannot be returned for a
properly-typed category.

## What was built

- `app/api/places/search/typeFilters.ts` (new, pure): `typeFilterFor(category)`
  returns `{ includedType, strict }` or `undefined` (no restriction).
  Precedence is preserved from before: green space (`park`), then casino, then the
  new strict kinds.
- `searchPlaces.ts`: the request body gains `strictTypeFiltering: true` only for
  the new strict kinds. `park` and `casino` keep their exact non-strict body
  (pinned byte-for-byte by a test). The general union's members are typed by their
  own text, so only its `bar` query is typed. The request-scoped dedupe key now
  includes strictness, so the cost boundary is unchanged (a named `bar` and the
  union's `bar` are still one call; tested).
- **A rejected type degrades instead of deleting the category.** A 400 on a
  *typed* request (a type that was renamed or never existed) is retried once
  untyped and logged as `[places-type-rejected]`. Only a 400 on a typed request:
  a 5xx, 429, timeout, or a 400 on an untyped request is not retried (tested).
  Cost: at most one extra call, only in that failure case.
- Tests: `typeFilters.test.ts` (new, 9 cases), `searchPlaces.test.ts` 25 to 30.
  Every guard was mutation-checked (deliberately broken, watched fail, restored).
  The mocked e2e suite is unaffected by construction: mock mode replaces
  `searchPools` wholesale at the route.

## Audit: where categories come from, and what each became

| Source | Examples | Result |
|---|---|---|
| Planner `searchQuery` (free vocabulary; told to emit "a concrete, searchable PLACE KIND") | "italian restaurant", "restaurant in the Distillery District", "live music venue on Ossington", "ice skating rink", "record store" | Mapped when the whole phrase is one confident kind; else unrestricted. Real queries carry a locative tail ("... in the Distillery District", "... on Ossington", seen live), so the tail is stripped before matching. |
| `GENERAL_QUERIES` union ("things to do", "bar", "live music", "late night food", "entertainment") | | Only `bar` is a confident kind, so only it is typed. The rest are the *answer* to "no kind stated" and stay open. |
| Activity preference phrases (`plannerPreferences.ts`) | art gallery, park, board game cafe, climbing gym, live music venue | `art gallery` becomes `art_gallery`; `park` is already `park` (non-strict); `board game cafe`, `climbing gym`, `live music venue` are deliberately unmapped (below). |
| Cuisine preference phrases | "japanese restaurant", "vegetarian restaurant" | `restaurant`. |
| Swap and recovery free text | "board games", "coffee instead", "something else" | Same function: mapped if confident, else open. |
| Duration table's categories (`durations.ts`) | coffee shop, restaurant, bar, dessert, museum, park, movie | Cross-checked; `dessert` is deliberately unmapped. |

## The mapping (all STRICT unless noted; every type is a classic Table A name)

| Category phrase (whole phrase, closed modifiers) | Type |
|---|---|
| `... restaurant(s)` (any cuisine), `dinner` | `restaurant` |
| `bar`, cocktail / wine / sports / dive / rooftop / beer bar, cocktail or wine lounge, speakeasy | `bar` |
| `pub`, irish pub, gastropub | `pub` |
| night club, nightclub, dance club | `night_club` |
| cafe, coffee shop, coffee house | `cafe` |
| bakery | `bakery` |
| ice cream, gelato | `ice_cream_shop` |
| `... museum` | `museum` |
| gallery, art gallery | `art_gallery` |
| movie theater/theatre, cinema, movie | `movie_theater` |
| bowling, bowling alley | `bowling_alley` |
| zoo, aquarium | `zoo`, `aquarium` |
| tourist attraction(s), attraction(s) | `tourist_attraction` |
| shopping mall, mall | `shopping_mall` |
| book store / bookshop | `book_store` |
| spa, day spa | `spa` |
| park-like (existing, NON-strict) | `park` |
| casino (existing, NON-strict) | `casino` |

Type names were checked against Google's published Table A (fetched 2026-09-25)
and a snapshot of the relevant sections is embedded in `typeFilters.test.ts`, so a
mistyped name fails a unit test rather than failing quietly in production.

## The design rule, and why it is this conservative

**A type filter deletes; it does not error.** `strictTypeFiltering` silently
removes every place lacking the type, so a wrong or too-narrow mapping is
invisible: the pool just comes back small and the user meets an empty category.
That is the `max_price` lesson from the OpenRouter work, applied to Places. Three
consequences shaped the table:

1. Whole-phrase, anchored matches with a small closed modifier set. Anything else
   is unrestricted. A missing entry costs a possible lookalike; a wrong one costs
   real venues. Explicit guards keep `sushi bar`, `salad bar`, `oyster bar`,
   `snack bar`, `juice bar` (restaurants and shops) out of the bar type, and
   `food gallery` (a food court) out of the gallery type.
2. Multi-kind phrases are never typed ("dinner and drinks", "bar/restaurant",
   "restaurant with a patio", "place for dinner").
3. The **generic classic** type is used in preference to a narrower newer one
   (`bar` not `cocktail_bar`, `cafe` not `coffee_shop`, `restaurant` not
   `italian_restaurant`), because Google keeps the general type on the specific
   places. That choice is what makes the table safe under either reading of the
   one thing Google's docs leave open (below).

## FLAGGED: the judgment calls, with the default chosen

The task asked to flag boundary cases rather than block on them. Each default is
"no restriction" unless stated.

| Category | Default | Why | If you disagree |
|---|---|---|---|
| **spa** | **mapped to `spa`** | A "spa" text search matches hotels and salons; `spa` is a classic type. Hotel spas typed only `hotel` would drop. | Remove the `spas?` rule. |
| **shopping** | unmapped | A mall? boutiques? a market? One type cannot answer it. `shopping mall` and `book store` are mapped separately. | Map to `shopping_mall` if you mean malls. |
| **arcade** | unmapped | Arcade bars are typed `bar`/`amusement_center`; `video_arcade` would miss them. No single type; a broader net is not expressible with one `includedType`. | Map to `amusement_center` if you accept losing arcade bars. |
| **live music / live music venue** | unmapped | Dedicated venues *and* bars and clubs host it; `live_music_venue` would drop the bars. Also the `music` survey option's phrase. | Map to `live_music_venue` for strictness at the cost of bars. |
| **climbing gym** | unmapped | `gym` vs `sports_activity_location` vs `sports_club` is unclear for climbing gyms. | Needs a live look at what climbing gyms are tagged. |
| **board game cafe** | unmapped | A cafe by name, not reliably typed one (`cat_cafe`, `internet_cafe` exist). | Map to `cafe` if you accept the risk. |
| **dessert / brunch / breakfast / lunch / coffee** | unmapped | Each is served by several types (shop, bakery, restaurant, cafe) and none is reliable alone. | Per category. |
| **escape room** | unmapped | No Table A type exists. | n/a |
| **brewery, karaoke, comedy club** | unmapped | Newer types with thinner coverage; brewpubs and karaoke bars are often tagged bar/pub only. | Live-check coverage first. |
| **amusement park / theme park** | (existing quirk) | Reaches the *existing* park rule first because of the word "park", so it is biased to `park`. Pre-existing, out of scope, noted. | Separate fix. |
| **park and casino strictness** | stay NON-strict | Live-verified as biases; making them strict is a separate, owner-visible change. | Set `strict: true` in `typeFilterFor`. |
| **`restaurant` for cuisine-specific queries** | generic `restaurant` | "italian restaurant" to `restaurant`, not `italian_restaurant`: recall-safe under either matching reading. The text query still says "italian", so ranking still favours it. | Use the specific type if live shows the generic one loses nothing and you want precision. |

## LIVE-PROBE checklist for the owner (unprovable offline)

These need real Places calls, which this session must not make. None should be
merged blind.

1. **Type strings are accepted.** Run one typed search per mapped type. The unit
   test guards spelling against Table A and `searchText` degrades a 400, but only a
   live call proves Google accepts each with `strictTypeFiltering`.
2. **Recall of the generic types.** Google's Text Search docs do not say whether
   `includedType` matches a place's *primary* type or *any* of its `types`. The
   table is built to be safe under either reading, but the number that matters is
   worth one look: "italian restaurant" with `restaurant` strict should return
   Italian restaurants (not only places whose primary type is plain `restaurant`).
   If it does not, switch cuisine-specific queries to their specific type or drop
   strict for `restaurant`.
3. **The decoys are really gone.** With a real key, "gallery" and "restaurant"
   near the Distillery District should no longer return "The Gallery Consulting
   Group" or "The Distillery District" itself. The unit test proves the request
   and, under Google's *documented* semantics, the outcome; it cannot prove
   Google's actual behaviour.
4. **No pool starved.** Plan a few ordinary evenings and watch for a category
   coming back empty or thin that used to have results (that is the failure mode
   of any type filter). Look at `[places-type-rejected]` in the logs too.
5. **Cost.** Calls per plan are unchanged except the rare 400-retry; worth a glance
   at one billing line.

## Not done, on purpose

- No code-side type guard on the response (`places.types` in the field mask).
  It would verify the filter deterministically, but the field mask has a policy
  ("every requested field has a code-side consumer") and it is a second mechanism;
  worth considering if the live probe shows Google's strict matching is weaker than
  documented.
- No change to the two existing filters, the planner prompt, or the category-shape
  guard (which stays necessary: an unmapped kind is still an open search).
