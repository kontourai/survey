import type { ReviewOutcome, ReviewStatus } from "./types.js";

/**
 * The neutral trust-artifact shape Kontour Flow consumes through
 * `flow attach-evidence --trust-artifact`. Flow evaluates only these fields
 * plus its own definition and project config; Survey stays the producer-side
 * authority for what the review actually decided.
 */
export interface FlowTrustArtifact {
  schema_version: "0.1";
  artifact_type: "trust-report";
  subject: string;
  producer: string;
  status: string;
  issued_at: string;
  authority_traces: string[];
  claims: Array<{ type: string; subject: string; status: string }>;
}

export interface FlowTrustArtifactOptions {
  /** Flow claim type the gate expects, e.g. "adversarial.review". */
  claimType: string;
  /** Flow claim subject the gate expects, e.g. "adversarial-pass.review". */
  subject: string;
  /** Producer identity recorded on the artifact, e.g. "survey/adversarial-workbench". */
  producer: string;
  /** Defaults to the review outcome's reviewedAt, then the current time. */
  issuedAt?: string;
  /** Defaults to ["survey:review-outcome/<outcome id>"]. */
  authorityTraces?: string[];
  /** Override the ReviewStatus -> artifact status projection per entry. */
  statusMap?: Partial<Record<ReviewStatus, string>>;
}

const defaultStatusMap: Record<ReviewStatus, string> = {
  verified: "trusted",
  assumed: "assumed",
  proposed: "proposed",
  rejected: "rejected",
};

/**
 * Projects a Survey ReviewOutcome into the neutral trust artifact Flow
 * consumes, so a per-round review (including an adversarial pass) can satisfy
 * or fail a Flow gate without Flow learning Survey vocabulary.
 */
export function flowTrustArtifactFromReviewOutcome(
  outcome: ReviewOutcome,
  options: FlowTrustArtifactOptions,
): FlowTrustArtifact {
  if (!outcome.id) {
    throw new Error("flowTrustArtifactFromReviewOutcome requires a review outcome id");
  }
  const statusMap = { ...defaultStatusMap, ...options.statusMap };
  const status = statusMap[outcome.status];
  if (!status) {
    throw new Error(`flowTrustArtifactFromReviewOutcome: unmapped review status '${outcome.status}'`);
  }
  return {
    schema_version: "0.1",
    artifact_type: "trust-report",
    subject: options.subject,
    producer: options.producer,
    status,
    issued_at: options.issuedAt ?? outcome.reviewedAt ?? new Date().toISOString(),
    authority_traces: options.authorityTraces ?? [`survey:review-outcome/${outcome.id}`],
    claims: [{ type: options.claimType, subject: options.subject, status }],
  };
}
