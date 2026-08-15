import { NextRequest } from "next/server";
import { ParsedPrompt, Place } from "../places/search/filter";
import { SelectParseError, selectModelCall, selectVenues } from "./selectVenues";
import { withModelFallback } from "../_shared/modelFallback";
import { isMockMode, mockSelectModelResponse } from "../_mock/fixtures";
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
import {
  parseParsedPrompt,
  parsePools,
  parseSlots,
  parseSlotEstimates,
} from "../_shared/schemas";

// Thin wrapper over selectVenues (shared with the reroute engine).
export async function POST(request: NextRequest) {
  const ctx = requestContext(request, "select");
  try {
    enforceRateLimit(ctx, 60);
    const body = await readJsonBody(request);
    if (!isRecord(body)) {
      throw new ApiError(400, "invalid_request", "Request body must be a JSON object.");
    }
    const parsed: ParsedPrompt = parseParsedPrompt(body.parsed);
    const poolsIn: Record<string, Place[]> = parsePools(body.pools);
    // the requested stops in order, duplicates intact — a repeated category
    // is two stops sharing one pool, not one stop (code-audit §7.1)
    const slots = parseSlots(body.slots);
    // the planner's per-slot duration estimates (index-aligned with slots);
    // absent for callers that never saw a planner
    const estimates = parseSlotEstimates(body.plannedMinutes, slots?.length);

    // Fixture seam replaces the model completion only. Slot validation,
    // constraint enforcement, correction, and global assignment below are
    // the same production core used outside mock mode.
    if (isMockMode()) {
      const selections = await selectVenues(
        "",
        parsed,
        poolsIn,
        slots,
        mockSelectModelResponse,
        estimates
      );
      return apiJson(ctx, { selections });
    }
    const apiKey = requireServiceKey(process.env.OPENROUTER_API_KEY);
    // one logical call = the whole selectVenues ladder (invalid ids → one
    // correction → deterministic fallback) on ONE model; the chain advances
    // only when a model is rate limited
    const selections = await withModelFallback("select", (model) =>
      selectVenues(apiKey, parsed, poolsIn, slots, selectModelCall(apiKey, model), estimates)
    );
    return apiJson(ctx, { selections });
  } catch (err) {
    if (err instanceof SelectParseError) {
      return apiError(
        ctx,
        new ApiError(
          502,
          "selection_invalid_response",
          "Couldn't pick venues for that just now — try again?"
        )
      );
    }
    return apiError(ctx, err);
  }
}
