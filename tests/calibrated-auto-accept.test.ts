import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runCalibratedAutoAccept } from "../examples/calibrated-auto-accept.js";

// Verifies the experimental calibration example against the #279 guards.
describe("examples/calibrated-auto-accept", () => {
  it("suggests a threshold only when the history supports it", () => {
    const { suggestedThreshold, sparseHistoryThreshold } = runCalibratedAutoAccept();
    // 60 samples per decile: 0.9 and 0.8 deciles clear the 0.9 target on their
    // Wilson lower bounds; the half-affirmed 0.7 decile ends the run.
    assert.equal(suggestedThreshold, 0.8);
    // The same shape at 10 samples per decile is below the 30-sample floor.
    assert.equal(sparseHistoryThreshold, undefined);
  });

  it("sets conclusionConfidence.value only under the experimental opt-in, as a group base rate", () => {
    const { groupAccuracy, producedValues, defaultValues } = runCalibratedAutoAccept();
    assert.deepEqual(defaultValues, [undefined, undefined]);
    // (60 + 59 + 30 + 6) / 240 affirmed.
    assert.equal(groupAccuracy, 0.6458);
    // Two claims with different confidences (0.85, 0.92) get the same number:
    // it is the group's affirmation rate, not a per-claim probability.
    assert.deepEqual(producedValues, [groupAccuracy, groupAccuracy]);
  });
});
