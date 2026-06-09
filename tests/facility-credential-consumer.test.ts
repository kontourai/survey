import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildFacilityCredentialConsumerExample,
  facilityCredentialPresentationAdapter,
} from "../examples/review-workbench/facility-credential-consumer.js";
import {
  buildReviewItemPresentation,
  buildReviewResultPresentation,
  buildReviewWorkbenchSessionExportForSnapshot,
  validateReviewSessionEventsForSnapshot,
} from "../src/review-workbench/review-workbench.js";

describe("generic facility credential consumer example", () => {
  it("uses product presentation hooks without mutating the ReviewItem", async () => {
    const example = await buildFacilityCredentialConsumerExample();
    const presentation = buildReviewItemPresentation(example.reviewItem, facilityCredentialPresentationAdapter);
    const proposed = presentation.candidates.find((candidate) => candidate.candidate.role === "proposed");

    assert.equal(presentation.targetLabel, "Operating license credential");
    assert.equal(presentation.reviewItemLink?.href, "/review/items/facility-credential-review-operating-license");
    assert.equal(proposed?.roleLabel, "Registry candidate");
    assert.match(proposed?.valueText ?? "", /FAC-2026-1042 is active through 2027-01-15/);
    assert.equal(proposed?.sourceLink?.label, "Registry source");
    assert.ok(proposed?.traceRefs.some((ref) => ref.kind === "claim" && ref.link?.label === "Claim target"));
    assert.equal(example.reviewItem.spec.target, "operatingLicenseCredential");
  });

  it("persists replayable review events and derives the selected result from the persisted snapshot events", async () => {
    const example = await buildFacilityCredentialConsumerExample();
    const issues = validateReviewSessionEventsForSnapshot(example.reviewedSnapshot, example.persistedEvents);
    const replayed = buildReviewWorkbenchSessionExportForSnapshot(example.reviewedSnapshot, example.persistedEvents);
    const [result] = replayed.results;

    assert.deepEqual(issues, []);
    assert.equal(example.eventsToPersist.length, 6);
    assert.deepEqual(example.persistedEvents, example.eventsToPersist);
    assert.equal(example.persistedEventCount, example.persistedEvents.length);
    assert.equal(replayed.events.length, example.persistedEvents.length);
    assert.equal(result?.decision, "accept-proposed");
    assert.equal(result?.selectedCandidateRole, "proposed");
    assert.equal(result?.reviewDecision.spec.actor?.id, "review-operator@example.test");
    assert.equal(result?.reviewDecision.spec.status, "verified");
  });

  it("presents result meaning and a Surface projection preview for the selected candidate", async () => {
    const example = await buildFacilityCredentialConsumerExample();
    const [result] = example.sessionExport.results;
    assert.ok(result);

    const resultPresentation = buildReviewResultPresentation(
      result,
      example.reviewItem,
      facilityCredentialPresentationAdapter,
    );

    assert.equal(resultPresentation.targetLabel, "Operating license credential");
    assert.equal(resultPresentation.decisionLabel, "Accept Proposed");
    assert.equal(resultPresentation.applyMeaning, "Saved decision applies proposed value");
    assert.match(resultPresentation.selectedValueText, /FAC-2026-1042/);
    assert.equal(example.surfaceProjectionPreview.canonicalClaim.status, "verified");
    assert.equal(example.surfaceProjectionPreview.canonicalClaim.candidateId, result.selectedCandidateId);
    assert.equal(example.surfaceProjectionPreview.candidateHistory.length, 1);
    assert.equal(example.surfaceProjectionPreview.sourceEvidence.sourceId, "facility-credential-review-operating-license:source:registry");
  });
});
