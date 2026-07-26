import assert from "node:assert";
import {
  arrivalForRow,
  mergeFinalArrivals,
  mergePlacePools,
  provisionalArrivals,
  usedIdsOutsideRow,
} from "./recoverySlots";

interface PoolPlace {
  id?: string;
  name: string;
}

const cases: Array<[string, () => void]> = [
  [
    "provisional arrivals keep original slot identity and use replacement durations",
    () => {
      const arrivals = provisionalArrivals(
        ["coffee shop", "bar", "dessert"],
        "2026-07-25T20:00:00.000Z",
        [
          { slot: 1, category: "dinner", id: "restaurant-1" },
          { category: "museum", id: "legacy-no-slot" },
        ]
      );

      assert.deepStrictEqual(arrivals, {
        0: "2026-07-25T20:00:00.000Z",
        1: "2026-07-25T21:00:00.000Z",
        2: "2026-07-25T22:45:00.000Z",
      });
    },
  ],
  [
    "invalid provisional start returns an empty map",
    () => {
      assert.deepStrictEqual(
        provisionalArrivals(["dinner"], "not-a-date", [{ slot: 0, category: "bar" }]),
        {}
      );
    },
  ],
  [
    "scheduled starts override provisional instants by slot",
    () => {
      const merged = mergeFinalArrivals(
        {
          0: "2026-07-25T20:00:00.000Z",
          1: "2026-07-25T21:00:00.000Z",
          2: "2026-07-25T22:00:00.000Z",
        },
        [
          { slot: 2, start_time: "2026-07-25T23:15:00.000Z" },
          { slot: 1, start_time: "invalid" },
        ]
      );

      assert.deepStrictEqual(merged, {
        0: "2026-07-25T20:00:00.000Z",
        1: "2026-07-25T21:00:00.000Z",
        2: "2026-07-25T23:15:00.000Z",
      });
    },
  ],
  [
    "scheduled legacy stops use their stable positional slot",
    () => {
      assert.deepStrictEqual(
        mergeFinalArrivals({}, [
          { start_time: "2026-07-25T20:05:00.000Z" },
          { start_time: null },
          { start_time: "2026-07-25T22:30:00.000Z" },
        ]),
        {
          0: "2026-07-25T20:05:00.000Z",
          2: "2026-07-25T22:30:00.000Z",
        }
      );
    },
  ],
  [
    "row arrival uses its valid slot instant then a safe fallback",
    () => {
      const fallback = new Date("2026-07-25T19:00:00.000Z");
      assert.strictEqual(
        arrivalForRow(
          { 1: "2026-07-25T21:30:00.000Z" },
          { slot: 1, category: "bar" },
          fallback
        ).toISOString(),
        "2026-07-25T21:30:00.000Z"
      );
      assert.strictEqual(
        arrivalForRow(
          { 1: "invalid" },
          { slot: 1, category: "bar" },
          fallback
        ).toISOString(),
        fallback.toISOString()
      );
      assert.strictEqual(
        arrivalForRow({}, { category: "bar" }, "also-invalid").toISOString(),
        "1970-01-01T00:00:00.000Z"
      );
    },
  ],
  [
    "used IDs exclude the selected row by slot and deduplicate the rest",
    () => {
      const used = usedIdsOutsideRow(
        [
          { slot: 0, category: "bar", id: "a" },
          { slot: 1, category: "bar", id: "b" },
          { slot: 2, category: "dessert", id: "a" },
          { category: "bar", id: "legacy" },
          { slot: 3, category: "museum", id: null },
        ],
        { slot: 1, category: "bar" }
      );
      assert.deepStrictEqual([...used], ["a", "legacy"]);
    },
  ],
  [
    "legacy rows use category identity when collecting occupied IDs",
    () => {
      const used = usedIdsOutsideRow(
        [
          { category: "bar", id: "bar-1" },
          { category: "museum", id: "museum-1" },
        ],
        { category: "bar" }
      );
      assert.deepStrictEqual([...used], ["museum-1"]);
    },
  ],
  [
    "pool merge preserves earlier venues and appends only new IDs",
    () => {
      const first: PoolPlace = { id: "same", name: "Original" };
      const idless: PoolPlace = { name: "No ID yet" };
      const merged = mergePlacePools<PoolPlace>(
        [first, { id: "old", name: "Old" }],
        [
          { id: "same", name: "Refreshed duplicate" },
          { id: "new", name: "New" },
          idless,
        ]
      );

      assert.deepStrictEqual(merged, [
        first,
        { id: "old", name: "Old" },
        { id: "new", name: "New" },
        idless,
      ]);
      assert.strictEqual(merged[0], first);
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
