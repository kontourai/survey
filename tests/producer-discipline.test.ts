/**
 * Tests for the Producer Discipline core — src/producer-discipline.ts.
 *
 * Covers the shared review-outcome triad `assertReviewOutcomeDiscipline`
 * pins for both call sites (src/to-surface.ts's assertProducerDiscipline,
 * src/source-of-authority-observation.ts's assertVerifiedPosture):
 * - A non-triggering status ("proposed") with no review present does not
 *   throw.
 * - "verified"/"assumed" with no review outcome throws, with the status
 *   word interpolated into the message.
 * - "verified" with a review present but no actor throws the actor variant.
 * - "verified" with actor present but no reviewedAt throws the reviewedAt
 *   variant.
 * - "verified" and "assumed" with a full review (actor + reviewedAt) do not
 *   throw.
 * - The caller-supplied `subject` string is interpolated verbatim at the
 *   start of the thrown message (pins the subject-noun parameterization
 *   contract both call sites rely on).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertReviewOutcomeDiscipline } from "../src/producer-discipline.js";

describe("assertReviewOutcomeDiscipline", () => {
  it("does not throw for a non-triggering status with no review present", () => {
    assert.doesNotThrow(() =>
      assertReviewOutcomeDiscipline({
        subject: "Claim c-1",
        status: "proposed",
        review: undefined,
      }),
    );
  });

  it("does not throw for other non-triggering statuses with no review present", () => {
    assert.doesNotThrow(() =>
      assertReviewOutcomeDiscipline({
        subject: "Claim c-1",
        status: "disputed",
        review: undefined,
      }),
    );
    assert.doesNotThrow(() =>
      assertReviewOutcomeDiscipline({
        subject: "Claim c-1",
        status: "rejected",
        review: undefined,
      }),
    );
    assert.doesNotThrow(() =>
      assertReviewOutcomeDiscipline({
        subject: "Claim c-1",
        status: undefined,
        review: undefined,
      }),
    );
  });

  it("throws when verified with no review outcome", () => {
    assert.throws(
      () =>
        assertReviewOutcomeDiscipline({
          subject: "Claim c-1",
          status: "verified",
          review: undefined,
        }),
      /cannot be verified without a review outcome/,
    );
  });

  it("throws when assumed with no review outcome", () => {
    assert.throws(
      () =>
        assertReviewOutcomeDiscipline({
          subject: "Claim c-1",
          status: "assumed",
          review: undefined,
        }),
      /cannot be assumed without a review outcome/,
    );
  });

  it("throws when verified with a review present but no actor", () => {
    assert.throws(
      () =>
        assertReviewOutcomeDiscipline({
          subject: "Claim c-1",
          status: "verified",
          review: { actor: undefined, reviewedAt: "2026-07-02T00:00:00.000Z" },
        }),
      /without review actor authority/,
    );
  });

  it("throws when verified with actor present but no reviewedAt", () => {
    assert.throws(
      () =>
        assertReviewOutcomeDiscipline({
          subject: "Claim c-1",
          status: "verified",
          review: { actor: "reviewer-1", reviewedAt: undefined },
        }),
      /without reviewedAt/,
    );
  });

  it("does not throw when verified with a full review outcome", () => {
    assert.doesNotThrow(() =>
      assertReviewOutcomeDiscipline({
        subject: "Claim c-1",
        status: "verified",
        review: { actor: "reviewer-1", reviewedAt: "2026-07-02T00:00:00.000Z" },
      }),
    );
  });

  it("does not throw when assumed with a full review outcome", () => {
    assert.doesNotThrow(() =>
      assertReviewOutcomeDiscipline({
        subject: "Claim c-1",
        status: "assumed",
        review: { actor: "reviewer-1", reviewedAt: "2026-07-02T00:00:00.000Z" },
      }),
    );
  });

  it("interpolates the caller-supplied subject verbatim into the thrown message", () => {
    assert.throws(
      () =>
        assertReviewOutcomeDiscipline({
          subject: "Widget w-1",
          status: "verified",
          review: undefined,
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, "Widget w-1 cannot be verified without a review outcome");
        return true;
      },
    );
    assert.throws(
      () =>
        assertReviewOutcomeDiscipline({
          subject: "Source-of-authority observation soa-1",
          status: "assumed",
          review: { actor: undefined, reviewedAt: "2026-07-02T00:00:00.000Z" },
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(
          err.message,
          "Source-of-authority observation soa-1 cannot be assumed without review actor authority",
        );
        return true;
      },
    );
  });
});
