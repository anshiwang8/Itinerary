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
