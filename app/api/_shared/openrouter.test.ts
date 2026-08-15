// The OpenRouter request body. Everything here is pure — no network, no key.
//
// This suite exists because these fields fail SILENTLY when they are wrong.
// Dropping `provider.require_parameters` does not error: OpenRouter drops
// `response_format` on an endpoint that lacks it and the model answers in
// prose, which every parser downstream reads as a malformed model rather than
// a malformed request. Dropping `provider.sort` does not error either — it
// routes by price, which is how a plan came back at 8.9 tokens/sec and timed
// out in the browser. Nor does a `max_price` set too low, which is a FILTER:
// it deletes endpoints rather than complaining. And sending `reasoning` to a
// model that is not a reasoning model over-filters routing until the request
// has no endpoints at all. None of it is visible in mock e2e, which never
// reaches a provider.
// Run with: npx tsx app/api/_shared/openrouter.test.ts
import assert from "node:assert";
import { OPENROUTER_URL, chatCompletionBody } from "./openrouter";
import { BUILT_IN_CHAINS } from "./models";

const MESSAGES = [{ role: "user", content: "hi" }];

function body(model: string): Record<string, unknown> {
  return JSON.parse(chatCompletionBody(model, MESSAGES)) as Record<string, unknown>;
}

const cases: Array<[string, () => void]> = [
  [
    "the endpoint is OpenRouter's, hardcoded — no env var decides where a plan goes",
    () => {
      assert.strictEqual(
        OPENROUTER_URL,
        "https://openrouter.ai/api/v1/chat/completions"
      );
    },
  ],
  [
    "EVERY body asks for JSON mode and require_parameters together",
    () => {
      // The pair is the point: response_format states the contract and
      // require_parameters is what stops routing from quietly discarding it.
      for (const model of Object.values(BUILT_IN_CHAINS).flat()) {
        const sent = body(model);
        assert.deepStrictEqual(
          sent.response_format,
          { type: "json_object" },
          `${model} must ask for JSON mode`
        );
        assert.deepStrictEqual(
          sent.provider,
          {
            require_parameters: true,
            sort: "throughput",
            max_price: { prompt: 5, completion: 10 },
          },
          `${model} must pin routing to endpoints that actually support it`
        );
      }
    },
  ],
  [
    "routing asks for the FASTEST endpoint, and only among the compliant ones",
    () => {
      // The composition is the whole fix. `require_parameters` narrows the
      // candidates to endpoints that genuinely honour response_format;
      // `sort` picks the fastest of what survives. Either one alone is a
      // different product: fastest-outright would reintroduce the prose
      // replies of gotcha 1, and compliant-only is what shipped at 8.9
      // tokens/sec and blew the client deadline.
      for (const model of Object.values(BUILT_IN_CHAINS).flat()) {
        const provider = body(model).provider as Record<string, unknown>;
        assert.strictEqual(provider.sort, "throughput", `${model} must sort by speed`);
        assert.strictEqual(
          provider.require_parameters,
          true,
          `${model} must still filter to compliant endpoints FIRST`
        );
      }
    },
  ],
  [
    "the price ceiling clears every real endpoint — the round number does NOT",
    () => {
      // Throughput-sorting takes price out of the ordering, so max_price is
      // what puts a bound back. It is a filter, so a ceiling set too low
      // silently DELETES a legitimate endpoint rather than erroring.
      // Probed per endpoint on 2026-08-15 (`/api/v1/models/{id}/endpoints`,
      // not the blended per-model figure, because per-endpoint is what this
      // filters on): the priciest across all four chain models was $1.04/M
      // prompt (Together on llama-3.3-70b) and $2.253/M completion
      // (Cloudflare, same model). An obvious `completion: 2` would have
      // dropped that endpoint — this case exists so that edit turns red.
      const price = (body("meta-llama/llama-3.3-70b-instruct").provider as {
        max_price: { prompt: number; completion: number };
      }).max_price;
      assert.ok(price.prompt >= 1.04, "the prompt ceiling must clear a real endpoint");
      assert.ok(
        price.completion >= 2.253,
        "the completion ceiling must clear a real endpoint"
      );
    },
  ],
  [
    "the routing policy names no provider and no model — it survives a chain change",
    () => {
      // Model-agnostic on purpose. `order`/`only` would pin a provider, and
      // providers serve different subsets of models, so a pin here breaks
      // silently the day models.ts changes — the exact drift models.ts was
      // created to end. "Fastest compliant endpoint under a ceiling" is true
      // of whatever chain is in force, including an env-overridden one.
      const everyModelId = Object.values(BUILT_IN_CHAINS).flat();
      for (const model of everyModelId) {
        const provider = body(model).provider as Record<string, unknown>;
        for (const pinning of ["order", "only", "ignore"]) {
          assert.ok(
            !(pinning in provider),
            `${model}: provider.${pinning} pins routing to a named provider`
          );
        }
        const serialized = JSON.stringify(provider);
        for (const id of everyModelId) {
          assert.ok(
            !serialized.includes(id),
            `${model}: the routing policy must not name a model`
          );
        }
      }
    },
  ],
  [
    "the rest of the body is unchanged from the Groq era — same weights, same call",
    () => {
      const sent = body("meta-llama/llama-3.3-70b-instruct");
      assert.strictEqual(sent.model, "meta-llama/llama-3.3-70b-instruct");
      assert.deepStrictEqual(sent.messages, MESSAGES);
      assert.strictEqual(sent.temperature, 0, "determinism is not negotiable here");
    },
  ],
  [
    "reasoning is asked for on the gpt-oss entries, and EXCLUDED from content",
    () => {
      // These emit reasoning tokens whether or not anyone asks. `exclude`
      // keeps them out of message.content, which is the string JSON.parse
      // runs on at all three call sites.
      for (const model of ["openai/gpt-oss-120b", "openai/gpt-oss-20b"]) {
        assert.deepStrictEqual(
          body(model).reasoning,
          { effort: "low", exclude: true },
          `${model} is reasoning-mandatory`
        );
      }
    },
  ],
  [
    "reasoning is NOT sent to the llama entries — require_parameters cuts both ways",
    () => {
      // Asking for `reasoning` alongside require_parameters restricts routing
      // to endpoints advertising support for it. llama-3.3-70b is not a
      // reasoning model, so that filter would leave the request with no
      // endpoint at all — a total failure of the primary on both chains.
      for (const model of [
        "meta-llama/llama-3.3-70b-instruct",
        "meta-llama/llama-3.1-8b-instruct",
      ]) {
        assert.ok(
          !("reasoning" in body(model)),
          `${model} must not be filtered on a parameter it does not have`
        );
      }
    },
  ],
  [
    "every chain PRIMARY is a non-reasoning model, so no plan waits on thinking",
    () => {
      // Not an accident worth losing: the models that answer when nothing has
      // gone wrong are the ones with no reasoning preamble in front of them.
      for (const [call, chain] of Object.entries(BUILT_IN_CHAINS)) {
        assert.ok(
          !("reasoning" in body(chain[0])),
          `${call}'s primary should not be reasoning-mandatory`
        );
      }
    },
  ],
];

let failed = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${error instanceof Error ? error.message : error}`);
  }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
if (failed > 0) process.exit(1);
