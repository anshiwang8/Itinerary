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
import { OPENROUTER_URL, chatCompletionBody } from "../_shared/openrouter";
import { withModelFallback } from "../_shared/modelFallback";
import { parsePlannerBody } from "../_shared/schemas";
import { verifyCaller } from "../_shared/caller";
import { readTasteProfile } from "../profile/profileStore";
import { toPlannerPreferences, type PlannerPreferences } from "./plannerPreferences";
import { DEFAULT_ZONE, normalizeZone } from "../../lib/zoneTime";
import {
  applyTimeFloors,
  buildPlannerMessages,
  planToParsed,
  planWithModel,
  stripLeakedPreferenceConstraints,
} from "./planner";

// The PLANNER step: natural-language prompt → the SHAPE of a day (which
// activities, how long, what to search for, what to ask about) plus the
// legacy ParsedPrompt the rest of the pipeline speaks.
//
// Same architecture as before — one model call, JSON out, validated in code —
// with a new system prompt, a new output schema, and one genuinely new input:
// the current instant in the plan's timezone. Every rule the planner proposes
// is checked in planner.ts before it can reach a user.

/**
 * Stage 3B — the caller's stored taste, or nothing.
 *
 * THE UID IS THE VERIFIED ONE OR THERE ISN'T ONE. This route has never known
 * about auth before, and what it learns here is deliberately minimal: it reads
 * a profile for the uid inside a signed token and has no other way to name a
 * user. There is no `?uid=`, nothing in the body is consulted, and a caller who
 * sends someone else's uid is simply a caller with no identity.
 *
 * ANONYMOUS CALLERS SKIP THE READ, and that is a cost decision rather than a
 * second safety gate: `/api/profile` refuses the WRITE for a guest, so a
 * guest's profile is empty by construction and the query has a known answer.
 * The history reader declines to double-gate for exactly that reason — the
 * difference here is that this one sits on the planning hot path, and a
 * Firestore round-trip with a known-empty result is latency every guest (and
 * every mock-e2e request) would pay for nothing.
 *
 * NOTHING HERE CAN FAIL A PLAN. `verifyCaller` returns null for a missing,
 * unverifiable or uncheckable token, `readTasteProfile` never throws and
 * reports a broken query as no profile, and `toPlannerPreferences` maps every
 * one of those to null — which the planner treats as "no preferences were
 * mentioned". A person's dinner does not fail because a profile lookup did.
 */
async function callerPreferences(
  request: NextRequest,
  prompt: string
): Promise<PlannerPreferences | null> {
  const caller = await verifyCaller(request);
  if (!caller || caller.isAnonymous) return null;
  const { profile } = await readTasteProfile(caller.uid);
  return toPlannerPreferences(profile, prompt);
}

// the model is a PARAMETER now — withModelFallback picks it from the
// planner's chain and re-runs this whole call on the next entry if the
// current model is rate limited (models.ts explains why per call type)
async function callModel(
  apiKey: string,
  messages: unknown[],
  model: string
): Promise<string> {
  const res = await fetchProvider("openrouter", OPENROUTER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: chatCompletionBody(model, messages),
    cache: "no-store",
  });
  const data = requireProviderRecord("openrouter", await readProviderJson("openrouter", res));
  const choices = data.choices;
  const first = Array.isArray(choices) ? choices[0] : undefined;
  const message = isRecord(first) ? first.message : undefined;
  const raw = isRecord(message) ? message.content : undefined;
  if (typeof raw !== "string" || raw.length > 50_000) {
    throw new ApiError(
      502,
      "openrouter_invalid_response",
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
    // Stage 3B. Both passes get it: an answered second pass is still this
    // person's plan, and the preferences are the same background for it.
    const preferences = await callerPreferences(request, prompt);
    const messages = buildPlannerMessages(prompt, now, timeZone, {
      city: body.city,
      answers: body.answers,
      preferences,
    });

    // e2e fixture seam — deterministic planner, no model call, no key needed.
    // The seam replaces the DATA SOURCE only: the fixture's raw object still
    // goes through the production validator, and the deterministic time
    // floors still apply, because both are LOGIC.
    const apiKey = isMockMode() ? "" : requireServiceKey(process.env.OPENROUTER_API_KEY);

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
          // e2e fixture seam — deterministic planner, no model call, no key
          // needed. The seam replaces the DATA SOURCE only: the fixture's raw
          // object still goes through the production validator, and the
          // deterministic time floors still apply, because both are LOGIC.
          isMockMode()
            ? async () => JSON.stringify(mockPlan(prompt, now, timeZone, body.answers ?? []))
            : (msgs: unknown[]) => callModel(apiKey, msgs, model)
        )
    );
    // Two floors over the model's answer, both correcting facts it does not
    // get to be wrong about: the time floors, then the preference-leak strip.
    // The strip is a no-op (same object) for every caller with no activity
    // preference, which is every guest and every mock e2e run.
    const timed = applyTimeFloors(modelPlan, prompt, now, timeZone);
    const plan = stripLeakedPreferenceConstraints(timed, preferences);
    const strippedConstraints =
      timed.context.constraints.length - plan.context.constraints.length;
    // Permanent observability at the resolution point, same spirit as
    // [swap-apply] and [reroute-apply]: which rung answered, what shape came
    // back, and — when a rung was rejected — exactly why.
    logEvent(source === "fallback" ? "error" : "info", "planner_plan", {
      source,
      activities: plan.activities.length,
      questions: plan.questions.length,
      timeKind: plan.timeIntent.kind,
      hasEnd: plan.timeIntent.endISO !== null,
      // WHETHER a profile shaped this plan, never WHICH preferences did. The
      // owner needs to tell a personalized plan from an ordinary one while
      // tuning; a log line naming someone's dietary restriction is a different
      // thing entirely, and this file is not where that gets written down.
      personalized: preferences !== null,
      // HOW MANY leaked preference constraints code had to remove, never WHICH
      // — a count is the tuning signal (the prompt half of that guard is
      // wording, and wording drifts between models), and a count names nobody's
      // taste. Omitted entirely when the strip did nothing, which is the
      // ordinary case.
      ...(strippedConstraints > 0 ? { strippedConstraints } : {}),
      ...(problems.length > 0 ? { problems: problems.slice(0, 6) } : {}),
    });
    return apiJson(ctx, { plan, parsed: planToParsed(plan) });
  } catch (err) {
    return apiError(ctx, err);
  }
}
