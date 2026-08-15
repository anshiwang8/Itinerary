// The OpenRouter request body. Everything here is pure — no network, no key.
//
// This suite exists because two of these fields fail SILENTLY when they are
// missing. Dropping `provider.require_parameters` does not error: OpenRouter
// drops `response_format` on an endpoint that lacks it and the model answers
// in prose, which every parser downstream reads as a malformed model rather
// than a malformed request. Sending `reasoning` to a model that is not a
// reasoning model does not error either — it over-filters routing, and an
// over-filtered request has no endpoints at all. Neither is visible in mock
// e2e, which never reaches a provider.
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
          { require_parameters: true },
          `${model} must pin routing to endpoints that actually support it`
        );
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
