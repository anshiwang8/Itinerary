import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { ClientFetchError } from "./clientFetch";

// Execute the actual page closures with injected transport and state sinks.
// No copy of the lock/End/apply algorithm and no production test exports.
// Browser tests separately exercise disabled controls and real React events.
const source = ts.createSourceFile("page.tsx", readFileSync("app/page.tsx", "utf8"),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = new Set(["beginOperation", "endOperation", "isCurrentOperation", "applyItinerary",
  "clearItineraryState", "chooseStop", "mutationOutcomeMayBeAmbiguous"]);
const declarations: string[] = [];
const operationHandlers: string[] = [];
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name) {
    if (names.has(node.name.text)) declarations.push(node.getText(source));
    if (node.body?.statements.some((statement) =>
      ts.isVariableStatement(statement) && /const operation = beginOperation\(\)/.test(statement.getText(source)))) {
      operationHandlers.push(node.name.text);
      assert.match(node.body.getText(source), /finally\s*\{[\s\S]*endOperation\(operation\)/);
    }
  }
  if (ts.isVariableDeclaration(node) && names.has(node.name.getText(source))) {
    declarations.push(`const ${node.getText(source)};`);
  }
  ts.forEachChild(node, visit);
}
visit(source);

type Plan = { id: string; version: number; stops: unknown[]; endedAt?: string };
const plan = (id = "A", version = 1): Plan => ({ id, version, stops: [] });
function deferred() {
  let resolve!: (value?: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness() {
  const writes: Array<[string, unknown]> = [];
  const current = plan();
  const context: Record<string, unknown> = {
    itinerary: current,
    itineraryRef: { current },
    activeOperation: { current: null },
    arrivalProgressRef: { current: {} },
    resumeAttempted: { current: false },
    INITIAL_ARRIVAL_PROGRESS: {},
    simNow: "",
    ClientFetchError,
    useCallback: (callback: unknown) => callback,
    clientErrorMessage: () => "interrupted",
    authHeaders: async () => ({ Authorization: "fixture" }),
    fetchJson: async () => ({}),
    readItinerary: async () => current,
    stopsFromItinerary: (it: Plan) => it.stops,
  };
  for (const name of ["Itinerary", "Schedule", "MapStops", "HomeLeg", "Selected", "ManualLegId",
    "ArrivedStopId", "YouToActiveStopM", "Banner", "ChangedIds", "OldStarts", "WeatherBlocks",
    "SwapError", "Error", "StopOpen", "StopError", "StopBusy"]) {
    context[`set${name}`] = (value: unknown) => writes.push([name, value]);
  }
  const js = ts.transpileModule(declarations.join("\n") +
    "\nresult = { beginOperation, endOperation, applyItinerary, clearItineraryState, chooseStop };",
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(js, context);
  const handlers = context.result as {
    beginOperation(): symbol | null;
    endOperation(token: symbol): void;
    applyItinerary(it: Plan, expectedId: string | null, token?: symbol): boolean;
    clearItineraryState(): void;
    chooseStop(choice: string): Promise<void>;
  };
  return { context, writes, handlers,
    ref: context.itineraryRef as { current: Plan | null },
    lock: context.activeOperation as { current: symbol | null } };
}

test("D7: all twelve operation entry points, including End, pair the shared lock with finally", () => {
  assert.equal(operationHandlers.length, 12);
  assert.ok(operationHandlers.includes("chooseStop"));
});

test("D7: End cannot send a request while another operation owns the lock", async () => {
  const h = harness();
  let requests = 0;
  h.context.fetchJson = async () => { requests++; };
  const token = h.handlers.beginOperation()!;
  await h.handlers.chooseStop("discard-end");
  assert.equal(requests, 0);
  assert.equal(h.lock.current, token);
  assert.equal(h.ref.current?.id, "A");
});

test("D7: End holds the lock through submission, blocks another operation and cannot be cancelled", async () => {
  const h = harness();
  const response = deferred();
  h.context.fetchJson = () => response.promise;
  const ending = h.handlers.chooseStop("discard-end");
  assert.ok(h.lock.current, "End must acquire synchronously, before auth resolves");
  assert.equal(h.handlers.beginOperation(), null);
  await Promise.resolve();
  await h.handlers.chooseStop("cancel");
  assert.equal(h.writes.some(([key, value]) => key === "StopOpen" && value === false), false);
  response.resolve();
  await ending;
  assert.equal(h.ref.current, null);
  assert.equal(h.lock.current, null);
});

test("D7: a stale mutation completion after End cannot resurrect any of the four display surfaces", async () => {
  const h = harness();
  const mutation = h.handlers.beginOperation()!;
  h.handlers.endOperation(mutation);
  await h.handlers.chooseStop("discard-end");
  h.writes.length = 0;
  h.handlers.applyItinerary(plan("A", 2), "A", mutation);
  assert.deepEqual(h.writes, [], "late apply must not write itinerary, schedule, mapStops or homeLeg");
  assert.equal(h.ref.current, null);
});

test("D7: a late End response cannot clear a replacement plan or release its newer operation", async () => {
  const h = harness();
  const response = deferred();
  h.context.fetchJson = () => response.promise;
  const ending = h.handlers.chooseStop("discard-end");
  await Promise.resolve(); // auth resolved, POST sent
  const nextOperation = Symbol("newer operation");
  h.ref.current = plan("B");
  h.lock.current = nextOperation;
  h.writes.length = 0;
  response.resolve();
  await ending;
  assert.equal(h.ref.current.id, "B");
  assert.equal(h.lock.current, nextOperation);
  assert.equal(h.writes.some(([key]) => key === "Itinerary"), false);
});

test("D7: current completions apply, older same-plan versions and displaced plans do not", () => {
  const h = harness();
  const token = h.handlers.beginOperation()!;
  h.handlers.applyItinerary(plan("A", 3), "A", token);
  assert.equal(h.writes.length, 4);
  h.writes.length = 0;
  h.handlers.applyItinerary(plan("A", 2), "A", token);
  h.handlers.applyItinerary(plan("B", 4), "B", token);
  assert.deepEqual(h.writes, []);
});

test("D7: ambiguous End reads back under the same lock and clears only a confirmed ended plan", async () => {
  const h = harness();
  h.context.fetchJson = async () => { throw new ClientFetchError(null, "network_error", "lost"); };
  let reads = 0;
  h.context.readItinerary = async () => {
    reads++;
    assert.equal(h.handlers.beginOperation(), null);
    return { ...plan(), endedAt: "2026-08-30T19:00:00Z" };
  };
  await h.handlers.chooseStop("discard-end");
  assert.equal(reads, 1);
  assert.equal(h.ref.current, null);
  assert.equal(h.lock.current, null);
});

test("D7: definite End refusal keeps the plan and releases the lock without a read-back", async () => {
  const h = harness();
  h.context.fetchJson = async () => { throw new ClientFetchError(403, "forbidden", "refused"); };
  h.context.readItinerary = async () => assert.fail("a definite rejection is not ambiguous");
  await h.handlers.chooseStop("discard-end");
  assert.equal(h.ref.current?.id, "A");
  assert.equal(h.lock.current, null);
});

test("D7: the actual End dialog disables Cancel and every ending choice while submitting", () => {
  const path = resolve("app/StopItineraryDialog.tsx");
  const output = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports: Record<string, unknown> = {};
  runInNewContext(output, { exports, require: createRequire(path) });
  const Dialog = exports.default as ComponentType<{
    isAnonymous: boolean; busy: boolean; error: null; onChoose: () => void;
  }>;
  for (const isAnonymous of [true, false]) {
    for (const busy of [true, false]) {
      const html = renderToStaticMarkup(createElement(Dialog, {
        isAnonymous, busy, error: null, onChoose: () => {},
      }));
      const buttons = [...html.matchAll(/<button\b([^>]*)>(.*?)<\/button>/g)];
      assert.equal(buttons.length, isAnonymous ? 2 : 3);
      assert.ok(buttons.some(([, , text]) => text === "Cancel"));
      for (const [, attributes, label] of buttons) {
        assert.equal(attributes.includes('disabled=""'), busy, `${label} while busy=${busy}`);
      }
    }
  }
});
