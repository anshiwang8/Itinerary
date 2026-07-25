import { NextRequest } from "next/server";
import { isMockMode, mockParse } from "../_mock/fixtures";
import type { ParsedPrompt } from "../places/search/filter";
import { UNPARSEABLE_MESSAGE } from "../../lib/planGuards";
import { hasImmediateTimeSignal } from "../../lib/immediateTime";
import { hasAllDaySignal } from "../../lib/allDayTime";
import {
  ApiError,
  apiError,
  apiJson,
  enforceRateLimit,
  isRecord,
  readJsonBody,
  requestContext,
  requireServiceKey,
} from "../_shared/http";
import { fetchProvider, readProviderJson, requireProviderRecord } from "../_shared/provider";
import { parsePromptBody } from "../_shared/schemas";

// Standalone LLM parse step: natural-language prompt → structured plan
// parameters. Not connected to Places yet — this route only proves Groq
// returns clean, schema-matching JSON.
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.3-70b-versatile";

const SYSTEM_PROMPT = `You are a parser for a day-plan generator. Convert the user's request into JSON.

Respond with ONLY a single JSON object. No prose, no explanations, no markdown fences, no leading or trailing text. The object must match this exact schema — every key present, no extra keys:

{
  "time_window": string,        // ONLY timing and duration, nothing else. Capture the MOST SPECIFIC time information given: if an exact time is stated (e.g. "7pm", "around 3:30"), include it verbatim alongside any duration, e.g. "7pm, 2 hours". Preserve day qualifiers verbatim too ("today", "tomorrow", "Saturday"): e.g. "coffee at 6am tomorrow" → "tomorrow, 6am". IMMEDIACY ("right now", "ASAP", "immediately", "at this moment", "as soon as possible", "open now") is time information — capture it as exactly "now", never a day-part and never "unspecified". An ALL-DAY ask ("a full day", "the whole day", "a full schedule", "all day", "for a day") is duration information — include exactly "all day" alongside any day qualifier, e.g. "plan a full schedule for tomorrow" → "tomorrow, all day". Only fall back to a general day-part (morning/afternoon/evening/night) when no specific time is stated. "unspecified" if no time information at all
  "stop_count": number | null,  // ONLY if the user states a NUMBER of stops/places in words or digits (e.g. "3 stops", "exactly two places"); otherwise null. Never count listed activities yourself: "dinner then a bar" has no stated number, so stop_count is null (the activities still go in category_signals). Numbers that describe duration, clock times, people, or budget are NOT stop counts.
  "aesthetic": string,          // the vibe/mood the user wants, e.g. "cozy", "lively night out", "quiet and scenic"
  "category_signals": string[], // place/activity categories implied, e.g. ["coffee shop", "bookstore", "park"]. Capture EVERY distinct activity in the prompt, one entry each, including non-venue activities: "a walk" → "walk", "shopping" → "shopping", "a stroll in the park" → "park walk". Never merge or drop an activity because it isn't a business type. Preserve specific cuisine/food types as the category — "ramen" stays "ramen", "tacos" stays "tacos", never generalized to "restaurant". A VENUE FEATURE attached to an activity is NOT its own category: "dessert with a patio", "a bar with live music", "dinner with a view", "somewhere with outdoor seating" are each ONE activity — the feature ("patio", "live music", "a view", "outdoor seating", "rooftop") goes in "constraints", exactly like dietary words do. Only a genuinely distinct activity gets its own entry: "dinner then a bar" is two. PASSIVE OUTDOOR/NATURE ENJOYMENT normalizes to the category "park": sitting on a bench, quiet scenery, greenery, fresh air, people-watching outside, "somewhere calm outside", enjoying nature — all of these are "park", never a cafe/bar/restaurant with a view. THEME EXPANSION: a prompt that states an INTEREST or IDENTITY rather than concrete activities — "as a ___ fan", "a full day around ___", "explore ___ culture", "immerse myself in ___", "a ___-themed day" — combined with an open-ended ask ("a full schedule", "a full day", "things to do") is NOT one category. Expand the theme into 3-4 DISTINCT categories, each a DIFFERENT concrete, map-searchable kind of place representing a different facet of the interest, e.g. a soccer fan's full day → ["soccer stadium tour", "sports museum", "sports bar", "restaurant"]; "immerse myself in jazz" → ["jazz club", "record store", "music venue", "cocktail bar"]. Facets must be genuinely different kinds of places — never four near-synonyms, and at most ONE general food stop. Do NOT expand when the user already names a concrete place kind ("a soccer museum" → ["soccer museum"]) or lists their own activities — expansion applies only to open-ended themed asks
  "group_context": string,      // who is going, e.g. "solo", "date", "family with kids", "group of friends"; "unspecified" if unknown
  "budget": string | null,      // budget signal if stated, e.g. "cheap", "under $50", "$$$"; null if unstated
  "constraints": string[],      // hard requirements — dietary/accessibility AND venue-feature modifiers attached to a category, e.g. ["wheelchair accessible", "vegetarian options", "patio", "live music", "indoors only"]; [] if none
  "location": string            // a neighbourhood/area WITHIN the city, only if the prompt states one ("west end", "downtown", "near the harbour"); "" if none. NEVER a city name — the city is supplied separately by the app, never inferred from the prompt
}`;

const PARSE_KEYS = [
  "time_window",
  "stop_count",
  "aesthetic",
  "category_signals",
  "group_context",
  "budget",
  "constraints",
  "location",
] as const;

function parseModelOutput(raw: unknown): ParsedPrompt {
  if (!isRecord(raw)) {
    throw new ApiError(502, "groq_invalid_schema", UNPARSEABLE_MESSAGE);
  }
  const keys = Object.keys(raw).sort();
  if (
    keys.length !== PARSE_KEYS.length ||
    PARSE_KEYS.some((key) => !Object.prototype.hasOwnProperty.call(raw, key))
  ) {
    throw new ApiError(502, "groq_invalid_schema", UNPARSEABLE_MESSAGE);
  }
  const validString = (value: unknown, allowEmpty = false) =>
    typeof value === "string" &&
    value.length <= 240 &&
    (allowEmpty || value.trim() !== "");
  const validList = (value: unknown) =>
    Array.isArray(value) &&
    value.length <= 8 &&
    value.every((entry) => validString(entry));
  if (
    !validString(raw.time_window) ||
    !validString(raw.aesthetic) ||
    !validString(raw.group_context) ||
    !validString(raw.location, true) ||
    !validList(raw.category_signals) ||
    !validList(raw.constraints) ||
    (raw.budget !== null && !validString(raw.budget)) ||
    (raw.stop_count !== null &&
      (typeof raw.stop_count !== "number" ||
        !Number.isInteger(raw.stop_count) ||
        raw.stop_count < 1 ||
        raw.stop_count > 8))
  ) {
    throw new ApiError(502, "groq_invalid_schema", UNPARSEABLE_MESSAGE);
  }
  return raw as unknown as ParsedPrompt;
}

// Deterministic immediate-time floor (same spirit as swap.ts's
// parseTimeExpr): when the RAW prompt states immediacy, time_window is
// "now" — the exact value the clarify UI's own "now" button produces and
// resolveStartTime's immediate branch already handles — regardless of
// what the model returned. Live repro showed the model mapping "right
// now" to "unspecified", which rolled the plan to tomorrow.
function withImmediateFloor(prompt: string, parsed: ParsedPrompt): ParsedPrompt {
  if (!hasImmediateTimeSignal(prompt)) return parsed;
  return { ...parsed, time_window: "now" };
}

// All-day floor: APPENDS rather than replaces — a day qualifier the model
// did capture ("tomorrow") must survive ("tomorrow, all day"), and an
// explicit clock time still wins downstream because resolveStartTime
// checks clock times before day-parts. Applied INSIDE the immediate
// floor: "everything open right now" + "all day" is an immediacy prompt,
// and "now" replaces wholesale.
function withAllDayFloor(prompt: string, parsed: ParsedPrompt): ParsedPrompt {
  if (!hasAllDaySignal(prompt)) return parsed;
  const tw = parsed.time_window ?? "";
  if (/\ball day\b/i.test(tw)) return parsed; // model already captured it
  const base = /^unspecified$/i.test(tw.trim()) ? "" : tw.trim();
  return { ...parsed, time_window: base ? `${base}, all day` : "all day" };
}

export async function POST(request: NextRequest) {
  const ctx = requestContext(request, "parse");
  try {
    enforceRateLimit(ctx, 60);
    const prompt = parsePromptBody(await readJsonBody(request));

    // e2e fixture seam — deterministic parse, no Groq call, no key needed.
    // The immediate-time floor still applies: it is LOGIC, not data, so the
    // mock seam must not fork around it.
    if (isMockMode()) {
      return apiJson(
        ctx,
        withImmediateFloor(prompt, withAllDayFloor(prompt, mockParse(prompt)))
      );
    }

    const apiKey = requireServiceKey(process.env.GROQ_API_KEY);
    const res = await fetchProvider("groq", GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        // Belt and braces: the system prompt demands bare JSON, and
        // response_format guarantees the model can't wrap it in prose.
        response_format: { type: "json_object" },
        temperature: 0,
      }),
      cache: "no-store",
    });
    const data = requireProviderRecord("groq", await readProviderJson("groq", res));
    const choices = data.choices;
    const first = Array.isArray(choices) ? choices[0] : undefined;
    const message = isRecord(first) ? first.message : undefined;
    const raw = isRecord(message) ? message.content : undefined;
    if (typeof raw !== "string" || raw.length > 50_000) {
      throw new ApiError(
        502,
        "groq_invalid_response",
        "The planner returned an invalid response. Please try again."
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ApiError(502, "groq_invalid_json", UNPARSEABLE_MESSAGE);
    }
    return apiJson(
      ctx,
      withImmediateFloor(prompt, withAllDayFloor(prompt, parseModelOutput(parsed)))
    );
  } catch (err) {
    return apiError(ctx, err);
  }
}
