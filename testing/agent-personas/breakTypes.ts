// Shared vocabulary for the BREAK persona set (testing/agent-personas/breakPersonas.ts).
//
// This set exists to try to BREAK the app, not use it normally: hostile input,
// out-of-order and concurrent operations, the exact numeric edges of real
// guardrails, malformed requests sent straight to the API, bounded rate-limit
// probing, and re-validation of the R1 ownership work. It runs in the SAME
// harness (same recorder, same report, same cost guard, same batching pool) as
// the ordinary 51-persona set, and is STRICTLY GUEST throughout — no persona
// here needs a signed-in session.
//
// TWO kinds of persona share one runnable list:
//   - BROWSER personas are ordinary `Persona`s (types.ts). They reuse the
//     existing `runPersona`, its actions, and every mechanism unchanged. Two
//     new actions were added to `Persona` for the break scenarios that the
//     existing actions could not express — `concurrentMutations` and
//     `crossSessionAccessDenied` — both additive; the 51-persona set uses
//     neither and is untouched.
//   - API personas (`ApiPersona`, below) are driven by a NEW, lightweight
//     fetch-based runner (`lib/runApiPersona.ts`). No browser, no page, no
//     navigation — just raw HTTP straight at the API routes, testing that
//     SERVER-SIDE validation rejects what it should independent of whatever a
//     real browser would ever send. They reuse the Recorder and the report
//     mechanism as-is (a `CheckRecord`/`PersonaResult` needs no page).
//
// NOTHING here is imported by the application, exactly like the rest of this
// directory: it drives the REAL deployed app from the outside and must never
// become a dependency of `app/`.

import type { Persona } from "./types";
import { COST_PER_CALL_USD, estimatePersonaCostUSD } from "./config";
import { personaActionCounts } from "./personas";

export type HttpMethod = "GET" | "POST";

/** A hard ceiling on any single burst, so a rate-limit probe can never turn
 *  into an actual attempt to exhaust anything. See CATEGORY 5 in the README:
 *  the goal is confirming graceful degradation EXISTS, bounded small, never
 *  stress-testing at a scale that risks real cost or resembles a DoS. */
export const MAX_BURST_REQUESTS = 45;

/** The most real PLANS any one resource-exhaustion persona may create, so the
 *  bounded-plan-creation case cannot spend beyond a few dollars. */
export const MAX_REAL_PLANS_PER_PERSONA = 5;

interface ApiStepBase {
  /** Report label / step name (kebab-ish, unique within the persona). */
  step: string;
  /** What the app SHOULD do, in words, for the report. */
  expected: string;
  /** Path relative to the base URL, e.g. "/api/parse". A `<newid>` token is
   *  replaced with a fresh syntactically-valid-but-nonexistent id at run time,
   *  so a nonexistent-plan probe never depends on a hardcoded id. */
  path: string;
  method: HttpMethod;
  /** Sent as `JSON.stringify(json)` with an application/json content type.
   *  Use for well-formed-JSON-but-wrong-shape bodies. */
  json?: unknown;
  /** Sent VERBATIM as the request body, no stringify, no content type unless
   *  one is given in `headers`. Use for invalid-JSON and oversized-body tests. */
  rawBody?: string;
  /** Merged over the runner's defaults. Use to omit/override content type,
   *  spoof content-length, or attach a forged Authorization header. */
  headers?: Record<string, string>;
}

/** One malformed / boundary request, fired once. */
export interface ApiSingleStep extends ApiStepBase {
  kind?: "single";
  /** The response must be one of these statuses. When omitted, the default
   *  bar is `expectClientError`. */
  expectStatusIn?: number[];
  /** Convenience: the response must be a 4xx (never a 5xx, never a 2xx). The
   *  default assertion for a malformed request when no explicit status set is
   *  given. */
  expectClientError?: boolean;
  /** When given, the JSON error body's `code` must equal this. */
  expectCode?: string;
}

/**
 * A BOUNDED burst of identical requests, for the rate-limit personas.
 *
 * `count` is clamped to `MAX_BURST_REQUESTS` by the runner. The requests are
 * cheap by construction — they trip the per-route rate bucket (which is
 * incremented BEFORE body parsing or any provider call), so most answer the
 * route's ordinary rejection until the limiter engages, then 429. The bar:
 * NO request 5xx's, and every rate-limited response carries the app's own
 * "Too many requests" message and a Retry-After header. If the bounded burst
 * is too small to trip the limit, that is recorded, not failed — the point is
 * that graceful degradation EXISTS, not that we exhaust the limiter.
 */
export interface ApiBurstStep extends ApiStepBase {
  kind: "burst";
  count: number;
}

export type ApiStep = ApiSingleStep | ApiBurstStep;

export interface ApiPersona {
  kind: "api";
  name: string;
  intent: string;
  /** Always false — the whole break set is strictly guest. Present for report
   *  symmetry with the browser `Persona`. */
  signedIn: false;
  steps: ApiStep[];
  /** Cross-cutting notes recorded once at the end, like `Persona.expectations`. */
  expectations?: string[];
}

/** The break set is a mix of ordinary browser personas and API personas. */
export type BreakPersona = Persona | ApiPersona;

export function isApiPersona(persona: BreakPersona): persona is ApiPersona {
  return persona.kind === "api";
}

export interface BreakCounts {
  browserPersonas: number;
  apiPersonas: number;
  plans: number;
  swaps: number;
  removes: number;
  modeSwitches: number;
  pageLoads: number;
  /** Total single requests + clamped burst requests across API personas. */
  apiRequests: number;
  /** Concurrent-mutation ops across browser personas (each is a real swap /
   *  remove / mode switch and is folded into those counts too). */
  concurrentOps: number;
}

/**
 * Count what a break run will actually do, for the cost warning and the
 * pre-flight summary. Browser personas reuse the ordinary
 * `personaActionCounts`; on top of it, `concurrentMutations` ops are counted
 * as the real swaps/removes/mode-switches they are. API personas add only
 * requests, which are near-zero cost (rejected before any provider call).
 */
export function breakActionCounts(personas: BreakPersona[]): BreakCounts {
  const browser = personas.filter((p): p is Persona => !isApiPersona(p));
  const api = personas.filter(isApiPersona);

  const base = personaActionCounts(browser);
  let swaps = base.swaps;
  let removes = base.removes;
  let modeSwitches = base.modeSwitches;
  let concurrentOps = 0;

  for (const persona of browser) {
    for (const action of persona.actions) {
      if (action.kind === "concurrentMutations") {
        for (const op of action.ops) {
          concurrentOps++;
          if (op.op === "swap") swaps++;
          else if (op.op === "remove") removes++;
          else if (op.op === "mode") modeSwitches++;
        }
      }
    }
  }

  let apiRequests = 0;
  for (const persona of api) {
    for (const step of persona.steps) {
      apiRequests += step.kind === "burst" ? Math.min(step.count, MAX_BURST_REQUESTS) : 1;
    }
  }

  return {
    browserPersonas: browser.length,
    apiPersonas: api.length,
    plans: base.plans,
    swaps,
    removes,
    modeSwitches,
    pageLoads: base.pageLoads,
    apiRequests,
    concurrentOps,
  };
}

/**
 * Rough cost of a break run. Browser personas dominate (real plans, real
 * mutations); API personas are counted at a token cost because they are
 * rejected at validation or by the rate limiter BEFORE any provider call, so
 * they spend essentially nothing. Deliberately an upper bound, like the
 * ordinary set's estimate: many break personas exist precisely to be refused,
 * and a refused plan never reaches Places or Routes.
 */
export function estimateBreakCostUSD(personas: BreakPersona[]): number {
  const counts = breakActionCounts(personas);
  const browserCost = estimatePersonaCostUSD({
    plans: counts.plans,
    swaps: counts.swaps,
    removes: counts.removes,
    modeSwitches: counts.modeSwitches,
    pageLoads: counts.pageLoads,
  });
  // A tiny nominal for the API requests: a 400/404/429 costs nothing on the
  // provider side, but the map-load-equivalent request overhead is real.
  const apiCost = counts.apiRequests * COST_PER_CALL_USD.geocode * 0.05;
  return browserCost + apiCost;
}
