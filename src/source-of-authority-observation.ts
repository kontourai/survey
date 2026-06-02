import type { SurveyObservationInput } from "./builder.js";
import { buildObservation } from "./observation-helper.js";
import type { ClaimTarget, ReviewStatus } from "./types.js";

export type SourceAuthorityClass =
  | "official_publication"
  | "system_of_record"
  | "publisher_owned_page"
  | "contract_record"
  | "policy_document"
  | "other";

export interface SourceAuthorityMetadata {
  authorityClass: SourceAuthorityClass;
  scope: Record<string, unknown>;
  effectiveFrom?: string;
  effectiveUntil?: string;
  sourceVersion?: string;
  sourceOwner?: string;
  declaredBy: string;
  metadata?: Record<string, unknown>;
}

export interface SourceOfAuthorityObservationInput<TValue> {
  id: string;
  field: string;
  value: TValue;
  sourceAuthority: SourceAuthorityMetadata;
  rawSource: SurveyObservationInput["rawSource"];
  extraction: Omit<SurveyObservationInput["extraction"], "target" | "value" | "excerpt"> & {
    target?: string;
    excerpt?: string | null;
  };
  reviewOutcome?: SurveyObservationInput["reviewOutcome"];
  claim: Omit<SurveyObservationInput["claim"], "fieldOrBehavior" | "value"> & {
    fieldOrBehavior?: string;
  };
  candidate?: SurveyObservationInput["candidate"];
  candidateSet?: SurveyObservationInput["candidateSet"];
  metadata?: Record<string, unknown>;
}

export function sourceOfAuthorityObservation<TValue>(
  input: SourceOfAuthorityObservationInput<TValue>,
): SurveyObservationInput {
  assertSourceAuthority(input.sourceAuthority, input.id);
  assertVerifiedPosture(input);

  const sourceAuthority = {
    ...input.sourceAuthority,
    scope: { ...input.sourceAuthority.scope },
    metadata: input.sourceAuthority.metadata
      ? { ...input.sourceAuthority.metadata }
      : undefined,
  };

  return buildObservation({
    ...input,
    extraction: {
      ...input.extraction,
      metadata: {
        ...input.extraction.metadata,
        sourceAuthority,
      },
    },
    surveyMetadata: {
      sourceOfAuthority: {
        authorityClass: sourceAuthority.authorityClass,
      },
    },
    defaultExcerpt: `${input.field}: ${valueSummary(input.value)}`,
  });
}

function assertSourceAuthority(sourceAuthority: SourceAuthorityMetadata, observationId: string): void {
  if (!sourceAuthority.authorityClass) {
    throw new Error(`Source-of-authority observation ${observationId} needs sourceAuthority.authorityClass`);
  }
  if (!sourceAuthority.declaredBy) {
    throw new Error(`Source-of-authority observation ${observationId} needs sourceAuthority.declaredBy`);
  }
  if (!isRecord(sourceAuthority.scope) || Object.keys(sourceAuthority.scope).length === 0) {
    throw new Error(`Source-of-authority observation ${observationId} needs sourceAuthority.scope`);
  }
}

function assertVerifiedPosture<TValue>(input: SourceOfAuthorityObservationInput<TValue>): void {
  const status = claimStatus(input.claim.status, input.reviewOutcome?.status);
  if (status !== "verified" && status !== "assumed") return;

  if (!input.rawSource.sourceRef) {
    throw new Error(`Source-of-authority observation ${input.id} cannot be ${status} without a source reference`);
  }
  if (!input.extraction.locator) {
    throw new Error(`Source-of-authority observation ${input.id} cannot be ${status} without a source locator`);
  }
  if (!input.reviewOutcome) {
    throw new Error(`Source-of-authority observation ${input.id} cannot be ${status} without a review outcome`);
  }
  if (!input.reviewOutcome.actor) {
    throw new Error(`Source-of-authority observation ${input.id} cannot be ${status} without review actor authority`);
  }
  if (!input.reviewOutcome.reviewedAt) {
    throw new Error(`Source-of-authority observation ${input.id} cannot be ${status} without reviewedAt`);
  }
}

function claimStatus(
  claimStatusValue: ClaimTarget["status"] | undefined,
  reviewStatus: ReviewStatus | undefined,
): ClaimTarget["status"] | undefined {
  return claimStatusValue ?? reviewStatus;
}

function valueSummary(value: unknown): string {
  if (value === null || value === undefined) return "<empty>";
  return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
