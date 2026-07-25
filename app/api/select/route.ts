import { NextRequest } from "next/server";
import { ParsedPrompt, Place } from "../places/search/filter";
import { SelectParseError, selectVenues } from "./selectVenues";
import { isMockMode, mockSelect } from "../_mock/fixtures";
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
import { parseParsedPrompt, parsePools, parseSlots } from "../_shared/schemas";

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

    // fixture seam: deterministic highest-rated pick, no Groq call
    if (isMockMode()) {
      return apiJson(ctx, { selections: mockSelect(parsed, poolsIn, slots) });
    }
    const apiKey = requireServiceKey(process.env.GROQ_API_KEY);
    const selections = await selectVenues(apiKey, parsed, poolsIn, slots);
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
