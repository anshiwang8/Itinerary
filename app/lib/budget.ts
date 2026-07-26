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
