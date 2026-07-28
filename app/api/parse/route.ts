import { NextRequest } from "next/server";
import { isMockMode, mockPlan } from "../_mock/fixtures";
import {
  ApiError,
  apiError,
  apiJson,
  enforceRateLimit,
  isRecord,
  logEvent,
  readJsonBody,
  requestContext,
  requireServiceKey,
} from "../_shared/http";
import { fetchProvider, readProviderJson, requireProviderRecord } from "../_shared/provider";
import { withModelFallback } from "../_shared/modelFallback";
import { parsePlannerBody } from "../_shared/schemas";
import { DEFAULT_ZONE, normalizeZone } from "../../lib/zoneTime";
import { applyTimeFloors, buildPlannerMessages, planToParsed, planWithModel } from "./planner";

// The PLANNER step: natural-language prompt → the SHAPE of a day (which
// activities, how long, what to search for, what to ask about) plus the
// legacy ParsedPrompt the rest of the pipeline speaks.
//
// Same architecture as before — one Groq call, JSON out, validated in code —
// with a new system prompt, a new output schema, and one genuinely new input:
// the current instant in the plan's timezone. Every rule the planner proposes
// is checked in planner.ts before it can reach a user.
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

// the model is a PARAMETER now — withModelFallback picks it from the
// planner's chain and re-runs this whole call on the next entry if the
// current model is rate limited (models.ts explains why per call type)
async function callGroq(
  apiKey: string,
  messages: unknown[],
  model: string
): Promise<string> {
  const res = await fetchProvider("groq", GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
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
  return raw;
}

export async function POST(request: NextRequest) {
  const ctx = requestContext(request, "parse");
  try {
    // 120, not the 60 the extraction-era parse used: one PLAN can now cost
    // two calls to this route (the proposal, then the answered second pass),
    // so the same 60-plans-per-minute ceiling needs twice the request
    // budget. Still defense in depth — the real limiter is infrastructure
    // (DEPLOY.md), and every other route's burst allowance is unchanged.
    enforceRateLimit(ctx, 120);
    const body = parsePlannerBody(await readJsonBody(request));
    const { prompt } = body;
    const timeZone = normalizeZone(body.timeZone ?? DEFAULT_ZONE);
    const now = body.nowISO ? new Date(body.nowISO) : new Date();
    const messages = buildPlannerMessages(prompt, now, timeZone, {
      city: body.city,
      answers: body.answers,
    });

    // e2e fixture seam — deterministic planner, no Groq call, no key needed.
    // The seam replaces the DATA SOURCE only: the fixture's raw object still
    // goes through the production validator, and the deterministic time
    // floors still apply, because both are LOGIC.
    const apiKey = isMockMode() ? "" : requireServiceKey(process.env.GROQ_API_KEY);

    // The fallback wraps the ENTIRE planWithModel ladder, not the single
    // completion inside it: that ladder is a conversation (answer → "this was
    // invalid, here's why" → correction), and letting a correction land on a
    // different model than the answer it corrects would be a subtler bug than
    // the rate limit it was working around.
    const { plan: modelPlan, source, problems } = await withModelFallback(
      "planner",
      (model) =>
        planWithModel(
          messages,
          now,
          prompt,
          timeZone,
          // e2e fixture seam — deterministic planner, no Groq call, no key
          // needed. The seam replaces the DATA SOURCE only: the fixture's raw
          // object still goes through the production validator, and the
          // deterministic time floors still apply, because both are LOGIC.
          isMockMode()
            ? async () => JSON.stringify(mockPlan(prompt, now, timeZone, body.answers ?? []))
            : (msgs: unknown[]) => callGroq(apiKey, msgs, model)
        )
    );
    const plan = applyTimeFloors(modelPlan, prompt, now, timeZone);
    // Permanent observability at the resolution point, same spirit as
    // [swap-apply] and [reroute-apply]: which rung answered, what shape came
    // back, and — when a rung was rejected — exactly why.
    logEvent(source === "fallback" ? "error" : "info", "planner_plan", {
      source,
      activities: plan.activities.length,
      questions: plan.questions.length,
      timeKind: plan.timeIntent.kind,
      hasEnd: plan.timeIntent.endISO !== null,
      ...(problems.length > 0 ? { problems: problems.slice(0, 6) } : {}),
    });
    return apiJson(ctx, { plan, parsed: planToParsed(plan) });
  } catch (err) {
    return apiError(ctx, err);
  }
}
