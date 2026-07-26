import assert from "node:assert";
import {
  hardPriceLevelMaximum,
  parseBudget,
} from "./budget";

const cases: Array<[string, () => void]> = [
  [
    "relative symbols and language produce defensible Places caps",
    () => {
      const one = parseBudget("$");
      const two = parseBudget("$$");
      const cheap = parseBudget("budget");
      assert.deepStrictEqual(one, { kind: "places-level", maxLevel: 1, raw: "$" });
      assert.deepStrictEqual(two, { kind: "places-level", maxLevel: 2, raw: "$$" });
      assert.deepStrictEqual(cheap, { kind: "relative", level: "cheap", raw: "budget" });
      assert.strictEqual(hardPriceLevelMaximum(one), 1);
      assert.strictEqual(hardPriceLevelMaximum(two), 2);
      assert.strictEqual(hardPriceLevelMaximum(cheap), 2);
    },
  ],
  [
    "numeric maxima retain amount and currency without inventing a Places cap",
    () => {
      assert.deepStrictEqual(parseBudget("under $20"), {
        kind: "numeric-max",
        amount: 20,
        currency: "USD",
        raw: "under $20",
      });
      assert.deepStrictEqual(parseBudget("under $300"), {
        kind: "numeric-max",
        amount: 300,
        currency: "USD",
        raw: "under $300",
      });
      assert.deepStrictEqual(parseBudget("under €30"), {
        kind: "numeric-max",
        amount: 30,
        currency: "EUR",
        raw: "under €30",
      });
      assert.deepStrictEqual(parseBudget("under 30€"), {
        kind: "numeric-max",
        amount: 30,
        currency: "EUR",
        raw: "under 30€",
      });
      assert.deepStrictEqual(parseBudget("under $1,000"), {
        kind: "numeric-max",
        amount: 1000,
        currency: "USD",
        raw: "under $1,000",
      });
      assert.deepStrictEqual(parseBudget("up to 40 CAD"), {
        kind: "numeric-max",
        amount: 40,
        currency: "CAD",
        raw: "up to 40 CAD",
      });
      assert.strictEqual(hardPriceLevelMaximum(parseBudget("under $20")), null);
      assert.strictEqual(hardPriceLevelMaximum(parseBudget("under $300")), null);
      assert.strictEqual(parseBudget("under $1,000 CAD"), null);
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
