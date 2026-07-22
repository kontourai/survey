import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolvePlaywrightRuntime } from "../scripts/playwright-runtime.js";

describe("Playwright runtime isolation", () => {
  it("assigns different local ports to independent process ids", () => {
    assert.notEqual(
      resolvePlaywrightRuntime({}, 101).port,
      resolvePlaywrightRuntime({}, 102).port,
    );
  });

  it("keeps CI deterministic and accepts an explicit override", () => {
    assert.equal(resolvePlaywrightRuntime({ CI: "true" }, 101).port, 4_180);
    assert.equal(resolvePlaywrightRuntime({ SURVEY_PLAYWRIGHT_PORT: "43210" }, 101).port, 43_210);
  });

  it("rejects unsafe port overrides", () => {
    assert.throws(
      () => resolvePlaywrightRuntime({ SURVEY_PLAYWRIGHT_PORT: "0" }, 101),
      /must be an integer/,
    );
  });
});
