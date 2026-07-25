import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const projectRoot = process.cwd();
const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");

function testFilesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return testFilesUnder(path);
    return entry.isFile() && entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

const tests = testFilesUnder(join(projectRoot, "app")).sort();

if (tests.length === 0) {
  console.error("No app/**/*.test.ts unit suites were found.");
  process.exit(1);
}

console.log(`Running ${tests.length} unit suites`);

for (const test of tests) {
  const displayPath = relative(projectRoot, test);
  console.log(`\n===== ${displayPath} =====`);
  const result = spawnSync(process.execPath, [tsxCli, test], {
    cwd: projectRoot,
    env: process.env,
    stdio: "inherit",
  });

  if (result.error) {
    console.error(`Unable to run ${displayPath}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`${displayPath} failed with exit code ${result.status ?? "unknown"}.`);
    process.exit(result.status ?? 1);
  }
}

console.log(`\nAll ${tests.length} unit suites passed.`);
