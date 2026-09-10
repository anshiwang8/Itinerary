import type { Place } from "../api/places/search/filter";

export function normalizeConstraint(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/-+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

export function normalizeConstraints(values: string[] | null | undefined): string[] {
  return [
    ...new Set(
      (values ?? [])
        .filter((value): value is string => typeof value === "string")
        .map(normalizeConstraint)
        .filter(Boolean)
    ),
  ];
}

/**
 * Deterministic provider evidence only. Venue names, narrative summaries,
 * and model knowledge are never evidence: prose can negate a term or contain
 * instruction-like text, so a keyword match cannot prove a hard constraint.
 */
export function constraintEvidence(place: Place): string[] {
  const evidence = new Set<string>();
  if (place.servesVegetarianFood === true) evidence.add("vegetarian");
  if (place.outdoorSeating === true) {
    evidence.add("outdoor seating");
    evidence.add("patio");
  }
  if (place.liveMusic === true) evidence.add("live music");
  if (place.goodForChildren === true) evidence.add("family friendly");
  if (place.allowsDogs === true) evidence.add("dog friendly");
  const accessibility = place.accessibilityOptions;
  if (accessibility?.wheelchairAccessibleEntrance) {
    evidence.add("accessible");
    evidence.add("wheelchair accessible");
    evidence.add("wheelchair accessible entrance");
  }
  if (accessibility?.wheelchairAccessibleParking) {
    evidence.add("wheelchair accessible parking");
  }
  if (accessibility?.wheelchairAccessibleRestroom) {
    evidence.add("wheelchair accessible restroom");
  }
  if (accessibility?.wheelchairAccessibleSeating) {
    evidence.add("wheelchair accessible seating");
  }
  return [...evidence];
}

function aliasesFor(constraint: string): string[] {
  if (
    /\bwheelchair\b.*\bparking\b|\baccessible parking\b/.test(constraint)
  ) {
    return ["wheelchair accessible parking"];
  }
  if (/\bwheelchair\b.*\brestroom\b|\baccessible restroom\b/.test(constraint)) {
    return ["wheelchair accessible restroom"];
  }
  if (/\bwheelchair\b.*\bseating\b|\baccessible seating\b/.test(constraint)) {
    return ["wheelchair accessible seating"];
  }
  if (/\bwheelchair\b.*\bentrance\b|\baccessible entrance\b/.test(constraint)) {
    return ["wheelchair accessible entrance"];
  }
  if (/\bwheelchair\b|\baccessible\b|\baccessibility\b/.test(constraint)) {
    return ["wheelchair accessible", "accessible"];
  }
  if (/\bpatio\b|\boutdoor seating\b/.test(constraint)) {
    return ["patio", "outdoor seating"];
  }
  // The four branches from here to `kosher` are DEAD BUT INTENTIONAL: each
  // maps a dietary/religious word only to ITSELF, and no string any of them
  // returns is in EVIDENCE_UNIVERSE, because no provider boolean carries the
  // meaning. Keeping them serves two separate purposes. They keep
  // `placeMeetsConstraint` honestly false for these words (a venue name or a
  // menu blurb is never proof), and they let `canEverBeProven` correctly
  // report the word as unprovable. What still lets an unprovable dietary word
  // refuse a plan is NOT this function: it is the STRICT_DIETARY_CONSTRAINTS
  // carve-out, an explicit owner decision that is consulted BEFORE the
  // provability strip. Do not delete these as cruft, and do not repoint them
  // at real evidence. ("vegetarian" is different: it IS a provider boolean.)
  if (/\bvegan\b|\bplant based\b/.test(constraint)) return ["vegan"];
  if (/\bvegetarian\b/.test(constraint)) return ["vegetarian"];
  if (/\bgluten free\b/.test(constraint)) return ["gluten free"];
  if (/\blive music\b/.test(constraint)) return ["live music"];
  if (/\bfamily\b|\bkid\b|\bchildren\b/.test(constraint)) return ["family friendly"];
  if (/\bdog\b|\bpet\b/.test(constraint)) return ["dog friendly"];
  if (/\bhalal\b/.test(constraint)) return ["halal"];
  if (/\bkosher\b/.test(constraint)) return ["kosher"];
  return [constraint];
}

export function placeMeetsConstraint(place: Place, requested: string): boolean {
  const normalized = normalizeConstraint(requested);
  if (!normalized) return false;
  const evidence = new Set(constraintEvidence(place));
  return aliasesFor(normalized).some((alias) => evidence.has(alias));
}

export function placeMeetsAllConstraints(place: Place, requested: string[]): boolean {
  const constraints = normalizeConstraints(requested);
  return constraints.every((constraint) => placeMeetsConstraint(place, constraint));
}

// ── provability ──────────────────────────────────────────────────────────
// `placeMeetsConstraint` asks "does THIS place have evidence for this
// constraint". Nothing here asked "is this constraint the KIND of thing
// evidence could ever exist for" — so a word the system has no way to verify
// ("indoor", "waterfront", "quiet", "seats six", "licensed") was treated
// exactly like a constraint that was checked and genuinely failed, producing
// a self-contradicting refusal ("a waterfront park that's really waterfront")
// that killed the whole plan. These two exports are that missing question.

/** A synthetic place with every provider boolean `constraintEvidence` reads
 *  set true — used ONCE, below, to derive the evidence vocabulary. */
const ALL_EVIDENCE_PROBE: Place = {
  id: "__evidence-universe-probe__",
  servesVegetarianFood: true,
  outdoorSeating: true,
  liveMusic: true,
  goodForChildren: true,
  allowsDogs: true,
  accessibilityOptions: {
    wheelchairAccessibleParking: true,
    wheelchairAccessibleEntrance: true,
    wheelchairAccessibleRestroom: true,
    wheelchairAccessibleSeating: true,
  },
};

/**
 * Every string `constraintEvidence` can ever emit — DERIVED by running that
 * exact function over `ALL_EVIDENCE_PROBE`, never hand-typed. If someone
 * later adds a field to the provider mask (say `servesBeer` for "licensed")
 * and teaches `constraintEvidence` to emit a token for it, this set widens
 * automatically with zero change here or to `canEverBeProven`.
 */
export const EVIDENCE_UNIVERSE: ReadonlySet<string> = new Set(
  constraintEvidence(ALL_EVIDENCE_PROBE)
);

/**
 * Could provider evidence EVER establish this constraint? Not "does this one
 * venue have it" — "is it the kind of thing `constraintEvidence` speaks about
 * at all". True for patio / outdoor seating / live music / wheelchair
 * accessible / dog friendly / family friendly / vegetarian (all real
 * provider booleans). False for indoor / quiet / cozy / waterfront / "seats
 * six" / licensed — and false for vegan / halal / kosher / gluten free,
 * which have no provider boolean (see the dead alias branches). Uses the
 * SAME `normalizeConstraint` + `aliasesFor` the judge uses, so a `true` here
 * means `placeMeetsConstraint` has a genuine chance of returning true and a
 * `false` means it is guaranteed false for every venue that will ever exist.
 */
export function canEverBeProven(constraint: string): boolean {
  const normalized = normalizeConstraint(constraint);
  if (!normalized) return false;
  return aliasesFor(normalized).some((alias) => EVIDENCE_UNIVERSE.has(alias));
}

/**
 * Dietary and religious words the owner has explicitly chosen to keep STRICT.
 *
 * Every entry FAILS `canEverBeProven` — there is no provider boolean for
 * "vegan" or "halal". Everything else that fails provability is stripped from
 * the hard pass/fail check at the parse seam (an unverifiable word must never
 * become a plan-killing negative finding). These words are the deliberate
 * exception: they stay hard requirements that can refuse a plan, exactly as
 * before, because the owner has chosen stricter handling for this category
 * over the soft-signal treatment everything else gets.
 *
 * The two concerns are kept VISIBLY SEPARATE. `canEverBeProven` answers "is
 * there evidence for this" (no). This set answers "is it exempt from
 * stripping regardless" (yes). The strip checks this set FIRST and never
 * folds it into the provability predicate.
 *
 * Keep this set TIGHT and dietary/religious-specific. Do NOT broaden it
 * without the owner's sign-off.
 */
export const STRICT_DIETARY_CONSTRAINTS: readonly string[] = [
  "vegan",
  "plant based",
  "gluten free",
  "halal",
  "kosher",
];

/** Is this constraint one of the strict dietary/religious words that stays a
 *  hard requirement even though `canEverBeProven` is false for it? Matches
 *  the normalized word directly and via `aliasesFor` (so "plant based" folds
 *  onto "vegan"), deliberately WITHOUT a broader keyword net. */
export function isStrictDietaryConstraint(constraint: string): boolean {
  const normalized = normalizeConstraint(constraint);
  if (!normalized) return false;
  if (STRICT_DIETARY_CONSTRAINTS.includes(normalized)) return true;
  return aliasesFor(normalized).some((alias) =>
    STRICT_DIETARY_CONSTRAINTS.includes(alias)
  );
}
