import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConfidenceBasis, ImpactLevel, TrustStatus } from "@kontourai/surface";
import {
  confidenceBasisForReview,
  defineProductVocabulary,
  stableId,
} from "../src/vocabulary.js";

describe("stableId", () => {
  it("slugifies and joins ordered parts with a dot", () => {
    assert.equal(stableId(["public-record", "entity-123", "current"]), "public-record.entity-123.current");
  });

  it("collapses non-alphanumeric runs, trims edges, and lowercases", () => {
    assert.equal(stableId(["Public Record", "Entity #123", "Proposed!"]), "public-record.entity-123.proposed");
  });

  it("accepts numeric parts", () => {
    assert.equal(stableId(["proposal", 456, "candidate"]), "proposal.456.candidate");
  });

  it("matches the reference algorithm byte-for-byte", () => {
    const reference = (parts: ReadonlyArray<string | number>): string =>
      parts
        .map((p) => String(p).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase())
        .join(".");
    const inputs: ReadonlyArray<ReadonlyArray<string | number>> = [
      ["public-record", "entity-123", "current"],
      ["Regulated Rule", "conflict/2026", 7],
      ["  spaced  ", "MiXeD"],
    ];
    for (const input of inputs) {
      assert.equal(stableId(input), reference(input));
    }
  });
});

describe("defineProductVocabulary", () => {
  it("round-trips the definition it is given, using the canonical facet option", () => {
    const vocabulary = defineProductVocabulary({
      subjectType: "public-directory.entity",
      facet: "public-directory.entity-profile",
      claimTypes: {
        scalarField: "public-data.field",
        scalarFieldCandidate: "public-data.field-candidate",
      },
      decisionEffects: {
        acceptedCandidateValue: "accepted-candidate-value",
        keptCurrentValue: "kept-current-value",
      },
    });

    assert.equal(vocabulary.subjectType, "public-directory.entity");
    assert.equal(vocabulary.facet, "public-directory.entity-profile");
    assert.equal(vocabulary.claimTypes.scalarField, "public-data.field");
    assert.equal(vocabulary.decisionEffects.keptCurrentValue, "kept-current-value");
  });

  it("deep-freezes the returned vocabulary", () => {
    const vocabulary = defineProductVocabulary({
      subjectType: "regulated-rule",
      facet: "regulated-rule.library",
      claimTypes: { rule: "regulated.rule" },
      decisionEffects: { keptCurrentValue: "kept-current-value" },
    });

    assert.equal(Object.isFrozen(vocabulary), true);
    assert.equal(Object.isFrozen(vocabulary.claimTypes), true);
    assert.equal(Object.isFrozen(vocabulary.decisionEffects), true);
    assert.throws(() => {
      (vocabulary.claimTypes as Record<string, string>).rule = "mutated";
    }, TypeError);
  });

  describe("deprecated surface alias (Hachure schema 5 facet rename)", () => {
    it("accepts the legacy surface option, mirrors it onto facet, and warns exactly once across repeated legacy calls", () => {
      const originalWarn = console.warn;
      const warnings: unknown[][] = [];
      console.warn = (...args: unknown[]) => {
        warnings.push(args);
      };
      try {
        const vocabulary = defineProductVocabulary({
          subjectType: "public-directory.entity",
          surface: "public-directory.entity-profile",
          claimTypes: { scalarField: "public-data.field" },
          decisionEffects: { keptCurrentValue: "kept-current-value" },
        });

        assert.equal(vocabulary.facet, "public-directory.entity-profile");
        assert.equal(vocabulary.surface, "public-directory.entity-profile");
        assert.equal(warnings.length, 1);
        assert.match(String(warnings[0]?.[0]), /"surface".*renamed.*"facet"/);

        // A second legacy call in the same process must not warn again — the
        // deprecation notice is warn-once per process, mirroring surface's
        // own validateTrustBundle legacy-facet read shim.
        defineProductVocabulary({
          subjectType: "regulated-rule",
          surface: "regulated-rule.library",
          claimTypes: { rule: "regulated.rule" },
          decisionEffects: { keptCurrentValue: "kept-current-value" },
        });
        assert.equal(warnings.length, 1);
      } finally {
        console.warn = originalWarn;
      }
    });

    it("prefers facet over surface when both are supplied, without warning", () => {
      const originalWarn = console.warn;
      const warnings: unknown[][] = [];
      console.warn = (...args: unknown[]) => {
        warnings.push(args);
      };
      try {
        const vocabulary = defineProductVocabulary({
          subjectType: "public-directory.entity",
          facet: "public-directory.entity-profile",
          surface: "legacy-ignored-value",
          claimTypes: { scalarField: "public-data.field" },
          decisionEffects: { keptCurrentValue: "kept-current-value" },
        });

        assert.equal(vocabulary.facet, "public-directory.entity-profile");
        assert.equal(vocabulary.surface, "public-directory.entity-profile");
        assert.equal(warnings.length, 0);
      } finally {
        console.warn = originalWarn;
      }
    });
  });
});

describe("confidenceBasisForReview", () => {
  // The fixtures below are hand-derived from the two real, unmodified reference
  // algorithms (read fresh, not from this library's own logic) so the tests
  // cannot be tautological. Algorithm identifiers are kept generic per this
  // repo's content-boundary rule (no private-vertical names in tracked files);
  // full external citations are recorded in the session's execution notes.
  //
  // Algorithm A — confidenceBasisFor(status, review, extractionConfidence)
  // (surface-trust-export.ts:453-466):
  //   hasSupport = review || extractionConfidence !== undefined
  //   sourceQuality:     hasSupport ? "moderate" : "unknown"
  //   reviewerAuthority: status === "verified" ? "operator" : "none"
  //   evidenceStrength:  hasSupport ? "moderate" : "none"
  //   impactLevel:       constant "medium" in that algorithm
  //   (never returns "strong" for sourceQuality or evidenceStrength, for any input)
  //
  // Algorithm B — confidenceBasisForCandidate(field, candidate, extracted, verified, status)
  // (surface-adapter.ts:597-611), using its sourceQualityFor (surface-adapter.ts:682-687)
  // and reviewerAuthorityFor (surface-adapter.ts:689-692) helpers:
  //   sourceQuality:     !extracted ? "unknown"
  //                       : sourceType in {corrected_document, high_confidence_document} ? "strong"
  //                       : sourceType === medium_confidence_document ? "moderate"
  //                       : "weak"
  //   reviewerAuthority: status !== "verified" ? "none"
  //                       : !verified ? "none" : verifiedBy === "system" ? "system" : "operator"
  //   evidenceStrength:  status === "verified" ? "strong" : "moderate"
  //   impactLevel:       caller-supplied (field.impactLevel)
  //   (never returns "weak" or "none" for evidenceStrength, for any input)

  function algorithmA(
    status: TrustStatus,
    hasSupport: boolean,
    extractionConfidence?: number,
  ): ConfidenceBasis {
    const basis: ConfidenceBasis = {
      sourceQuality: hasSupport ? "moderate" : "unknown",
      reviewerAuthority: status === "verified" ? "operator" : "none",
      evidenceStrength: hasSupport ? "moderate" : "none",
      impactLevel: "medium",
    };
    if (extractionConfidence !== undefined) {
      basis.extractionConfidence = extractionConfidence;
    }
    return basis;
  }

  const sourceQualityRank: Record<string, number> = { unknown: 0, weak: 1, moderate: 2, strong: 3 };
  const evidenceStrengthRank: Record<string, number> = { none: 0, weak: 1, moderate: 2, strong: 3 };

  describe("bare defaults are the conservative floor", () => {
    it("returns the weakest sourceQuality/evidenceStrength for a verified status", () => {
      assert.deepEqual(confidenceBasisForReview({ status: "verified", impactLevel: "medium" }), {
        sourceQuality: "unknown",
        reviewerAuthority: "operator",
        evidenceStrength: "none",
        impactLevel: "medium",
      });
    });

    it("returns the weakest sourceQuality/evidenceStrength for a non-verified status, even with extractionConfidence present", () => {
      const basis = confidenceBasisForReview({
        status: "proposed",
        impactLevel: "low",
        extractionConfidence: 0.91,
      });
      assert.deepEqual(basis, {
        sourceQuality: "unknown",
        reviewerAuthority: "none",
        evidenceStrength: "none",
        impactLevel: "low",
        extractionConfidence: 0.91,
      });
    });

    it("omits extractionConfidence entirely when not provided", () => {
      const basis = confidenceBasisForReview({ status: "proposed", impactLevel: "low" });
      assert.equal("extractionConfidence" in basis, false);
    });
  });

  describe("reviewerAuthority is the one status-driven default, mirroring Algorithm A exactly", () => {
    for (const status of ["verified", "proposed", "unknown", "assumed", "stale", "disputed", "superseded", "rejected"] as const) {
      it(`status "${status}" -> reviewerAuthority ${status === "verified" ? '"operator"' : '"none"'}`, () => {
        const basis = confidenceBasisForReview({ status, impactLevel: "medium" });
        assert.equal(basis.reviewerAuthority, algorithmA(status, false).reviewerAuthority);
      });
    }
  });

  describe("explicit overrides reproduce Algorithm A exactly, across its input domain", () => {
    const fixtures: Array<{ status: TrustStatus; hasSupport: boolean; extractionConfidence?: number }> = [
      { status: "verified", hasSupport: false },
      { status: "verified", hasSupport: true, extractionConfidence: 0.91 },
      { status: "proposed", hasSupport: false },
      { status: "proposed", hasSupport: true, extractionConfidence: 0.4 },
    ];

    for (const fixture of fixtures) {
      it(`status=${fixture.status} hasSupport=${fixture.hasSupport}`, () => {
        const expected = algorithmA(fixture.status, fixture.hasSupport, fixture.extractionConfidence);
        const actual = confidenceBasisForReview({
          status: fixture.status,
          impactLevel: "medium",
          extractionConfidence: fixture.extractionConfidence,
          sourceQuality: expected.sourceQuality,
          evidenceStrength: expected.evidenceStrength,
        });
        assert.deepEqual(actual, expected);
      });
    }
  });

  describe("explicit overrides reproduce Algorithm B exactly, across its input domain", () => {
    const fixtures: Array<{
      status: TrustStatus;
      sourceQuality: ConfidenceBasis["sourceQuality"];
      reviewerAuthority: ConfidenceBasis["reviewerAuthority"];
      evidenceStrength: ConfidenceBasis["evidenceStrength"];
      impactLevel: ImpactLevel;
      extractionConfidence: number;
    }> = [
      // status=verified, extracted.sourceType=corrected_document, verifiedBy=operator
      {
        status: "verified",
        sourceQuality: "strong",
        reviewerAuthority: "operator",
        evidenceStrength: "strong",
        impactLevel: "high",
        extractionConfidence: 0.97,
      },
      // status=verified, extracted.sourceType=medium_confidence_document, verifiedBy=system
      {
        status: "verified",
        sourceQuality: "moderate",
        reviewerAuthority: "system",
        evidenceStrength: "strong",
        impactLevel: "medium",
        extractionConfidence: 0.6,
      },
      // status=proposed (not verified), extracted present but reviewerAuthority forced to "none"
      {
        status: "proposed",
        sourceQuality: "weak",
        reviewerAuthority: "none",
        evidenceStrength: "moderate",
        impactLevel: "low",
        extractionConfidence: 0.3,
      },
      // status=proposed, no extracted document at all
      {
        status: "proposed",
        sourceQuality: "unknown",
        reviewerAuthority: "none",
        evidenceStrength: "moderate",
        impactLevel: "medium",
        extractionConfidence: 0.5,
      },
    ];

    for (const fixture of fixtures) {
      it(`status=${fixture.status} sourceQuality=${fixture.sourceQuality} evidenceStrength=${fixture.evidenceStrength}`, () => {
        const actual = confidenceBasisForReview(fixture);
        assert.deepEqual(actual, {
          sourceQuality: fixture.sourceQuality,
          reviewerAuthority: fixture.reviewerAuthority,
          evidenceStrength: fixture.evidenceStrength,
          impactLevel: fixture.impactLevel,
          extractionConfidence: fixture.extractionConfidence,
        });
      });
    }
  });

  describe("conservative dominance: bare defaults never outrank Algorithm A for the same status", () => {
    const statuses: TrustStatus[] = ["verified", "proposed", "unknown", "assumed", "stale", "disputed", "superseded", "rejected"];
    const supportCases: Array<{ hasSupport: boolean; extractionConfidence?: number }> = [
      { hasSupport: false },
      { hasSupport: true, extractionConfidence: 0.5 },
    ];

    for (const status of statuses) {
      for (const support of supportCases) {
        it(`status=${status} hasSupport=${support.hasSupport}`, () => {
          const real = algorithmA(status, support.hasSupport, support.extractionConfidence);
          const defaults = confidenceBasisForReview({
            status,
            impactLevel: "medium",
            extractionConfidence: support.extractionConfidence,
          });

          assert.ok(
            sourceQualityRank[defaults.sourceQuality as string] <= sourceQualityRank[real.sourceQuality as string],
            `sourceQuality default (${defaults.sourceQuality}) must not outrank Algorithm A's real value (${real.sourceQuality})`,
          );
          assert.ok(
            evidenceStrengthRank[defaults.evidenceStrength as string] <= evidenceStrengthRank[real.evidenceStrength as string],
            `evidenceStrength default (${defaults.evidenceStrength}) must not outrank Algorithm A's real value (${real.evidenceStrength})`,
          );
        });
      }
    }
  });

  it("lets caller overrides win over the status-driven reviewerAuthority default", () => {
    const basis = confidenceBasisForReview({
      status: "proposed",
      impactLevel: "critical",
      extractionConfidence: 0.8,
      sourceQuality: "strong",
      reviewerAuthority: "domain_expert",
      evidenceStrength: "strong",
    });
    assert.equal(basis.sourceQuality, "strong");
    assert.equal(basis.reviewerAuthority, "domain_expert");
    assert.equal(basis.evidenceStrength, "strong");
  });
});
