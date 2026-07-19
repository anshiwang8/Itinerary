// LLM candidate selection core, shared by the /api/select route and the
// reroute engine. One Groq call over all pools, validation ladder:
// invalid ids → one correction retry → highest-rated fallback.
import { ParsedPrompt, Place } from "../places/search/filter";
// CurrentOpeningHours lives in hours.ts (filter.ts imports it there too and
// doesn't re-export it) — take it from the canonical source.
import type { CurrentOpeningHours } from "../places/search/hours";
import { haversineMeters } from "../schedule/travel";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.3-70b-versatile";

const SYSTEM_PROMPT = `You are the venue selector for a day-plan generator. You receive the user's parsed request, the SLOTS to fill (the stops of the outing, in order), and candidate venue pools grouped by category. Pick exactly ONE venue for EACH SLOT.

Rules:
- Every slot gets its own entry, identified by its "slot" number. Two slots can share a category (the user asked for two stops of the same kind) — when they do, they MUST get DIFFERENT venues. Never repeat a venue across slots.
- Select by "id", ONLY from the provided candidates for that slot's category. Never invent an id and never borrow one from another category.
- Judge fit against the parsed request (aesthetic, group_context, budget, constraints) AND cohesion across the full set: the chosen venues should make sense together as one outing — compatible vibe, and reasonable proximity to each other (use the lat/lng provided).
- Prefer a coherent outing over individually highest-rated venues.
- DISTANCE (applies when candidates carry "kmFromHome" — the straight-line km from the user's starting point, computed by code): treat distance as a real cost, not a tiebreaker. Prefer the nearer candidate when quality is comparable, and NEVER pick a venue tens of kilometres away when an acceptable option exists much nearer — a slightly lower rating close by beats a slightly higher rating across the region. Mention distance in the reason only when it drove the pick.
- BUDGET (applies whenever request.budget is stated): strongly prefer venues whose "price" is known and fits the budget (for cheap/budget requests: PRICE_LEVEL_INEXPENSIVE or PRICE_LEVEL_MODERATE). A venue with price null/unknown is a RISK, not a free pass — pick it only when no appropriately-priced option exists in that category. Also use your own general knowledge as a tiebreaker: if you recognize a venue as upscale or pricey even though its price data is missing, avoid it. When affordability influenced a pick, say so in the reason.
- CONSTRAINTS are hard requirements, not preferences. Treat a candidate as meeting a constraint (dietary, accessibility, etc.) ONLY when the provided data, its "desc", or the venue's name/known character is actual evidence for it — a "vegan" constraint needs a vegan or clearly plant-based venue, not a steakhouse that might have options. If NO candidate in a category meets every constraint, do NOT pick a best-effort venue: return { "category": <category>, "id": null, "unmet_constraint": <the constraint no candidate meets> } for that category instead. NEVER pick a venue while telling the user to verify — reasons must not contain hedges like "worth confirming", "check with the venue", or "may accommodate".
- PARKS / OUTDOOR RELAXATION categories (park, garden, trail, walk): prefer the highest-rated genuine public park or notable scenic spot over ANY commercial venue with a "scenic" angle — a lounge, cafe, or restaurant with a view is not a park. Parks usually have no price data; when the pick is a public park with null price, the reason may note that it's free.
- "reason": exactly one sentence in a user-facing tone, e.g. "Cozy and low-key, a natural fit for a quiet date." Never meta commentary about ids, JSON, data, or your selection process.

Respond with ONLY a single JSON object, no prose, no markdown fences:
{ "selections": [ { "slot": number, "category": string, "id": string | null, "reason": string, "unmet_constraint": string | null } ] }
"id" may be null ONLY together with a non-null "unmet_constraint".
Exactly one entry per slot, in the order the slots were given.`;

export interface Selection {
  category: string;
  id: string | null;
  reason: string;
  fallback?: boolean;
  /** which requested stop this fills. Two stops can share a category
   * ("a drink, then another drink somewhere else"), so the SLOT — not the
   * category string — is a selection's identity. Absent on legacy/simple
   * callers, where category is unique and doubles as the identity. */
  slot?: number;
  /** set (with id: null) when the request asked for more stops of this
   * category than there are distinct venues to fill them — the plan is
   * narrower than asked, and the user must be told, never silently
   * collapsed (code-audit 2026-07-18 §7.1). */
  narrowed?: boolean;
  name?: string;
  rating?: number;
  /** price + one-line description travel with the pick so the UI never
   * depends on a stale pools lookup after a swap/reroute */
  priceLevel?: string;
  description?: string;
  /** opening hours travel with the pick for the same reason: a LATER
   * availability check (the swap engine's adapt step) must be able to ask
   * "is this venue open then" without a pools lookup that has gone stale —
   * or, as it did before, without any hours at all. */
  currentOpeningHours?: CurrentOpeningHours;
  /** set (with id: null) when no candidate actually meets a hard
   * constraint — the caller fails loud instead of hedging */
  unmetConstraint?: string;
}

/** Groq output unparseable as JSON — carries the raw text for debugging. */
export class SelectParseError extends Error {
  raw: string;
  constructor(message: string, raw: string, cause?: unknown) {
    super(message);
    this.raw = raw;
    this.name = "SelectParseError";
    if (cause instanceof Error) this.message += ` (${cause.message})`;
  }
}

// Compact candidate view sent to the model — just what's needed to
// judge fit and proximity, keeps tokens down. When the plan's starting
// point is known, each candidate carries a CODE-computed kmFromHome so
// the distance judgment rests on a verifiable fact, never LLM arithmetic.
function candidateView(p: Place, home?: { latitude: number; longitude: number }) {
  return {
    id: p.id,
    name: p.displayName?.text ?? "(unnamed)",
    rating: p.rating ?? null,
    price: p.priceLevel ?? null,
    // constraint evidence lives here ("plant-based", "patio", …)
    desc: p.editorialSummary?.text ?? null,
    lat: p.location?.latitude ?? null,
    lng: p.location?.longitude ?? null,
    ...(home && p.location
      ? { kmFromHome: Math.round(haversineMeters(home, p.location) / 100) / 10 }
      : {}),
  };
}

async function callGroq(apiKey: string, messages: unknown[]) {
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      response_format: { type: "json_object" },
      temperature: 0,
    }),
    cache: "no-store",
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message ?? `Groq request failed (${res.status}).`);
  }
  return data?.choices?.[0]?.message?.content ?? "";
}

// Raw selection shape as the model returns it (unmet_constraint is the
// wire name; Selection carries it as unmetConstraint).
interface RawSelection {
  slot?: unknown;
  category?: string;
  id?: unknown;
  reason?: unknown;
  unmet_constraint?: unknown;
}

/** Index the model's answers by slot. Tolerant by design: a model that
 *  answers by category only (the pre-slot contract) still lines up as long
 *  as the category is unambiguous — so a shape regression degrades to the
 *  old behaviour instead of failing every slot into the fallback ladder. */
function indexBySlot(raw: unknown, slots: string[]): Map<number, RawSelection> {
  const bySlot = new Map<number, RawSelection>();
  if (!Array.isArray(raw)) return bySlot;
  const byCategory = new Map<string, RawSelection[]>();
  for (const s of raw as RawSelection[]) {
    if (!s || typeof s !== "object") continue;
    if (typeof s.slot === "number" && Number.isInteger(s.slot)) {
      if (!bySlot.has(s.slot)) bySlot.set(s.slot, s);
      continue;
    }
    if (typeof s.category === "string") {
      const list = byCategory.get(s.category) ?? [];
      list.push(s);
      byCategory.set(s.category, list);
    }
  }
  // fill any slot the model didn't number, in request order per category
  slots.forEach((category, i) => {
    if (bySlot.has(i)) return;
    const queue = byCategory.get(category);
    if (queue && queue.length > 0) bySlot.set(i, queue.shift()!);
  });
  return bySlot;
}

function unmetOf(sel: RawSelection | undefined): string | null {
  return sel && typeof sel.unmet_constraint === "string" && sel.unmet_constraint.trim()
    ? sel.unmet_constraint.trim()
    : null;
}

// Check the model's selections against the pools, SLOT by slot. Returns a
// list of human-readable problems (empty = valid). id: null is valid ONLY
// as an honest unmet-constraint answer. Two slots sharing a category must
// get different venues — a repeat is a problem, not a preference.
function findProblems(
  selections: unknown,
  pools: Record<string, Place[]>,
  slots: string[]
): string[] {
  const problems: string[] = [];
  if (!Array.isArray(selections)) {
    return ["`selections` is missing or not an array"];
  }
  const bySlot = indexBySlot(selections, slots);
  const usedIds = new Set<string>();
  slots.forEach((category, i) => {
    const places = pools[category] ?? [];
    const sel = bySlot.get(i);
    if (!sel) {
      problems.push(`no selection for slot ${i} ("${category}")`);
      return;
    }
    if (sel.id === null && unmetOf(sel)) return; // honest constraint failure
    const validIds = new Set(places.map((p) => p.id));
    if (typeof sel.id !== "string" || !validIds.has(sel.id)) {
      problems.push(
        `slot ${i}: selected id "${String(sel.id)}" is not in the "${category}" pool`
      );
      return;
    }
    if (usedIds.has(sel.id)) {
      problems.push(
        `slot ${i}: venue "${sel.id}" is already used by an earlier slot — each stop needs a different venue`
      );
      return;
    }
    usedIds.add(sel.id);
  });
  return problems;
}

// A pick whose reason tells the user to verify the constraint themselves
// is an unmet constraint in disguise — the code-side backstop for the
// no-hedging rule.
const HEDGE_PATTERN =
  /\b(worth confirming|check with|double[- ]?check|call ahead|ask (?:them|ahead|the venue)|may (?:be able to )?accommodate|might (?:be able to )?accommodate|verify|confirm (?:with|that|they))\b/i;

/** Highest-rated of the given places; undefined when there are none left
 *  (every candidate already taken by an earlier slot). */
function highestRated(places: Place[]): Place | undefined {
  return [...places].sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1))[0];
}

/**
 * Select one venue per category. Empty pools resolve to null-id
 * selections without touching the LLM; invalid model answers get one
 * correction retry, then a highest-rated fallback flagged on the
 * selection. Throws SelectParseError when Groq output isn't JSON.
 */
export async function selectVenues(
  apiKey: string,
  parsed: ParsedPrompt,
  poolsIn: Record<string, Place[]>,
  slotsIn?: string[]
): Promise<Selection[]> {
  // Ignore meta keys (e.g. _dropLog passed through by mistake) and
  // split empty pools out — they're answered without the LLM.
  const pools: Record<string, Place[]> = {};
  const emptyCategories = new Set<string>();
  for (const [k, v] of Object.entries(poolsIn)) {
    if (k.startsWith("_") || !Array.isArray(v)) continue;
    if (v.length === 0) emptyCategories.add(k);
    else pools[k] = v;
  }

  // The SLOTS are the requested stops, in order, duplicates intact — pools
  // are keyed by category, so a repeated category shares one pool but still
  // needs its own stop. Callers that don't care (single stop, or a
  // guaranteed-unique category list) can omit them and get the old
  // one-per-pool behaviour.
  const allSlots = (slotsIn ?? Object.keys(poolsIn)).filter(
    (c): c is string => typeof c === "string" && c.trim() !== "" && !c.startsWith("_")
  );

  // slots whose pool never materialized — answered without the LLM, and
  // appended LAST (the recovery flow's ordering depends on this shape)
  const emptySelections: Selection[] = [];
  const liveSlots: Array<{ slot: number; category: string }> = [];
  allSlots.forEach((category, slot) => {
    if (pools[category] && pools[category].length > 0) {
      liveSlots.push({ slot, category });
    } else if (emptyCategories.has(category) || !pools[category]) {
      emptySelections.push({
        category,
        slot,
        id: null,
        reason: "no venues survived filtering",
      });
    }
  });

  if (liveSlots.length === 0) return emptySelections;

  const liveCategories = [...new Set(liveSlots.map((s) => s.category))];
  const candidates: Record<string, unknown[]> = {};
  for (const category of liveCategories) {
    candidates[category] = pools[category].map((p) => candidateView(p, parsed.home));
  }

  const messages: unknown[] = [
    {
      role: "system",
      content: SYSTEM_PROMPT,
    },
    {
      role: "user",
      content: JSON.stringify({
        request: parsed,
        slots: liveSlots.map((s) => ({ slot: s.slot, category: s.category })),
        candidates,
      }),
    },
  ];

  let raw = await callGroq(apiKey, messages);
  let parsedOut: { selections?: Selection[] };
  try {
    parsedOut = JSON.parse(raw);
  } catch (err) {
    throw new SelectParseError(
      "Failed to parse Groq selection response as JSON.",
      raw,
      err
    );
  }

  const liveSlotCategories = liveSlots.map((s) => s.category);
  let problems = findProblems(parsedOut.selections, pools, liveSlotCategories);
  if (problems.length > 0) {
    // One correction retry with the problems spelled out.
    messages.push({ role: "assistant", content: raw });
    messages.push({
      role: "user",
      content: `Your previous answer was invalid: ${problems.join("; ")}. Respond again with ONLY the JSON object, one entry per slot, selecting ids strictly from the provided candidates for that slot's category, and never repeating a venue across slots.`,
    });
    raw = await callGroq(apiKey, messages);
    try {
      parsedOut = JSON.parse(raw);
    } catch (err) {
      throw new SelectParseError(
        "Failed to parse Groq retry response as JSON.",
        raw,
        err
      );
    }
  }

  // Assemble final selections in SLOT order; per-slot fallback to the
  // highest-rated venue not already taken by an earlier slot.
  const bySlot = indexBySlot(parsedOut.selections, liveSlotCategories);
  const hasConstraints = (parsed.constraints ?? []).some(
    (c) => typeof c === "string" && c.trim() !== ""
  );
  const taken = new Set<string>();
  const selections = liveSlots.map(({ slot, category }): Selection => {
    const places = pools[category];
    const validIds = new Set(places.map((p) => p.id));
    const sel = bySlot.get(slot);
    const unmet = unmetOf(sel);
    if (sel && sel.id === null && unmet) {
      // honest constraint failure — surfaced, never papered over
      return {
        category,
        slot,
        id: null,
        reason: `no ${category} candidate actually meets "${unmet}"`,
        unmetConstraint: unmet,
      };
    }
    if (sel && typeof sel.id === "string" && validIds.has(sel.id) && !taken.has(sel.id)) {
      const place = places.find((p) => p.id === sel.id)!;
      const reason = typeof sel.reason === "string" ? sel.reason : "";
      if (hasConstraints && HEDGE_PATTERN.test(reason)) {
        // "may accommodate / check with them" = the constraint isn't met
        const c = (parsed.constraints ?? []).find(
          (x) => typeof x === "string" && x.trim() !== ""
        )!;
        return {
          category,
          slot,
          id: null,
          reason: `no ${category} candidate verifiably meets "${c}"`,
          unmetConstraint: c,
        };
      }
      taken.add(sel.id);
      return {
        category,
        slot,
        id: sel.id,
        reason,
        name: place.displayName?.text,
        rating: place.rating,
        priceLevel: place.priceLevel,
        description: place.editorialSummary?.text,
        currentOpeningHours: place.currentOpeningHours,
      };
    }
    const fb = highestRated(places.filter((p) => !taken.has(p.id)));
    if (!fb) {
      // The request asked for more stops of this category than there are
      // distinct venues to fill them. Narrower than asked — say so, don't
      // silently drop the stop (code-audit 2026-07-18 §7.1).
      return {
        category,
        slot,
        id: null,
        narrowed: true,
        reason: `only found ${taken.size === 1 ? "one" : String(taken.size)} ${category} nearby`,
      };
    }
    taken.add(fb.id);
    return {
      category,
      slot,
      id: fb.id,
      reason: "Top-rated option in this category.",
      fallback: true,
      name: fb.displayName?.text,
      rating: fb.rating,
      priceLevel: fb.priceLevel,
      description: fb.editorialSummary?.text,
      currentOpeningHours: fb.currentOpeningHours,
    };
  });

  return [...selections, ...emptySelections];
}
