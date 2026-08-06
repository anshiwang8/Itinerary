export type BudgetSpec =
  | { kind: "places-level"; maxLevel: 1 | 2; raw: string }
  | { kind: "relative"; level: "cheap"; raw: string }
  | { kind: "numeric-max"; amount: number; currency: string | null; raw: string };

const CURRENCY_SYMBOLS: Record<string, string> = {
  "$": "USD",
  "C$": "CAD",
  "CA$": "CAD",
  "US$": "USD",
  "€": "EUR",
  "£": "GBP",
  "¥": "JPY",
};

function currencyCode(marker: string | undefined): string | null {
  if (!marker) return null;
  const normalized = marker.toUpperCase();
  return CURRENCY_SYMBOLS[normalized] ?? CURRENCY_SYMBOLS[marker] ?? normalized;
}

export function parseBudget(raw: string | null | undefined): BudgetSpec | null {
  const value = raw?.trim();
  if (!value) return null;
  if (value === "$") return { kind: "places-level", maxLevel: 1, raw: value };
  if (value === "$$") return { kind: "places-level", maxLevel: 2, raw: value };

  const numeric = value.match(
    /\b(?:under|below|less than|up to|maximum|max)\s*(?:(US\$|CA\$|C\$|\$|€|£|¥|USD|CAD|EUR|GBP|JPY)\s*)?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)\s*(US\$|CA\$|C\$|\$|€|£|¥|USD|CAD|EUR|GBP|JPY)?(?![\w.,])/i
  );
  if (numeric) {
    const amount = Number(numeric[2].replaceAll(",", ""));
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const prefixCurrency = currencyCode(numeric[1]);
    const suffixCurrency = currencyCode(numeric[3]);
    if (prefixCurrency && suffixCurrency && prefixCurrency !== suffixCurrency) {
      return null;
    }
    const currency = prefixCurrency ?? suffixCurrency;
    return { kind: "numeric-max", amount, currency, raw: value };
  }

  if (/\b(?:cheap|budget|broke|inexpensive|affordable|student)\b/i.test(value)) {
    return { kind: "relative", level: "cheap", raw: value };
  }
  return null;
}

const PRICE_RANK: Record<string, number> = {
  PRICE_LEVEL_FREE: 0,
  PRICE_LEVEL_INEXPENSIVE: 1,
  PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3,
  PRICE_LEVEL_VERY_EXPENSIVE: 4,
};

/** null means the budget cannot be mapped to Places' relative levels. */
export function hardPriceLevelMaximum(spec: BudgetSpec | null): number | null {
  if (!spec) return null;
  if (spec.kind === "places-level") return spec.maxLevel;
  if (spec.kind === "relative") return 2;
  return null;
}

export function priceLevelRank(priceLevel: string | undefined): number | null {
  return priceLevel ? PRICE_RANK[priceLevel] ?? null : null;
}

// ── Price DIRECTION ───────────────────────────────────────────────────────
//
// `parseBudget` above answers "what ceiling did the user state?" and only
// ever cheap-ward — `$$$`, "fancier", "upscale" and "splurge" all fall
// through it to null. That made a price-direction swap a NO-OP: with no
// budget the objective filter's price rule never fires, the selector is
// handed `budget: null`, and the swap degrades to "any candidate not
// currently in the plan" — which ping-pongs A→B→A between same-tier venues.
//
// A direction is a different question from a ceiling, so it gets its own
// parser. It is deliberately RELATIVE: "fancier" means pricier than the
// venue you are looking at, not "over some absolute line". Everything here
// is pure and deterministic — price is a field comparison, so the LLM never
// gets a say (the core architecture rule), and the raw refinement text is
// the input, never the model's interpretation of it.

export type PriceDirection = "up" | "down";

// Terms that ask for a MORE expensive venue. Narrow on purpose: a false
// positive re-ranks a swap the user never asked to have re-ranked.
// `fancy` carries a negative lookahead because British usage makes "fancy a
// drink" / "fancy the patio" a VERB — those are not price requests.
const UP_TERMS =
  "fancier|fancy(?!\\s+(?:a|an|the)\\b)|nicer|upscale|upmarket|posh|classier|classy|swankier|swanky|bougie|luxurious|luxury|pricier|pricey|expensive|splurge|high[\\s-]?end|fine[\\s-]?dining";

// Terms that ask for a LESS expensive one.
const DOWN_TERMS =
  "cheaper|cheap|cheapest|budget|inexpensive|affordable|low[\\s-]?cost|down[\\s-]?market";

// Particles that may sit between a negation and the word it negates, as a
// CLOSED set rather than "any word or two" — the loose version turned
// "no patio, want fancier" into a cheaper request.
const NEGATION_FILLER = "(?:\\s+(?:so|too|as|that|very|really|of|a|an|the))*";

// A NEGATED up-term is a DOWN request: "less fancy", "not too expensive",
// "nothing posh", "less of a splurge". This must be tested FIRST — every
// one of those strings also matches UP_PATTERN, so the naive order reads
// them exactly backwards.
const NEGATED_UP_PATTERN = new RegExp(
  `\\b(?:less|not|nothing|no|never)\\b${NEGATION_FILLER}\\s+(?:${UP_TERMS})\\b`,
  "i"
);
const DOWN_PATTERN = new RegExp(`\\b(?:${DOWN_TERMS})\\b`, "i");
const UP_PATTERN = new RegExp(`\\b(?:${UP_TERMS})\\b`, "i");

/**
 * The price direction a refinement asks for, or null when it asks for none.
 *
 * `$` and `$$` are deliberately NOT handled here: they already mean a hard
 * ceiling through `parseBudget`, and that behaviour is unchanged. `$$$` and
 * `$$$$` are read as "up" because they are a total no-op today.
 */
export function parsePriceDirection(
  raw: string | null | undefined
): PriceDirection | null {
  const value = raw?.trim();
  if (!value) return null;
  if (/^\${3,4}$/.test(value)) return "up";
  if (NEGATED_UP_PATTERN.test(value)) return "down";
  if (DOWN_PATTERN.test(value)) return "down";
  if (UP_PATTERN.test(value)) return "up";
  return null;
}

/** The Places text-search term that biases a query toward a direction.
 *  Punctuation-free (it is prepended verbatim into the query by
 *  `buildQuery`) and category-agnostic — "fine dining" was rejected because
 *  the same swap runs on bars, cafes and activities, not just restaurants. */
export function priceDirectionSearchTerm(direction: PriceDirection): string {
  return direction === "up" ? "upscale" : "cheap casual";
}

export interface PricedCandidate {
  priceLevel?: string;
}

export interface PriceDirectionRanking<T> {
  /** STRICTLY in the requested direction versus the current venue, most
   *  extreme first. Empty means nothing genuinely moves that way. */
  ranked: T[];
  /** Places has no price for these. Keep-on-missing is non-negotiable, so
   *  they are never dropped — but they are a LAST RESORT, because a venue
   *  known to move in the requested direction always beats an unknown. */
  unpriced: T[];
  /** the CURRENT venue has no price either, so there was nothing to compare
   *  against and `ranked` is every priced candidate, most extreme first */
  bestEffort: boolean;
}

/**
 * Partition candidates by price against the CURRENT venue's own level.
 *
 * Pure and total: it drops nothing and decides nothing about refusal — the
 * caller reads `ranked`/`unpriced` and chooses. Missing price on a candidate
 * lands it in `unpriced`; missing price on the CURRENT venue means no
 * comparison is possible at all, which is best-effort rather than a refusal
 * (refusing there would be refusing BECAUSE of missing data).
 */
export function rankByPriceDirection<T extends PricedCandidate>(
  candidates: readonly T[],
  currentPriceLevel: string | undefined,
  direction: PriceDirection
): PriceDirectionRanking<T> {
  const currentRank = priceLevelRank(currentPriceLevel);
  const priced: Array<{ item: T; rank: number }> = [];
  const unpriced: T[] = [];
  for (const candidate of candidates) {
    const rank = priceLevelRank(candidate.priceLevel);
    if (rank === null) unpriced.push(candidate);
    else priced.push({ item: candidate, rank });
  }
  const bestEffort = currentRank === null;
  const inDirection = bestEffort
    ? priced
    : priced.filter(({ rank }) =>
        direction === "up" ? rank > currentRank : rank < currentRank
      );
  const ranked = inDirection
    .slice()
    .sort((a, b) => (direction === "up" ? b.rank - a.rank : a.rank - b.rank))
    .map(({ item }) => item);
  return { ranked, unpriced, bestEffort };
}
