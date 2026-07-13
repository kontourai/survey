import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runCalibratedAutoAccept } from "../examples/calibrated-auto-accept.js";

// Verifies the downstream-wiring example: the empirically-grounded auto-accept
// threshold and the produced conclusionConfidence.value match the history.
describe("examples/calibrated-auto-accept", () => {
  it("grounds the auto-accept threshold and produces calibrated values", () => {
    const { suggestedThreshold, groupAccuracy, producedValues } = runCalibratedAutoAccept();

    // Top two deciles (0.85, 0.95) were fully affirmed; the 0.7–0.8 decile was
    // only half affirmed, so the empirical threshold lands at 0.8.
    assert.equal(suggestedThreshold, 0.8);

    // (extractor, field) affirmation rate over the 40-sample history: 26/40.
    assert.equal(groupAccuracy, 0.65);

    // Both new claims are affirmed, so each carries the calibrated value.
    assert.deepEqual(producedValues, [0.65, 0.65]);
  });
});
