// EVERY model decision lives here.
//
// The model id was hardcoded in three places — parse/route.ts,
// selectVenues.ts and swap.ts each declared their own
// `const MODEL = "llama-3.3-70b-versatile"`. Changing models meant editing
// three files and remembering all three existed.
//
// Each call type gets an ORDERED CHAIN rather than one id: a 429 or a
// provider-side 5xx on the primary is not one on the next model, because it
// is a different upstream serving it. That makes falling back genuinely
// different from retrying — a plain retry hits the same wall by definition.
//
// PROVIDER: OpenRouter (migrated 2026-08-15, transport only — same weights,
// same prompts). The ids below are OpenRouter's namespaced spellings of the
// exact models this pipeline was tuned on; `openai/gpt-oss-*` are the same
// strings Groq used, and the llama ids gained the `meta-llama/` prefix and
// the `-instruct` suffix.

/** The three semantic calls in the pipeline. Named for the job, not the file,
 *  because the reroute engine reaches select through a different route. */
export type CallType = "planner" | "select" | "swap";

/**
 * Why chains are PER CALL TYPE rather than one global list.
 *
 * The obvious reading is that this is over-engineering — one chain would be
 * fewer moving parts. The ORIGINAL reason was specific to Groq: limits were
 * per model, so giving swap a different PRIMARY meant swap traffic never
 * spent the planner's budget at all. Under OpenRouter that half is weaker —
 * account credit is shared across models, and a 429 is as likely to come from
 * the upstream serving one model as from the account — so DO NOT re-derive
 * this split from rate limits alone. What survives the provider change intact
 * is the task-fit argument below, which is what the split now rests on: swap
 * is a small classification job with deterministic parsers under it, and
 * running it on a 70B is paying judgment prices for a label.
 *
 * The tasks also differ enough to justify different primaries:
 *  - planner: the hardest job. Shapes the whole day, resolves time against a
 *    real clock, decides what to ask. Gets the strongest model.
 *  - select: hard, and quality is directly visible in the product — a bad
 *    pick is a bad night out. Same primary as the planner.
 *  - swap: a small classification job ("is this a time, duration, venue or
 *    constraint complaint?") that already has a deterministic floor beneath
 *    it — parseTimeExpr/parseDurationExpr own every number regardless of what
 *    the model says. A smaller, faster model is genuinely right here, and
 *    using one keeps the 70B budget for the two calls that need it.
 *
 * THE WEIGHTS BELOW ARE THE ONES THAT WERE PROBED, not new choices. The
 * original probe ran 2026-07-27 against Groq's live model list and the REAL
 * planner prompt (see the DEVLOG): every model here returned the planner's
 * exact contract shape in JSON mode and resolved "6-10pm" to the correct
 * 18:00→22:00 instants. Two candidates were REJECTED by that probe and are
 * deliberately absent: `qwen/qwen3.6-27b` failed JSON validation
 * (`json_validate_failed`, empty generation), and `groq/compound-mini` is an
 * agentic tool-using system rather than a plain completion model. A chain
 * entry that cannot hold the contract is worse than a shorter chain.
 *
 * THE 2026-08-15 MIGRATION CHANGED THE SPELLING, NOT THE MODEL. Nothing here
 * was re-picked; each id is the same weights under OpenRouter's namespace.
 * Never pick a NEW chain model from memory: probe
 * `GET https://openrouter.ai/api/v1/models` and run the candidate against the
 * real system prompt in JSON mode first.
 */
const DEFAULT_CHAINS: Record<CallType, readonly string[]> = {
  // 70B first for judgment; gpt-oss-120b is the closest peer that answered
  // when 70B was rate-limited during that change; 20b is the last resort
  // that still produced the full contract.
  planner: [
    "meta-llama/llama-3.3-70b-instruct",
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
  ],
  select: [
    "meta-llama/llama-3.3-70b-instruct",
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
  ],
  // 8b answered this shape in 0.35s — a third of the time of the
  // alternatives — and the deterministic parsers outrank its numbers anyway.
  // 70B sits at the END as the quality backstop, not the default.
  swap: [
    "meta-llama/llama-3.1-8b-instruct",
    "openai/gpt-oss-20b",
    "meta-llama/llama-3.3-70b-instruct",
  ],
};

/** Env var per call type, so a chain can change on the host without a
 *  deploy — the failure this guards against is one you discover in
 *  production, at which point waiting for a build is the wrong shape. */
const ENV_VAR: Record<CallType, string> = {
  planner: "OPENROUTER_MODELS_PLANNER",
  select: "OPENROUTER_MODELS_SELECT",
  swap: "OPENROUTER_MODELS_SWAP",
};

/** Comma-separated ids; blanks and stray whitespace tolerated because this is
 *  hand-edited in a hosting dashboard, not generated. */
function parseChain(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

/**
 * The ordered model chain for a call type. Env override wins entirely when it
 * yields at least one id; an unset or all-blank value falls back to the
 * defaults rather than leaving a call type with no model at all.
 */
export function modelChain(call: CallType): string[] {
  const override = parseChain(process.env[ENV_VAR[call]]);
  return override.length > 0 ? override : [...DEFAULT_CHAINS[call]];
}

/** The model a call type uses when nothing has gone wrong. Exported for
 *  logging and tests; the chain is what actually drives the call. */
export function primaryModel(call: CallType): string {
  return modelChain(call)[0];
}

/** Read-only view of the built-in defaults, for tests that assert the
 *  override beat them rather than coincidentally matched them. */
export const BUILT_IN_CHAINS = DEFAULT_CHAINS;
