import assert from "node:assert";
import { shouldShowDevControls } from "./devControls";

const matrix: Array<{
  name: string;
  nodeEnv: string | undefined;
  publicFlag: string | undefined;
  expected: boolean;
}> = [
  {
    name: "development shows controls without an explicit flag",
    nodeEnv: "development",
    publicFlag: undefined,
    expected: true,
  },
  {
    name: "test environments show controls without an explicit flag",
    nodeEnv: "test",
    publicFlag: undefined,
    expected: true,
  },
  {
    name: "production hides controls when the flag is absent",
    nodeEnv: "production",
    publicFlag: undefined,
    expected: false,
  },
  {
    name: "production hides controls when the flag is empty",
    nodeEnv: "production",
    publicFlag: "",
    expected: false,
  },
  {
    name: "production hides controls when the flag is false",
    nodeEnv: "production",
    publicFlag: "false",
    expected: false,
  },
  {
    name: "production rejects non-exact truthy spellings",
    nodeEnv: "production",
    publicFlag: "TRUE",
    expected: false,
  },
  {
    name: "production rejects numeric truthy values",
    nodeEnv: "production",
    publicFlag: "1",
    expected: false,
  },
  {
    name: "production shows controls only for exact true",
    nodeEnv: "production",
    publicFlag: "true",
    expected: true,
  },
];

let failed = 0;
for (const { name, nodeEnv, publicFlag, expected } of matrix) {
  try {
    assert.strictEqual(
      shouldShowDevControls(nodeEnv, publicFlag),
      expected
    );
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${error instanceof Error ? error.message : error}`);
  }
}
console.log(`\n${matrix.length - failed}/${matrix.length} passed`);
if (failed > 0) process.exit(1);
