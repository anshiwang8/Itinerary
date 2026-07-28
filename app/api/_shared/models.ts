// EVERY model decision lives here.
//
// The model id was hardcoded in three places — parse/route.ts,
// selectVenues.ts and swap.ts each declared their own
// `const MODEL = "llama-3.3-70b-versatile"`. Changing models meant editing
// three files and remembering all three existed.
//
// Each call type gets an ORDERED CHAIN rather than one id: Groq rate-limits
// PER MODEL, so a 429 on the primary is not a 429 on the next one. That makes
// falling back genuinely different from retrying — a plain retry hits the
// same wall by definition.

/** The three semantic calls in the pipeline. Named for the job, not the file,
 *  because the reroute engine reaches select through a different route. */
export type CallType = "planner" | "select" | "swap";

/**
 * Why chains are PER CALL TYPE rather than one global list.
 *
 * The obvious reading is that this is over-engineering — one chain would be
 * fewer moving parts. It earns its keep for a reason specific to Groq: limits
 * are per model, so giving swap a different PRIMARY means swap traffic never
 * spends the planner's budget at all. Under the load that actually causes
 * this problem (someone re-planning and swapping repeatedly), a single shared
 * chain would have swaps pushing the planner toward its limit — the exact
 * failure this change exists to prevent.
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
 * MODEL CHOICES ARE FROM GROQ'S LIVE MODEL LIST, PROBED AGAINST THE REAL
 * PLANNER PROMPT — not from memory. Verified 2026-07-27 (see the DEVLOG):
 * every id below returned the planner's exact contract shape in JSON mode and
 * resolved "6-10pm" to the correct 18:00→22:00 instants. Two candidates were
 * REJECTED by that probe and are deliberately absent: `qwen/qwen3.6-27b`
 * fails Groq's own JSON validation (`json_validate_failed`, empty
 * generation), and `groq/compound-mini` is an agentic tool-using system
 * rather than a plain completion model. A chain entry that cannot hold the
 * contract is worse than a shorter chain.
 */
const DEFAULT_CHAINS: Record<CallType, readonly string[]> = {
  // 70B first for judgment; gpt-oss-120b is the closest peer that answered
  // when 70B was rate-limited during this very change; 20b is the last resort
  // that still produced the full contract.
  planner: ["llama-3.3-70b-versatile", "openai/gpt-oss-120b", "openai/gpt-oss-20b"],
  select: ["llama-3.3-70b-versatile", "openai/gpt-oss-120b", "openai/gpt-oss-20b"],
  // 8b-instant answered this shape in 0.35s — a third of the time of the
  // alternatives — and the deterministic parsers outrank its numbers anyway.
  // 70B sits at the END as the quality backstop, not the default.
  swap: ["llama-3.1-8b-instant", "openai/gpt-oss-20b", "llama-3.3-70b-versatile"],
};

/** Env var per call type, so a chain can change on the host without a
 *  deploy — the failure this guards against is one you discover in
 *  production, at which point waiting for a build is the wrong shape. */
const ENV_VAR: Record<CallType, string> = {
  planner: "GROQ_MODELS_PLANNER",
  select: "GROQ_MODELS_SELECT",
  swap: "GROQ_MODELS_SWAP",
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
