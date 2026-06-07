export type DownstreamProposalStatus = "PENDING" | "APPROVED" | "REJECTED" | "SKIPPED";

export interface DownstreamFieldDiff {
  old: unknown;
  new: unknown;
  confidence: number;
  excerpt?: string;
  sourceUrl?: string;
  mode?: "update" | "populate" | "add_items";
}

export interface DownstreamPublicDirectoryProposal {
  id: string;
  publicRecordId: string;
  crawlRunId: string | null;
  createdAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  status: DownstreamProposalStatus;
  sourceUrl: string;
  rawExtraction: Record<string, unknown>;
  proposedChanges: Record<string, DownstreamFieldDiff>;
  overallConfidence: number;
  extractionModel: string;
  reviewerNotes: string | null;
  feedbackTags: string[] | null;
  priority: number;
  appliedFields: string[];
  recordName?: string;
  recordSlug?: string;
  communitySlug?: string;
  providerId?: string | null;
  lastVerifiedAt?: string | null;
  recordData?: Record<string, unknown>;
  fieldTimeline?: Record<string, { lastUpdatedAt: string | null; lastAttestedAt: string | null }>;
  crawlStartedAt?: string;
  crawlCompletedAt?: string | null;
  crawlTrigger?: string;
  crawlTriggeredBy?: string | null;
}

export const downstreamPublicDirectoryProposalFixture = {
  id: "proposal-public-456",
  publicRecordId: "record-123",
  crawlRunId: "crawl-run-2026-05-31",
  createdAt: "2026-05-31T15:00:00.000Z",
  reviewedAt: "2026-06-01T17:20:00.000Z",
  reviewedBy: "review-operator-7",
  status: "REJECTED",
  sourceUrl: "https://example.test/listings/example-program",
  rawExtraction: {
    registrationStatus: "WAITLIST",
    confidence: {
      registrationStatus: 0.82,
    },
    sourceObservedAt: "2026-05-31T15:00:00.000Z",
  },
  proposedChanges: {
    registrationStatus: {
      old: "OPEN",
      new: "WAITLIST",
      confidence: 0.82,
      excerpt: "Join the waitlist for this listing.",
      sourceUrl: "https://example.test/listings/example-program",
      mode: "update",
    },
  },
  overallConfidence: 0.82,
  extractionModel: "example-directory-extractor-2026-05",
  reviewerNotes: "Rejected proposed registration status; retained the current reviewed value.",
  feedbackTags: ["source-text-ambiguous"],
  priority: 0,
  appliedFields: [],
  recordName: "Example Program",
  recordSlug: "example-program",
  communitySlug: "example-community",
  providerId: "provider-789",
  lastVerifiedAt: "2026-05-30T18:00:00.000Z",
  recordData: {
    registrationStatus: "OPEN",
    websiteUrl: "https://example.test/listings/example-program",
    fieldSources: {
      registrationStatus: {
        excerpt: "Registration is open for the example program.",
        sourceUrl: "https://example.test/listings/example-program",
        approvedAt: "2026-05-30T18:00:00.000Z",
      },
    },
  },
  fieldTimeline: {
    registrationStatus: {
      lastUpdatedAt: "2026-05-30T18:05:00.000Z",
      lastAttestedAt: "2026-05-30T18:05:00.000Z",
    },
  },
  crawlStartedAt: "2026-05-31T14:58:00.000Z",
  crawlCompletedAt: "2026-05-31T15:03:00.000Z",
  crawlTrigger: "SCHEDULED",
  crawlTriggeredBy: null,
} satisfies DownstreamPublicDirectoryProposal;
