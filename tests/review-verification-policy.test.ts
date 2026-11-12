/**
 * Survey's review verification policy (#367).
 *
 * From Surface 5.0 (status function "3"), a claim whose latest event is
 * `verified` derives `proposed` unless a policy that requires something
 * resolves for it and its evidence meets that policy. Survey declares what its
 * review means: every projected claim names the review policy, and an
 * affirming review is projected as attestation evidence that meets it.
 *
 * These tests run on whichever Surface the suite resolves (each
 * `surface-compat` leg pins one) and derive under that version's default
 * status function. The attestation-removal test is the one that holds the
 * policy in force on every version: under "2" as well as "3"/"4", a verified
 * claim without its review attestation derives `proposed` only because the
 * policy requires it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildTrustReport,
  resolveInquiry,
  statusFunctionVersion,
  validateTrustBundle,
  type TrustBundle,
} from "@kontourai/surface";
import { publicFieldReviewExample } from "../example-data/public-field-review.js";
import { buildSurveyTrustBundle, resolveQuestion, surveyAgentUtterance, type SurveyInput } from "../src/index.js";
import type { ExtractedStatement, UtteranceClaimExtractor } from "../src/agent-utterance.js";

const REVIEWED = "public-field.entity-123.availability-status.current";
const UNREVIEWED = "public-field.entity-123.availability-status.proposal-456";
const NOW = new Date("2026-06-10T00:00:00.000Z");

function statusOf(bundle: TrustBundle, claimId: string): string | undefined {
  const report = buildTrustReport(validateTrustBundle(bundle), { now: NOW });
  return report.claims.find((claim) => claim.id === claimId)?.status;
}

function withReviewerKind(kind: "human" | "agent"): SurveyInput {
  const input = structuredClone(publicFieldReviewExample);
  input.reviewOutcomes[0]!.reviewerKind = kind;
  return input;
}

describe("Survey review verification policy", () => {
  it(`derives verified for a reviewed claim and proposed for an unreviewed candidate (status function ${statusFunctionVersion})`, () => {
    const bundle = buildSurveyTrustBundle(publicFieldReviewExample);

    assert.equal(statusOf(bundle, REVIEWED), "verified");
    // Negative control: the policy must not verify a candidate nobody reviewed.
    assert.equal(statusOf(bundle, UNREVIEWED), "proposed");
    assert.equal(bundle.evidence.filter((item) => item.claimId === UNREVIEWED && item.method === "attestation").length, 0);
  });

  it("names one policy that requires attestation on every claim, and attests the review the verified event links", () => {
    const bundle = buildSurveyTrustBundle(publicFieldReviewExample);
    assert.equal(bundle.policies.length, 1);
    const policy = bundle.policies[0]!;
    assert.deepEqual(policy.requiredMethods, ["attestation"]);
    assert.deepEqual(policy.requiredEvidence, []);
    assert.equal(policy.validityRule.kind, "manual");
    for (const claim of bundle.claims) assert.equal(claim.verificationPolicyId, policy.id, claim.id);

    const review = publicFieldReviewExample.reviewOutcomes[0]!;
    const attestations = bundle.evidence.filter((item) => item.claimId === REVIEWED && item.method === "attestation");
    assert.equal(attestations.length, 1);
    const attestation = attestations[0]!;
    // A legacy review with no attested kind is a person by inference, and says so.
    assert.equal(attestation.evidenceType, "human_attestation");
    assert.equal(attestation.collectedBy, review.actor);
    assert.equal(attestation.observedAt, review.reviewedAt);
    assert.equal(attestation.sourceRef, `survey:review-outcome:${review.id}`);
    assert.equal(attestation.metadata?.reviewerKindInferred, true);
    const event = bundle.events.find((item) => item.claimId === REVIEWED && item.status === "verified");
    assert.ok(event?.evidenceIds.includes(attestation.id), "the verified event links the review attestation");
  });

  it("derives proposed when the review attestation is removed, on every status function version", () => {
    const bundle = buildSurveyTrustBundle(publicFieldReviewExample);
    const attestationIds = new Set(bundle.evidence.filter((item) => item.method === "attestation").map((item) => item.id));
    assert.ok(attestationIds.size > 0);
    const stripped: TrustBundle = {
      ...bundle,
      evidence: bundle.evidence.filter((item) => !attestationIds.has(item.id)),
      events: bundle.events.map((event) => ({ ...event, evidenceIds: event.evidenceIds.filter((id) => !attestationIds.has(id)) })),
    };
    assert.equal(statusOf(stripped, REVIEWED), "proposed");
  });

  it("attests an agent review as attestation, not human_attestation, and it still verifies with system authority", () => {
    const bundle = buildSurveyTrustBundle(withReviewerKind("agent"));
    const attestation = bundle.evidence.find((item) => item.claimId === REVIEWED && item.method === "attestation");
    assert.equal(attestation?.evidenceType, "attestation");
    assert.equal(attestation?.metadata?.reviewerKind, "agent");
    assert.equal(attestation?.metadata?.reviewerKindInferred, false);
    assert.equal(bundle.claims.find((claim) => claim.id === REVIEWED)?.confidenceBasis?.reviewerAuthority, "system");
    assert.equal(statusOf(bundle, REVIEWED), "verified");

    const human = buildSurveyTrustBundle(withReviewerKind("human"));
    assert.equal(human.evidence.find((item) => item.claimId === REVIEWED && item.method === "attestation")?.evidenceType, "human_attestation");
  });

  it("derives stale when a later event revokes the reviewed claim", () => {
    const bundle = buildSurveyTrustBundle(publicFieldReviewExample);
    bundle.events.push({
      id: "event.revoked",
      claimId: REVIEWED,
      status: "revoked",
      actor: "example-operator",
      method: "survey-review",
      evidenceIds: [],
      createdAt: "2026-06-01T00:00:00.000Z",
    });
    assert.equal(statusOf(bundle, REVIEWED), "stale");
  });

  it("answers an inquiry on the reviewed claim verified, and badges a contradicting statement contradicted", async () => {
    const input = structuredClone(publicFieldReviewExample);
    input.claims = input.claims.filter((claim) => claim.id === REVIEWED);
    const bundle = buildSurveyTrustBundle(input);
    const target = { subjectType: "public-record.entity", subjectId: "entity-123", fieldOrBehavior: "availabilityStatus" };

    const record = resolveInquiry(bundle, { id: "inquiry.1", question: "availability?", target, askedBy: "test", askedAt: NOW.toISOString() }, { now: NOW });
    assert.equal(record.answer?.status, "verified");
    assert.equal(record.statusFunctionVersion, statusFunctionVersion);

    const extractor = (value: string): UtteranceClaimExtractor => ({
      name: "fixed-extractor",
      extract: (): ExtractedStatement[] => [{ target: { ...target, subjectType: "public-record.entity" }, value, excerpt: `status is ${value}`, span: { start: 0, end: 10 }, confidence: 0.9 }],
    });
    const agreeing = await surveyAgentUtterance("status is AVAILABLE", extractor("AVAILABLE"), { bundle, now: NOW, agentId: "agent" });
    assert.equal(agreeing.statements[0]?.badge, "verified");
    const contradicting = await surveyAgentUtterance("status is WAITLIST", extractor("WAITLIST"), { bundle, now: NOW, agentId: "agent" });
    assert.equal(contradicting.statements[0]?.badge, "contradicted");
  });

  it("records the installed Surface's status function version on an unmapped question", () => {
    const bundle = buildSurveyTrustBundle(publicFieldReviewExample);
    const record = resolveQuestion(bundle, "what is unmapped?", { mappings: [], askedBy: "test", now: NOW });
    assert.equal(record.outcome, "unsupported");
    assert.equal(record.statusFunctionVersion, statusFunctionVersion);
    assert.notEqual(record.statusFunctionVersion, "1");
    assert.equal(record.resolvedAt, NOW.toISOString());
  });
});
