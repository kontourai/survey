/**
 * Tests for the statement-level badge in `surveyAgentUtterance`.
 *
 * The property under test is that a badge grades THE STATEMENT, not the
 * target: it is a function of both the bundle's answer status and the
 * statement's own asserted value. Before this suite existed the badge read
 * only `record.answer?.status`, so an agent asserting a value that the
 * verified claim denies was badged "verified" — a green badge beside a false
 * sentence.
 *
 * Every assertion here is written to go red if the comparison is removed:
 * the contradiction cases assert an exact badge that only a value-aware
 * implementation can produce, and the pass-through cases pin the statuses
 * that used to fall through to "unsupported".
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TrustBundle, TrustStatus } from "@kontourai/surface";
import { surveyAgentUtterance, referenceUtteranceExtractor } from "../src/agent-utterance.js";
import type { ExtractedStatement, UtteranceClaimExtractor } from "../src/agent-utterance.js";

const NOW = new Date("2026-06-10T00:00:00.000Z");
const TARGET = { subjectType: "unknown", subjectId: "acme", fieldOrBehavior: "status" } as const;

/**
 * A bundle holding exactly one claim about `unknown/acme/status`, with a
 * terminal verification event that drives the derived answer status.
 *
 * `eventStatus` is the status the event records; the derived answer status is
 * whatever Surface's status function folds it to, which is not always the
 * same string (a "revoked" event folds to "stale", a "proposed" event folds
 * to "unknown"). Tests therefore assert the badge against the DERIVED status
 * read back off the InquiryRecord, never against the event's own string.
 */
function makeBundle(value: unknown, eventStatus: TrustStatus | null = "verified"): TrustBundle {
  return {
    schemaVersion: 3,
    source: "test.agent-utterance-badge",
    claims: [
      {
        id: "claim.acme.status",
        subjectType: "unknown",
        subjectId: "acme",
        facet: "test.profile",
        claimType: "test.field",
        fieldOrBehavior: "status",
        value,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
      },
    ],
    evidence: [],
    policies: [],
    events:
      eventStatus === null
        ? []
        : [
            {
              id: `event.acme.${eventStatus}`,
              claimId: "claim.acme.status",
              status: eventStatus,
              actor: "reviewer",
              method: "attestation",
              evidenceIds: [],
              createdAt: "2026-06-01T00:00:00.000Z",
              verifiedAt: "2026-06-01T00:00:00.000Z",
            },
          ],
  };
}

/** A bundle whose claim was verified long enough ago to have gone stale. */
function makeStaleBundle(value: unknown): TrustBundle {
  const bundle = makeBundle(value, "verified");
  bundle.claims[0]!.verificationPolicyId = "policy.short";
  bundle.policies = [
    {
      id: "policy.short",
      claimType: "test.field",
      requiredEvidence: [],
      acceptanceCriteria: [],
      reviewAuthority: "operator",
      validityRule: { kind: "duration", durationDays: 5 },
      stalenessTriggers: [],
      conflictRules: [],
      impactLevel: "low",
    },
  ];
  bundle.events[0]!.createdAt = "2026-01-01T00:00:00.000Z";
  bundle.events[0]!.verifiedAt = "2026-01-01T00:00:00.000Z";
  return bundle;
}

/**
 * An extractor that emits exactly the statements it is given, so a test can
 * assert a specific asserted VALUE and TYPE. The reference extractor only
 * ever produces strings pulled out of prose, which cannot express "the agent
 * asserted the number 95".
 */
function fixedExtractor(statements: ExtractedStatement[], name = "fixed-extractor"): UtteranceClaimExtractor {
  return { name, extract: () => statements };
}

function statement(overrides: Partial<ExtractedStatement> = {}): ExtractedStatement {
  return {
    target: { ...TARGET },
    value: "active",
    excerpt: "acme status is active",
    span: { start: 0, end: 21 },
    confidence: 0.7,
    ...overrides,
  };
}

async function survey(utterance: string, extractor: UtteranceClaimExtractor, bundle: TrustBundle) {
  return surveyAgentUtterance(utterance, extractor, { bundle, now: NOW, agentId: "test-agent" });
}

// ---------------------------------------------------------------------------
// The headline defect: a contradicting statement must not read as support
// ---------------------------------------------------------------------------

describe("surveyAgentUtterance — badge grades the statement, not the target", () => {
  it("does NOT badge verified when the asserted value contradicts the verified claim", async () => {
    const bundle = makeBundle("active", "verified");
    const report = await survey(
      "acme status is revoked",
      fixedExtractor([statement({ value: "revoked", excerpt: "acme status is revoked" })]),
      bundle,
    );

    const stmt = report.statements[0]!;
    assert.equal(stmt.inquiryRecord.answer?.status, "verified", "precondition: the bundle's answer is verified");
    assert.notEqual(stmt.badge, "verified");
    assert.equal(stmt.badge, "contradicted");
    assert.equal(stmt.valueComparison, "contradicts");
  });

  it("badges verified only when the asserted value agrees with the verified claim", async () => {
    const report = await survey("acme status is active", fixedExtractor([statement()]), makeBundle("active", "verified"));
    const stmt = report.statements[0]!;
    assert.equal(stmt.badge, "verified");
    assert.equal(stmt.valueComparison, "agrees");
  });

  it("badges an invented value of the wrong type as contradicted, not verified", async () => {
    const report = await survey(
      "acme status is 42",
      fixedExtractor([statement({ value: 42, excerpt: "acme status is 42" })]),
      makeBundle("active", "verified"),
    );
    assert.equal(report.statements[0]!.badge, "contradicted");
  });

  it("surfaces the asserted value verbatim so a reader can see what was compared", async () => {
    const report = await survey(
      "acme status is REVOKED",
      fixedExtractor([statement({ value: "REVOKED", excerpt: "acme status is REVOKED" })]),
      makeBundle("active", "verified"),
    );
    const stmt = report.statements[0]!;
    // Verbatim: not trimmed, not lowercased, not defaulted to null.
    assert.equal(stmt.assertedValue, "REVOKED");
    assert.match(stmt.comparisonRationale, /revoked/);
    assert.match(stmt.comparisonRationale, /active/);
  });

  it("contradiction also overrides an assumed and a stale answer (the other statuses that read as support)", async () => {
    const assumed = await survey(
      "acme status is revoked",
      fixedExtractor([statement({ value: "revoked" })]),
      makeBundle("active", "assumed"),
    );
    assert.equal(assumed.statements[0]!.inquiryRecord.answer?.status, "assumed");
    assert.equal(assumed.statements[0]!.badge, "contradicted");

    const stale = await survey(
      "acme status is revoked",
      fixedExtractor([statement({ value: "revoked" })]),
      makeStaleBundle("active"),
    );
    assert.equal(stale.statements[0]!.inquiryRecord.answer?.status, "stale");
    assert.equal(stale.statements[0]!.badge, "contradicted");
  });

  it("leaves a non-supporting answer status as the badge, while still recording the contradiction", async () => {
    for (const eventStatus of ["disputed", "rejected"] as const) {
      const report = await survey(
        "acme status is revoked",
        fixedExtractor([statement({ value: "revoked" })]),
        makeBundle("active", eventStatus),
      );
      const stmt = report.statements[0]!;
      assert.equal(stmt.badge, eventStatus, `expected the ${eventStatus} claim's own standing to be the badge`);
      assert.equal(stmt.valueComparison, "contradicts", "the contradiction is still legible on the statement");
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-boundary value comparison
// ---------------------------------------------------------------------------

describe("surveyAgentUtterance — statement-vs-answer comparison", () => {
  it("bridges a prose token to a typed producer value instead of accusing it", async () => {
    // The agent wrote "95"; the producer stored the number 95. A typeof-strict
    // comparison would badge this true statement as a contradiction.
    const report = await survey(
      "acme status is 95",
      fixedExtractor([statement({ value: "95", excerpt: "acme status is 95" })]),
      makeBundle(95, "verified"),
    );
    assert.equal(report.statements[0]!.valueComparison, "agrees");
    assert.equal(report.statements[0]!.badge, "verified");
  });

  it("still catches a genuine numeric disagreement across the same bridge", async () => {
    const report = await survey(
      "acme status is 96",
      fixedExtractor([statement({ value: "96", excerpt: "acme status is 96" })]),
      makeBundle(95, "verified"),
    );
    assert.equal(report.statements[0]!.valueComparison, "contradicts");
    assert.equal(report.statements[0]!.badge, "contradicted");
  });

  it("reports not-compared — never agrees — when the extractor parsed no value", async () => {
    const report = await survey(
      "acme status is discussed at length",
      fixedExtractor([statement({ value: undefined, excerpt: "acme status is discussed at length" })]),
      makeBundle(null, "verified"),
    );
    const stmt = report.statements[0]!;
    assert.equal(stmt.valueComparison, "not-compared");
    assert.equal(Object.prototype.hasOwnProperty.call(stmt, "assertedValue"), false);
    // The claim's own standing still shows through; it is not upgraded or
    // downgraded by the absence of a comparison.
    assert.equal(stmt.badge, "verified");
  });

  it("reports not-compared when the producer's value is not a scalar", async () => {
    const report = await survey(
      "acme status is active",
      fixedExtractor([statement({ value: "active" })]),
      makeBundle({ code: "active" }, "verified"),
    );
    assert.equal(report.statements[0]!.valueComparison, "not-compared");
  });

  it("reports not-compared and unsupported when there is no answer at all", async () => {
    const report = await survey(
      "nosuch thing is whatever",
      fixedExtractor([
        statement({
          target: { subjectType: "unknown", subjectId: "nosuch", fieldOrBehavior: "thing" },
          value: "whatever",
          excerpt: "nosuch thing is whatever",
        }),
      ]),
      makeBundle("active", "verified"),
    );
    const stmt = report.statements[0]!;
    assert.equal(stmt.inquiryRecord.outcome, "unsupported");
    assert.equal(stmt.badge, "unsupported");
    assert.equal(stmt.valueComparison, "not-compared");
  });
});

// ---------------------------------------------------------------------------
// "unsupported" no longer absorbs real statuses
// ---------------------------------------------------------------------------

describe("surveyAgentUtterance — awaiting review is distinguishable from no such claim", () => {
  it("badges a registered-but-unreviewed claim with its own status, not unsupported", async () => {
    const report = await survey("acme status is active", fixedExtractor([statement()]), makeBundle("active", null));
    const stmt = report.statements[0]!;
    assert.equal(stmt.inquiryRecord.outcome, "matched", "the claim IS registered");
    assert.notEqual(stmt.badge, "unsupported");
    assert.equal(stmt.badge, "unknown");
  });

  it("passes every derived answer status through unchanged when the values agree", async () => {
    // Event status → derived answer status. Surface's fold is what decides
    // the right-hand side; the point of the table is that NO status falls
    // through to "unsupported" any more.
    const cases: Array<[TrustStatus | null, TrustStatus]> = [
      ["verified", "verified"],
      ["assumed", "assumed"],
      ["disputed", "disputed"],
      ["rejected", "rejected"],
      ["superseded", "superseded"],
      ["revoked", "stale"],
      ["proposed", "unknown"],
      [null, "unknown"],
    ];
    for (const [eventStatus, expected] of cases) {
      const report = await survey("acme status is active", fixedExtractor([statement()]), makeBundle("active", eventStatus));
      const stmt = report.statements[0]!;
      assert.equal(stmt.inquiryRecord.answer?.status, expected, `derived status for event ${eventStatus}`);
      assert.equal(stmt.badge, expected, `badge for event ${eventStatus}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Locator disclosure
// ---------------------------------------------------------------------------

describe("surveyAgentUtterance — locator resolution is disclosed", () => {
  it("marks a span-supplied locator as resolved from the span", async () => {
    const report = await survey("acme status is active", fixedExtractor([statement()]), makeBundle("active"));
    const stmt = report.statements[0]!;
    assert.equal(stmt.locatorResolution, "span");
    assert.equal(stmt.records.extraction.locator, "text-span:0-21");
  });

  it("marks a locator recovered by finding the excerpt as excerpt-match", async () => {
    const utterance = "preamble. acme status is active";
    const idx = utterance.indexOf("acme status is active");
    const report = await survey(utterance, fixedExtractor([statement({ span: undefined })]), makeBundle("active"));
    const stmt = report.statements[0]!;
    assert.equal(stmt.locatorResolution, "excerpt-match");
    assert.equal(stmt.records.extraction.locator, `text-span:${idx}-${idx + 21}`);
  });

  it("marks a fabricated locator as unanchored-fallback when the excerpt is not in the utterance", async () => {
    const utterance = "acme status is active";
    const excerpt = "acme status was independently confirmed by the registrar";
    assert.equal(utterance.indexOf(excerpt), -1, "fixture must not contain the excerpt");

    const report = await survey(utterance, fixedExtractor([statement({ span: undefined, excerpt })]), makeBundle("active"));
    const stmt = report.statements[0]!;

    assert.equal(stmt.locatorResolution, "unanchored-fallback");
    // The locator value is unchanged from before this fix — well-formed and
    // therefore resolvable against unrelated prose. That is exactly why the
    // resolution has to travel with it.
    assert.equal(stmt.records.extraction.locator, `text-span:0-${excerpt.length}`);
    const meta = stmt.records.extraction.metadata?.agentUtterance as { locatorResolution?: unknown };
    assert.equal(meta.locatorResolution, "unanchored-fallback", "the Extraction record itself must carry the disclosure");
  });
});

// ---------------------------------------------------------------------------
// Provenance reaches the report
// ---------------------------------------------------------------------------

describe("surveyAgentUtterance — provenance is reported, not discarded", () => {
  it("carries the extractor's confidence into the report, so confidence is observable", async () => {
    const high = await survey(
      "acme status is active",
      fixedExtractor([statement({ confidence: 0.99 })]),
      makeBundle("active"),
    );
    const low = await survey(
      "acme status is active",
      fixedExtractor([statement({ confidence: 0.01 })]),
      makeBundle("active"),
    );

    assert.equal(high.statements[0]!.records.extraction.confidence, 0.99);
    assert.equal(low.statements[0]!.records.extraction.confidence, 0.01);
    assert.notEqual(
      JSON.stringify(high.statements[0]!.records),
      JSON.stringify(low.statements[0]!.records),
      "two extractions that disagree about confidence must not serialize identically",
    );
  });

  it("carries the extractor name and per-statement Candidate onto every statement", async () => {
    const report = await survey(
      "acme status is active",
      fixedExtractor([statement()], "named-extractor"),
      makeBundle("active"),
    );
    const stmt = report.statements[0]!;
    assert.equal(stmt.records.extraction.extractor, "named-extractor");
    assert.equal(stmt.records.candidate.id, stmt.records.extraction.id.replace(/\.extraction$/, ".candidate"));
    assert.equal(stmt.records.candidateSet.target, "unknown/acme/status");
  });

  it("surfaces the Candidate Conflict when two statements in one utterance disagree about one target", async () => {
    const report = await survey(
      "acme status is active. acme status is revoked.",
      fixedExtractor([
        statement({ value: "active", excerpt: "acme status is active", span: { start: 0, end: 21 } }),
        statement({ value: "revoked", excerpt: "acme status is revoked", span: { start: 23, end: 45 } }),
      ]),
      makeBundle("active"),
    );

    assert.equal(report.statements.length, 2);
    for (const stmt of report.statements) {
      assert.equal(stmt.records.candidateSet.status, "conflict");
      assert.match(stmt.records.candidateSet.rationale ?? "", /disagree for unknown\/acme\/status/);
    }
    // The two statements share one Candidate Set (grouped by target) but keep
    // their own Candidates.
    assert.equal(report.statements[0]!.records.candidateSet.id, report.statements[1]!.records.candidateSet.id);
    assert.notEqual(report.statements[0]!.records.candidate.id, report.statements[1]!.records.candidate.id);
  });
});

// ---------------------------------------------------------------------------
// The documented happy path, end to end, through the reference extractor
// ---------------------------------------------------------------------------

describe("surveyAgentUtterance — reference extractor end to end", () => {
  it("badges a false sentence produced by the documented extractor as contradicted", async () => {
    const report = await survey("acme status is revoked", referenceUtteranceExtractor, makeBundle("active", "verified"));
    const stmt = report.statements.find((s) => s.target.fieldOrBehavior === "status");
    assert.ok(stmt, "expected a status statement");
    assert.equal(stmt.badge, "contradicted");
    assert.equal(stmt.assertedValue, "revoked");
  });
});
