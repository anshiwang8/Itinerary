import assert from "node:assert/strict";
import test from "node:test";
import { originDisplayLabel } from "./locationLabels";

test("originDisplayLabel removes UI prefixes without rewriting the resolved address", () => {
  assert.equal(
    originDisplayLabel("Start · 100 Queen Street West, Toronto, ON, Canada"),
    "100 Queen Street West, Toronto, ON, Canada"
  );
  assert.equal(
    originDisplayLabel("Home · Chestnut Residence"),
    "Chestnut Residence"
  );
  assert.equal(
    originDisplayLabel("London, ON, Canada"),
    "London, ON, Canada"
  );
});
