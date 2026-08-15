// THE OpenRouter completion request. One endpoint, one body builder, three
// callers (parse, select, swap).
//
// Why this is a module rather than three literals: the model id used to be
// declared three times and models.ts exists because that drifted. The request
// BODY now carries the same hazard, because its `provider` block stopped being
// cosmetic when the provider changed — `require_parameters` is what keeps JSON
// mode real, `sort` is what keeps the answer fast enough to arrive before the
// browser gives up, and a missing `reasoning` policy is what keeps reasoning
// tokens out of the text every parser here reads. A fourth call site that
// forgets any of them fails in a way that looks like a model problem.

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
 * Byte-identical to the Groq-era body except for `provider` and `reasoning`
 * below; OpenRouter takes `messages`, `response_format: {type:"json_object"}`
 * and `temperature: 0` verbatim and returns `choices[0].message.content` the
 * same way, which is what made this migration a transport swap rather than a
 * rewrite. Everything added here is ROUTING — which endpoint serves the
 * request — and none of it changes what the model is asked or what comes back.
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
 * GOTCHA 2 — `provider.sort: "throughput"` decides HOW FAST the answer comes
 * back, and without it the default is price-weighted.
 * OpenRouter's default routing optimises for price among the compliant
 * endpoints, and "cheapest" and "usable" are not the same question when a
 * human is waiting. Measured live on this pipeline: a
 * `meta-llama/llama-3.3-70b-instruct` planner call was routed to an endpoint
 * generating at 8.9 tokens/sec, which made one plan take ~21s. OpenRouter's own
 * activity breakdown put routing at 59ms — nothing was wrong with the model,
 * the chain, the body or the JSON; the request simply landed on a slow serving
 * endpoint. 21s is past `DEFAULT_CLIENT_FETCH_TIMEOUT_MS`, so the user saw a
 * client timeout for a request the server would have completed.
 * `sort: "throughput"` (documented as equivalent to the `:nitro` suffix) orders
 * routing by generation speed instead, which composes with gotcha 1 exactly the
 * way it needs to: require_parameters filters the candidate endpoints down to
 * the ones that genuinely support every parameter sent, and `sort` picks the
 * FASTEST of what survives. Fastest COMPLIANT endpoint, never fastest outright.
 *
 * DELIBERATELY NOT `order: ["<provider>"]`. Pinning a provider names something
 * that is not ours: providers serve different subsets of models, so a pin
 * hard-couples the request body to today's chain and breaks silently the day
 * models.ts changes — the exact drift models.ts exists to prevent, one file
 * over. `sort` and `max_price` name no provider and no model; they express
 * "fastest compliant endpoint under a price ceiling" for WHATEVER chain is in
 * force, including an env-overridden one this file has never heard of.
 *
 * GOTCHA 3 — `max_price` is the ceiling that throughput-sorting removed.
 * Sorting by throughput takes price OUT of the ordering entirely, so nothing
 * would stop routing at a fast-but-premium endpoint. This puts a bound back,
 * as USD per MILLION tokens. The numbers come from probing every serving
 * endpoint of every chain model (`GET /api/v1/models/{id}/endpoints`,
 * 2026-08-15) rather than from the blended per-model figure, because per
 * ENDPOINT is what this filters on: across all four chain models the most
 * expensive endpoint was $1.04/M prompt (Together, llama-3.3-70b) and $2.253/M
 * completion (Cloudflare, same model). So the obvious round $2 would have
 * SILENTLY DROPPED a legitimate endpoint — the trap this constant sets for its
 * next reader. 5/10 clears every endpoint in the chain by ~4.5x while still
 * refusing anything in frontier-model price territory, which is the surprise
 * worth failing a request over. Raise it, don't delete it, if a probe ever
 * shows a legitimate endpoint above the ceiling.
 *
 * GOTCHA 4 — `reasoning` is sent ONLY to models that mandate it, because
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
    // Routing policy, model-agnostic by construction — see gotchas 1-3.
    // Read as one sentence: the FASTEST endpoint, among those that support
    // every parameter we send, that does not charge a premium price.
    provider: {
      require_parameters: true,
      sort: "throughput",
      max_price: { prompt: 5, completion: 10 },
    },
    ...(REASONING_MANDATORY.test(model)
      ? { reasoning: { effort: "low", exclude: true } }
      : {}),
  });
}
