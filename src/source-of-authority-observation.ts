import type { SurveyObservationInput } from "./builder.js";
import { buildObservation } from "./observation-helper.js";
import { assertReviewOutcomeDiscipline } from "./producer-discipline.js";
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

export interface SourceOfAuthorityObservationBuilderArgs<TValue> {
  id: string;
  field: string;
  value: TValue;
}

type SourceOfAuthorityObservationBuilderState<TValue> = Partial<SourceOfAuthorityObservationInput<TValue>> &
  SourceOfAuthorityObservationBuilderArgs<TValue>;

export class SourceOfAuthorityObservationBuilder<TValue> {
  private readonly state: SourceOfAuthorityObservationBuilderState<TValue>;

  constructor(args: SourceOfAuthorityObservationBuilderArgs<TValue>) {
    this.state = { ...args };
  }

  static create<TValue>(
    args: SourceOfAuthorityObservationBuilderArgs<TValue>,
  ): SourceOfAuthorityObservationBuilder<TValue> {
    return new SourceOfAuthorityObservationBuilder(args);
  }

  withSourceAuthority(sourceAuthority: SourceAuthorityMetadata): this {
    this.state.sourceAuthority = sourceAuthority;
    return this;
  }

  fromSource(rawSource: SourceOfAuthorityObservationInput<TValue>["rawSource"]): this {
    this.state.rawSource = rawSource;
    return this;
  }

  withExtraction(extraction: SourceOfAuthorityObservationInput<TValue>["extraction"]): this {
    this.state.extraction = extraction;
    return this;
  }

  withReviewOutcome(reviewOutcome: SourceOfAuthorityObservationInput<TValue>["reviewOutcome"]): this {
    this.state.reviewOutcome = reviewOutcome;
    return this;
  }

  forClaim(claim: SourceOfAuthorityObservationInput<TValue>["claim"]): this {
    this.state.claim = claim;
    return this;
  }

  withCandidate(candidate: SourceOfAuthorityObservationInput<TValue>["candidate"]): this {
    this.state.candidate = candidate;
    return this;
  }

  withCandidateSet(candidateSet: SourceOfAuthorityObservationInput<TValue>["candidateSet"]): this {
    this.state.candidateSet = candidateSet;
    return this;
  }

  withMetadata(metadata: Record<string, unknown>): this {
    this.state.metadata = metadata;
    return this;
  }

  build(): SurveyObservationInput {
    return sourceOfAuthorityObservation(completeBuilderState(this.state));
  }
}

export function sourceOfAuthorityObservationBuilder<TValue>(
  args: SourceOfAuthorityObservationBuilderArgs<TValue>,
): SourceOfAuthorityObservationBuilder<TValue> {
  return SourceOfAuthorityObservationBuilder.create(args);
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

function completeBuilderState<TValue>(
  state: SourceOfAuthorityObservationBuilderState<TValue>,
): SourceOfAuthorityObservationInput<TValue> {
  return {
    id: state.id,
    field: state.field,
    value: state.value,
    sourceAuthority: requireBuilderField(state.sourceAuthority, state.id, "sourceAuthority"),
    rawSource: requireBuilderField(state.rawSource, state.id, "rawSource"),
    extraction: requireBuilderField(state.extraction, state.id, "extraction"),
    reviewOutcome: state.reviewOutcome,
    claim: requireBuilderField(state.claim, state.id, "claim"),
    candidate: state.candidate,
    candidateSet: state.candidateSet,
    metadata: state.metadata,
  };
}

function requireBuilderField<TValue>(
  value: TValue | undefined,
  observationId: string,
  field: string,
): TValue {
  if (value === undefined) {
    throw new Error(`Source-of-authority observation ${observationId} builder needs ${field}`);
  }
  return value;
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
  assertReviewOutcomeDiscipline({
    subject: `Source-of-authority observation ${input.id}`,
    status,
    review: input.reviewOutcome,
  });
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
