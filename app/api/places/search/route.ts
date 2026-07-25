import { NextRequest } from "next/server";
import { DropEntry, filterPools, ParsedPrompt, WeatherHour } from "./filter";
import { searchPools } from "./searchPlaces";
import { resolveStartTime } from "../../schedule/schedule";
import { wallClockParts } from "../../../lib/zoneTime";
import { isMockMode, mockPools } from "../../_mock/fixtures";
import {
  apiError,
  apiJson,
  enforceRateLimit,
  badRequest,
  isRecord,
  logEvent,
  readJsonBody,
  requestContext,
  requireServiceKey,
} from "../../_shared/http";
import {
  parseCategories,
  parseOptionalInstant,
  parseOptionalTimeZone,
  parseParsedPrompt,
  parseWeather,
} from "../../_shared/schemas";

// Places API (New) — Text Search, driven by the parsed prompt from
// /api/parse. Search core lives in searchPlaces.ts (shared with the
// reroute engine); pools pass through the objective filter before the
// response. No LLM selection here.
export async function POST(request: NextRequest) {
  const ctx = requestContext(request, "places_search");
  try {
    enforceRateLimit(ctx, 60);
    const body = await readJsonBody(request);
    if (!isRecord(body)) {
      badRequest("Request body must be a JSON object.");
    }
    const parsed: ParsedPrompt = parseParsedPrompt(body.parsed);
    const weather: WeatherHour[] | null = parseWeather(body.weather);
    // the plan's zone — the hours filter checks the VENUE's local wall clock
    const timeZone = parseOptionalTimeZone(body.timeZone);
    // optional: re-search only a subset of categories (partial-failure
    // recovery + reroute), leaving the rest of the plan untouched — same
    // parameter searchPools already exposes to the reroute engine
    // the plan's ALREADY-RESOLVED start instant. A single-category
    // re-search (recovery's widen/replace, the weather override) would
    // otherwise re-resolve the time from that one category alone and land
    // on a different instant than the slot it's filling (code-audit §1.7).
    const targetTime = parseOptionalInstant(body.targetTime, "targetTime");
    const categoriesOverride = parseCategories(body.categoriesOverride);

    // observability at the resolution point (like [swap-apply]): what the
    // parse handed us, what instant it resolved to, and under which TZ —
    // a schedule anchored at a nonsense hour is visible right here
    let lateNight = false;
    {
      const cats = (categoriesOverride ?? parsed.category_signals ?? []).filter(
        (c): c is string => typeof c === "string" && c.trim() !== ""
      );
      const resolved =
        targetTime !== undefined
          ? new Date(targetTime)
          : resolveStartTime(parsed.time_window ?? "", new Date(), cats, timeZone);
      // late-night broadening kicks in when the PLAN's local hour is late —
      // judged in the plan's zone, like every other hour in the pipeline
      const localHour = wallClockParts(resolved, timeZone).hour;
      lateNight = localHour >= 21 || localHour < 5;
      logEvent("info", "schedule_resolved", {
        categoryCount: cats.length,
        timeZone: timeZone ?? "America/Toronto",
        resolved: resolved.toISOString(),
      });
    }

    // fixture seam: swap the DATA SOURCE only — the objective filter
    // below still runs for real over the fixture pools
    // a category whose search failed comes back as an empty pool plus a
    // drop entry saying so, instead of 500-ing the whole request (§6.1)
    const searchOut = { failures: [] as DropEntry[] };
    const rawPools = isMockMode()
      ? mockPools(categoriesOverride ?? parsed.category_signals ?? [], parsed)
      : await searchPools(
          requireServiceKey(process.env.GOOGLE_PLACES_API_KEY),
          parsed,
          categoriesOverride,
          searchOut,
          { lateNight }
        );
    const { pools, dropLog, weatherBlocked } = filterPools(
      rawPools,
      parsed,
      weather,
      new Date(),
      targetTime !== undefined ? new Date(targetTime) : undefined,
      timeZone
    );
    return apiJson(ctx, {
      ...pools,
      _dropLog: [...searchOut.failures, ...dropLog],
      _weatherBlocked: weatherBlocked,
    });
  } catch (err) {
    return apiError(ctx, err);
  }
}
