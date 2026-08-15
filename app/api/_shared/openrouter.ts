// THE OpenRouter completion request. One endpoint, one body builder, three
// callers (parse, select, swap).
//
// Why this is a module rather than three literals: the model id used to be
// declared three times and models.ts exists because that drifted. The request
// BODY now carries the same hazard, because two of its fields stopped being
// cosmetic when the provider changed — `provider.require_parameters` is what
// keeps JSON mode real, and a missing `reasoning` policy is what keeps
// reasoning tokens out of the text every parser here reads. A third call site
// that forgets either one fails in a way that looks like a model problem.

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/**
 * Models that emit reasoning tokens whether or not anyone asked
 * (`reasoning.mandatory` on OpenRouter). Today that is the gpt-oss family,
 * which sits at positions 2 and 3 of the planner/select chains and 2 of the
 * swap chain. A chain entry added by env override is NOT known here — see the
 * note on `reasoning` below for what that costs.
 */
const REASONING_MANDATORY = /gpt-oss/;

/**
 * The body for one chat completion.
 *
 * Byte-identical to the Groq-era body except for the two fields below;
 * OpenRouter takes `messages`, `response_format: {type:"json_object"}` and
 * `temperature: 0` verbatim and returns `choices[0].message.content` the same
 * way, which is what made this migration a transport swap rather than a
 * rewrite.
 *
 * GOTCHA 1 — `provider.require_parameters` is the JSON-mode safety net, and
 * it is MANDATORY.
 * OpenRouter resolves a model id to one of several SERVING ENDPOINTS, and
 * `response_format` support is a property of the ENDPOINT, not of the model.
 * An endpoint that does not support it does not reject the request:
 * OpenRouter SILENTLY DROPS `response_format` and the model replies in prose.
 * Every parser downstream reads that as malformed output, at a rate that
 * depends on which endpoint routing happened to pick — a failure with no
 * cause anywhere in this repo. `require_parameters: true` restricts routing to
 * endpoints supporting every parameter in the request, so "no compliant
 * endpoint" surfaces as a 5xx instead, and a 5xx is precisely what
 * `withModelFallback` advances the chain on.
 *
 * GOTCHA 2 — `reasoning` is sent ONLY to models that mandate it, because
 * require_parameters cuts both ways.
 * The gpt-oss chain entries emit reasoning tokens before answering, so asking
 * for `{ effort: "low", exclude: true }` buys two things: less latency spent
 * thinking, and reasoning kept OUT of `message.content`, which is the string
 * `JSON.parse` runs on at all three call sites. But `require_parameters` also
 * filters on THIS parameter, and `meta-llama/llama-3.3-70b-instruct` is not a
 * reasoning model — sending `reasoning` with it would ask routing for
 * endpoints advertising support for a parameter the model does not have, and
 * an over-filtered request has no endpoints at all. So the gate is the model,
 * not the call site. An env-overridden chain that names some other
 * reasoning-mandatory model simply does not get the `exclude` hint: it still
 * works, and its reasoning still lands in `message.reasoning` rather than
 * `content` under OpenRouter's normalization — the leak that would break the
 * parsers is a LIVE-PROBE item, not something this code can assert.
 */
export function chatCompletionBody(model: string, messages: unknown[]): string {
  return JSON.stringify({
    model,
    messages,
    // Belt and braces: the system prompts demand bare JSON, and
    // response_format guarantees the model can't wrap it in prose.
    response_format: { type: "json_object" },
    temperature: 0,
    provider: { require_parameters: true },
    ...(REASONING_MANDATORY.test(model)
      ? { reasoning: { effort: "low", exclude: true } }
      : {}),
  });
}
