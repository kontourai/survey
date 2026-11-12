import type { Evidence, TrustBundle, VerificationPolicy } from "@kontourai/surface";
import { publicFieldReviewExample } from "../example-data/public-field-review.js";
import { buildSurveyTrustBundle } from "../src/index.js";

/**
 * Hand-built test bundles that stand in for Survey output need what Survey
 * now emits for a review (#367): the review policy and an attestation
 * evidence item. Both are taken from a real projection, not restated, so a
 * change to the projection's shape reaches these fixtures too.
 */
const projected = buildSurveyTrustBundle(publicFieldReviewExample);
const policy = projected.policies[0];
const template = projected.evidence.find((item) => item.method === "attestation");
if (!policy || !template) {
  throw new Error("buildSurveyTrustBundle no longer emits a review policy and attestation for a verified review");
}
export const surveyReviewPolicy: VerificationPolicy = policy;

/**
 * Adds a review attestation, linked from the event, for every verified or
 * assumed event that links none, as Survey's projection does. A claim that already resolves a
 * policy (by id, or by a policy for its claim type) keeps it; any other
 * attested claim names Survey's review policy.
 */
export function attestSurveyReviews(bundle: TrustBundle): TrustBundle {
  const evidence: Evidence[] = [...bundle.evidence];
  const attestationIds = new Set(bundle.evidence.filter((item) => item.method === "attestation").map((item) => item.id));
  const events = bundle.events.map((event) => {
    if (event.status !== "verified" && event.status !== "assumed") return event;
    // Projected by Survey already (for example a schema-mapping bundle).
    if (event.evidenceIds.some((id) => attestationIds.has(id))) return event;
    const attestation: Evidence = {
      ...structuredClone(template!),
      id: `${event.id}.review-attestation`,
      claimId: event.claimId,
      sourceRef: `survey:review-outcome:${event.id}`,
      excerptOrSummary: `Review recorded ${event.status} by ${event.actor}.`,
      observedAt: event.verifiedAt ?? event.createdAt,
      collectedBy: event.actor,
      metadata: { ...template!.metadata, reviewOutcomeId: event.id },
    };
    evidence.push(attestation);
    return { ...event, evidenceIds: [...event.evidenceIds, attestation.id] };
  });
  const attested = new Set(events.filter((event) => event.status === "verified" || event.status === "assumed").map((event) => event.claimId));
  let needsPolicy = false;
  const claims = bundle.claims.map((claim) => {
    if (!attested.has(claim.id) || claim.verificationPolicyId) return claim;
    if (bundle.policies.some((candidate) => candidate.claimType === claim.claimType)) return claim;
    needsPolicy = true;
    return { ...claim, verificationPolicyId: surveyReviewPolicy.id };
  });
  const policies = needsPolicy && !bundle.policies.some((candidate) => candidate.id === surveyReviewPolicy.id)
    ? [...bundle.policies, surveyReviewPolicy]
    : bundle.policies;
  return { ...bundle, claims, evidence, policies, events };
}
