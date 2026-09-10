# Self-Contradicting Constraint Investigation

## Summary

**A constraint word the system has no way to verify was treated identically to
a constraint that was checked and genuinely failed.** `placeMeetsConstraint`
asked "does this place have evidence for this constraint?" Nothing ever asked
"is this constraint the KIND of thing evidence could ever exist for?" So
`indoor`, `waterfront`, `quiet`, `seats six`, `licensed` and the like produced
a hard `unmet_constraint` refusal that killed the WHOLE plan, with a
self-contradicting message ("a waterfront park that's really waterfront") and
NO recovery path (`isEmptyPoolPick` deliberately excludes an unmet constraint
from the recovery panel).

Confirmed live by the agent-persona-testing harness, present for roughly seven
weeks (since the constraint-evidence contract shipped). Reproduced by the
`indoor-only`, `vegan-dinner`, `birthday-six`, `bar-crawl-live-music` and
`waterfront-detour` personas in `testing/agent-personas/output/`.

## The bug mechanism (verified against current code)

1. `PLANNER_SYSTEM_PROMPT` (`app/api/parse/planner.ts`) instructs the model
   that `constraints` are "HARD requirements only" and gave `vegan` as its
   canonical dietary example — the one word the system was never able to
   verify.
2. The model puts an unverifiable word into `context.constraints`
   (`indoor`, `waterfront`, `licensed`, `seats six`). `planToParsed`
   projects it onto `parsed.constraints`.
3. `parsed.constraints` feeds TWO consumers with no split between them:
   - `buildQuery` (`app/api/places/search/searchPlaces.ts`) splices it into
     the Places text query — fine, Google just ranks by the word.
   - `selectVenues` (`app/api/select/selectVenues.ts`) treats it as a HARD
     pass/fail, proved only from `constraintEvidence` — six provider
     booleans. A word with no possible evidence is false for EVERY candidate
     in EVERY category.
4. `selectVenues` returns `id: null` + `unmet_constraint`. The correction
   retry fails identically. The deterministic fallback also finds no
   evidenced candidate.
5. `continuePipeline` (`app/page.tsx`) did `if (unmet) return fail(...)` — a
   hard dead end. `unmetConstraintReason` (`app/lib/planGuards.ts`) produced
   "Couldn't find a {category} that's really {constraint}", which
   self-contradicts whenever the category already contains the word
   ("a vegan restaurant that's really vegan").
6. `isEmptyPoolPick` is `s.id === null && !s.unmetConstraint`, so
   `partialEmptySelections` never routes an unmet constraint into the
   recovery panel. The harshest possible outcome was reserved for the least
   reliable signal.

The four dead `aliasesFor` branches (`vegan`/`plant based` → `vegan`,
`gluten free` → `gluten free`, `halal` → `halal`, `kosher` → `kosher`) map
each word only to itself, and no value they return is in the provider
vocabulary — so `placeMeetsConstraint` is correctly, permanently false for
them.

## The fix

### 1. A derived provability predicate (`app/lib/constraints.ts`)

- `EVIDENCE_UNIVERSE` — the complete set of strings `constraintEvidence` can
  ever emit, derived by running that EXACT function over one synthetic place
  with every provider boolean set true. Not a hand-typed list: add a field to
  the provider mask (`servesBeer` for "licensed") and teach
  `constraintEvidence` a token for it, and this set widens automatically with
  no other change.

  Derived contents (12 tokens): `vegetarian`, `outdoor seating`, `patio`,
  `live music`, `family friendly`, `dog friendly`, `accessible`,
  `wheelchair accessible`, `wheelchair accessible entrance`,
  `wheelchair accessible parking`, `wheelchair accessible restroom`,
  `wheelchair accessible seating`.

- `canEverBeProven(constraint)` — `normalizeConstraint`, then `aliasesFor`,
  then "is ANY alias in `EVIDENCE_UNIVERSE`". Same normalisation and alias
  table the judge uses, so `true` means `placeMeetsConstraint` has a genuine
  chance and `false` means it is guaranteed false for every venue that will
  ever exist. `true` for patio / outdoor seating / live music / wheelchair
  accessible / dog friendly / family friendly / vegetarian; `false` for
  indoor / quiet / cozy / waterfront / "seats six" / licensed / vegan /
  halal / kosher / gluten free.

### 2. The strip (`app/api/parse/route.ts`, beside `stripLeakedPreferenceConstraints`)

`stripUnprovableConstraints(plan)` (`app/api/parse/planner.ts`) removes from
`context.constraints` any entry that is neither strict-dietary nor provable.
It runs after the preference-leak strip, as a third floor over the model's
answer. `context.constraints` and each activity's `searchQuery` are SEPARATE
arrays, so the word stays in the search text wherever the model wrote it
there; only the hard pass/fail path is cleaned. Removed count rides out on
`planner_plan` as `unprovableConstraints` (a count only, omitted when 0),
the same shape as `strippedConstraints`.

The SAME disjunct is wired into `swap.ts`'s `isLeakedConstraint` (~:1537):
the swap model invents constraints too — a live trace had it return
"licensed" on a complaint that mentioned neither "licensed" nor a bar.

### 3. Dietary/religious words stay strict (explicit owner decision)

`STRICT_DIETARY_CONSTRAINTS` (`vegan`, `plant based`, `gluten free`, `halal`,
`kosher`) and `isStrictDietaryConstraint`. Every entry FAILS
`canEverBeProven`. The two concerns are kept visibly separate: the strip
consults `isStrictDietaryConstraint` FIRST and never folds it into the
provability predicate. A strict dietary constraint stays a hard requirement
that can refuse a plan, exactly as before — the owner has chosen stricter
handling for this category over the soft-signal treatment everything else
gets. The set is deliberately tight; broadening it needs the owner's
sign-off.

The four dead `aliasesFor` branches are kept, with an expanded comment: they
exist so `canEverBeProven` correctly reports these words as unprovable, while
the carve-out separately ensures that unprovability never strips them.

### 4. The two dietary-specific bugs

- **Self-contradicting wording** (`unmetConstraintReason`,
  `app/lib/planGuards.ts`): when the normalized category and constraint
  share a meaningful word (stopwords excluded), it now reads "Couldn't
  confirm anywhere nearby is genuinely {constraint}. Want to look further
  out, or try something else for this stop?" — said once, honestly. This is
  a GENERAL fix for any colliding pair, not dietary-only ("a bar with live
  music that's really live music" collides the same way).

- **Dead-end recovery** (`app/page.tsx`, `continuePipeline`): an unmet
  constraint now opens the SAME `mode: "empty"` recovery panel an empty pool
  gets (widen / replace / plan without it), via a parallel path rather than
  by changing `isEmptyPoolPick`. The impossible constraint(s) are lifted
  from the recovery context's `parseData.constraints` so a re-search can
  actually resolve the slot. Nothing is planned until the user picks an
  option, so a strict dietary constraint still refuses to auto-build.

### 5. The prompt bug

`PLANNER_SYSTEM_PROMPT` line 253: `dietary ("vegan")` became
`dietary ("vegetarian")`, matching `swap.ts`'s `REFINE_SYSTEM` which already
said "vegetarian". A single word in an example list, no structural change.
`vegetarian` is a real provider boolean, so it is the honest canonical
example.

## Scope explicitly NOT touched

- "Search real venue text/descriptions for vegan/halal before refusing" — a
  separate future task.
- The dietary/religious exemption set is not broadened beyond the five words.
- D9 (transit-rider dropped activity), D11 (window-fit), D12 (cross-border
  dead code), the leaking internal validator message, the possible
  down-to-zero recurrence on a patio constraint — all separate, later work.
- The scheduler, travel, geocode, and `selectVenues`' core matching logic
  are untouched. `canEverBeProven` is never a hand-typed list.

## Tests

- `app/lib/constraints.test.ts` — `EVIDENCE_UNIVERSE` exact contents;
  `canEverBeProven` true/false tables; the derived-not-allowlist property
  (every evidence token is provable); `isStrictDietaryConstraint` tight set
  with aliases folded; the two-concerns-stay-separate property.
- `app/api/parse/planner.test.ts` — `stripUnprovableConstraints` removes
  `indoor`/`waterfront`, keeps `vegetarian`/`patio`, leaves `category_signals`
  untouched; the dietary carve-out keeps every strict word; the no-op
  same-object path.
- `app/lib/planGuards.test.ts` — `unmetConstraintReason` collision vs
  non-collision phrasing; the stopword guard.
- `app/api/itinerary/swap.test.ts` — an unprovable word stripped from the
  swap's judge and search, a provable feature and a strict diet kept.
- `e2e/failloud.spec.ts` + `e2e/recovery.spec.ts` — an unmet provable
  constraint opens the recovery panel (not a fail-loud) and widen resolves
  it; a strict dietary word still refuses to auto-plan but offers recovery.
- Revert-runs: removing the strip reproduces the "indoor plan refuses" bug;
  removing the dietary carve-out makes "vegan still refuses" go red (proving
  the carve-out, not the provability check, is what protects dietary
  strictness).
