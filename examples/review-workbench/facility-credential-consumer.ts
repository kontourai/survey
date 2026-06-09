import { facilityCredentialReviewItemFixture } from "../../src/review-workbench/review-workbench-data.js";
import {
  buildReviewItemPresentation,
  buildReviewResultPresentation,
  buildReviewSessionEvents,
  buildSurfaceProjectionPreview,
  deriveReviewSessionApplyResultForSnapshot,
  initialReviewQueueSessionState,
  persistReviewSessionEvents,
  type ReviewPresentationAdapter,
} from "../../src/review-workbench/review-workbench.js";
import type { ReviewSessionEvent } from "../../src/review-resource.js";

export const facilityCredentialPresentationAdapter: ReviewPresentationAdapter = {
  labelForTarget: (target) => target === "operatingLicenseCredential"
    ? "Operating license credential"
    : undefined,
  labelForCandidateRole: (role) => role === "current"
    ? "Current managed credential"
    : role === "proposed"
      ? "Registry candidate"
      : undefined,
  summarizeValue: (value) => {
    if (!isCredentialValue(value)) {
      return undefined;
    }

    const serviceSummary = value.permittedServices.length === 0
      ? "no listed services"
      : value.permittedServices.join(", ");

    return `${value.licenseNumber} is ${value.status} through ${value.expiresAt}; services: ${serviceSummary}`;
  },
  linkForReviewItem: (item) => ({
    label: typeof item.metadata.producer?.displayName === "string"
      ? item.metadata.producer.displayName
      : "Review item",
    href: `/review/items/${encodeURIComponent(item.metadata.name)}`,
  }),
  linkForSource: (sourceRef, { candidate }) => ({
    label: candidate.role === "current" ? "Managed record" : "Registry source",
    href: sourceRef.startsWith("http") ? sourceRef : `/sources/${encodeURIComponent(sourceRef)}`,
  }),
  linkForTraceRef: (ref) => {
    if (ref.kind === "claim") {
      return {
        label: "Claim target",
        href: `/claims/${encodeURIComponent(ref.value)}`,
      };
    }

    if (ref.kind === "candidate-set") {
      return {
        label: "Candidate set",
        href: `/candidate-sets/${encodeURIComponent(ref.value)}`,
      };
    }

    return undefined;
  },
};

export async function buildFacilityCredentialConsumerExample(): Promise<FacilityCredentialConsumerExample> {
  const reviewedSnapshot = {
    ...initialReviewQueueSessionState([facilityCredentialReviewItemFixture]),
    actorId: "review-operator@example.test",
    reviewedAt: "2026-01-17T16:15:00.000Z",
    decisionsByItemName: {
      [facilityCredentialReviewItemFixture.metadata.name]: "accept-proposed" as const,
    },
    notesByItemName: {
      [facilityCredentialReviewItemFixture.metadata.name]: "Registry credential supersedes the managed snapshot.",
    },
  };

  const eventsToPersist = buildReviewSessionEvents(reviewedSnapshot);
  const persistedEvents: ReviewSessionEvent[] = [];
  const persisted = await persistReviewSessionEvents({
    session: reviewedSnapshot,
    events: eventsToPersist,
    expectedEventCount: persistedEvents.length,
    persist: async ({ events, expectedEventCount }) => {
      if (expectedEventCount !== persistedEvents.length) {
        throw new Error(`Expected ${expectedEventCount} persisted events, found ${persistedEvents.length}.`);
      }

      persistedEvents.splice(0, persistedEvents.length, ...events);
      return { eventCount: persistedEvents.length };
    },
  });

  const applyResult = deriveReviewSessionApplyResultForSnapshot({
    snapshot: reviewedSnapshot,
    events: persisted.events,
    requiredResolvedItems: "all",
  });
  if (!applyResult.ok) {
    throw new Error(`Expected persisted credential events to replay before apply: ${applyResult.issues.map((issue) => issue.message).join(" ")}`);
  }
  const [result] = applyResult.results;
  if (!result) {
    throw new Error("Expected the reviewed credential snapshot to produce one review result.");
  }

  const itemPresentation = buildReviewItemPresentation(
    facilityCredentialReviewItemFixture,
    facilityCredentialPresentationAdapter,
  );
  const resultPresentation = buildReviewResultPresentation(
    result,
    facilityCredentialReviewItemFixture,
    facilityCredentialPresentationAdapter,
  );
  const surfaceProjectionPreview = buildSurfaceProjectionPreview(
    facilityCredentialReviewItemFixture,
    result.reviewDecision,
    facilityCredentialPresentationAdapter,
  );
  if (!surfaceProjectionPreview) {
    throw new Error("Expected the reviewed credential result to produce a Surface projection preview.");
  }

  return {
    reviewItem: facilityCredentialReviewItemFixture,
    reviewedSnapshot,
    eventsToPersist,
    persistedEvents: persisted.events,
    persistedEventCount: persisted.eventCount,
    applyResult,
    itemPresentation,
    resultPresentation,
    surfaceProjectionPreview,
  };
}

export const facilityCredentialConsumerExample = await buildFacilityCredentialConsumerExample();

export interface FacilityCredentialConsumerExample {
  readonly reviewItem: typeof facilityCredentialReviewItemFixture;
  readonly reviewedSnapshot: ReturnType<typeof initialReviewQueueSessionState>;
  readonly eventsToPersist: readonly ReviewSessionEvent[];
  readonly persistedEvents: readonly ReviewSessionEvent[];
  readonly persistedEventCount: number;
  readonly applyResult: Extract<ReturnType<typeof deriveReviewSessionApplyResultForSnapshot>, { readonly ok: true }>;
  readonly itemPresentation: ReturnType<typeof buildReviewItemPresentation>;
  readonly resultPresentation: ReturnType<typeof buildReviewResultPresentation>;
  readonly surfaceProjectionPreview: NonNullable<ReturnType<typeof buildSurfaceProjectionPreview>>;
}

function isCredentialValue(value: unknown): value is {
  readonly licenseNumber: string;
  readonly status: string;
  readonly expiresAt: string;
  readonly permittedServices: readonly string[];
} {
  return typeof value === "object"
    && value !== null
    && "licenseNumber" in value
    && typeof value.licenseNumber === "string"
    && "status" in value
    && typeof value.status === "string"
    && "expiresAt" in value
    && typeof value.expiresAt === "string"
    && "permittedServices" in value
    && Array.isArray(value.permittedServices)
    && value.permittedServices.every((service) => typeof service === "string");
}
