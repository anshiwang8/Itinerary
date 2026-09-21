// One API persona, start to finish — the BREAK set's lightweight execution
// path.
//
// This is deliberately NOT the browser runner. It launches no browser, opens
// no page, renders nothing: it sends raw HTTP straight at the API routes with
// Node's global `fetch`, so it tests that SERVER-SIDE validation rejects what
// it should independent of whatever a real browser would ever let through.
// Browser-driven break personas still go through `runPersona` unchanged; only
// the direct-API personas come here, so the existing personas pay no browser
// overhead they don't need.
//
// It REUSES the shared mechanisms rather than forking them: the `Recorder` is
// the same expected-vs-actual ledger (its `record()` needs no page), and the
// result it returns is an ordinary `PersonaResult` the same `writeReport`
// consumes. What it does NOT reuse is the per-persona interpreter — an API
// persona has no actions, no plan on screen, no movement, so `runPersona`'s
// machinery does not apply to it.
//
// The whole set is guest and every request here is either malformed (rejected
// at validation, before any provider call) or a bounded rate-limit probe
// (rejected by the limiter, before any provider call), so an API persona
// spends essentially nothing.

import path from "node:path";
import { randomUUID } from "node:crypto";
import { Recorder } from "./recorder";
import {
  MAX_BURST_REQUESTS,
  type ApiBurstStep,
  type ApiPersona,
  type ApiSingleStep,
  type ApiStep,
} from "../breakTypes";
import type { RunOptions } from "../config";
import type { PersonaResult } from "../types";

/**
 * Signatures of a RAW failure in a response body — the app breaking rather
 * than answering. The app's own error envelope (`{ error, code, requestId }`)
 * matches none of these; a framework crash page, a stack trace, or a value
 * that escaped its formatter does. Mirrors the browser runner's own list.
 */
const RAW_ERROR_SIGNATURES = [
  /<!DOCTYPE html>/i,
  /Internal Server Error/i,
  /\b(?:Type|Reference|Syntax|Range)Error\b/,
  /Cannot read propert(?:y|ies)/i,
  /\bat .+\(.+:\d+:\d+\)/, // a stack frame
  /\[object Object\]/,
];

interface RequestOutcome {
  status: number | null;
  bodyText: string;
  json: unknown;
  jsonOk: boolean;
  retryAfter: string | null;
  rawFailure: string | null;
  transportError: string | null;
}

/** A syntactically-valid itinerary id that does not exist — matches the
 *  routes' `^[A-Za-z0-9-]{1,128}$` so it clears the id-shape check and lands
 *  on the genuine not-found path, never the invalid-id one. */
function freshNonexistentId(): string {
  return "brk-" + randomUUID().replace(/-/g, "");
}

async function fireOnce(
  baseURL: string,
  step: ApiStep,
  timeoutMs = 45_000
): Promise<RequestOutcome> {
  const url = baseURL + step.path.replace(/<newid>/g, freshNonexistentId());
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (step.rawBody !== undefined) {
    body = step.rawBody;
  } else if (step.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(step.json);
  }
  Object.assign(headers, step.headers ?? {});

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: step.method,
      headers,
      body: step.method === "GET" ? undefined : body,
      signal: controller.signal,
    });
    const bodyText = await response.text().catch(() => "");
    let json: unknown = null;
    let jsonOk = false;
    if (bodyText.trim() === "") {
      jsonOk = true; // an empty body is not a raw crash page
    } else {
      try {
        json = JSON.parse(bodyText);
        jsonOk = true;
      } catch {
        jsonOk = false;
      }
    }
    const rawFailure =
      RAW_ERROR_SIGNATURES.map((re) => re.exec(bodyText)).find(Boolean)?.[0] ?? null;
    return {
      status: response.status,
      bodyText,
      json,
      jsonOk,
      retryAfter: response.headers.get("retry-after"),
      rawFailure,
      transportError: null,
    };
  } catch (error) {
    return {
      status: null,
      bodyText: "",
      json: null,
      jsonOk: false,
      retryAfter: null,
      rawFailure: null,
      transportError: String(error).slice(0, 200),
    };
  } finally {
    clearTimeout(timer);
  }
}

function codeOf(json: unknown): string | null {
  if (json && typeof json === "object" && "code" in json) {
    const code = (json as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

function messageOf(json: unknown): string {
  if (json && typeof json === "object" && "error" in json) {
    const error = (json as { error?: unknown }).error;
    if (typeof error === "string") return error;
  }
  return "";
}

export async function runApiPersona(
  persona: ApiPersona,
  run: RunOptions,
  reportDir: string
): Promise<PersonaResult> {
  const startedAt = new Date();
  const recorder = new Recorder(persona.name, path.join(reportDir, persona.name), reportDir);
  const deadline = Date.now() + run.personaTimeoutMs;

  for (const step of persona.steps) {
    if (Date.now() > deadline) {
      recorder.record({
        step: "persona_timeout",
        expected: "every step completes inside the per-persona budget",
        actual: "the budget ran out before step `" + step.step + "`",
        pass: false,
      });
      break;
    }
    if (step.kind === "burst") {
      await runBurst(step, run, recorder);
    } else {
      await runSingle(step, run, recorder);
    }
  }

  if (persona.expectations) {
    for (const expectation of persona.expectations) {
      recorder.record({
        step: "persona_expectation",
        expected: expectation,
        actual: "recorded; see this persona's individual checks above",
        pass: true,
      });
    }
  }

  return {
    persona: persona.name,
    intent: persona.intent,
    signedIn: false,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    checks: recorder.checks,
    timedOut: Date.now() > deadline,
    consoleErrors: recorder.consoleErrors,
    networkErrors: recorder.networkErrors,
    planIds: [],
  };
}

async function runSingle(
  step: ApiSingleStep,
  run: RunOptions,
  recorder: Recorder
): Promise<void> {
  const outcome = await fireOnce(run.baseURL, step);

  // The floor every request must clear: it completed and was not a 5xx.
  const noServerError = outcome.status !== null && outcome.status < 500;

  // The app's OWN routes answer with a structured JSON error envelope, so a
  // malformed request to one must come back as JSON with nothing raw leaked.
  // The exception is a FRAMEWORK-level status (an unknown route's 404, a
  // wrong-method 405): Next may answer those with its own HTML page, which is
  // correct, not a crash. A step that pins only `expectStatusIn` (no
  // `expectCode`) is declaring exactly those acceptable statuses, so the
  // JSON-envelope requirement is relaxed for it — but never the no-5xx floor.
  const requireEnvelope = !(step.expectStatusIn && !step.expectCode);
  const gracefulShape = !requireEnvelope || (outcome.jsonOk && outcome.rawFailure === null);

  // Every declared expectation must hold; several may be declared at once
  // (e.g. status 404 AND code "itinerary_not_found").
  let specificPass = true;
  if (step.expectStatusIn && step.expectStatusIn.length > 0) {
    specificPass &&= outcome.status !== null && step.expectStatusIn.includes(outcome.status);
  }
  if (step.expectCode) {
    specificPass &&= codeOf(outcome.json) === step.expectCode;
  }
  if (!step.expectStatusIn && !step.expectCode) {
    // Default bar for a malformed request: a clean 4xx.
    specificPass = outcome.status !== null && outcome.status >= 400 && outcome.status < 500;
  }

  recorder.record({
    step: step.step,
    expected: step.expected,
    actual:
      (outcome.status === null
        ? "no response (transport error: " + outcome.transportError + ")"
        : "HTTP " +
          outcome.status +
          (codeOf(outcome.json) ? ' code "' + codeOf(outcome.json) + '"' : "") +
          (messageOf(outcome.json)
            ? ' message "' + messageOf(outcome.json).slice(0, 120) + '"'
            : "")) +
      (outcome.rawFailure ? "; RAW FAILURE in body: " + JSON.stringify(outcome.rawFailure) : "") +
      (!outcome.jsonOk && outcome.bodyText.trim() !== ""
        ? "; body was not JSON: " + JSON.stringify(outcome.bodyText.slice(0, 160))
        : ""),
    pass: noServerError && gracefulShape && specificPass,
  });
}

async function runBurst(
  step: ApiBurstStep,
  run: RunOptions,
  recorder: Recorder
): Promise<void> {
  const count = Math.min(step.count, MAX_BURST_REQUESTS);
  const settled = await Promise.allSettled(
    Array.from({ length: count }, () => fireOnce(run.baseURL, step))
  );
  const outcomes = settled.map((result) =>
    result.status === "fulfilled"
      ? result.value
      : ({
          status: null,
          bodyText: "",
          json: null,
          jsonOk: false,
          retryAfter: null,
          rawFailure: null,
          transportError: "rejected",
        } as RequestOutcome)
  );

  const statuses = outcomes.map((o) => o.status);
  const serverErrors = statuses.filter((s): s is number => s !== null && s >= 500);
  const rawFailures = outcomes.filter((o) => o.rawFailure !== null);
  const limited = outcomes.filter((o) => o.status === 429);
  const limitTripped = limited.length > 0;
  // Every 429 must carry the app's own rate-limit envelope and a Retry-After.
  const wellFormedLimit = limited.every(
    (o) =>
      codeOf(o.json) === "rate_limited" &&
      /too many requests/i.test(messageOf(o.json)) &&
      o.retryAfter !== null &&
      Number.isFinite(Number(o.retryAfter))
  );

  const distribution = summarise(statuses);
  const pass =
    serverErrors.length === 0 &&
    rawFailures.length === 0 &&
    (!limitTripped || wellFormedLimit);

  recorder.record({
    step: step.step,
    expected: step.expected,
    actual:
      count +
      " request(s) fired at once (bounded, cap " +
      MAX_BURST_REQUESTS +
      "); statuses {" +
      distribution +
      "}; " +
      (limitTripped
        ? limited.length +
          " rate-limited (429), all " +
          (wellFormedLimit ? "carrying the app's message + Retry-After" : "NOT well-formed")
        : "the bounded burst did not trip the limiter, which is fine — the point is that degradation exists, not that it is reached") +
      (serverErrors.length > 0 ? "; " + serverErrors.length + " SERVER ERROR(s)" : "") +
      (rawFailures.length > 0
        ? "; RAW FAILURE(s): " + JSON.stringify(rawFailures[0]?.rawFailure)
        : ""),
    pass,
  });
}

function summarise(statuses: Array<number | null>): string {
  const tally = new Map<string, number>();
  for (const status of statuses) {
    const key = status === null ? "no-response" : String(status);
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  return [...tally.entries()].map(([key, n]) => key + "×" + n).join(", ");
}
