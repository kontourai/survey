/**
 * #359: a host-attested `reviewerKind` ("human" | "agent" | "rule") on review
 * outcomes and review session events, projected to Surface
 * `confidenceBasis.reviewerAuthority`, refused when unknown or contradictory,
 * broken out in oversight metrics, carried by entity review outcomes, and never
 * settable by the browser.
 */

import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  applyMappingReview,
  buildCanonicalReviewedTrustInput,
  buildReviewProofAnchor,
  buildSurveyTrustBundle,
  deriveCalibration,
  proposalsToCandidateSet,
  splitRoundForCarryForward,
  createEntityProposal,
  currentProposedReviewItem,
  deriveOversightMetrics,
  entityOutcomeFromDecision,
  entityProposalToReviewItem,
  isReviewerKind,
  oversightMetricsToClaims,
  projectEntityReviews,
  REVIEWER_KINDS,
  SurveyInputBuilder,
} from "../src/index.js";
import type { EntityAlternative, ReviewOutcome, ReviewerKind, SurveyInput } from "../src/index.js";
import { startReviewConsoleServer } from "../src/console/review-console-server.js";
import { reviewResourceApiVersion, type ReviewDecision, type ReviewSessionEvent } from "../src/review-resource.js";
import {
  buildReviewDecision,
  buildReviewSessionEvents,
  buildReviewWorkbenchResultsFromSession,
  initialReviewQueueSessionState,
  replayReviewSessionEvents,
  type ReviewQueueSessionState,
} from "../src/review-workbench/review-workbench.js";
import { appendReviewSessionEvents, type ReviewSessionFileContent } from "../src/review-session-file.js";
import { deriveReviewSessionApplyResultForSnapshot } from "../src/review-workbench/review-workbench.js";

// ---------------------------------------------------------------------------
// Projection: reviewerKind -> confidenceBasis.reviewerAuthority + metadata
// ---------------------------------------------------------------------------

function surveyInput(reviews: ReviewOutcome[]): SurveyInput {
  return {
    source: "survey.reviewer-kind.fixture",
    generatedAt: "2026-11-03T00:00:00.000Z",
    rawSources: [{
      id: "source.1",
      kind: "uploaded-document",
      sourceRef: "documents://entity-1/report.pdf",
      observedAt: "2026-11-01T00:00:00.000Z",
      locatorScheme: "structured-field",
    }],
    extractions: [{
      id: "extraction.1",
      sourceId: "source.1",
      target: "reportedAmount",
      value: 48000,
      confidence: 0.9,
      locator: "structured-field:amount",
      extractor: "document-parser",
      extractedAt: "2026-11-01T00:00:00.000Z",
    }],
    candidateSets: [{
      id: "set.1",
      target: "reportedAmount",
      status: "resolved",
      selectedCandidateId: "candidate.1",
      candidates: [{ id: "candidate.1", extractionId: "extraction.1", value: 48000, confidence: 0.9 }],
    }],
    reviewOutcomes: reviews,
    claims: [{
      id: "claim.1",
      candidateSetId: "set.1",
      candidateId: "candidate.1",
      subjectType: "record.entity",
      subjectId: "entity-1",
      facet: "record.profile",
      claimType: "record.field",
      fieldOrBehavior: "reportedAmount",
      impactLevel: "high",
      collectedBy: "document-parser",
    }],
  };
}

function review(overrides: Partial<ReviewOutcome> = {}): ReviewOutcome {
  return {
    id: "review.1",
    candidateSetId: "set.1",
    candidateId: "candidate.1",
    status: "verified",
    actor: "records-operator",
    reviewedAt: "2026-11-02T00:00:00.000Z",
    ...overrides,
  };
}

function projectedClaim(overrides: Partial<ReviewOutcome> = {}) {
  return buildSurveyTrustBundle(surveyInput([review(overrides)])).claims[0]!;
}

describe("reviewerKind projects to Surface reviewer authority (#359)", () => {
  it("projects human -> operator, agent -> system, rule -> system, and carries the kind as metadata", () => {
    const human = projectedClaim({ reviewerKind: "human" });
    assert.equal(human.confidenceBasis?.reviewerAuthority, "operator");
    assert.equal((human.metadata?.survey as { reviewerKind?: string }).reviewerKind, "human");
    assert.equal((human.metadata?.survey as { reviewerKindInferred?: boolean }).reviewerKindInferred, false);

    const agent = projectedClaim({ reviewerKind: "agent", actor: "triage-agent" });
    assert.equal(agent.confidenceBasis?.reviewerAuthority, "system");
    assert.equal((agent.metadata?.survey as { reviewerKind?: string }).reviewerKind, "agent");
    assert.equal((agent.metadata?.survey as { reviewerKindInferred?: boolean }).reviewerKindInferred, false);

    const rule = projectedClaim({ reviewerKind: "rule", actor: "routing-rule" });
    assert.equal(rule.confidenceBasis?.reviewerAuthority, "system");
    assert.equal((rule.metadata?.survey as { reviewerKind?: string }).reviewerKind, "rule");
  });

  it("an explicit kind outranks what the actor name would imply", () => {
    // An actor id is a label the producer chose; only the attested kind decides authority.
    assert.equal(projectedClaim({ reviewerKind: "agent", actor: "records-operator" }).confidenceBasis?.reviewerAuthority, "system");
    assert.equal(projectedClaim({ reviewerKind: "rule", actor: "records-operator" }).confidenceBasis?.reviewerAuthority, "system");
  });

  it("infers a kind for a legacy record, keeps today's authority, and marks it inferred", () => {
    const legacyHuman = projectedClaim();
    assert.equal(legacyHuman.confidenceBasis?.reviewerAuthority, "operator");
    assert.equal((legacyHuman.metadata?.survey as { reviewerKind?: string }).reviewerKind, "human");
    assert.equal((legacyHuman.metadata?.survey as { reviewerKindInferred?: boolean }).reviewerKindInferred, true);

    const legacyPolicy = projectedClaim({ actor: "auto-accept-policy", status: "assumed", withinComfortZone: true });
    assert.equal(legacyPolicy.confidenceBasis?.reviewerAuthority, "system");
    assert.equal(legacyPolicy.confidenceBasis?.evidenceStrength, "weak");
    assert.equal((legacyPolicy.metadata?.survey as { reviewerKind?: string }).reviewerKind, "rule");
    assert.equal((legacyPolicy.metadata?.survey as { reviewerKindInferred?: boolean }).reviewerKindInferred, true);
  });

  it("an agent-reviewed claim that is not trusted keeps reviewerAuthority none", () => {
    const claim = projectedClaim({ reviewerKind: "agent", status: "rejected" });
    assert.equal(claim.confidenceBasis?.reviewerAuthority, "none");
    assert.equal((claim.metadata?.survey as { reviewerKind?: string }).reviewerKind, "agent");
  });

  it("a producer cannot supply the reviewer kind through claim metadata", () => {
    const base = surveyInput([review({ reviewerKind: "agent" })]);
    const forged: SurveyInput = {
      ...base,
      claims: [{ ...base.claims[0]!, metadata: { survey: { reviewerKind: "human", reviewerKindInferred: false } } }],
    };
    const survey = buildSurveyTrustBundle(forged).claims[0]!.metadata?.survey as { reviewerKind?: string };
    assert.equal(survey.reviewerKind, "agent");

    const unreviewed: SurveyInput = {
      ...base,
      reviewOutcomes: [],
      claims: [{ ...base.claims[0]!, status: "proposed", metadata: { survey: { reviewerKind: "human" } } }],
    };
    assert.equal((buildSurveyTrustBundle(unreviewed).claims[0]!.metadata?.survey as { reviewerKind?: string }).reviewerKind, undefined);
  });
});

describe("reviewerKind validation (#359)", () => {
  it("publishes exactly the three kinds", () => {
    assert.deepEqual([...REVIEWER_KINDS], ["human", "agent", "rule"]);
    assert.equal(isReviewerKind("human"), true);
    assert.equal(isReviewerKind("admin"), false);
    assert.equal(isReviewerKind(undefined), false);
  });

  it("refuses an unknown kind on every record path", () => {
    const bogus = { reviewerKind: "admin" as unknown as ReviewerKind };
    assert.throws(() => buildSurveyTrustBundle(surveyInput([review(bogus)])), /reviewerKind must be one of human, agent, rule/);
    assert.throws(() => new SurveyInputBuilder({ source: "x" }).addReviewOutcome(review(bogus)), /reviewerKind must be one of/);
    // Even a rejected review and a null (a JSON record, not a typed one) are refused.
    assert.throws(() => buildSurveyTrustBundle(surveyInput([review({ ...bogus, status: "rejected" })])), /reviewerKind must be one of/);
    assert.throws(() => buildSurveyTrustBundle(surveyInput([review({ reviewerKind: null as unknown as ReviewerKind })])), /reviewerKind must be one of/);
  });

  it("refuses human on the auto-accept policy actor and accepts rule", () => {
    const policy = { actor: "auto-accept-policy", status: "assumed" as const, withinComfortZone: true };
    assert.throws(
      () => buildSurveyTrustBundle(surveyInput([review({ ...policy, reviewerKind: "human" })])),
      /reviewerKind human contradicts actor auto-accept-policy/,
    );
    assert.throws(
      () => new SurveyInputBuilder({ source: "x" }).addReviewOutcome(review({ ...policy, reviewerKind: "human" })),
      /reviewerKind human contradicts actor auto-accept-policy/,
    );
    const claim = buildSurveyTrustBundle(surveyInput([review({ ...policy, reviewerKind: "rule" })])).claims[0]!;
    assert.equal(claim.confidenceBasis?.reviewerAuthority, "system");
    assert.equal((claim.metadata?.survey as { reviewerKindInferred?: boolean }).reviewerKindInferred, false);
  });
});

// ---------------------------------------------------------------------------
// Workbench: the host's value wins; the browser cannot set the kind
// ---------------------------------------------------------------------------

function reviewedItem() {
  return currentProposedReviewItem({
    name: "availability-review",
    target: "availabilityStatus",
    projection: { candidateSetId: "availability.candidates", claimId: "availability.claim" },
    current: {
      value: "AVAILABLE",
      confidence: 0.94,
      sourceRank: 1,
      source: { sourceId: "directory-current", sourceRef: "https://example.test/current", kind: "web-page", observedAt: "2026-07-20T00:00:00.000Z", checksum: "sha256:current", locatorScheme: "html" },
      locator: { scheme: "html", locator: "#availability", excerpt: "Available" },
      extraction: { extractionId: "availability.current.extraction", target: "availabilityStatus", confidence: 0.94, extractor: "directory-parser", model: "parser-v2", extractedAt: "2026-07-20T00:01:00.000Z" },
      claimTarget: { subjectType: "directory.entity", subjectId: "entity-123", facet: "directory.profile", claimType: "directory.field", fieldOrBehavior: "availabilityStatus", impactLevel: "medium", evidenceType: "source_excerpt", evidenceMethod: "extraction", collectedBy: "directory-producer" },
      projection: { rawSourceId: "directory-current", extractionId: "availability.current.extraction" },
    },
    proposed: {
      value: "WAITLIST",
      confidence: 0.82,
      sourceRank: 2,
      source: { sourceId: "directory-proposed", sourceRef: "https://example.test/proposed", kind: "web-page", observedAt: "2026-07-21T00:00:00.000Z", checksum: "sha256:proposed", locatorScheme: "html" },
      locator: { scheme: "html", locator: "#availability", excerpt: "Waitlist" },
      extraction: { extractionId: "availability.proposed.extraction", target: "availabilityStatus", confidence: 0.82, extractor: "directory-parser", model: "parser-v3", extractedAt: "2026-07-21T00:01:00.000Z" },
      claimTarget: { claimId: "availability.claim", subjectType: "directory.entity", subjectId: "entity-123", facet: "directory.profile", claimType: "directory.field", fieldOrBehavior: "availabilityStatus", impactLevel: "medium", evidenceType: "source_excerpt", evidenceMethod: "extraction", collectedBy: "directory-producer" },
      projection: { rawSourceId: "directory-proposed", extractionId: "availability.proposed.extraction", reviewOutcomeId: "availability.review", claimId: "availability.claim" },
    },
  });
}

/** The host's pre-decision snapshot: nothing decided yet. */
function hostSnapshot(reviewerKind?: ReviewerKind): ReviewQueueSessionState {
  const item = reviewedItem();
  return {
    ...initialReviewQueueSessionState([item]),
    actorId: "reviewer-7",
    reviewedAt: "2026-11-03T12:00:00.000Z",
    ...(reviewerKind !== undefined ? { reviewerKind } : {}),
  };
}

/** What a browser would POST: the reviewer accepted, and the page claimed a kind. */
function browserEvents(snapshot: ReviewQueueSessionState, claimedKind: ReviewerKind): ReviewSessionEvent[] {
  const itemName = snapshot.items[0]!.metadata.name;
  const decided: ReviewQueueSessionState = {
    ...snapshot,
    decisionsByItemName: { [itemName]: "accept-proposed" },
    notesByItemName: { [itemName]: "Checked the cited field." },
  };
  return buildReviewSessionEvents(decided).map((event) => ({
    ...event,
    spec: { ...event.spec, reviewerKind: claimedKind },
  }));
}

describe("the Workbench ignores a browser-supplied reviewer kind (#359)", () => {
  it("stamps the host's kind on decisions and events built from its session", () => {
    const snapshot = hostSnapshot("human");
    const itemName = snapshot.items[0]!.metadata.name;
    const decided: ReviewQueueSessionState = { ...snapshot, decisionsByItemName: { [itemName]: "accept-proposed" }, notesByItemName: { [itemName]: "ok" } };
    assert.equal(buildReviewDecision({ item: snapshot.items[0]!, decision: "accept-proposed", note: "ok", reviewedAt: snapshot.reviewedAt, actorId: "reviewer-7", reviewerKind: "human" })?.spec.reviewerKind, "human");
    const events = buildReviewSessionEvents(decided);
    assert.ok(events.length > 0 && events.every((event) => event.spec.reviewerKind === "human"));
    assert.equal(buildReviewWorkbenchResultsFromSession(decided)[0]!.reviewDecision.spec.reviewerKind, "human");
  });

  it("the host's agent wins over a browser event that claims human", () => {
    const snapshot = hostSnapshot("agent");
    const events = browserEvents(snapshot, "human");
    assert.ok(events.every((event) => event.spec.reviewerKind === "human"), "fixture: the browser claims human");

    const replayed = replayReviewSessionEvents(snapshot, events);
    assert.equal(replayed.reviewerKind, "agent");

    const applied = deriveReviewSessionApplyResultForSnapshot({ snapshot, events });
    assert.equal(applied.ok, true, JSON.stringify(applied.issues));
    assert.equal(applied.decisions[0]!.spec.reviewerKind, "agent");
  });

  it("a snapshot with no kind stays kindless when the browser claims human", () => {
    const snapshot = hostSnapshot();
    const events = browserEvents(snapshot, "human");
    const applied = deriveReviewSessionApplyResultForSnapshot({ snapshot, events });
    assert.equal(applied.ok, true, JSON.stringify(applied.issues));
    assert.equal(applied.decisions[0]!.spec.reviewerKind, undefined);
    assert.equal(replayReviewSessionEvents(snapshot, events).reviewerKind, undefined);
  });

  it("the host's kind flows through the canonical input to a system-authority claim", () => {
    const snapshot = hostSnapshot("agent");
    const item = snapshot.items[0]!;
    const applied = deriveReviewSessionApplyResultForSnapshot({ snapshot, events: browserEvents(snapshot, "human") });
    assert.equal(applied.ok, true, JSON.stringify(applied.issues));
    const projected = buildCanonicalReviewedTrustInput({
      source: "directory-review/session-359",
      generatedAt: "2026-11-03T12:00:01.000Z",
      projectionContextId: "session-359",
      items: [item],
      results: applied.results,
    });
    assert.equal(projected.surveyInput.reviewOutcomes[0]?.reviewerKind, "agent");
    const claim = buildSurveyTrustBundle(projected.surveyInput, { projectionContextId: projected.projectionContextId }).claims[0]!;
    assert.equal(claim.status, "verified");
    assert.equal(claim.confidenceBasis?.reviewerAuthority, "system");
    assert.equal((claim.metadata?.survey as { reviewerKind?: string }).reviewerKind, "agent");
  });

  it("refuses a host session that carries an unknown kind or a policy actor attested human", () => {
    const item = reviewedItem();
    const decided = (overrides: Partial<ReviewQueueSessionState>): ReviewQueueSessionState => ({
      ...hostSnapshot(),
      decisionsByItemName: { [item.metadata.name]: "accept-proposed" },
      ...overrides,
    });
    assert.throws(() => buildReviewWorkbenchResultsFromSession(decided({ reviewerKind: "admin" as unknown as ReviewerKind })), /reviewerKind must be one of/);
    assert.throws(() => buildReviewSessionEvents(decided({ reviewerKind: "admin" as unknown as ReviewerKind })), /reviewerKind must be one of/);
    assert.throws(() => buildReviewWorkbenchResultsFromSession(decided({ actorId: "auto-accept-policy", reviewerKind: "human" })), /contradicts actor auto-accept-policy/);
  });

  it("the stored event log records the host's kind, not the poster's", () => {
    const withKind = (reviewerKind?: ReviewerKind): ReviewSessionFileContent => ({
      session: undefined,
      snapshot: hostSnapshot(reviewerKind),
      events: [],
    });
    const posted = browserEvents(hostSnapshot(), "human");
    for (const event of appendReviewSessionEvents(withKind("agent"), posted)) {
      assert.equal(event.spec.reviewerKind, "agent");
    }
    for (const event of appendReviewSessionEvents(withKind(), posted)) {
      assert.equal(event.spec.reviewerKind, undefined, "no host kind: the poster's claim is dropped");
    }
  });
});

describe("the review console stores the host's kind for events a browser posts (#359)", () => {
  async function postBrowserDecision(hostKind: ReviewerKind | undefined): Promise<ReviewSessionEvent[]> {
    const tmpDir = await mkdtemp(join(tmpdir(), "survey-reviewer-kind-"));
    const sessionPath = join(tmpDir, "session.json");
    await copyFile("example-data/mcp-review-session.json", sessionPath);
    const file = JSON.parse(await readFile(sessionPath, "utf8")) as { snapshot: ReviewQueueSessionState; events: unknown[] };
    if (hostKind !== undefined) file.snapshot = { ...file.snapshot, reviewerKind: hostKind };
    await writeFile(sessionPath, JSON.stringify(file));
    const handle = await startReviewConsoleServer({ sessionPath, port: 0 });
    try {
      const itemName = file.snapshot.items[0]!.metadata.name;
      const decisionEvents = buildReviewSessionEvents({
        ...file.snapshot,
        decisionsByItemName: { [itemName]: "accept-proposed" },
      }).filter((event) => event.spec.eventType.startsWith("decision-")).map((event) => ({
        ...event,
        spec: { ...event.spec, reviewerKind: "human" as const },
      }));
      assert.ok(decisionEvents.length > 0);
      const revision = ((await (await fetch(`${handle.url}api/session`)).json()) as { revision: string }).revision;
      const res = await fetch(`${handle.url}api/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: decisionEvents, baseRevision: revision }),
      });
      assert.equal(res.status, 200, await res.clone().text());
      const stored = JSON.parse(await readFile(sessionPath, "utf8")) as { events: ReviewSessionEvent[] };
      return stored.events.filter((event) => event.spec.eventType.startsWith("decision-"));
    } finally {
      await handle.close();
      await rm(tmpDir, { recursive: true, force: true });
    }
  }

  it("keeps the host's agent when the browser posts human", async () => {
    const stored = await postBrowserDecision("agent");
    assert.ok(stored.length > 0);
    for (const event of stored) assert.equal(event.spec.reviewerKind, "agent");
  });

  it("refuses a post to a session attested human, and stores nothing", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "survey-reviewer-kind-"));
    const sessionPath = join(tmpDir, "session.json");
    await copyFile("example-data/mcp-review-session.json", sessionPath);
    const file = JSON.parse(await readFile(sessionPath, "utf8")) as { snapshot: ReviewQueueSessionState; events: unknown[] };
    file.snapshot = { ...file.snapshot, reviewerKind: "human" };
    await writeFile(sessionPath, JSON.stringify(file));
    const before = file.events.length;
    const handle = await startReviewConsoleServer({ sessionPath, port: 0 });
    try {
      const itemName = file.snapshot.items[0]!.metadata.name;
      const decisionEvents = buildReviewSessionEvents({ ...file.snapshot, decisionsByItemName: { [itemName]: "accept-proposed" } })
        .filter((event) => event.spec.eventType.startsWith("decision-"));
      const revision = ((await (await fetch(`${handle.url}api/session`)).json()) as { revision: string }).revision;
      const res = await fetch(`${handle.url}api/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: decisionEvents, baseRevision: revision }),
      });
      assert.equal(res.status, 403);
      assert.match(((await res.json()) as { error: string }).error, /authenticates nobody/);
      assert.equal(((JSON.parse(await readFile(sessionPath, "utf8")) as { events: unknown[] }).events).length, before);
    } finally {
      await handle.close();
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("drops the browser's human when the host attested no kind", async () => {
    const stored = await postBrowserDecision(undefined);
    assert.ok(stored.length > 0);
    for (const event of stored) assert.equal(event.spec.reviewerKind, undefined);
  });
});

// ---------------------------------------------------------------------------
// Oversight metrics by reviewer kind
// ---------------------------------------------------------------------------

function oversightDecision(id: string, actorId: string, minute: number, reviewerKind?: ReviewerKind): ReviewDecision {
  return {
    apiVersion: reviewResourceApiVersion,
    kind: "ReviewDecision",
    metadata: { name: `decision-${id}` },
    spec: {
      reviewItemName: `item-${id}`,
      candidateId: `candidate-${id}`,
      status: "verified",
      actor: { id: actorId },
      ...(reviewerKind !== undefined ? { reviewerKind } : {}),
      reviewedAt: new Date(Date.UTC(2026, 10, 3, 10, minute)).toISOString(),
    },
  };
}

describe("oversight metrics break decisions down by reviewer kind (#359)", () => {
  const now = new Date("2026-11-03T12:00:00.000Z");

  it("reports a row per kind, counts inferred kinds, and keeps the aggregate whole", () => {
    const metrics = deriveOversightMetrics([
      oversightDecision("1", "alice", 0, "human"),
      oversightDecision("2", "alice", 2, "human"),
      oversightDecision("3", "bob", 3),
      oversightDecision("4", "triage-agent", 4, "agent"),
      oversightDecision("5", "auto-accept-policy", 5),
      oversightDecision("6", "routing-rule", 6, "rule"),
    ], { now, presentedCount: 12 });

    assert.equal(metrics.aggregate.decisionCount, 6);
    assert.deepEqual(
      metrics.byReviewerKind.map((row) => [row.reviewerKind, row.decisionCount, row.inferredDecisionCount]),
      [["human", 3, 1], ["agent", 1, 0], ["rule", 2, 1]],
    );
    assert.equal(metrics.byReviewerKind.reduce((sum, row) => sum + row.decisionCount, 0), metrics.aggregate.decisionCount);
    const human = metrics.byReviewerKind[0]!;
    assert.equal(human.samplingCoverage, 3 / 12);
    // Human decisions fall at minutes 0, 2 and 3: gaps of 120 s and 60 s.
    assert.equal(human.medianInterDecisionSeconds, 90);
  });

  it("omits a kind with no decisions and reports none for no input", () => {
    const humans = deriveOversightMetrics([oversightDecision("1", "alice", 0, "human")], { now });
    assert.deepEqual(humans.byReviewerKind.map((row) => row.reviewerKind), ["human"]);
    assert.deepEqual(deriveOversightMetrics([], { now }).byReviewerKind, []);
  });

  it("refuses an unknown kind and a policy actor attested human, even outside the window", () => {
    assert.throws(
      () => deriveOversightMetrics([oversightDecision("1", "alice", 0, "admin" as unknown as ReviewerKind)], { now }),
      /reviewerKind must be one of/,
    );
    assert.throws(
      () => deriveOversightMetrics([oversightDecision("1", "auto-accept-policy", 0, "human")], { now }),
      /contradicts actor auto-accept-policy/,
    );
    const old = { ...oversightDecision("1", "alice", 0, "admin" as unknown as ReviewerKind) };
    assert.throws(() => deriveOversightMetrics([old], { now, windowDays: 1 }), /reviewerKind must be one of/);
  });

  it("projects the breakdown onto the oversight-quality claims", () => {
    const metrics = deriveOversightMetrics([
      oversightDecision("1", "alice", 0, "human"),
      oversightDecision("2", "triage-agent", 1, "agent"),
      oversightDecision("3", "triage-agent", 2, "agent"),
    ], { now });
    const claims = oversightMetricsToClaims(metrics, {
      subjectType: "review-session",
      subjectId: "session-359",
      facet: "review.oversight",
      actor: "oversight-collector",
      observedAt: now.toISOString(),
      collectedBy: "oversight-metrics",
    });
    assert.ok(claims.length > 0);
    for (const { claim } of claims) {
      assert.deepEqual((claim.metadata?.oversightMetrics as { decisionsByReviewerKind?: unknown }).decisionsByReviewerKind, { human: 1, agent: 2 });
    }
  });
});

// ---------------------------------------------------------------------------
// Entity review outcomes carry the kind
// ---------------------------------------------------------------------------

const subjects: EntityAlternative["subjects"] = [
  { subjectType: "person", subjectId: "alex-1" },
  { subjectType: "person", subjectId: "alex-2" },
];

function mergeProposal() {
  return createEntityProposal({
    revision: "1",
    proposer: { id: "extractor", model: "model-v1", rule: "name" },
    policy: { id: "identity-policy", revision: "7" },
    alternatives: [{
      subjects,
      operation: "merge",
      evidence: [{ id: "a", sourceId: "s1", sourceRef: "urn:source:1", checksum: "sha256:abc", observedAt: "2026-10-01T00:00:00Z", locatorScheme: "text-span", locator: "chars:0-10", excerpt: "Alex Smith", stance: "supports" }],
      confidenceComponents: { name: 0.99 },
    }],
  });
}

function entityDecision(reviewerKind?: ReviewerKind, actorId = "reviewer") {
  const proposal = mergeProposal();
  return {
    proposal,
    decision: buildReviewDecision({
      item: entityProposalToReviewItem(proposal),
      decision: "accept-proposed",
      note: "reviewed source",
      actorId,
      ...(reviewerKind !== undefined ? { reviewerKind } : {}),
      reviewedAt: "2026-11-03T00:00:00Z",
    })!,
  };
}

describe("entity review outcomes carry the reviewer kind (#359)", () => {
  it("projects human -> operator and agent -> system, on the record and the mapping claim", () => {
    for (const [kind, authority] of [["human", "operator"], ["agent", "system"], ["rule", "system"]] as const) {
      const { proposal, decision } = entityDecision(kind);
      const outcome = entityOutcomeFromDecision(proposal, decision);
      assert.equal(outcome.spec.decision.spec.reviewerKind, kind);
      const record = projectEntityReviews([proposal], [outcome])[0]!;
      assert.equal(record.reviewerKind, kind);
      assert.equal(record.reviewerKindInferred, false);
      assert.equal(record.mappingClaim?.confidenceBasis?.reviewerAuthority, authority);
      const survey = record.mappingClaim?.metadata?.survey as { reviewerKind?: string; reviewerKindInferred?: boolean };
      assert.equal(survey.reviewerKind, kind);
      assert.equal(survey.reviewerKindInferred, false);
    }
  });

  it("infers and marks the kind of a decision recorded without one", () => {
    const { proposal, decision } = entityDecision();
    const record = projectEntityReviews([proposal], [entityOutcomeFromDecision(proposal, decision)])[0]!;
    assert.equal(record.reviewerKind, "human");
    assert.equal(record.reviewerKindInferred, true);
    assert.equal(record.mappingClaim?.confidenceBasis?.reviewerAuthority, "operator");
    assert.equal((record.mappingClaim?.metadata?.survey as { reviewerKindInferred?: boolean }).reviewerKindInferred, true);
  });

  it("binds the kind into the outcome identity, so a changed kind is a different outcome", () => {
    const human = entityDecision("human");
    const agent = entityDecision("agent");
    assert.notEqual(entityOutcomeFromDecision(human.proposal, human.decision).id, entityOutcomeFromDecision(agent.proposal, agent.decision).id);
  });

  it("refuses an unknown kind and a policy actor attested human at the entity gate itself", () => {
    // buildReviewDecision refuses both, so forge the decision the way a stored or posted record could be.
    const { proposal, decision } = entityDecision("agent");
    const forged = (reviewerKind: unknown, actorId = "reviewer"): ReviewDecision => ({
      ...decision,
      spec: { ...decision.spec, reviewerKind: reviewerKind as ReviewerKind, actor: { id: actorId } },
    });
    assert.throws(() => entityOutcomeFromDecision(proposal, forged("admin")), /reviewerKind must be one of/);
    assert.throws(() => entityOutcomeFromDecision(proposal, forged("human", "auto-accept-policy")), /contradicts actor auto-accept-policy/);
    assert.doesNotThrow(() => entityOutcomeFromDecision(proposal, forged("rule", "auto-accept-policy")));
  });

  it("refuses a stored outcome whose kind was rewritten to one the decision cannot carry", () => {
    const { proposal, decision } = entityDecision("agent");
    const outcome = entityOutcomeFromDecision(proposal, decision);
    const tampered = { ...outcome, spec: { ...outcome.spec, decision: { ...outcome.spec.decision, spec: { ...outcome.spec.decision.spec, reviewerKind: "human" as const } } } };
    assert.throws(() => projectEntityReviews([proposal], [tampered]), /Invalid outcome identity/);
  });
});

// ---------------------------------------------------------------------------
// Review round 1 (kontourai/survey#360): findings F1-F6 and the proof binding
// ---------------------------------------------------------------------------

describe("a producer cannot raise an attested agent or rule review to human authority (F1)", () => {
  function withOverride(kind: ReviewerKind | undefined, reviewerAuthority: "operator" | "domain_expert" | "system" | "none") {
    const base = surveyInput([review(kind ? { reviewerKind: kind, actor: "triage-agent" } : {})]);
    return { ...base, claims: [{ ...base.claims[0]!, confidenceBasis: { reviewerAuthority } }] };
  }

  it("refuses operator and domain_expert over an attested agent or rule", () => {
    for (const kind of ["agent", "rule"] as const) {
      for (const authority of ["operator", "domain_expert"] as const) {
        assert.throws(() => buildSurveyTrustBundle(withOverride(kind, authority)), /contradicts the attested reviewerKind/, `${kind}/${authority}`);
      }
    }
  });

  it("refuses the same override on a claim that selects no candidate, and under a could-not-confirm round", () => {
    const base = surveyInput([]);
    const conflict: SurveyInput = {
      ...base,
      extractions: [base.extractions[0]!, { ...base.extractions[0]!, id: "extraction.2", value: 52000 }],
      candidateSets: [{
        id: "set.1", target: "reportedAmount", status: "conflict",
        candidates: [
          { id: "candidate.1", extractionId: "extraction.1", value: 48000, confidence: 0.9 },
          { id: "candidate.2", extractionId: "extraction.2", value: 52000, confidence: 0.8 },
        ],
      }],
      reviewOutcomes: [review({ status: "rejected", candidateId: undefined, reviewerKind: "agent", actor: "triage-agent" })],
      claims: [{ ...base.claims[0]!, candidateId: undefined, confidenceBasis: { reviewerAuthority: "operator" } }],
    };
    assert.throws(() => buildSurveyTrustBundle(conflict), /contradicts the attested reviewerKind agent/);

    // A could-not-confirm round on an assumed claim projects no review of its own.
    const notConfirmed = (extra: Partial<ReviewOutcome>) => surveyInput([review({ status: "assumed", resolution: "could_not_confirm", resolutionReason: "Source unreachable.", ...extra })]);
    const agentRound = notConfirmed({ reviewerKind: "agent", actor: "triage-agent" });
    const forged = { ...agentRound, claims: [{ ...agentRound.claims[0]!, confidenceBasis: { reviewerAuthority: "operator" as const } }] };
    assert.throws(() => buildSurveyTrustBundle(forged), /contradicts the attested reviewerKind agent/);
    // Without the override, an attested agent's round is system authority, not the legacy operator default.
    assert.equal(buildSurveyTrustBundle(agentRound).claims[0]!.confidenceBasis?.reviewerAuthority, "system");
    assert.equal(buildSurveyTrustBundle(notConfirmed({})).claims[0]!.confidenceBasis?.reviewerAuthority, "operator", "a legacy could-not-confirm round keeps the default it had");
  });

  it("still allows an equal or lower authority, any override of an attested human, and any override of a legacy record", () => {
    assert.equal(buildSurveyTrustBundle(withOverride("agent", "system")).claims[0]!.confidenceBasis?.reviewerAuthority, "system");
    assert.equal(buildSurveyTrustBundle(withOverride("agent", "none")).claims[0]!.confidenceBasis?.reviewerAuthority, "none");
    assert.equal(buildSurveyTrustBundle(withOverride("human", "domain_expert")).claims[0]!.confidenceBasis?.reviewerAuthority, "domain_expert");
    assert.equal(buildSurveyTrustBundle(withOverride(undefined, "domain_expert")).claims[0]!.confidenceBasis?.reviewerAuthority, "domain_expert");
  });
});

describe("a claim that selects no candidate carries the same reviewer provenance (F3)", () => {
  function unselected(reviewerKind: ReviewerKind | undefined, producerMetadata?: Record<string, unknown>): SurveyInput {
    const base = surveyInput([]);
    return {
      ...base,
      extractions: [
        base.extractions[0]!,
        { ...base.extractions[0]!, id: "extraction.2", value: 52000 },
      ],
      candidateSets: [{
        id: "set.1",
        target: "reportedAmount",
        status: "conflict",
        candidates: [
          { id: "candidate.1", extractionId: "extraction.1", value: 48000, confidence: 0.9 },
          { id: "candidate.2", extractionId: "extraction.2", value: 52000, confidence: 0.8 },
        ],
      }],
      reviewOutcomes: [{
        id: "review.1",
        candidateSetId: "set.1",
        status: "proposed",
        resolution: "could_not_confirm",
        resolutionReason: "Neither source could be checked.",
        actor: "triage-agent",
        reviewedAt: "2026-11-02T00:00:00.000Z",
        ...(reviewerKind ? { reviewerKind } : {}),
      }],
      claims: [{ ...base.claims[0]!, candidateId: undefined, ...(producerMetadata ? { metadata: producerMetadata } : {}) }],
    };
  }

  it("records the attested kind, and discards a forged one", () => {
    const survey = buildSurveyTrustBundle(unselected("agent", { survey: { reviewerKind: "human", reviewerKindInferred: false } })).claims[0]!.metadata?.survey as Record<string, unknown>;
    assert.equal(survey.reviewerKind, "agent");
    assert.equal(survey.reviewerKindInferred, false);
  });

  it("marks an inferred kind, and records none for an unreviewed claim", () => {
    const survey = buildSurveyTrustBundle(unselected(undefined)).claims[0]!.metadata?.survey as Record<string, unknown>;
    assert.equal(survey.reviewerKind, "human");
    assert.equal(survey.reviewerKindInferred, true);
    const bare = { ...unselected(undefined, { survey: { reviewerKind: "human" } }), reviewOutcomes: [] };
    assert.equal((buildSurveyTrustBundle(bare).claims[0]!.metadata?.survey as Record<string, unknown>).reviewerKind, undefined);
  });
});

describe("every review boundary validates the kind (F4)", () => {
  const bogus = (reviewerKind: unknown) => reviewerKind as ReviewerKind;

  it("buildCanonicalReviewedTrustInput refuses an unknown kind and a policy actor attested human on a decision", () => {
    const snapshot = hostSnapshot("agent");
    const applied = deriveReviewSessionApplyResultForSnapshot({ snapshot, events: browserEvents(snapshot, "human") });
    assert.equal(applied.ok, true, JSON.stringify(applied.issues));
    const forge = (spec: Partial<ReviewDecision["spec"]>) => applied.results.map((result) => ({
      ...result,
      reviewDecision: { ...result.reviewDecision, spec: { ...result.reviewDecision.spec, ...spec } },
    }));
    const build = (results: ReturnType<typeof forge>) => buildCanonicalReviewedTrustInput({
      source: "directory-review/session-359",
      generatedAt: "2026-11-03T12:00:01.000Z",
      projectionContextId: "session-359",
      items: snapshot.items,
      results,
    });
    assert.throws(() => build(forge({ reviewerKind: bogus("admin") })), /reviewerKind must be one of/);
    assert.throws(() => build(forge({ reviewerKind: bogus(null) })), /reviewerKind must be one of/);
    assert.throws(() => build(forge({ reviewerKind: "human", actor: { id: "auto-accept-policy" } })), /contradicts actor auto-accept-policy/);
    assert.doesNotThrow(() => build(forge({})));
  });

  it("applyMappingReview refuses them instead of minting a durable verified mapping", () => {
    const proposal = {
      id: "p1", question: "What is the annual fee?", target: { subjectType: "record", facet: "profile", claimType: "field", fieldOrBehavior: "annualFee" },
      confidence: 0.9, rationale: "x", proposedAt: "2026-06-10T00:00:00.000Z", proposedBy: "m",
    } as unknown as Parameters<typeof proposalsToCandidateSet>[1][number];
    const { candidateSet, candidates } = proposalsToCandidateSet("What is the annual fee?", [proposal]);
    const outcome = (extra: Record<string, unknown>) => ({
      id: "r1", candidateSetId: candidateSet.id, candidateId: candidates[0]!.id, status: "verified" as const,
      actor: "reviewer@example.test", reviewedAt: "2026-06-10T12:00:00.000Z", ...extra,
    }) as ReviewOutcome;
    assert.throws(() => applyMappingReview(candidateSet, outcome({ reviewerKind: "admin" })), /reviewerKind must be one of/);
    assert.throws(() => applyMappingReview(candidateSet, outcome({ actor: "auto-accept-policy", reviewerKind: "human" })), /contradicts actor auto-accept-policy/);
    assert.doesNotThrow(() => applyMappingReview(candidateSet, outcome({ reviewerKind: "human" })));
  });

  it("splitRoundForCarryForward refuses a prior decision whose kind is invalid", () => {
    const snapshot = hostSnapshot("agent");
    const item = snapshot.items[0]!;
    const entry = { item, slotId: "slot:a", candidateVersionIds: Object.fromEntries(item.spec.candidates.map((c) => [c.id, `v:${c.id}`])) };
    const decision = buildReviewDecision({ item, decision: "accept-proposed", note: "ok", actorId: "reviewer-7", reviewerKind: "agent", reviewedAt: "2026-11-03T12:00:00.000Z" })!;
    const prior = (spec: Partial<ReviewDecision["spec"]>) => ({ ...entry, decision: { ...decision, spec: { ...decision.spec, ...spec } } });
    assert.doesNotThrow(() => splitRoundForCarryForward({ roundId: "r2", items: [entry], priorDecisions: [prior({})] }));
    assert.throws(() => splitRoundForCarryForward({ roundId: "r2", items: [entry], priorDecisions: [prior({ reviewerKind: bogus("admin") })] }), /reviewerKind must be one of/);
    assert.throws(() => splitRoundForCarryForward({ roundId: "r2", items: [entry], priorDecisions: [prior({ reviewerKind: "human", actor: { id: "auto-accept-policy" } })] }), /contradicts actor auto-accept-policy/);
  });

  it("the stored event log pairs the host's actor with the host's kind, not the poster's actor", () => {
    const content: ReviewSessionFileContent = { session: undefined, snapshot: hostSnapshot("human"), events: [] };
    const forged = browserEvents(hostSnapshot("human"), "human").map((event) => ({ ...event, spec: { ...event.spec, actor: { id: "auto-accept-policy" } } }));
    for (const event of appendReviewSessionEvents(content, forged)) {
      assert.equal(event.spec.actor?.id, "reviewer-7");
      assert.equal(event.spec.reviewerKind, "human");
    }
    const contradictory: ReviewSessionFileContent = { ...content, snapshot: { ...content.snapshot, actorId: "auto-accept-policy" } };
    assert.throws(() => appendReviewSessionEvents(contradictory, forged), /contradicts actor auto-accept-policy/);
    const unknown: ReviewSessionFileContent = { ...content, snapshot: { ...content.snapshot, reviewerKind: bogus("admin") } };
    assert.throws(() => appendReviewSessionEvents(unknown, forged), /reviewerKind must be one of/);
  });
});

describe("review selection cannot hide or blur the kind (F5)", () => {
  it("refuses an invalid kind on a review that loses selection", () => {
    const winner = review({ id: "a", reviewerKind: "human" });
    const loser = review({ id: "z", reviewerKind: "admin" as unknown as ReviewerKind });
    assert.throws(() => buildSurveyTrustBundle(surveyInput([winner, loser])), /reviewerKind must be one of/);
    const policyHuman = review({ id: "z", actor: "auto-accept-policy", status: "assumed", reviewerKind: "human" });
    assert.throws(() => buildSurveyTrustBundle(surveyInput([winner, policyHuman])), /contradicts actor auto-accept-policy/);
  });

  it("treats a human and an agent review at the same instant as conflicting, not as one recorded twice", () => {
    const human = review({ id: "a", reviewerKind: "human" });
    const agent = review({ id: "z", reviewerKind: "agent", actor: "triage-agent" });
    assert.throws(() => buildSurveyTrustBundle(surveyInput([human, agent])), /conflicting review outcomes/);
    // The same decision recorded twice with the same kind is still one review.
    assert.doesNotThrow(() => buildSurveyTrustBundle(surveyInput([human, { ...human, id: "b" }])));
  });
});

describe("calibration counts only human labels (F6)", () => {
  function labelled(reviewerKind: ReviewerKind | undefined, id: string) {
    return {
      extractions: [{ id: `ext-${id}`, sourceId: "s", target: "field.a", value: "v", extractor: "extractor-x", extractedAt: "2026-07-01T00:00:00.000Z" }],
      candidateSets: [{
        id: `cs-${id}`, target: "field.a", status: "resolved" as const, selectedCandidateId: `cand-${id}`,
        candidates: [{ id: `cand-${id}`, extractionId: `ext-${id}`, value: "v", confidence: 0.9, metadata: { candidateRole: "proposed" } }],
      }],
      reviewOutcomes: [{
        id: `ro-${id}`, candidateSetId: `cs-${id}`, candidateId: `cand-${id}`, status: "verified" as const,
        actor: "reviewer", reviewedAt: "2026-07-01T00:00:00.000Z", ...(reviewerKind ? { reviewerKind } : {}),
      }],
    };
  }
  const merge = (...parts: ReturnType<typeof labelled>[]) => ({
    extractions: parts.flatMap((p) => p.extractions),
    candidateSets: parts.flatMap((p) => p.candidateSets),
    reviewOutcomes: parts.flatMap((p) => p.reviewOutcomes),
  });

  it("excludes an agent- or rule-attested affirmation, keeps human and legacy, and honors includeAutoAccepted", () => {
    const input = merge(labelled("human", "h"), labelled(undefined, "legacy"), labelled("agent", "ag"), labelled("rule", "ru"));
    const metrics = deriveCalibration(input);
    assert.equal(metrics.overall.sampleCount, 2);
    assert.equal(metrics.skippedCount, 2);
    assert.equal(deriveCalibration(input, { includeAutoAccepted: true }).overall.sampleCount, 4);
  });
});

describe("the review proof binds the attested kind (proof gap from review)", () => {
  function proofInput(reviewerKind?: ReviewerKind) {
    const base = surveyInput([review(reviewerKind ? { reviewerKind } : {})]);
    return base;
  }
  function anchorFor(reviewerKind?: ReviewerKind) {
    const bundle = buildSurveyTrustBundle(proofInput(reviewerKind), { reviewProofs: true });
    return bundle.claims[0]!.currentIntegrityAnchor!.value;
  }

  it("changing only the kind changes the proof, and a record with no kind keeps its digest", () => {
    assert.notEqual(anchorFor("agent"), anchorFor("human"));
    assert.notEqual(anchorFor("human"), anchorFor(undefined));
    // Computed by origin/main (a9fede3, which has no reviewerKind) for this exact fixture.
    assert.equal(anchorFor(undefined), "72214229d2d402b4e1fc1bbb92fc46caad0bcf906a1adb988c16117dc81bce87");
  });
});

describe("the MCP tool cannot decide a session attested as human (F2)", () => {
  async function decideOver(hostKind: ReviewerKind | undefined) {
    const { spawn } = await import("node:child_process");
    const { createInterface } = await import("node:readline");
    const tmpDir = await mkdtemp(join(tmpdir(), "survey-mcp-kind-"));
    const sessionPath = join(tmpDir, "session.json");
    await copyFile("example-data/mcp-review-session.json", sessionPath);
    const file = JSON.parse(await readFile(sessionPath, "utf8")) as { snapshot: ReviewQueueSessionState };
    if (hostKind) file.snapshot = { ...file.snapshot, reviewerKind: hostKind };
    await writeFile(sessionPath, JSON.stringify(file));
    const server = spawn("node", ["bin/survey-review-mcp.mjs", "--session", sessionPath], { stdio: ["pipe", "pipe", "inherit"] });
    try {
      const reply = new Promise<{ result?: { isError?: boolean; content: Array<{ text?: string }> } }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("MCP timed out")), 15_000);
        createInterface({ input: server.stdout! }).on("line", (line) => {
          if (!line.trim()) return;
          const message = JSON.parse(line);
          if (message.id === 2) { clearTimeout(timer); resolve(message); }
        });
      });
      const send = (message: unknown) => server.stdin!.write(`${JSON.stringify(message)}\n`);
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agent-client", version: "0" } } });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "survey_review_decide", arguments: { itemName: file.snapshot.items[0]!.metadata.name, decision: "accept", note: "relayed by an agent" } } });
      const response = await reply;
      const stored = JSON.parse(await readFile(sessionPath, "utf8")) as { events: ReviewSessionEvent[] };
      return { response, stored: stored.events.filter((event) => event.spec.eventType.startsWith("decision-")) };
    } finally {
      server.kill();
      await rm(tmpDir, { recursive: true, force: true });
    }
  }

  it("refuses on a human-attested session and records nothing", async () => {
    const { response, stored } = await decideOver("human");
    assert.equal(response.result?.isError, true);
    assert.match(response.result?.content[0]?.text ?? "", /cannot tell a person from an agent/);
    assert.equal(stored.length, 0);
  });

  it("records an agent-attested session's decision as an agent's", async () => {
    const { response, stored } = await decideOver("agent");
    assert.notEqual(response.result?.isError, true, JSON.stringify(response));
    assert.ok(stored.length > 0);
    for (const event of stored) assert.equal(event.spec.reviewerKind, "agent");
  });
});
