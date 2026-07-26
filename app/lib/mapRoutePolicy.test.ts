import assert from "node:assert";
import { displayableRouteMode } from "./mapRoutePolicy";

const cases: Array<[string, () => void]> = [
  [
    "provider-backed transit and walking modes remain displayable",
    () => {
      assert.strictEqual(displayableRouteMode("transit"), "transit");
      assert.strictEqual(displayableRouteMode("walk"), "walk");
    },
  ],
  [
    "an uncertain fallback never becomes a confident straight map line",
    () => {
      assert.strictEqual(displayableRouteMode("unknown"), null);
      assert.strictEqual(displayableRouteMode(undefined), null);
    },
  ],
];

let failed = 0;
for (const [name, test] of cases) {
  try {
    test();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${error instanceof Error ? error.message : error}`);
  }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
if (failed > 0) process.exit(1);
