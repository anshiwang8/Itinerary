// Run the real offline lookup, and guard its server boundary using the
// emitted runtime import graph (type-only imports cannot pull in a bundle).
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { DEFAULT_ZONE } from "../../lib/zoneTime";
import { zoneFromLatLng } from "./zoneLookup";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return /\.tsx?$/.test(file) && !/\.(test|d)\.ts$/.test(file) ? [file] : [];
  });
}

function assertClientBoundary(): void {
  const root = process.cwd();
  const config = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
  const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const lookupFile = resolve(root, "app/api/geocode/zoneLookup.ts");
  const files = sourceFiles(join(root, "app"));
  // Explicit roots also protect the three reusable browser helpers if page
  // code stops importing one temporarily. All actual use-client roots count.
  const roots = [
    ...files.filter((file) => /^\s*["']use client["'];/m.test(readFileSync(file, "utf8"))),
    ...["timeLabels", "clientPayloads", "historyView", "zoneTime"].map((name) =>
      join(root, "app/lib", `${name}.ts`)
    ),
  ];
  assert(roots.length > 4, "include the actual client entry points");
  const visited = new Set<string>();
  function visit(file: string, chain: string[]): void {
    if (visited.has(file)) return;
    visited.add(file);
    const source = readFileSync(file, "utf8");
    const { outputText } = ts.transpileModule(source, {
      fileName: file,
      compilerOptions: { ...options, module: ts.ModuleKind.ESNext },
    });
    for (const ref of ts.preProcessFile(outputText, true, true).importedFiles) {
      const nextChain = [...chain, ref.fileName];
      assert.notEqual(ref.fileName, "tz-lookup", `client imports lookup database: ${nextChain.join(" -> ")}`);
      const resolved = ts.resolveModuleName(ref.fileName, file, options, ts.sys).resolvedModule;
      if (!resolved) continue;
      const dependency = resolve(resolved.resolvedFileName);
      assert.notEqual(dependency, lookupFile, `client imports server lookup: ${nextChain.join(" -> ")}`);
      if (!resolved.isExternalLibraryImport && !dependency.endsWith(".d.ts")) {
        visit(dependency, nextChain);
      }
    }
  }
  for (const file of roots) visit(file, [relative(root, file)]);
  assert(visited.has(resolve(root, "app/lib/zoneTime.ts")));
  // The geographic function has one production importer, the geocoder.
  const importers = files.filter((file) => {
    const source = ts.preProcessFile(readFileSync(file, "utf8"), true, true);
    return source.importedFiles.some((ref) =>
      resolve(dirname(file), ref.fileName + ".ts") === lookupFile
    );
  });
  assert.deepEqual(importers, [resolve(root, "app/api/geocode/geocode.ts")]);
}

const cases: Array<[string, () => void]> = [
  ["zoneFromLatLng: real cities, bad coords fall back to default", () => {
    assert.equal(zoneFromLatLng(43.6547, -79.3862), "America/Toronto");
    assert.equal(zoneFromLatLng(49.2827, -123.1207), "America/Vancouver");
    assert.equal(zoneFromLatLng(51.5074, -0.1278), "Europe/London");
    assert.equal(zoneFromLatLng(NaN, NaN), DEFAULT_ZONE);
  }],
  ["out-of-range and non-finite coordinates retain the offline fallback", () => {
    for (const [lat, lng] of [[91, 0], [0, 181], [-91, 0], [0, -181], [Infinity, 0], [0, -Infinity]]) {
      assert.equal(zoneFromLatLng(lat, lng), DEFAULT_ZONE);
    }
  }],
  ["no client runtime import path reaches the geographic lookup or database", assertClientBoundary],
];

let failed = 0;
for (const [name, run] of cases) {
  try { run(); console.log(`PASS  ${name}`); }
  catch (error) { failed++; console.error(`FAIL  ${name}`, error); }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
if (failed) process.exit(1);
