import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { publicDirectoryReviewItemExample } from "../example-data/public-directory-review-resource.js";
import { reviewResourceApiVersion } from "../src/index.js";
import {
  buildReviewDecision,
  buildReviewDecisionsFromSession,
  buildReviewItemPresentation,
  buildReviewResultPresentation,
  buildReviewWorkbenchResultsFromSession,
  buildReviewSessionEvents,
  buildReviewWorkbenchSessionExport,
  buildReviewWorkbenchSessionExportForSnapshot,
  buildSurfaceProjectionPreview,
  createInMemoryReviewSessionEventStore,
  createLocalStorageReviewSessionEventStore,
  createPersistentReviewSessionEventStore,
  currentReviewWorkbenchState,
  deriveQueueRowStatus,
  initialReviewWorkbenchState,
  initialReviewQueueSessionState,
  assertReviewResultMatches,
  mapReviewWorkbenchResultsToApplyActions,
  mountReviewWorkbench,
  nextUnresolvedItemName,
  persistReviewSessionEvents,
  deriveReviewSessionApplyResultForSnapshot,
  renderReviewWorkbenchHtml,
  requireReviewResultForItem,
  replayReviewSessionEvents,
  replayReviewSessionEventsForSnapshot,
  ReviewApplyActionMappingError,
  reviewSessionSummary,
  validateReviewSessionEventsForSnapshot,
  type ReviewPresentationAdapter,
  type ReviewWorkbenchDecision,
} from "../src/review-workbench/review-workbench.js";
import {
  facilityCredentialReviewItemExample,
  regulatedRuleConflictReviewItemExample,
  reviewWorkbenchQueueExamples,
} from "../src/review-workbench/review-workbench-data.js";
import type { ReviewDecision, ReviewItem, ReviewSessionEvent } from "../src/review-resource.js";

describe("review workbench prototype", () => {
  const cases: Array<{
    decision: ReviewWorkbenchDecision;
    candidateId: string;
    status: "verified" | "rejected";
    selectedText: string;
  }> = [
    {
      decision: "accept-proposed",
      candidateId: "public-directory:candidate:proposed",
      status: "verified",
      selectedText: "Proposed value becomes the verified review outcome.",
    },
    {
      decision: "keep-current",
      candidateId: "public-directory:candidate:current",
      status: "verified",
      selectedText: "Current value remains the verified review outcome.",
    },
    {
      decision: "reject-proposed",
      candidateId: "public-directory:candidate:proposed",
      status: "rejected",
      selectedText: "Proposed value is rejected and the current value remains unmodified.",
    },
  ];

  for (const entry of cases) {
    it(`builds a ReviewDecision payload for ${entry.decision}`, () => {
      const state = {
        ...initialReviewWorkbenchState(),
        decision: entry.decision,
        note: "Reviewed against source excerpt.",
      };

      const decision = buildReviewDecision(state);

      assert.ok(decision);
      assert.equal(decision.apiVersion, reviewResourceApiVersion);
      assert.equal(decision.kind, "ReviewDecision");
      assert.equal(decision.spec.reviewItemName, publicDirectoryReviewItemExample.metadata.name);
      assert.equal(decision.spec.candidateId, entry.candidateId);
      assert.equal(decision.spec.status, entry.status);
      assert.equal(decision.spec.actor?.id, "review-workbench-operator");
      assert.equal(decision.spec.reviewedAt, "2026-06-04T00:00:00.000Z");
      assert.equal(decision.spec.rationale, "Reviewed against source excerpt.");
      assert.ok(decision.spec.projection?.candidateId);
      assert.ok(decision.spec.projection?.claimId);
      assert.deepEqual(decision.status?.appliedToClaimIds, [decision.spec.projection?.claimId]);
    });

    it(`renders decision effect for ${entry.decision}`, () => {
      const html = renderReviewWorkbenchHtml({
        ...initialReviewWorkbenchState(),
        decision: entry.decision,
      });

      assert.match(html, new RegExp(escapeRegExp(entry.selectedText)));
      assert.match(html, /ReviewDecision payload/);
      assert.match(html, /&quot;kind&quot;: &quot;ReviewDecision&quot;/);
    });
  }

  it("renders candidate and evidence context from the public directory fixture", () => {
    const html = renderReviewWorkbenchHtml(initialReviewWorkbenchState());

    assert.match(html, /Review candidate update/);
    assert.match(html, /decide whether/);
    assert.match(html, /data-testid="review-focus"/);
    assert.match(html, /Active review/);
    assert.match(html, /Current/);
    assert.match(html, /Proposed/);
    assert.match(html, /AVAILABLE/);
    assert.match(html, /WAITLIST/);
    assert.match(html, /https:\/\/example\.test\/listings\/example-program/);
    assert.match(html, /html:field=availabilityStatus/);
    assert.match(html, /Availability is open for the example program\./);
    assert.match(html, /Join the waitlist for this listing\./);
    assert.match(html, /91% \(0\.91\)/);
    assert.match(html, /82% \(0\.82\)/);
    assert.match(html, /Reviewer note/);
    assert.match(html, /Accept proposed/);
    assert.match(html, /Keep current/);
    assert.match(html, /Reject proposed/);
  });

  it("renders structured candidate values without downstream pre-stringification", () => {
    const structuredItem: ReviewItem = {
      ...publicDirectoryReviewItemExample,
      spec: {
        ...publicDirectoryReviewItemExample.spec,
        producerPolicy: {
          feedbackTags: ["structured-value", { producer: "downstream-reviewer" }],
        },
        candidates: publicDirectoryReviewItemExample.spec.candidates.map((candidate) => (
          candidate.role === "proposed"
            ? {
                ...candidate,
                value: [{ label: "Week 1", minAge: 7, maxAge: 12 }],
              }
            : {
                ...candidate,
                value: { status: "available", source: "current-record" },
              }
        )),
      },
    };

    const html = renderReviewWorkbenchHtml(initialReviewWorkbenchState(structuredItem));

    assert.match(html, /Week 1/);
    assert.match(html, /current-record/);
    assert.match(html, /structured-value/);
    assert.match(html, /downstream-reviewer/);
  });

  it("builds generic presentation metadata with downstream display overrides", () => {
    const item = publicDirectoryReviewItemExample;
    const presentation = buildReviewItemPresentation(item, {
      labelForTarget: (target) => target === "availabilityStatus" ? "Availability status" : undefined,
      summarizeValue: (value, context) => `${context.candidate.role ?? "candidate"}:${String(value).toLowerCase()}`,
      linkForReviewItem: (reviewItem) => ({ href: `/review/${reviewItem.metadata.name}`, label: "Review item" }),
      linkForTraceRef: (ref) => ref.kind === "candidate"
        ? { href: `/trace/${encodeURIComponent(ref.value)}`, label: ref.label }
        : undefined,
    });

    assert.equal(presentation.targetLabel, "Availability status");
    assert.equal(presentation.statusLabel, "Resolved");
    assert.equal(presentation.reviewItemLink?.href, "/review/public-directory-availability");
    assert.equal(presentation.candidates[0]?.roleLabel, "Current value");
    assert.equal(presentation.candidates[0]?.valueText, "current:available");
    assert.equal(presentation.candidates[1]?.roleLabel, "Proposed value");
    assert.equal(presentation.candidates[1]?.valueText, "proposed:waitlist");
    assert.equal(presentation.candidates[1]?.sourceLink?.href, "https://example.test/listings/example-program");
    assert.equal(
      presentation.candidates[1]?.traceRefs.find((ref) => ref.kind === "candidate")?.link?.href,
      "/trace/public-directory%3Acandidate%3Aproposed",
    );
  });

  it("builds saved result presentation without product-specific branches", () => {
    const session = {
      ...initialReviewQueueSessionState([publicDirectoryReviewItemExample]),
      decisionsByItemName: {
        [publicDirectoryReviewItemExample.metadata.name]: "accept-proposed" as const,
      },
    };
    const result = buildReviewWorkbenchResultsFromSession(session)[0];

    assert.ok(result);

    const presentation = buildReviewResultPresentation(result, publicDirectoryReviewItemExample, {
      labelForTarget: () => "Availability status",
    });

    assert.equal(presentation.targetLabel, "Availability status");
    assert.equal(presentation.decisionLabel, "Accept Proposed");
    assert.equal(presentation.selectedValueText, "WAITLIST");
    assert.equal(presentation.applyMeaning, "Saved decision applies proposed value");
    assert.equal(presentation.traceRefs[0]?.label, "Survey ReviewItem");
    assert.equal(presentation.traceRefs[1]?.value, "public-directory:candidate:proposed");
  });

  it("renders embedded workbench labels and value summaries from the presentation adapter", () => {
    const html = renderReviewWorkbenchHtml(initialReviewWorkbenchState(), undefined, {
      presentationAdapter: {
        labelForTarget: () => "Reviewable field",
        summarizeValue: (value) => `display:${String(value).toLowerCase()}`,
        statusLabel: () => "Needs operator review",
      },
    });

    assert.match(html, /Reviewable field/);
    assert.match(html, /display:waitlist/);
    assert.match(html, /display:available/);
    assert.match(html, /Needs operator review/);
    assert.doesNotMatch(html, /<strong>availabilityStatus<\/strong>/);
  });

  it("presents a non-product facility credential ReviewItem with nested structured values", () => {
    const presentation = buildReviewItemPresentation(facilityCredentialReviewItemExample, facilityCredentialPresentationAdapter());
    const proposed = presentation.candidates.find((candidate) => candidate.candidate.role === "proposed");

    assert.equal(presentation.targetLabel, "Operating license credential");
    assert.equal(presentation.statusLabel, "Credential review needed");
    assert.equal(presentation.traceRefs.find((ref) => ref.kind === "candidate-set")?.value, "facility-credential-review-operating-license:candidate-set");
    assert.ok(proposed);
    assert.equal(proposed.valueText, "FAC-2026-1042 active through 2027-01-15; 3 permitted services; 2 inspections");
    assert.equal(proposed.sourceLink?.href, "https://example.test/facility-registry/facility-42/license");
    assert.equal(
      proposed.traceRefs.find((ref) => ref.kind === "claim")?.value,
      "facility-credential.facility-42.operating-license.registry",
    );
  });

  it("renders facility credential presentation through the embedded workbench adapter", () => {
    const html = renderReviewWorkbenchHtml(
      initialReviewWorkbenchState(facilityCredentialReviewItemExample),
      undefined,
      { presentationAdapter: facilityCredentialPresentationAdapter() },
    );

    assert.match(html, /Operating license credential/);
    assert.match(html, /FAC-2026-1042 active through 2027-01-15; 3 permitted services; 2 inspections/);
    assert.match(html, /Credential review needed/);
    assert.match(html, /facility-credential-review-operating-license:candidate:proposed/);
    assert.match(html, /facility-credential-review-operating-license:source:registry/);
    assert.doesNotMatch(html, /public-directory/);
  });

  it("builds saved facility credential result presentation from replayed Survey decisions", () => {
    const session = {
      ...initialReviewQueueSessionState([facilityCredentialReviewItemExample]),
      decisionsByItemName: {
        [facilityCredentialReviewItemExample.metadata.name]: "accept-proposed" as const,
      },
    };
    const events = buildReviewSessionEvents(session);
    const replayed = buildReviewWorkbenchSessionExportForSnapshot({
      ...session,
      decisionsByItemName: {},
    }, events);
    const result = replayed.results[0];

    assert.ok(result);

    const presentation = buildReviewResultPresentation(
      result,
      facilityCredentialReviewItemExample,
      facilityCredentialPresentationAdapter(),
    );

    assert.equal(presentation.targetLabel, "Operating license credential");
    assert.equal(presentation.selectedValueText, "FAC-2026-1042 active through 2027-01-15; 3 permitted services; 2 inspections");
    assert.equal(presentation.applyMeaning, "Saved decision applies proposed value");
    assert.equal(presentation.traceRefs[1]?.value, "facility-credential-review-operating-license:candidate:proposed");
  });

  it("AC37-1 derives queue row statuses from ReviewItem status and local decisions", () => {
    const session = {
      ...initialReviewQueueSessionState(),
      activeItemName: "public-directory-hours",
      decisionsByItemName: {
        "public-directory-address": "reject-proposed" as const,
      },
    };

    assert.equal(deriveQueueRowStatus(reviewWorkbenchQueueExamples[0], session), "in-review");
    assert.equal(deriveQueueRowStatus(reviewWorkbenchQueueExamples[1], session), "pending");
    assert.equal(deriveQueueRowStatus(reviewWorkbenchQueueExamples[2], session), "resolved");
    assert.equal(deriveQueueRowStatus(reviewWorkbenchQueueExamples[3], session), "rejected");
    assert.equal(deriveQueueRowStatus(reviewWorkbenchQueueExamples[4], session), "escalated");
    assert.equal(deriveQueueRowStatus(reviewWorkbenchQueueExamples[5], session), "pending");

    const html = renderReviewWorkbenchHtml(session);
    assert.match(html, /data-testid="active-review-strip"/);
    assert.match(html, /Review 1 of 6/);
    assert.match(html, /data-testid="active-next-unresolved"/);
    assert.doesNotMatch(html, /active-review-decisions/);
    assert.doesNotMatch(html, /Quick review decision/);
    assert.match(html, /data-testid="queue-row" data-queue-status="in-review"/);
    assert.match(html, /data-testid="queue-row" data-queue-status="pending"/);
    assert.match(html, /data-testid="queue-row" data-queue-status="resolved"/);
    assert.match(html, /data-testid="queue-row" data-queue-status="rejected"/);
    assert.match(html, /data-testid="queue-row" data-queue-status="escalated"/);
  });

  it("AC37-2 retains local decisions and notes by ReviewItem name while navigating", () => {
    const session = {
      ...initialReviewQueueSessionState(),
      activeItemName: "public-directory-phone",
      notesByItemName: {
        "public-directory-hours": "Hours checked.",
        "public-directory-phone": "Phone source reviewed.",
      },
      decisionsByItemName: {
        "public-directory-hours": "accept-proposed" as const,
        "public-directory-phone": "keep-current" as const,
      },
    };

    assert.equal(currentReviewWorkbenchState(session).note, "Phone source reviewed.");
    assert.equal(currentReviewWorkbenchState(session).decision, "keep-current");
    assert.equal(nextUnresolvedItemName(session), "public-directory-address");

    const returnedSession = {
      ...session,
      activeItemName: "public-directory-hours",
    };
    assert.equal(currentReviewWorkbenchState(returnedSession).note, "Hours checked.");
    assert.equal(currentReviewWorkbenchState(returnedSession).decision, "accept-proposed");
  });

  it("AC37-3 summarizes accepted, kept-current, rejected, escalated, and unresolved items", () => {
    const summary = reviewSessionSummary({
      ...initialReviewQueueSessionState(),
      decisionsByItemName: {
        "public-directory-hours": "accept-proposed",
        "public-directory-phone": "keep-current",
        "public-directory-address": "reject-proposed",
      },
    });

    assert.deepEqual(summary, {
      accepted: 2,
      keptCurrent: 1,
      rejected: 1,
      escalated: 1,
      unresolved: 1,
    });

    const html = renderReviewWorkbenchHtml(initialReviewQueueSessionState());
    assert.match(html, /Session summary/);
    assert.match(html, /Accepted/);
    assert.match(html, /Kept current/);
    assert.match(html, /Rejected/);
    assert.match(html, /Escalated/);
    assert.match(html, /Unresolved/);
  });

  it("renders ReviewSession audit metadata, replay status, and ordered events", () => {
    const session = {
      ...initialReviewQueueSessionState(),
      notesByItemName: {
        "public-directory-hours": "Accepted longer posted hours.",
      },
      decisionsByItemName: {
        "public-directory-hours": "accept-proposed" as const,
      },
    };
    const events = buildReviewSessionEvents(session);
    const html = renderReviewWorkbenchHtml(session, events);

    assert.match(html, /data-testid="session-audit"/);
    assert.match(html, /ReviewSession/);
    assert.match(html, /review-workbench-session/);
    assert.match(html, /replay ok/);
    assert.match(html, /Events/);
    assert.match(html, /Decisions/);
    assert.match(html, /Actor/);
    assert.match(html, /review-workbench-operator/);
    assert.match(html, /data-testid="session-event-list"/);
    assert.match(html, /session-started/);
    assert.match(html, /item-selected/);
    assert.match(html, /note-changed/);
    assert.match(html, /decision-changed/);
    assert.match(html, /decision-submitted/);
    assert.match(html, /Session export/);
    assert.match(html, /&quot;kind&quot;: &quot;ReviewSession&quot;/);
    assert.match(html, /&quot;kind&quot;: &quot;ReviewSessionEvent&quot;/);
  });

  it("marks ReviewSession audit replay drift when events do not reconstruct the current session", () => {
    const session = {
      ...initialReviewQueueSessionState(),
      decisionsByItemName: {
        "public-directory-hours": "accept-proposed" as const,
      },
    };
    const html = renderReviewWorkbenchHtml(session, []);

    assert.match(html, /data-testid="session-audit"/);
    assert.match(html, /replay drift/);
  });

  it("AC37-4 displays producer feedback tags as producer vocabulary", () => {
    const session = initialReviewQueueSessionState();
    const html = renderReviewWorkbenchHtml(session);

    assert.match(html, /Producer feedback tags/);
    assert.match(html, /hours-change/);
    assert.match(html, /crawler-suggested/);

    const decidedHtml = renderReviewWorkbenchHtml({
      ...session,
      decisionsByItemName: {
        "public-directory-hours": "accept-proposed",
      },
    });

    assert.match(decidedHtml, /hours-change/);
    assert.doesNotMatch(decidedHtml, /<span class="tag">resolved<\/span>/);
  });

  it("exports and replays review session events into final review decisions", () => {
    const session = {
      ...initialReviewQueueSessionState(),
      activeItemName: "public-directory-address",
      notesByItemName: {
        "public-directory-hours": "Accepted longer posted hours.",
        "public-directory-phone": "Kept current phone after source check.",
        "public-directory-address": "Rejected proposed address as low confidence.",
      },
      decisionsByItemName: {
        "public-directory-hours": "accept-proposed" as const,
        "public-directory-phone": "keep-current" as const,
        "public-directory-address": "reject-proposed" as const,
      },
    };

    const events = buildReviewSessionEvents(session);
    const replayed = replayReviewSessionEvents(initialReviewQueueSessionState(), events);
    const exported = buildReviewWorkbenchSessionExport(replayed, events);
    const decisions = buildReviewDecisionsFromSession(replayed);
    const results = buildReviewWorkbenchResultsFromSession(replayed);

    assert.equal(exported.session.kind, "ReviewSession");
    assert.equal(exported.session.status?.eventCount, events.length);
    assert.deepEqual(exported.events.map((event) => event.kind), events.map(() => "ReviewSessionEvent"));
    assert.deepEqual(replayed.decisionsByItemName, session.decisionsByItemName);
    assert.deepEqual(replayed.notesByItemName, session.notesByItemName);
    assert.deepEqual(exported.decisions.map((decision) => decision.metadata.name), decisions.map((decision) => decision.metadata.name));
    assert.deepEqual(exported.results.map((result) => result.reviewDecision.metadata.name), decisions.map((decision) => decision.metadata.name));
    assert.deepEqual(decisions.map((decision) => decision.spec.status), ["verified", "verified", "rejected"]);
    assert.deepEqual(results.map((result) => result.decision), ["accept-proposed", "keep-current", "reject-proposed"]);
    assert.deepEqual(results.map((result) => result.status), ["verified", "verified", "rejected"]);
    assert.ok(results.every((result) => result.selectedCandidateId === result.selectedCandidate.id));

    const itemForDecision = (decision: ReviewDecision): ReviewItem => {
      const item = replayed.items.find((entry) => entry.metadata.name === decision.spec.reviewItemName);
      assert.ok(item);
      return item;
    };

    const previews = new Map(decisions.map((decision) => [
      decision.spec.reviewItemName,
      buildSurfaceProjectionPreview(itemForDecision(decision), decision),
    ]));
    const acceptedPreview = previews.get("public-directory-hours");
    const keptPreview = previews.get("public-directory-phone");
    const rejectedPreview = previews.get("public-directory-address");

    assert.equal(acceptedPreview?.canonicalClaim.status, "verified");
    assert.equal(keptPreview?.canonicalClaim.status, "verified");
    assert.equal(rejectedPreview?.canonicalClaim.status, "rejected");
    assert.equal(acceptedPreview?.reviewEvent?.rationale, "Accepted longer posted hours.");
    assert.equal(keptPreview?.reviewEvent?.rationale, "Kept current phone after source check.");
    assert.equal(rejectedPreview?.reviewEvent?.rationale, "Rejected proposed address as low confidence.");
  });

  it("exports review session results by strictly replaying events against the supplied snapshot", () => {
    const session = {
      ...initialReviewQueueSessionState(),
      decisionsByItemName: {
        "public-directory-hours": "accept-proposed" as const,
        "public-directory-phone": "keep-current" as const,
      },
      notesByItemName: {
        "public-directory-hours": "Accepted longer posted hours.",
      },
    };
    const events = buildReviewSessionEvents(session);

    const replayed = replayReviewSessionEventsForSnapshot(initialReviewQueueSessionState(), events);
    const exported = buildReviewWorkbenchSessionExportForSnapshot(initialReviewQueueSessionState(), events);

    assert.deepEqual(replayed.decisionsByItemName, session.decisionsByItemName);
    assert.deepEqual(exported.events.map((event) => event.metadata.name), events.map((event) => event.metadata.name));
    assert.deepEqual(exported.results.map((result) => result.reviewItemName), [
      "public-directory-hours",
      "public-directory-phone",
    ]);
    assert.deepEqual(exported.results.map((result) => result.selectedCandidateRole), ["proposed", "current"]);
  });

  it("reports stale replay events that do not match the supplied snapshot", () => {
    const snapshot = initialReviewQueueSessionState();
    const session = {
      ...snapshot,
      decisionsByItemName: {
        "public-directory-hours": "accept-proposed" as const,
      },
    };
    const events = buildReviewSessionEvents(session);
    const decisionEvent = events.find((event) => event.spec.eventType === "decision-changed");
    assert.ok(decisionEvent);
    const eventForUnknownItem = replaceReviewEventSpec(decisionEvent, {
      sequence: 1,
      reviewItemName: "missing-review-item",
    });
    const eventForUnknownCandidate = replaceReviewEventSpec(decisionEvent, {
      sequence: 2,
      candidateId: "missing-candidate",
    });
    const eventWithInvalidDecision = replaceReviewEventSpec(decisionEvent, {
      sequence: 3,
      data: {
        workbenchDecision: "not-a-workbench-decision",
      },
    });
    const currentCandidate = snapshot.items
      .find((item) => item.metadata.name === "public-directory-hours")
      ?.spec.candidates.find((candidate) => candidate.role === "current");
    assert.ok(currentCandidate);
    const eventWithCandidateMismatch = replaceReviewEventSpec(decisionEvent, {
      sequence: 4,
      candidateId: currentCandidate.id,
    });
    const eventWithStatusMismatch = replaceReviewEventSpec(decisionEvent, {
      sequence: 5,
      status: "rejected",
    });

    const issues = validateReviewSessionEventsForSnapshot(snapshot, [
      eventForUnknownItem,
      eventForUnknownCandidate,
      eventWithInvalidDecision,
      eventWithCandidateMismatch,
      eventWithStatusMismatch,
    ]);

    assert.deepEqual(issues.map((issue) => issue.code), [
      "unknown-review-item",
      "unknown-candidate",
      "invalid-workbench-decision",
      "decision-candidate-mismatch",
      "decision-status-mismatch",
    ]);
    assert.throws(
      () => replayReviewSessionEventsForSnapshot(snapshot, [eventForUnknownItem]),
      /missing-review-item/,
    );
    assert.throws(
      () => buildReviewWorkbenchSessionExportForSnapshot(snapshot, [eventForUnknownCandidate]),
      /missing-candidate/,
    );
    assert.throws(
      () => buildReviewWorkbenchSessionExportForSnapshot(snapshot, [eventWithInvalidDecision]),
      /replayable workbench decision/,
    );
    assert.throws(
      () => buildReviewWorkbenchSessionExportForSnapshot(snapshot, [eventWithCandidateMismatch]),
      /expects candidate/,
    );
  });

  it("prepares server-side review apply results from a pre-decision snapshot and persisted events", () => {
    const session = {
      ...initialReviewQueueSessionState(),
      decisionsByItemName: {
        "public-directory-hours": "accept-proposed" as const,
        "public-directory-phone": "keep-current" as const,
      },
      notesByItemName: {
        "public-directory-hours": "Accepted longer posted hours.",
      },
    };
    const events = buildReviewSessionEvents(session);

    const prepared = deriveReviewSessionApplyResultForSnapshot({
      snapshot: initialReviewQueueSessionState(),
      events,
      requiredResolvedItems: "any",
    });

    assert.equal(prepared.ok, true);
    assert.deepEqual(prepared.issues, []);
    assert.equal(prepared.unresolvedItemNames.includes("public-directory-hours"), false);
    assert.equal(prepared.unresolvedItemNames.includes("public-directory-phone"), false);
    assert.deepEqual(prepared.results.map((result) => result.reviewItemName), [
      "public-directory-hours",
      "public-directory-phone",
    ]);
    assert.deepEqual(prepared.results.map((result) => result.selectedCandidateRole), ["proposed", "current"]);
    assert.equal(prepared.decisions.length, 2);
    assert.equal(prepared.sessionExport.events.length, events.length);
    assert.deepEqual(prepared.replayedSession.decisionsByItemName, session.decisionsByItemName);
  });

  it("maps resolved review results into product-owned apply actions", () => {
    const snapshot = initialReviewQueueSessionState();
    const reviewedSession = {
      ...snapshot,
      decisionsByItemName: {
        "public-directory-hours": "accept-proposed" as const,
        "public-directory-phone": "keep-current" as const,
        "public-directory-address": "reject-proposed" as const,
      },
    };
    const apply = deriveReviewSessionApplyResultForSnapshot({
      snapshot,
      events: buildReviewSessionEvents(reviewedSession),
      requiredResolvedItems: "any",
    });
    assert.equal(apply.ok, true);

    const hoursItem = snapshot.items.find((item) => item.metadata.name === "public-directory-hours");
    assert.ok(hoursItem);
    const hoursResult = requireReviewResultForItem(hoursItem, apply.results);
    assertReviewResultMatches(hoursResult, {
      decision: "accept-proposed",
      status: "verified",
      selectedCandidateRole: "proposed",
    });
    assert.throws(
      () => assertReviewResultMatches(hoursResult, { selectedCandidateRole: "current" }),
      /expected current/,
    );

    const actions = mapReviewWorkbenchResultsToApplyActions({
      results: apply.results,
      items: snapshot.items,
      requireUniqueTargets: true,
      map: ({ result, item }) => {
        if (result.decision === "accept-proposed" && result.selectedCandidateRole === "proposed") {
          return { kind: "apply-field" as const, target: item.spec.target };
        }
        if (result.decision === "keep-current" || result.decision === "reject-proposed") {
          return { kind: "leave-current" as const, target: item.spec.target };
        }
        return undefined;
      },
    });

    assert.deepEqual(actions.map((entry) => entry.action), [
      { kind: "apply-field", target: "hours" },
      { kind: "leave-current", target: "phoneNumber" },
      { kind: "leave-current", target: "streetAddress" },
    ]);

    const skipped = mapReviewWorkbenchResultsToApplyActions({
      results: apply.results,
      items: snapshot.items,
      skip: ({ result }) => result.decision === "reject-proposed",
      map: ({ target }) => ({ kind: "apply-or-keep" as const, target }),
    });

    assert.deepEqual(skipped.map((entry) => entry.action.target), ["hours", "phoneNumber"]);

    const expanded = mapReviewWorkbenchResultsToApplyActions({
      results: [hoursResult],
      items: snapshot.items,
      map: ({ target, selectedCandidate }) => [
        { kind: "apply-field" as const, target },
        { kind: "record-selected-candidate" as const, candidateId: selectedCandidate.id },
      ],
    });

    assert.deepEqual(expanded.map((entry) => entry.action), [
      { kind: "apply-field", target: "hours" },
      { kind: "record-selected-candidate", candidateId: "public-directory-hours:candidate:proposed" },
    ]);
  });

  it("fails closed when review apply action mapping sees stale or incomplete inputs", () => {
    const snapshot = initialReviewQueueSessionState();
    const reviewedSession = {
      ...snapshot,
      decisionsByItemName: {
        "public-directory-hours": "accept-proposed" as const,
      },
    };
    const apply = deriveReviewSessionApplyResultForSnapshot({
      snapshot,
      events: buildReviewSessionEvents(reviewedSession),
      requiredResolvedItems: "any",
    });
    assert.equal(apply.ok, true);
    const [result] = apply.results;
    assert.ok(result);

    assert.throws(
      () => mapReviewWorkbenchResultsToApplyActions({
        results: [{ ...result, reviewItemName: "missing-review-item" }],
        items: snapshot.items,
        map: ({ target }) => ({ target }),
      }),
      (error) =>
        error instanceof ReviewApplyActionMappingError
        && error.issues[0]?.code === "unknown-review-item",
    );

    assert.throws(
      () => mapReviewWorkbenchResultsToApplyActions({
        results: apply.results,
        items: snapshot.items,
        map: () => undefined,
      }),
      (error) =>
        error instanceof ReviewApplyActionMappingError
        && error.issues[0]?.code === "unmapped-review-result",
    );

    assert.throws(
      () => mapReviewWorkbenchResultsToApplyActions({
        results: [{ ...result, selectedCandidateId: "stale-candidate" }],
        items: snapshot.items,
        map: ({ target }) => ({ target }),
      }),
      (error) =>
        error instanceof ReviewApplyActionMappingError
        && error.issues[0]?.code === "selected-candidate-mismatch",
    );

    const duplicateTargetItems = [
      snapshot.items[0]!,
      {
        ...snapshot.items[1]!,
        spec: {
          ...snapshot.items[1]!.spec,
          target: snapshot.items[0]!.spec.target,
        },
      },
    ];
    assert.throws(
      () => mapReviewWorkbenchResultsToApplyActions({
        results: apply.results,
        items: duplicateTargetItems,
        requireUniqueTargets: true,
        map: ({ target }) => ({ target }),
      }),
      (error) =>
        error instanceof ReviewApplyActionMappingError
        && error.issues.some((issue) => issue.code === "duplicate-review-target"),
    );
  });

  it("reports unresolved review items before a product applies review results", () => {
    const session = initialReviewQueueSessionState();
    const events = buildReviewSessionEvents({
      ...session,
      decisionsByItemName: {
        "public-directory-hours": "accept-proposed",
      },
    });

    const fullApply = deriveReviewSessionApplyResultForSnapshot({
      snapshot: session,
      events,
      requiredResolvedItems: "all",
    });
    const partialApply = deriveReviewSessionApplyResultForSnapshot({
      snapshot: session,
      events,
      requiredResolvedItems: "any",
    });

    assert.equal(fullApply.ok, false);
    assert.ok(fullApply.issues.every((issue) => issue.code === "unresolved-review-item"));
    assert.ok(fullApply.unresolvedItemNames.includes("public-directory-phone"));
    assert.equal(fullApply.unresolvedItemNames.includes("public-directory-hours"), false);
    assert.equal(fullApply.results.length, 1);
    assert.equal(partialApply.ok, true);
    assert.equal(partialApply.results.length, 1);
  });

  it("reports empty and stale persisted event sets without throwing", () => {
    const session = initialReviewQueueSessionState();
    const completeEvents = buildReviewSessionEvents({
      ...session,
      decisionsByItemName: {
        "public-directory-hours": "accept-proposed",
      },
    });
    const decisionEvent = completeEvents.find((event) => event.spec.eventType === "decision-changed");
    assert.ok(decisionEvent);
    const eventForUnknownItem = replaceReviewEventSpec(decisionEvent, {
      sequence: 1,
      reviewItemName: "missing-review-item",
    });

    const emptyApply = deriveReviewSessionApplyResultForSnapshot({
      snapshot: session,
      events: [],
      requiredResolvedItems: "any",
    });
    const staleApply = deriveReviewSessionApplyResultForSnapshot({
      snapshot: session,
      events: [eventForUnknownItem],
      requiredResolvedItems: "all",
    });
    const partiallyValidEvents = buildReviewSessionEvents({
      ...session,
      decisionsByItemName: {
        "public-directory-hours": "accept-proposed",
        "public-directory-phone": "keep-current",
      },
    });
    const malformedPhoneEvents = partiallyValidEvents.map((event) =>
      event.spec.eventType === "decision-changed" && event.spec.reviewItemName === "public-directory-phone"
        ? replaceReviewEventSpec(event, { data: { workbenchDecision: "not-a-workbench-decision" } })
        : event,
    );
    const currentHoursCandidate = session.items
      .find((item) => item.metadata.name === "public-directory-hours")
      ?.spec.candidates.find((candidate) => candidate.role === "current");
    assert.ok(currentHoursCandidate);
    const candidateMismatchEvents = partiallyValidEvents.map((event) =>
      event.spec.eventType === "decision-changed" && event.spec.reviewItemName === "public-directory-hours"
        ? replaceReviewEventSpec(event, { candidateId: currentHoursCandidate.id })
        : event,
    );
    const malformedPartialApply = deriveReviewSessionApplyResultForSnapshot({
      snapshot: session,
      events: malformedPhoneEvents,
      requiredResolvedItems: "any",
    });
    const mismatchPartialApply = deriveReviewSessionApplyResultForSnapshot({
      snapshot: session,
      events: candidateMismatchEvents,
      requiredResolvedItems: "any",
    });

    assert.equal(emptyApply.ok, false);
    assert.deepEqual(emptyApply.issues.map((issue) => issue.code), ["no-resolved-review-items"]);
    assert.deepEqual(emptyApply.unresolvedItemNames, session.items.map((item) => item.metadata.name));
    assert.equal(emptyApply.results.length, 0);
    assert.equal(staleApply.ok, false);
    assert.deepEqual(staleApply.issues.map((issue) => issue.code), ["unknown-review-item"]);
    assert.deepEqual(staleApply.unresolvedItemNames, session.items.map((item) => item.metadata.name));
    assert.equal(staleApply.results.length, 0);
    assert.equal(malformedPartialApply.ok, false);
    assert.deepEqual(malformedPartialApply.issues.map((issue) => issue.code), ["invalid-workbench-decision"]);
    assert.equal(malformedPartialApply.results.length, 0);
    assert.equal(mismatchPartialApply.ok, false);
    assert.deepEqual(mismatchPartialApply.issues.map((issue) => issue.code), ["decision-candidate-mismatch"]);
    assert.equal(mismatchPartialApply.results.length, 0);
  });

  it("creates a queued persistent event store with expected event count and status callbacks", async () => {
    const session = initialReviewQueueSessionState();
    const firstEvents = buildReviewSessionEvents({
      ...session,
      notesByItemName: {
        "public-directory-hours": "Accepted posted hours.",
      },
    });
    const secondEvents = buildReviewSessionEvents({
      ...session,
      notesByItemName: {
        "public-directory-hours": "Accepted posted hours.",
      },
      decisionsByItemName: {
        "public-directory-hours": "accept-proposed",
      },
    });
    const requests: Array<{
      expectedEventCount: number;
      events: readonly unknown[];
    }> = [];
    const statuses: string[] = [];
    const store = createPersistentReviewSessionEventStore({
      initialEvents: [],
      onStatusChange: (state) => statuses.push(state.status),
      persist: async (request) => {
        requests.push({
          expectedEventCount: request.expectedEventCount,
          events: request.events,
        });
        return { eventCount: request.events.length };
      },
    });

    store.save(session, firstEvents);
    store.save(session, secondEvents);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(requests.map((request) => request.expectedEventCount), [0, firstEvents.length]);
    assert.deepEqual(requests.map((request) => request.events.length), [firstEvents.length, secondEvents.length]);
    assert.deepEqual(statuses, ["saving", "saved", "saving", "saved"]);
    assert.equal(store.events().length, secondEvents.length);
  });

  it("persists review session events through an awaitable helper before replay", async () => {
    const session = initialReviewQueueSessionState();
    const events = buildReviewSessionEvents({
      ...session,
      notesByItemName: {
        "public-directory-hours": "Accepted posted hours.",
      },
      decisionsByItemName: {
        "public-directory-hours": "accept-proposed",
      },
    });
    const requests: Array<{
      expectedEventCount: number;
      events: readonly ReviewSessionEvent[];
    }> = [];

    const persisted = await persistReviewSessionEvents({
      session,
      events,
      expectedEventCount: 3,
      persist: async (request) => {
        requests.push({
          expectedEventCount: request.expectedEventCount,
          events: request.events,
        });
        return { eventCount: request.events.length };
      },
    });
    const exported = buildReviewWorkbenchSessionExportForSnapshot(session, persisted.events);

    assert.equal(persisted.eventCount, events.length);
    assert.deepEqual(persisted.events, events);
    assert.deepEqual(requests.map((request) => request.expectedEventCount), [3]);
    assert.equal(exported.results[0]?.decision, "accept-proposed");
  });

  it("uses committed review events returned by the persistence callback", async () => {
    const session = initialReviewQueueSessionState();
    const events = buildReviewSessionEvents({
      ...session,
      notesByItemName: {
        "public-directory-hours": "Accepted posted hours.",
      },
    });
    const committedEvents = events.map((event) => ({
      ...event,
      metadata: {
        ...event.metadata,
        annotations: {
          ...event.metadata.annotations,
          "survey.kontourai.io/persisted-by": "example-store",
        },
      },
    }));

    const persisted = await persistReviewSessionEvents({
      session,
      events,
      persist: async () => ({
        events: committedEvents,
        eventCount: committedEvents.length,
      }),
    });

    assert.deepEqual(persisted.events, committedEvents);
    assert.notDeepEqual(persisted.events, events);
    assert.equal(persisted.eventCount, committedEvents.length);
  });

  it("defaults persisted review event count to the persisted event array length", async () => {
    const session = initialReviewQueueSessionState();
    const events = buildReviewSessionEvents({
      ...session,
      notesByItemName: {
        "public-directory-hours": "Accepted posted hours.",
      },
    });

    const persisted = await persistReviewSessionEvents({
      session,
      events,
      persist: async () => undefined,
    });

    assert.equal(persisted.eventCount, events.length);
    assert.deepEqual(persisted.events, events);
  });

  it("marks selected and unselected outcomes after a decision", () => {
    const acceptedHtml = renderReviewWorkbenchHtml({
      ...initialReviewWorkbenchState(),
      decision: "accept-proposed",
    });
    const keptHtml = renderReviewWorkbenchHtml({
      ...initialReviewWorkbenchState(),
      decision: "keep-current",
    });
    const rejectedHtml = renderReviewWorkbenchHtml({
      ...initialReviewWorkbenchState(),
      decision: "reject-proposed",
    });

    assert.match(acceptedHtml, /data-testid="candidate-proposed" data-outcome="selected"/);
    assert.match(acceptedHtml, /data-testid="candidate-current" data-outcome="unselected"/);
    assert.match(keptHtml, /data-testid="candidate-current" data-outcome="selected"/);
    assert.match(keptHtml, /data-testid="candidate-proposed" data-outcome="unselected"/);
    assert.match(rejectedHtml, /data-testid="candidate-proposed" data-outcome="selected"/);
    assert.match(rejectedHtml, /data-testid="candidate-current" data-outcome="unselected"/);
    assert.doesNotMatch(rejectedHtml, /data-testid="candidate-current" data-outcome="selected"/);
  });

  it("keeps reject-proposed visually distinct from keep-current", () => {
    const rejectedState = {
      ...initialReviewWorkbenchState(),
      decision: "reject-proposed" as const,
    };
    const keptState = {
      ...initialReviewWorkbenchState(),
      decision: "keep-current" as const,
    };

    const rejectedDecision = buildReviewDecision(rejectedState);
    const keptDecision = buildReviewDecision(keptState);

    assert.equal(rejectedDecision?.spec.candidateId, "public-directory:candidate:proposed");
    assert.equal(rejectedDecision?.spec.status, "rejected");
    assert.equal(keptDecision?.spec.candidateId, "public-directory:candidate:current");
    assert.equal(keptDecision?.spec.status, "verified");

    const rejectedHtml = renderReviewWorkbenchHtml(rejectedState);
    const keptHtml = renderReviewWorkbenchHtml(keptState);

    assert.match(rejectedHtml, /data-testid="candidate-proposed" data-outcome="selected"/);
    assert.match(keptHtml, /data-testid="candidate-current" data-outcome="selected"/);
  });

  it("AC1 builds different Surface previews for accept-proposed and keep-current decisions", () => {
    const acceptedState = {
      ...initialReviewWorkbenchState(),
      decision: "accept-proposed" as const,
      note: "Accepted changed listing posture.",
    };
    const keptState = {
      ...initialReviewWorkbenchState(),
      decision: "keep-current" as const,
      note: "Kept existing reviewed source.",
    };

    const accepted = buildSurfaceProjectionPreview(acceptedState.item, buildReviewDecision(acceptedState));
    const kept = buildSurfaceProjectionPreview(keptState.item, buildReviewDecision(keptState));

    assert.ok(accepted);
    assert.ok(kept);
    assert.equal(accepted.canonicalClaim.candidateId, "public-directory:candidate:proposed");
    assert.equal(accepted.canonicalClaim.value, "WAITLIST");
    assert.equal(kept.canonicalClaim.candidateId, "public-directory:candidate:current");
    assert.equal(kept.canonicalClaim.value, "AVAILABLE");
    assert.notDeepEqual(accepted, kept);
  });

  it("AC2 shows selected canonical claim and unselected candidate history for accept-proposed", () => {
    const state = {
      ...initialReviewWorkbenchState(),
      decision: "accept-proposed" as const,
    };

    const preview = buildSurfaceProjectionPreview(state.item, buildReviewDecision(state));

    assert.ok(preview);
    assert.equal(preview.canonicalClaim.claimId, "public-field.entity-123.availability-status.proposal-456");
    assert.equal(preview.canonicalClaim.status, "verified");
    assert.deepEqual(preview.candidateHistory, [
      {
        candidateId: "public-directory:candidate:current",
        value: "AVAILABLE",
        historyLabel: "Unselected candidate history",
      },
    ]);

    const html = renderReviewWorkbenchHtml(state);
    assert.match(html, /data-testid="surface-canonical-claim"/);
    assert.match(html, /Selected claim/);
    assert.match(html, /public-field\.entity-123\.availability-status\.proposal-456/);
    assert.match(html, /data-testid="surface-candidate-history"/);
    assert.match(html, /Unselected candidate history/);
    assert.match(html, /public-directory:candidate:current/);
  });

  it("AC2 shows selected canonical claim and unselected candidate history for keep-current", () => {
    const state = {
      ...initialReviewWorkbenchState(),
      decision: "keep-current" as const,
      note: "Kept current source posture.",
    };

    const preview = buildSurfaceProjectionPreview(state.item, buildReviewDecision(state));

    assert.ok(preview);
    assert.equal(preview.canonicalClaim.candidateId, "public-directory:candidate:current");
    assert.equal(preview.canonicalClaim.claimId, "public-field.entity-123.availability-status.current");
    assert.equal(preview.canonicalClaim.value, "AVAILABLE");
    assert.equal(preview.canonicalClaim.status, "verified");
    assert.deepEqual(preview.candidateHistory, [
      {
        candidateId: "public-directory:candidate:proposed",
        value: "WAITLIST",
        historyLabel: "Unselected candidate history",
      },
    ]);

    const html = renderReviewWorkbenchHtml(state);
    assert.match(html, /public-field\.entity-123\.availability-status\.current/);
    assert.match(html, /public-directory:candidate:proposed/);
    assert.match(html, /WAITLIST/);
  });

  it("AC3 shows source evidence, sourceAuthority metadata, and review event for keep-current", () => {
    const state = {
      ...initialReviewWorkbenchState(),
      decision: "keep-current" as const,
      note: "Reviewed against approved page.",
    };

    const preview = buildSurfaceProjectionPreview(state.item, buildReviewDecision(state));

    assert.ok(preview);
    assert.equal(preview.sourceEvidence.sourceRef, "https://example.test/listings/example-program");
    assert.equal(preview.sourceEvidence.sourceId, "public-field:source:approved-page");
    assert.equal(preview.sourceEvidence.excerpt, "Availability is open for the example program.");
    assert.equal(preview.sourceEvidence.extractionId, "public-field:extraction:approved");
    assert.equal(preview.sourceEvidence.extractor, "example-field-review");
    assert.equal(preview.sourceEvidence.observedAt, "2026-05-30T18:00:00.000Z");
    assert.equal(preview.sourceEvidence.sourceAuthority?.authorityClass, "public-directory-listing");
    assert.equal(preview.sourceEvidence.sourceAuthority?.declaredBy, "Example Program public directory");
    assert.equal(preview.sourceEvidence.sourceAuthority?.scope, "availabilityStatus field on entity-123");
    assert.equal(preview.reviewEvent?.actor, "review-workbench-operator");
    assert.equal(preview.reviewEvent?.reviewedAt, "2026-06-04T00:00:00.000Z");
    assert.equal(preview.reviewEvent?.status, "verified");
    assert.equal(preview.reviewEvent?.rationale, "Reviewed against approved page.");
    assert.equal(preview.reviewEvent?.reviewOutcomeId, "public-field:review:approved");

    const html = renderReviewWorkbenchHtml(state);
    assert.match(html, /data-testid="surface-source-evidence"/);
    assert.match(html, /https:\/\/example\.test\/listings\/example-program/);
    assert.match(html, /public-field:source:approved-page/);
    assert.match(html, /Availability is open for the example program\./);
    assert.match(html, /public-field:extraction:approved/);
    assert.match(html, /example-field-review/);
    assert.match(html, /2026-05-30T18:00:00\.000Z/);
    assert.match(html, /Source authority class/);
    assert.match(html, /Example Program public directory/);
    assert.match(html, /data-testid="surface-review-event"/);
    assert.match(html, /2026-06-04T00:00:00\.000Z/);
    assert.match(html, /public-field:review:approved/);
    assert.match(html, /Reviewed against approved page\./);
  });

  it("AC3 shows source evidence and review event for accept-proposed", () => {
    const state = {
      ...initialReviewWorkbenchState(),
      decision: "accept-proposed" as const,
      note: "Accepted source update.",
    };

    const preview = buildSurfaceProjectionPreview(state.item, buildReviewDecision(state));

    assert.ok(preview);
    assert.equal(preview.sourceEvidence.sourceRef, "https://example.test/listings/example-program");
    assert.equal(preview.sourceEvidence.sourceId, "public-field:source:proposal-page");
    assert.equal(preview.sourceEvidence.excerpt, "Join the waitlist for this listing.");
    assert.equal(preview.sourceEvidence.extractionId, "public-field:extraction:proposal");
    assert.equal(preview.sourceEvidence.extractor, "example-crawl");
    assert.equal(preview.sourceEvidence.observedAt, "2026-05-31T15:00:00.000Z");
    assert.equal(preview.reviewEvent?.status, "verified");
    assert.equal(preview.reviewEvent?.reviewedAt, "2026-06-04T00:00:00.000Z");
    assert.equal(preview.reviewEvent?.rationale, "Accepted source update.");
    assert.equal(preview.reviewEvent?.reviewOutcomeId, "public-directory-availability:accept-proposed:review-outcome");
  });

  it("AC4 labels empty authorityTrace neutrally and keeps sourceAuthority separate", () => {
    const state = {
      ...initialReviewWorkbenchState(),
      decision: "accept-proposed" as const,
    };

    const preview = buildSurfaceProjectionPreview(state.item, buildReviewDecision(state));

    assert.ok(preview);
    assert.equal(preview.authorityTrace.status, "empty");
    assert.equal(preview.authorityTrace.label, "Empty / not provided");
    assert.match(preview.authorityTrace.detail, /SourceAuthority metadata is shown as source evidence/);
    assert.match(preview.postureDisclaimer, /does not validate real-world truth/);

    const html = renderReviewWorkbenchHtml(state);
    assert.match(html, /data-testid="surface-authority-trace"/);
    assert.match(html, /Empty \/ not provided/);
    assert.match(html, /is-neutral/);
    assert.match(html, /Survey records source and review posture/);
    assert.match(html, /does not validate real-world truth/);
  });

  it("renders a regulated rule conflict ReviewItem without product-specific workbench branches", () => {
    const state = {
      ...initialReviewWorkbenchState(regulatedRuleConflictReviewItemExample),
      decision: "keep-current" as const,
      note: "Kept current value after reviewing the official source candidate.",
    };

    const decision = buildReviewDecision(state);
    const preview = buildSurfaceProjectionPreview(state.item, decision);
    const html = renderReviewWorkbenchHtml(state);

    assert.ok(decision);
    assert.equal(decision.spec.reviewItemName, "regulated-rule-conflict-standard-threshold");
    assert.equal(decision.spec.candidateId, "regulated-rule-conflict-standard-threshold:candidate:current");
    assert.equal(decision.spec.status, "verified");
    assert.ok(preview);
    assert.equal(preview.canonicalClaim.value, "15000");
    assert.equal(preview.candidateHistory[0]?.candidateId, "regulated-rule-conflict-standard-threshold:candidate:proposed");
    assert.equal(preview.candidateHistory[0]?.value, "16000");
    assert.equal(preview.sourceEvidence.sourceRef, "survey-example://rules/example-jurisdiction/2026/standardThreshold");
    assert.match(html, /Regulated Rule Review/);
    assert.match(html, /standardThreshold/);
    assert.match(html, /Example Individual Standard Threshold \$16,000/);
    assert.match(html, /data-testid="candidate-current" data-outcome="selected"/);
    assert.match(html, /data-testid="candidate-proposed" data-outcome="unselected"/);
  });

  it("updates the mounted payload and replaces Surface preview when the reviewer enters a note", () => {
    const root = new ReviewWorkbenchTestRoot();
    const documentRestore = installTestDocument();

    try {
      mountReviewWorkbench(root as unknown as HTMLElement);
      root.clickDecision("accept-proposed");
      root.textarea.value = "Checked the source excerpt.";
      root.textarea.dispatch("input");
    } finally {
      documentRestore();
    }

    assert.match(root.payload.textContent, /Checked the source excerpt\./);
    assert.match(root.payload.textContent, /"kind": "ReviewDecision"/);
    assert.match(root.surfacePreview.html, /Checked the source excerpt\./);
    assert.match(root.surfacePreview.html, /data-testid="surface-review-event"/);
    assert.equal(root.surfacePreview.replaceCount, 1);
  });

  it("preserves the mounted single-item start state behavior", () => {
    const root = new ReviewWorkbenchTestRoot();

    mountReviewWorkbench(root as unknown as HTMLElement, {
      ...initialReviewWorkbenchState(),
      decision: "reject-proposed",
      note: "Rejected proposed source.",
    });

    assert.equal(root.textarea.value, "Rejected proposed source.");
    assert.match(root.html, /decision-button is-active" type="button" data-decision="reject-proposed"/);
    assert.match(root.payload.textContent, /"candidateId": "public-directory:candidate:proposed"/);
    assert.match(root.payload.textContent, /"status": "rejected"/);
    assert.match(root.html, /data-testid="candidate-proposed" data-outcome="selected"/);
  });

  it("AC37-2 handles mounted queue navigation without losing local note or decision", () => {
    const root = new ReviewWorkbenchTestRoot();
    const documentRestore = installTestDocument();

    try {
      mountReviewWorkbench(root as unknown as HTMLElement);
      root.clickDecision("accept-proposed");
      root.textarea.value = "Accepted the hours update.";
      root.textarea.dispatch("input");
      root.clickNextUnresolved();
      assert.match(root.html, /public-directory-phone/);
      root.clickDecision("keep-current");
      root.textarea.value = "Kept the listed phone.";
      root.textarea.dispatch("input");
      root.clickQueueRow("public-directory-hours");
    } finally {
      documentRestore();
    }

    assert.equal(root.textarea.value, "Accepted the hours update.");
    assert.match(root.html, /decision-button is-active" type="button" data-decision="accept-proposed"/);
    assert.match(root.html, /data-queue-status="resolved"/);
    assert.match(root.html, /Kept current/);
  });

  it("persists mounted review decisions and notes through a ReviewSessionEvent store", () => {
    const store = createInMemoryReviewSessionEventStore();
    const firstRoot = new ReviewWorkbenchTestRoot();
    const documentRestore = installTestDocument();

    try {
      mountReviewWorkbench(firstRoot as unknown as HTMLElement, initialReviewQueueSessionState(), { eventStore: store });
      firstRoot.clickDecision("accept-proposed");
      firstRoot.textarea.value = "Accepted persisted hours.";
      firstRoot.textarea.dispatch("input");
      firstRoot.clickNextUnresolved();
    } finally {
      documentRestore();
    }

    assert.deepEqual(store.events().map((event) => event.spec.eventType), [
      "decision-changed",
      "note-changed",
      "item-selected",
    ]);
    assert.match(firstRoot.html, /data-testid="session-audit"/);
    assert.match(firstRoot.html, /Events/);
    assert.match(firstRoot.html, /03/);
    assert.match(firstRoot.html, /note-changed/);

    const secondRoot = new ReviewWorkbenchTestRoot();
    mountReviewWorkbench(secondRoot as unknown as HTMLElement, initialReviewQueueSessionState(), { eventStore: store });

    assert.match(secondRoot.html, /public-directory-phone/);
    assert.match(secondRoot.html, /replay ok/);
    assert.match(secondRoot.html, /decision-changed/);
    secondRoot.clickQueueRow("public-directory-hours");
    assert.equal(secondRoot.textarea.value, "Accepted persisted hours.");
    assert.match(secondRoot.html, /decision-button is-active" type="button" data-decision="accept-proposed"/);
  });

  it("keeps local ReviewSessionEvent storage scoped to the review item set", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string): string | null => values.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        values.set(key, value);
      },
    };
    const store = createLocalStorageReviewSessionEventStore(storage);
    const queueSession = initialReviewQueueSessionState();
    const singleItemSession = initialReviewQueueSessionState([publicDirectoryReviewItemExample]);
    const events = buildReviewSessionEvents(queueSession);

    store.save(queueSession, events);

    assert.deepEqual(store.load(queueSession), events);
    assert.equal(store.load(singleItemSession), undefined);
  });

  it("ignores malformed local ReviewSessionEvent storage payloads", () => {
    const store = createLocalStorageReviewSessionEventStore({
      getItem: () => "{",
      setItem: () => undefined,
    });

    assert.equal(store.load(initialReviewQueueSessionState()), undefined);
  });

  for (const entry of cases) {
    it(`handles mounted ${entry.decision} button clicks`, () => {
      const root = new ReviewWorkbenchTestRoot();

      mountReviewWorkbench(root as unknown as HTMLElement, initialReviewQueueSessionState([publicDirectoryReviewItemExample]));
      root.clickDecision(entry.decision);

      assert.match(root.html, new RegExp(escapeRegExp(entry.selectedText)));
      assert.match(root.html, new RegExp(`data-decision="${entry.decision}"`));
      assert.match(root.html, new RegExp(`decision-button is-active" type="button" data-decision="${entry.decision}"`));
      assert.match(root.payload.textContent, new RegExp(`"candidateId": "${escapeRegExp(entry.candidateId)}"`));
      assert.match(root.payload.textContent, new RegExp(`"status": "${entry.status}"`));
    });
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

class ReviewWorkbenchTestRoot {
  html = "";
  textarea = new TestTextAreaElement();
  payload = new TestPayloadElement();
  surfacePreview = new TestSurfacePreviewElement(this);
  private buttons: TestButtonElement[] = [];
  private queueRows: TestQueueRowElement[] = [];
  private nextButtons: TestNextButtonElement[] = [];

  set innerHTML(value: string) {
    this.html = value;
    this.textarea = new TestTextAreaElement(textareaValue(value));
    this.payload = new TestPayloadElement(payloadValue(value));
    this.surfacePreview = new TestSurfacePreviewElement(this, surfacePreviewValue(value));
    this.buttons = decisionValues(value).map((decision) => new TestButtonElement(decision));
    this.queueRows = queueItemNames(value).map((itemName) => new TestQueueRowElement(itemName));
    this.nextButtons = nextButtonTestIds(value).map(() => new TestNextButtonElement());
  }

  get innerHTML(): string {
    return this.html;
  }

  querySelector<T>(selector: string): T | null {
    if (selector === "[data-testid='reviewer-note']") {
      return this.textarea as T;
    }

    if (selector === "[data-testid='decision-payload']") {
      return this.payload as T;
    }

    if (selector === "[data-testid='surface-preview']") {
      return this.surfacePreview as T;
    }

    if (selector === "[data-testid='next-unresolved']") {
      return this.nextButtons[0] as T;
    }

    return null;
  }

  querySelectorAll<T>(selector: string): T[] {
    if (selector === "[data-decision]") {
      return this.buttons as T[];
    }

    if (selector === "[data-item-name]") {
      return this.queueRows as T[];
    }

    if (selector === "[data-testid='next-unresolved'], [data-testid='active-next-unresolved']") {
      return this.nextButtons as T[];
    }

    return [];
  }

  clickDecision(decision: ReviewWorkbenchDecision): void {
    const button = this.buttons.find((entry) => entry.dataset.decision === decision);
    assert.ok(button, `Missing test button for ${decision}`);
    button.click();
  }

  clickQueueRow(itemName: string): void {
    const row = this.queueRows.find((entry) => entry.dataset.itemName === itemName);
    assert.ok(row, `Missing test queue row for ${itemName}`);
    row.click();
  }

  clickNextUnresolved(): void {
    this.nextButtons[0]?.click();
  }
}

class TestSurfacePreviewElement {
  replaceCount = 0;

  constructor(
    private readonly root: ReviewWorkbenchTestRoot,
    public html = "",
  ) {}

  replaceWith(replacement: TestSurfacePreviewElement): void {
    this.replaceCount += 1;
    this.html = replacement.html;
    this.root.surfacePreview = this;
    this.root.html = replaceSurfacePreview(this.root.html, replacement.html);
  }
}

class TestWrapperElement {
  firstElementChild: TestSurfacePreviewElement | null = null;

  set innerHTML(value: string) {
    this.firstElementChild = new TestSurfacePreviewElement(new ReviewWorkbenchTestRoot(), value);
  }
}

class TestTextAreaElement {
  private readonly listeners = new Map<string, Array<(event: { target: TestTextAreaElement }) => void>>();

  constructor(public value = "") {}

  addEventListener(type: string, listener: (event: { target: TestTextAreaElement }) => void): void {
    this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]);
  }

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ target: this });
    }
  }
}

class TestButtonElement {
  readonly dataset: { decision: ReviewWorkbenchDecision };
  private readonly listeners = new Map<string, Array<() => void>>();

  constructor(decision: ReviewWorkbenchDecision) {
    this.dataset = { decision };
  }

  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]);
  }

  click(): void {
    for (const listener of this.listeners.get("click") ?? []) {
      listener();
    }
  }
}

class TestQueueRowElement {
  readonly dataset: { itemName: string };
  private readonly listeners = new Map<string, Array<() => void>>();

  constructor(itemName: string) {
    this.dataset = { itemName };
  }

  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]);
  }

  click(): void {
    for (const listener of this.listeners.get("click") ?? []) {
      listener();
    }
  }
}

class TestNextButtonElement {
  private readonly listeners = new Map<string, Array<() => void>>();

  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]);
  }

  click(): void {
    for (const listener of this.listeners.get("click") ?? []) {
      listener();
    }
  }
}

class TestPayloadElement {
  constructor(public textContent = "") {}
}

function installTestDocument(): () => void {
  const previousDocument = globalThis.document;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: () => new TestWrapperElement(),
    },
  });

  return () => {
    if (previousDocument === undefined) {
      Reflect.deleteProperty(globalThis, "document");
      return;
    }

    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: previousDocument,
    });
  };
}

function decisionValues(html: string): ReviewWorkbenchDecision[] {
  return [...html.matchAll(/data-decision="([^"]+)"/g)].map((match) => match[1] as ReviewWorkbenchDecision);
}

function queueItemNames(html: string): string[] {
  return [...html.matchAll(/data-item-name="([^"]+)"/g)].map((match) => unescapeHtml(match[1]));
}

function nextButtonTestIds(html: string): string[] {
  return [...html.matchAll(/data-testid="(?:next-unresolved|active-next-unresolved)"/g)].map((match) => match[0]);
}

function textareaValue(html: string): string {
  return unescapeHtml(html.match(/<textarea[^>]*data-testid="reviewer-note"[^>]*>([\s\S]*?)<\/textarea>/)?.[1] ?? "");
}

function payloadValue(html: string): string {
  return unescapeHtml(html.match(/<pre[^>]*data-testid="decision-payload"[^>]*>([\s\S]*?)<\/pre>/)?.[1] ?? "");
}

function surfacePreviewValue(html: string): string {
  return html.match(/(<section class="surface-preview"[^>]*data-testid="surface-preview"[\s\S]*?)\s*<details class="payload-panel">/)?.[1]
    ?? html.match(/<section class="surface-preview"[^>]*data-testid="surface-preview"[\s\S]*?<\/section>/)?.[0]
    ?? "";
}

function replaceSurfacePreview(html: string, replacement: string): string {
  return html.replace(
    /<section class="surface-preview"[^>]*data-testid="surface-preview"[\s\S]*?(?=\s*<details class="payload-panel">)/,
    `${replacement}\n      `,
  );
}

function replaceReviewEventSpec(
  event: ReviewSessionEvent,
  spec: Partial<ReviewSessionEvent["spec"]>,
): ReviewSessionEvent {
  return {
    ...event,
    spec: {
      ...event.spec,
      ...spec,
    },
  };
}

function facilityCredentialPresentationAdapter(): ReviewPresentationAdapter {
  return {
    labelForTarget: (target) => target === "operatingLicenseCredential" ? "Operating license credential" : undefined,
    statusLabel: (status) => status === "needs-review" ? "Credential review needed" : undefined,
    summarizeValue: (value) => {
      if (!isRecord(value)) {
        return undefined;
      }

      const permittedServices = Array.isArray(value.permittedServices) ? value.permittedServices : [];
      const inspections = Array.isArray(value.inspections) ? value.inspections : [];
      return `${String(value.licenseNumber)} ${String(value.status)} through ${String(value.expiresAt)}; `
        + `${permittedServices.length} permitted services; ${inspections.length} inspections`;
    },
    linkForTraceRef: (ref) => ref.kind === "candidate"
      ? { href: `/credential-review/trace/${encodeURIComponent(ref.value)}` }
      : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unescapeHtml(value: string): string {
  return value
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}
