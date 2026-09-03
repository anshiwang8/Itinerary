// Zoom-band decisions for the map's road hierarchy, proven without a live
// Maps instance — plain zoom numbers in, a band or a style array out.
import assert from "node:assert";
import {
  ROAD_HIERARCHY_ZOOM_THRESHOLD,
  roadHierarchyBand,
  roadHierarchyStyles,
} from "./mapRoadHierarchy";

type Case = [string, () => void];

const cases: Case[] = [
  [
    "roadHierarchyBand: at the threshold is 'high' (inclusive)",
    () => {
      assert.strictEqual(roadHierarchyBand(ROAD_HIERARCHY_ZOOM_THRESHOLD), "high");
    },
  ],
  [
    "roadHierarchyBand: just below the threshold is 'low'",
    () => {
      assert.strictEqual(roadHierarchyBand(ROAD_HIERARCHY_ZOOM_THRESHOLD - 1), "low");
    },
  ],
  [
    "roadHierarchyBand: a wide city-level zoom is 'low'",
    () => {
      assert.strictEqual(roadHierarchyBand(10), "low");
    },
  ],
  [
    "roadHierarchyBand: a street-level zoom is 'high'",
    () => {
      assert.strictEqual(roadHierarchyBand(18), "high");
    },
  ],
  [
    "roadHierarchyStyles('high'): no overrides — the base style already reads as full detail",
    () => {
      assert.deepStrictEqual(roadHierarchyStyles("high"), []);
    },
  ],
  [
    "roadHierarchyStyles('low'): hides road.local outright",
    () => {
      const styles = roadHierarchyStyles("low");
      const local = styles.find((s) => s.featureType === "road.local");
      assert.ok(local, "expected a road.local rule");
      assert.strictEqual(local!.elementType, undefined, "must hide the whole feature, not one element");
      assert.deepStrictEqual(local!.stylers, [{ visibility: "off" }]);
    },
  ],
  [
    "roadHierarchyStyles('low'): road.arterial loses labels but keeps geometry",
    () => {
      const styles = roadHierarchyStyles("low");
      const arterialLabels = styles.find(
        (s) => s.featureType === "road.arterial" && s.elementType === "labels"
      );
      assert.ok(arterialLabels, "expected an arterial labels rule");
      assert.deepStrictEqual(arterialLabels!.stylers, [{ visibility: "off" }]);
      const arterialGeometryOverride = styles.find(
        (s) => s.featureType === "road.arterial" && s.elementType === "geometry"
      );
      assert.strictEqual(
        arterialGeometryOverride,
        undefined,
        "arterial geometry must not be touched — only its labels"
      );
    },
  ],
  [
    "roadHierarchyStyles('low'): never touches road.highway — the major skeleton stays visible at every zoom",
    () => {
      const styles = roadHierarchyStyles("low");
      const highwayRule = styles.find((s) => s.featureType === "road.highway");
      assert.strictEqual(highwayRule, undefined);
    },
  ],
];

function main() {
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
}

main();
