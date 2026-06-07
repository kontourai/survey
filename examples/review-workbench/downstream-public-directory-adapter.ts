import { reviewResourceApiVersion, type ReviewCandidate, type ReviewItem } from "../../src/review-resource.js";
import type { DownstreamFieldDiff, DownstreamPublicDirectoryProposal } from "../../fixtures/downstream-public-directory-proposal.js";

export function downstreamPublicDirectoryProposalToReviewItem(
  proposal: DownstreamPublicDirectoryProposal,
  field = firstProposedField(proposal),
): ReviewItem {
  const diff = proposal.proposedChanges[field];
  if (!diff) {
    throw new Error(`Proposal ${proposal.id} does not include proposed field ${field}.`);
  }

  const reviewState = reviewStateForProposal(proposal.status, field);

  const currentCandidate = currentReviewCandidate(proposal, field, diff, reviewState.selectedRole);
  const proposedCandidate = proposedReviewCandidate(proposal, field, diff, reviewState.selectedRole);

  return {
    apiVersion: reviewResourceApiVersion,
    kind: "ReviewItem",
    metadata: reviewItemMetadata(proposal, field),
    spec: {
      target: field,
      candidateSetStatus: reviewState.candidateSetStatus,
      ...optionalSelectedCandidateId(reviewState.selectedCandidateId),
      rationale: proposal.reviewerNotes ?? downstreamDecisionRationale(proposal.status),
      candidates: [currentCandidate, proposedCandidate],
      producerPolicy: {
        owner: "downstream-adapter",
        sourceShape: "public-directory-current-proposed-proposal",
        proposalStatus: proposal.status,
        ...rejectionPolicyForProposal(proposal.status),
        approvedFields: proposal.appliedFields,
        feedbackTags: proposal.feedbackTags,
        opaquePolicyMetadata: {
          priority: proposal.priority,
          crawlTrigger: proposal.crawlTrigger,
          communityScope: proposal.communitySlug,
        },
      },
      projection: selectedProjection(reviewState.selectedRole, currentCandidate, proposedCandidate),
    },
    status: {
      observedCandidateCount: 2,
      ...optionalSelectedCandidateId(reviewState.selectedCandidateId),
      reviewDecisionName: proposal.reviewedAt
        ? `public-directory-${proposal.publicRecordId}-${field}-${proposal.id}-decision`
        : undefined,
    },
  };
}

function reviewItemMetadata(proposal: DownstreamPublicDirectoryProposal, field: string): ReviewItem["metadata"] {
  return {
    name: `public-directory-${proposal.publicRecordId}-${field}-${proposal.id}`,
    uid: proposal.id,
    labels: {
      domain: "public-directory",
      field,
    },
    annotations: {
      "survey.kontourai.io/adapter": "downstream-public-directory",
      "survey.kontourai.io/source-shape": "sanitized-copied-proposal",
    },
    producer: {
      displayName: proposal.recordName ?? "Example Public Record",
      slug: proposal.recordSlug ?? proposal.publicRecordId,
    },
  };
}

function firstProposedField(proposal: DownstreamPublicDirectoryProposal): string {
  const [field] = Object.keys(proposal.proposedChanges);
  if (!field) {
    throw new Error(`Proposal ${proposal.id} does not include proposed changes.`);
  }
  return field;
}

function currentFieldSource(proposal: DownstreamPublicDirectoryProposal, field: string) {
  const fieldSources = proposal.recordData?.fieldSources;
  if (!isRecord(fieldSources)) {
    return {};
  }

  const source = fieldSources[field];
  return isRecord(source)
    ? {
        excerpt: typeof source.excerpt === "string" ? source.excerpt : undefined,
        sourceUrl: typeof source.sourceUrl === "string" ? source.sourceUrl : undefined,
        approvedAt: typeof source.approvedAt === "string" ? source.approvedAt : undefined,
      }
      : {};
}

function currentReviewCandidate(
  proposal: DownstreamPublicDirectoryProposal,
  field: string,
  diff: DownstreamFieldDiff,
  selectedRole: "current" | "proposed" | undefined,
): ReviewCandidate {
  const currentSource = currentFieldSource(proposal, field);
  const observedAt = currentSource.approvedAt ?? proposal.reviewedAt ?? proposal.createdAt;

  return reviewCandidate({
    proposal,
    field,
    diff,
    role: "current",
    value: diff.old,
    sourceId: `public-directory:source:${proposal.publicRecordId}:${field}:current`,
    sourceRef: currentSource.sourceUrl ?? `current-record:${proposal.publicRecordId}:${field}`,
    observedAt,
    excerpt: currentSource.excerpt ?? `Current ${field} value from the reviewed public record.`,
    extractor: "downstream-current-record",
    extractedAt: observedAt,
    confidence: 1,
    sourceRank: selectedRole === "current" ? 1 : 2,
  });
}

function proposedReviewCandidate(
  proposal: DownstreamPublicDirectoryProposal,
  field: string,
  diff: DownstreamFieldDiff,
  selectedRole: "current" | "proposed" | undefined,
): ReviewCandidate {
  return reviewCandidate({
    proposal,
    field,
    diff,
    role: "proposed",
    value: diff.new,
    sourceId: `public-directory:source:${proposal.publicRecordId}:${field}:${proposal.id}`,
    sourceRef: diff.sourceUrl ?? proposal.sourceUrl,
    observedAt: proposal.createdAt,
    excerpt: diff.excerpt ?? `Proposed ${field} value from downstream extraction.`,
    extractor: proposal.extractionModel,
    extractedAt: proposal.createdAt,
    confidence: diff.confidence,
    sourceRank: selectedRole === "proposed" ? 1 : 2,
  });
}

function reviewCandidate(args: {
  proposal: DownstreamPublicDirectoryProposal;
  field: string;
  diff: DownstreamFieldDiff;
  role: "current" | "proposed";
  value: unknown;
  sourceId: string;
  sourceRef: string;
  observedAt: string;
  excerpt: string;
  extractor: string;
  extractedAt: string;
  confidence: number;
  sourceRank: number;
}): ReviewCandidate {
  const id = candidateId(args.field, args.role);
  const extractionId = `public-directory:extraction:${args.proposal.publicRecordId}:${args.field}:${args.proposal.id}:${args.role}`;
  const claimId = candidateClaimId(args);

  return {
    id,
    role: args.role,
    value: args.value,
    confidence: args.confidence,
    sourceRank: args.sourceRank,
    source: candidateSource(args),
    locator: candidateLocator(args),
    extraction: candidateExtraction(args, extractionId),
    claimTarget: candidateClaimTarget(args, claimId),
    projection: candidateProjection(args, id, extractionId, claimId),
    producer: candidateProducerMetadata(args),
  };
}

type CandidateArgs = Parameters<typeof reviewCandidate>[0];

function reviewStateForProposal(
  status: DownstreamPublicDirectoryProposal["status"],
  field: string,
): {
  candidateSetStatus: ReviewItem["spec"]["candidateSetStatus"];
  selectedRole?: "current" | "proposed";
  selectedCandidateId?: string;
} {
  if (status === "APPROVED") {
    return {
      candidateSetStatus: "resolved",
      selectedRole: "proposed",
      selectedCandidateId: candidateId(field, "proposed"),
    };
  }
  if (status === "REJECTED") {
    return {
      candidateSetStatus: "resolved",
      selectedRole: "current",
      selectedCandidateId: candidateId(field, "current"),
    };
  }

  return {
    candidateSetStatus: "needs-review",
  };
}

function optionalSelectedCandidateId(selectedCandidateId: string | undefined): { selectedCandidateId?: string } {
  return selectedCandidateId ? { selectedCandidateId } : {};
}

function rejectionPolicyForProposal(status: DownstreamPublicDirectoryProposal["status"]): Record<string, unknown> {
  return status === "REJECTED"
    ? { rejectionSemantics: "selected-current-keeps-existing-value-and-rejects-proposed-candidate" }
    : {};
}

function selectedProjection(
  selectedRole: "current" | "proposed" | undefined,
  currentCandidate: ReviewCandidate,
  proposedCandidate: ReviewCandidate,
): ReviewCandidate["projection"] | undefined {
  if (selectedRole === "current") {
    return currentCandidate.projection;
  }
  if (selectedRole === "proposed") {
    return proposedCandidate.projection;
  }
  return undefined;
}

function candidateSource(args: CandidateArgs): ReviewCandidate["source"] {
  return {
    sourceId: args.sourceId,
    sourceRef: args.sourceRef,
    kind: args.sourceRef.startsWith("http") ? "web-page" : "manual-entry",
    observedAt: args.observedAt,
    fetchedAt: args.role === "proposed" ? args.proposal.crawlCompletedAt ?? args.observedAt : args.observedAt,
    locatorScheme: args.sourceRef.startsWith("http") ? "html" : "structured-field",
  };
}

function candidateLocator(args: CandidateArgs): ReviewCandidate["locator"] {
  return {
    scheme: args.sourceRef.startsWith("http") ? "html" : "structured-field",
    locator: `field:${args.field}`,
    excerpt: args.excerpt,
  };
}

function candidateExtraction(args: CandidateArgs, extractionId: string): ReviewCandidate["extraction"] {
  return {
    extractionId,
    target: args.field,
    confidence: args.confidence,
    extractor: args.extractor,
    extractedAt: args.extractedAt,
  };
}

function candidateClaimTarget(args: CandidateArgs, claimId: string): ReviewCandidate["claimTarget"] {
  return {
    claimId,
    subjectType: "public-record.entity",
    subjectId: args.proposal.publicRecordId,
    surface: "public-directory.profile",
    claimType: args.role === "current" ? "public-data.field" : "public-data.field-candidate",
    fieldOrBehavior: args.field,
    impactLevel: "medium",
    evidenceType: "source_excerpt",
    evidenceMethod: args.role === "current" ? "attestation" : "extraction",
    collectedBy: args.extractor,
  };
}

function candidateProjection(
  args: CandidateArgs,
  candidateIdValue: string,
  extractionId: string,
  claimId: string,
): ReviewCandidate["projection"] {
  return {
    rawSourceId: args.sourceId,
    extractionId,
    candidateSetId: `public-directory:candidates:${args.proposal.publicRecordId}:${args.field}:${args.proposal.id}`,
    candidateId: candidateIdValue,
    reviewOutcomeId: rejectedCurrentReviewOutcomeId(args),
    claimId,
  };
}

function candidateProducerMetadata(args: CandidateArgs): ReviewCandidate["producer"] {
  const selectedWhenRejected = rejectedCurrentReviewOutcomeId(args) ? { selectedWhenRejected: true } : {};

  return {
    proposalId: args.proposal.id,
    proposalStatus: args.proposal.status,
    previousValue: args.diff.old,
    diffMode: args.diff.mode,
    ...selectedWhenRejected,
    sourceAuthority: {
      authorityClass: "public-directory-listing",
      declaredBy: args.role === "current" ? "Downstream reviewed record" : "Downstream extraction pipeline",
      scope: `${args.field} field on ${args.proposal.publicRecordId}`,
    },
  };
}

function candidateClaimId(args: CandidateArgs): string {
  return args.role === "current"
    ? `public-directory.${args.proposal.publicRecordId}.${args.field}.current`
    : `public-directory.${args.proposal.publicRecordId}.${args.field}.${args.proposal.id}.proposed`;
}

function rejectedCurrentReviewOutcomeId(args: CandidateArgs): string | undefined {
  return args.role === "current" && args.proposal.status === "REJECTED"
    ? `public-directory:review:${args.proposal.publicRecordId}:${args.field}:${args.proposal.id}:keep-current`
    : undefined;
}

function candidateId(field: string, role: "current" | "proposed"): string {
  return `public-directory:candidate:${field}:${role}`;
}

function downstreamDecisionRationale(status: DownstreamPublicDirectoryProposal["status"]): string {
  if (status === "APPROVED") {
    return "Downstream reviewer accepted the proposed value.";
  }
  if (status === "REJECTED") {
    return "Downstream reviewer rejected the proposed value and kept the current value.";
  }
  return "Downstream proposal is awaiting review.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
