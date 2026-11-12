import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { surfaceVersionFromEntry } from "../src/surface-reviewed-extraction.js";

/**
 * Each `surface-compat` CI leg pins one Surface version and sets
 * SURVEY_EXPECT_SURFACE to a pattern for it. Checking the version in the
 * workflow alone does not show which copy the suite loads. This test resolves
 * Surface the way Survey's own modules do and fails when the leg's tests would
 * run on another version. Outside those legs the check is skipped. Inside the
 * job (GitHub sets GITHUB_JOB to the job id) a missing pattern fails, so
 * dropping it from the workflow cannot turn the check into a silent skip.
 */
describe("Surface compatibility leg", () => {
  const expected = process.env.SURVEY_EXPECT_SURFACE;
  const inCompatJob = process.env.GITHUB_JOB === "surface-compat";

  it("runs on the Surface version the leg pinned", { skip: expected || inCompatJob ? false : "SURVEY_EXPECT_SURFACE is unset (not a surface-compat leg)" }, () => {
    assert.ok(expected, "the surface-compat job must set SURVEY_EXPECT_SURFACE for its unit tests");
    const version = surfaceVersionFromEntry(() => import.meta.resolve("@kontourai/surface"));
    assert.match(version, new RegExp(expected), `the suite resolved @kontourai/surface ${version}; the leg expects ${expected}`);
  });
});
