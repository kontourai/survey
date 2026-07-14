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
  validateProposedValue,
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
      assert.match(html, /Saved record \(JSON\)/);
      assert.match(html, /&quot;kind&quot;: &quot;ReviewDecision&quot;/);
    });
  }

  it("renders candidate and evidence context from the public directory fixture", () => {
    const html = renderReviewWorkbenchHtml(initialReviewWorkbenchState());

    assert.match(html, /data-testid="review-workbench-shell"/);
    assert.match(html, /Availability Status/);
    assert.match(html, /data-testid="review-field"/);
    assert.match(html, /data-testid="review-fields"/);
    assert.match(html, />Current</);
    assert.match(html, />Proposed</);
    assert.match(html, /AVAILABLE/);
    assert.match(html, /WAITLIST/);
    assert.match(html, /https:\/\/example\.test\/listings\/example-program/);
    assert.match(html, /html:field=availabilityStatus/);
    assert.match(html, /Join the waitlist for this listing\./);
    assert.match(html, /<span class="pct">0\.82<\/span>/);
    assert.match(html, /width:82%/);
    assert.match(html, /Reviewer note/);
    assert.match(html, /Use proposed/);
    assert.match(html, /Keep current/);
    assert.match(html, /Suggestion was wrong/);
    // The producing model is surfaced as its own audit line (distinct from the extractor tool).
    assert.match(html, /Model/);
    assert.match(html, /example-extraction-model-2026-05/);
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
    assert.equal(presentation.candidates[0]?.sourceLabel, "Source Reference");
    assert.equal(presentation.candidates[0]?.valueText, "current:available");
    assert.equal(presentation.candidates[1]?.roleLabel, "Proposed value");
    assert.equal(presentation.candidates[1]?.sourceLabel, "Source Reference");
    assert.equal(presentation.candidates[1]?.valueText, "proposed:waitlist");
    assert.equal(presentation.candidates[1]?.sourceLink?.href, "https://example.test/listings/example-program");
    assert.equal(
      presentation.candidates[1]?.traceRefs.find((ref) => ref.kind === "source")?.label,
      "Raw Source ID",
    );
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

  it("renders needs-review status as Needs Review without renaming persisted status", () => {
    const item: ReviewItem = {
      ...publicDirectoryReviewItemExample,
      spec: {
        ...publicDirectoryReviewItemExample.spec,
        candidateSetStatus: "needs-review",
      },
    };

    const presentation = buildReviewItemPresentation(item);
    const html = renderReviewWorkbenchHtml(initialReviewWorkbenchState(item));

    assert.equal(item.spec.candidateSetStatus, "needs-review");
    assert.equal(presentation.statusLabel, "Needs Review");
    // The workbench's own field-card chip ("Needs review") is independent display
    // vocabulary from the presentation adapter's statusLabel, which is no longer
    // surfaced on the primary review surface.
    assert.match(html, /Needs review/);
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
    assert.doesNotMatch(html, /<span class="fname">Availability Status<\/span>/);
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
    const itemByName = (name: string): ReviewItem => {
      const item = reviewWorkbenchQueueExamples.find((entry) => entry.metadata.name === name);
      assert.ok(item, `Missing fixture ReviewItem ${name}`);
      return item;
    };

    assert.equal(deriveQueueRowStatus(itemByName("public-directory-hours"), session), "in-review");
    assert.equal(deriveQueueRowStatus(itemByName("public-directory-phone"), session), "pending");
    assert.equal(deriveQueueRowStatus(itemByName("public-directory-availability"), session), "resolved");
    assert.equal(deriveQueueRowStatus(itemByName("public-directory-address"), session), "rejected");
    assert.equal(deriveQueueRowStatus(itemByName("public-directory-license"), session), "escalated");
    assert.equal(deriveQueueRowStatus(itemByName("regulated-rule-conflict-standard-threshold"), session), "pending");

    // The field-diff renderer derives its own (simpler) per-field chip vocabulary
    // (review/accepted/kept/rejected) independent of deriveQueueRowStatus, which
    // remains available for producers building their own queue UI.
    const html = renderReviewWorkbenchHtml(session);
    assert.match(html, /data-testid="review-workbench-shell"/);
    assert.match(html, new RegExp(`data-item-name="public-directory-hours"[\\s\\S]*?data-state="review"`));
    assert.match(html, new RegExp(`data-item-name="public-directory-address"[\\s\\S]*?data-state="rejected"`));
    assert.match(html, new RegExp(`data-item-name="public-directory-availability"[\\s\\S]*?data-state="kept"`));
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
    assert.equal(nextUnresolvedItemName(session), "public-directory-dropin-price");

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
      unresolved: 3,
    });

    // The field-diff footer tally uses its own plain-language vocabulary
    // (Accepted / Kept / Flagged / Remaining) rather than reviewSessionSummary's.
    const html = renderReviewWorkbenchHtml(initialReviewQueueSessionState());
    assert.match(html, /data-testid="review-tally"/);
    assert.match(html, /data-testid="tally-accepted"/);
    assert.match(html, /data-testid="tally-kept"/);
    assert.match(html, /data-testid="tally-rejected"/);
    assert.match(html, /data-testid="tally-review"/);
  });

  // The whole-session audit trail panel (ReviewSession metadata, replay status,
  // ordered event list, session export JSON) was removed from the rendered UI in
  // the field-diff redesign — audit detail is now scoped per field (see the
  // "audit-details" tests below). The underlying session/event/replay functions
  // (buildReviewSessionEvents, replayReviewSessionEvents, etc.) are unchanged and
  // covered by the data-layer tests elsewhere in this file.

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

    assert.match(acceptedHtml, /data-state="accepted"/);
    assert.match(acceptedHtml, /data-decision="accept-proposed"/);
    assert.match(acceptedHtml, /<span class="chip accepted"[^>]*>Accepted<\/span>/);
    assert.match(keptHtml, /data-state="kept"/);
    assert.match(keptHtml, /data-decision="keep-current"/);
    assert.match(keptHtml, /<span class="chip kept"[^>]*>Kept current<\/span>/);
    assert.match(rejectedHtml, /data-state="rejected"/);
    assert.match(rejectedHtml, /data-decision="reject-proposed"/);
    assert.match(rejectedHtml, /Kept — flagged wrong/);
    assert.doesNotMatch(rejectedHtml, /data-state="kept"/);
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

    assert.match(rejectedHtml, /data-state="rejected"/);
    assert.match(keptHtml, /data-state="kept"/);
    assert.notEqual(
      rejectedHtml.match(/<span class="chip rejected"[^>]*>([^<]+)<\/span>/)?.[1],
      keptHtml.match(/<span class="chip kept"[^>]*>([^<]+)<\/span>/)?.[1],
    );
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
    // The Selected claim section was removed (duplicated by candidate cards).
    // Claim IDs still appear in the candidate history reference details.
    assert.doesNotMatch(html, /data-testid="surface-canonical-claim"/);
    assert.doesNotMatch(html, /Selected claim/);
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

  it("AC3 shows Raw Source, Source Reference, sourceAuthority metadata, and review event for keep-current", () => {
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
    assert.match(html, />Raw Source</);
    assert.match(html, /Source Reference/);
    assert.match(html, /Raw Source ID/);
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

  it("AC3 shows Raw Source and review event for accept-proposed", () => {
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
    assert.match(preview.authorityTrace.detail, /SourceAuthority metadata is shown with Raw Source and Source Reference posture/);
    assert.match(preview.postureDisclaimer, /does not validate real-world truth/);

    const html = renderReviewWorkbenchHtml(state);
    assert.match(html, /data-testid="surface-authority-trace"/);
    assert.match(html, /Empty \/ not provided/);
    assert.match(html, /is-neutral/);
    assert.match(html, /Survey records Raw Source, Source Reference, and review posture/);
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
    assert.match(html, /data-state="kept"/);
    assert.match(html, /data-decision="keep-current"/);
  });

  it("updates the reviewer note in place without a full re-render", () => {
    const root = new ReviewWorkbenchTestRoot();

    mountReviewWorkbench(root as unknown as HTMLElement, initialReviewQueueSessionState([publicDirectoryReviewItemExample]));
    root.field(publicDirectoryReviewItemExample.metadata.name).useButton.click();

    const field = root.field(publicDirectoryReviewItemExample.metadata.name);
    field.noteTextarea.value = "Checked the source excerpt.";
    field.noteTextarea.dispatch("input");

    // The same field-scope object is still attached (no full re-render happened),
    // and its decision-payload <pre> was patched in place with the new rationale.
    assert.equal(root.field(publicDirectoryReviewItemExample.metadata.name), field);
    assert.match(field.payloadText, /Checked the source excerpt\./);
    assert.match(field.payloadText, /"kind": "ReviewDecision"/);
  });

  it("preserves the mounted single-item start state behavior", () => {
    const root = new ReviewWorkbenchTestRoot();

    mountReviewWorkbench(root as unknown as HTMLElement, {
      ...initialReviewWorkbenchState(),
      decision: "reject-proposed",
      note: "Rejected proposed source.",
    });

    const field = root.field(publicDirectoryReviewItemExample.metadata.name);
    assert.equal(field.noteTextarea.value, "Rejected proposed source.");
    assert.match(root.html, /data-state="rejected"/);
    assert.match(root.html, /data-decision="reject-proposed"/);
    assert.match(field.payloadText, /"candidateId": "public-directory:candidate:proposed"/);
    assert.match(field.payloadText, /"status": "rejected"/);
  });

  it("uses proposed, keeps current, and flags the wrong-toggle reject signal via mounted clicks", () => {
    const root = new ReviewWorkbenchTestRoot();
    // "public-directory-hours" has candidateSetStatus "needs-review" (not a
    // producer-pre-resolved item), so undo cleanly returns it to "review" state.
    const itemName = "public-directory-hours";
    mountReviewWorkbench(root as unknown as HTMLElement, initialReviewQueueSessionState());

    root.field(itemName).useButton.click();
    assert.match(root.html, new RegExp(`data-item-name="${itemName}"[\\s\\S]*?data-state="accepted"`));
    assert.match(root.field(itemName).payloadText, /"status": "verified"/);

    root.field(itemName).undoButton.click();
    assert.match(root.html, new RegExp(`data-item-name="${itemName}"[\\s\\S]*?data-state="review"`));

    root.field(itemName).keepButton.click();
    assert.match(root.html, new RegExp(`data-item-name="${itemName}"[\\s\\S]*?data-state="kept"`));
    assert.match(root.field(itemName).payloadText, /"candidateId": "public-directory-hours:candidate:current"/);

    root.field(itemName).undoButton.click();
    root.field(itemName).wrongbox.checked = true;
    root.field(itemName).keepButton.click();
    assert.match(root.html, new RegExp(`data-item-name="${itemName}"[\\s\\S]*?data-state="rejected"`));
    assert.match(root.field(itemName).payloadText, /"candidateId": "public-directory-hours:candidate:proposed"/);
    assert.match(root.field(itemName).payloadText, /"status": "rejected"/);
  });

  it("threads an inline-edited proposed value into the ReviewDecision payload's editedValue", () => {
    const root = new ReviewWorkbenchTestRoot();
    const itemName = publicDirectoryReviewItemExample.metadata.name;
    mountReviewWorkbench(root as unknown as HTMLElement, initialReviewQueueSessionState([publicDirectoryReviewItemExample]));

    const field = root.field(itemName);
    assert.ok(field.editInput);
    field.editInput!.value = "WAITLIST (verified by phone)";
    field.useButton.click();

    const decided = root.field(itemName);
    assert.match(decided.payloadText, /"editedValue": "WAITLIST \(verified by phone\)"/);
    // The candidateId still identifies the real proposed candidate — the edit does
    // not fabricate a new candidate identity.
    assert.match(decided.payloadText, /"candidateId": "public-directory:candidate:proposed"/);
    assert.match(root.html, /WAITLIST \(verified by phone\)/);
  });

  it("does not record editedValue when the input is left unchanged", () => {
    const root = new ReviewWorkbenchTestRoot();
    const itemName = publicDirectoryReviewItemExample.metadata.name;
    mountReviewWorkbench(root as unknown as HTMLElement, initialReviewQueueSessionState([publicDirectoryReviewItemExample]));

    root.field(itemName).useButton.click();

    assert.doesNotMatch(root.field(itemName).payloadText, /"editedValue"/);
  });

  describe("typed proposed-value editors (ReviewValueDescriptor)", () => {
    const withDescriptor = (
      item: ReviewItem,
      valueDescriptor: ReviewItem["spec"]["valueDescriptor"],
    ): ReviewItem => ({ ...item, spec: { ...item.spec, valueDescriptor } });

    it("renders a plain text input and 'editable' hint when no descriptor is present", () => {
      const html = renderReviewWorkbenchHtml(initialReviewWorkbenchState());
      assert.match(html, /<input\s+type="text"[^>]*data-testid="edit-proposed-value"/);
      assert.match(html, /class="ehint">editable</);
    });

    it("always renders a hidden value-error slot", () => {
      const html = renderReviewWorkbenchHtml(initialReviewWorkbenchState());
      assert.match(html, /data-testid="value-error"[^>]*hidden/);
    });

    it("renders a <select> of the declared enum values", () => {
      const item = withDescriptor(publicDirectoryReviewItemExample, {
        type: "enum",
        enumValues: ["open", "waitlist", "closed"],
      });
      const html = renderReviewWorkbenchHtml(initialReviewWorkbenchState(item));
      assert.match(html, /<select[^>]*data-testid="edit-proposed-value"/);
      for (const opt of ["open", "waitlist", "closed"]) {
        assert.match(html, new RegExp(`<option value="${opt}"`));
      }
      assert.match(html, /class="ehint">choose one</);
    });

    it("renders a date input for a date field", () => {
      const item = withDescriptor(publicDirectoryReviewItemExample, { type: "date" });
      const html = renderReviewWorkbenchHtml(initialReviewWorkbenchState(item));
      assert.match(html, /<input\s+type="date"[^>]*data-testid="edit-proposed-value"/);
    });

    it("renders a number input for a number field", () => {
      const item = withDescriptor(publicDirectoryReviewItemExample, { type: "number" });
      const html = renderReviewWorkbenchHtml(initialReviewWorkbenchState(item));
      assert.match(html, /<input\s+type="number"[^>]*data-testid="edit-proposed-value"/);
    });

    it("renders a true/false select for a boolean field", () => {
      const item = withDescriptor(publicDirectoryReviewItemExample, { type: "boolean" });
      const html = renderReviewWorkbenchHtml(initialReviewWorkbenchState(item));
      assert.match(html, /<select[^>]*data-testid="edit-proposed-value"/);
      assert.match(html, /<option value="true"/);
      assert.match(html, /<option value="false"/);
    });

    it("blocks Use proposed on a value that violates the typed descriptor and surfaces the reason", () => {
      // reviewWorkbenchQueueExamples[0] ("public-directory-hours") is a genuinely
      // undecided "needs-review" item, so it starts in the editable review state.
      const item = withDescriptor(reviewWorkbenchQueueExamples[0]!, { type: "number" });
      const itemName = item.metadata.name;
      const root = new ReviewWorkbenchTestRoot();
      mountReviewWorkbench(root as unknown as HTMLElement, initialReviewQueueSessionState([item]));

      const field = root.field(itemName);
      field.editInput!.value = "not-a-number";
      field.useButton.click();

      // The decision is refused — the field is still in the undecided review state,
      // never accepted — and the inline error is revealed rather than a bad value
      // being persisted.
      assert.match(root.html, new RegExp(`data-item-name="${itemName}"[\\s\\S]*?data-state="review"`));
      assert.doesNotMatch(root.html, /data-state="accepted"/);
      assert.equal(field.valueError.hidden, false);
      assert.match(field.valueError.textContent, /not a number/);
    });

    it("accepts a value that satisfies the typed descriptor", () => {
      const item = withDescriptor(reviewWorkbenchQueueExamples[0]!, { type: "number" });
      const itemName = item.metadata.name;
      const root = new ReviewWorkbenchTestRoot();
      mountReviewWorkbench(root as unknown as HTMLElement, initialReviewQueueSessionState([item]));

      const field = root.field(itemName);
      field.editInput!.value = "42";
      field.useButton.click();

      assert.match(root.html, new RegExp(`data-item-name="${itemName}"[\\s\\S]*?data-state="accepted"`));
      assert.match(root.field(itemName).payloadText, /"editedValue": "42"/);
    });
  });

  describe("validateProposedValue", () => {
    it("returns undefined when there is no descriptor", () => {
      assert.equal(validateProposedValue(undefined, "anything"), undefined);
    });

    it("accepts finite numbers and rejects non-numeric / empty for type number", () => {
      assert.equal(validateProposedValue({ type: "number" }, "42"), undefined);
      assert.equal(validateProposedValue({ type: "number" }, "3.14"), undefined);
      assert.match(validateProposedValue({ type: "number" }, "abc") ?? "", /not a number/);
      assert.match(validateProposedValue({ type: "number" }, "  ") ?? "", /Enter a number/);
    });

    it("accepts only true/false for type boolean", () => {
      assert.equal(validateProposedValue({ type: "boolean" }, "true"), undefined);
      assert.equal(validateProposedValue({ type: "boolean" }, "false"), undefined);
      assert.match(validateProposedValue({ type: "boolean" }, "yes") ?? "", /true or false/);
    });

    it("accepts an ISO calendar date and rejects other shapes for type date", () => {
      assert.equal(validateProposedValue({ type: "date" }, "2026-03-03"), undefined);
      assert.match(validateProposedValue({ type: "date" }, "March 3") ?? "", /valid date/);
      assert.match(validateProposedValue({ type: "date" }, "2026-13-40") ?? "", /valid date/);
    });

    it("enforces the declared enum set, and enforces nothing when the set is empty", () => {
      const descriptor = { type: "enum" as const, enumValues: ["a", "b"] };
      assert.equal(validateProposedValue(descriptor, "a"), undefined);
      assert.match(validateProposedValue(descriptor, "c") ?? "", /Choose one of: a, b/);
      assert.equal(validateProposedValue({ type: "enum", enumValues: [] }, "anything"), undefined);
    });

    it("never constrains a free-form string field", () => {
      assert.equal(validateProposedValue({ type: "string" }, "any text at all"), undefined);
    });
  });

  it("persists mounted review decisions through a ReviewSessionEvent store and replays them on remount", () => {
    const store = createInMemoryReviewSessionEventStore();
    const firstRoot = new ReviewWorkbenchTestRoot();
    const itemName = "public-directory-hours";

    mountReviewWorkbench(firstRoot as unknown as HTMLElement, initialReviewQueueSessionState(), { eventStore: store });
    firstRoot.field(itemName).useButton.click();
    firstRoot.field(itemName).noteTextarea.value = "Accepted persisted hours.";
    firstRoot.field(itemName).noteTextarea.dispatch("input");

    assert.deepEqual(store.events().map((event) => event.spec.eventType), [
      "decision-changed",
      "note-changed",
    ]);

    const secondRoot = new ReviewWorkbenchTestRoot();
    mountReviewWorkbench(secondRoot as unknown as HTMLElement, initialReviewQueueSessionState(), { eventStore: store });

    assert.match(secondRoot.html, new RegExp(`data-item-name="${itemName}"[\\s\\S]*?data-state="accepted"`));
    assert.equal(secondRoot.field(itemName).noteTextarea.value, "Accepted persisted hours.");
  });

  it("replays an undo (Change) signal so a cleared decision does not resurface after reload", () => {
    const store = createInMemoryReviewSessionEventStore();
    const firstRoot = new ReviewWorkbenchTestRoot();
    const itemName = "public-directory-hours";

    mountReviewWorkbench(firstRoot as unknown as HTMLElement, initialReviewQueueSessionState(), { eventStore: store });
    firstRoot.field(itemName).useButton.click();
    firstRoot.field(itemName).undoButton.click();

    const secondRoot = new ReviewWorkbenchTestRoot();
    mountReviewWorkbench(secondRoot as unknown as HTMLElement, initialReviewQueueSessionState(), { eventStore: store });

    assert.match(secondRoot.html, new RegExp(`data-item-name="${itemName}"[\\s\\S]*?data-state="review"`));
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
      const itemName = publicDirectoryReviewItemExample.metadata.name;

      mountReviewWorkbench(root as unknown as HTMLElement, initialReviewQueueSessionState([publicDirectoryReviewItemExample]));
      const field = root.field(itemName);
      if (entry.decision === "reject-proposed") {
        field.wrongbox.checked = true;
        field.keepButton.click();
      } else if (entry.decision === "keep-current") {
        field.keepButton.click();
      } else {
        field.useButton.click();
      }

      assert.match(root.html, new RegExp(escapeRegExp(entry.selectedText)));
      assert.match(root.field(itemName).payloadText, new RegExp(`"candidateId": "${escapeRegExp(entry.candidateId)}"`));
      assert.match(root.field(itemName).payloadText, new RegExp(`"status": "${entry.status}"`));
    });
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Minimal DOM shim for `mountReviewWorkbench`. Unlike the pre-redesign harness,
 * this does not attempt to simulate `closest()`/`querySelector()` scoping in the
 * abstract — it parses the rendered HTML into one `TestFieldScope` per rendered
 * field card (keyed by `data-item-name`) and hands the controller's event
 * delegation exactly the elements it asks for, scoped the same way the real DOM
 * would scope them. Real interactive/visual verification (clicks, focus, CSS
 * state) lives in the Playwright specs under tests/browser/; this harness exists
 * to keep the controller-wiring contract (click -> decision -> re-render ->
 * payload) covered at the node:test layer without a full DOM dependency.
 */
class ReviewWorkbenchTestRoot {
  html = "";
  #fieldsByItemName = new Map<string, TestFieldScope>();
  #applyButton: TestApplyButtonElement | null = null;

  set innerHTML(value: string) {
    this.html = value;
    this.#fieldsByItemName = parseFieldScopes(value);
    this.#applyButton = /data-testid="apply-button"/.test(value) ? new TestApplyButtonElement() : null;
  }

  get innerHTML(): string {
    return this.html;
  }

  field(itemName: string): TestFieldScope {
    const scope = this.#fieldsByItemName.get(itemName);
    assert.ok(scope, `Missing rendered field for ${itemName}`);
    return scope as TestFieldScope;
  }

  querySelector<T>(selector: string): T | null {
    if (selector === "[data-testid='apply-button']") {
      return this.#applyButton as T;
    }
    return null;
  }

  querySelectorAll<T>(selector: string): T[] {
    const scopes = [...this.#fieldsByItemName.values()];
    if (selector === "[data-testid='use-proposed']") return scopes.map((scope) => scope.useButton) as T[];
    if (selector === "[data-testid='keep-current']") return scopes.map((scope) => scope.keepButton) as T[];
    if (selector === "[data-testid='undo-decision']") return scopes.map((scope) => scope.undoButton) as T[];
    if (selector === "[data-testid='reviewer-note']") return scopes.map((scope) => scope.noteTextarea) as T[];
    return [];
  }
}

class TestFieldScope {
  readonly useButton: TestFieldButtonElement;
  readonly keepButton: TestFieldButtonElement;
  readonly undoButton: TestFieldButtonElement;
  readonly noteTextarea: TestTextAreaElement;
  readonly wrongbox = new TestCheckboxElement();
  readonly editInput: TestInputElement | null;
  readonly valueError = new TestValueErrorElement();
  readonly #payload: TestPreElement;

  constructor(itemName: string, editValue: string | undefined, noteValue: string, payloadText: string) {
    this.useButton = new TestFieldButtonElement(itemName, this);
    this.keepButton = new TestFieldButtonElement(itemName, this);
    this.undoButton = new TestFieldButtonElement(itemName, this);
    this.noteTextarea = new TestTextAreaElement(noteValue, this, itemName);
    this.editInput = editValue === undefined ? null : new TestInputElement(editValue);
    this.#payload = new TestPreElement(payloadText);
  }

  get payloadText(): string {
    return this.#payload.textContent;
  }

  querySelector<T>(selector: string): T | null {
    if (selector === "[data-testid='edit-proposed-value']") return this.editInput as T;
    if (selector === "[data-testid='wrong-toggle']") return this.wrongbox as T;
    if (selector === "[data-testid='value-error']") return this.valueError as T;
    if (selector === "[data-testid='decision-payload']") return this.#payload as T;
    return null;
  }
}

class TestFieldButtonElement {
  readonly dataset: { itemName: string };
  #listeners: Array<() => void> = [];

  constructor(itemName: string, private readonly scope: TestFieldScope) {
    this.dataset = { itemName };
  }

  addEventListener(type: string, listener: () => void): void {
    if (type === "click") this.#listeners.push(listener);
  }

  closest<T>(selector: string): T | null {
    return selector === "[data-testid='review-field']" ? (this.scope as unknown as T) : null;
  }

  click(): void {
    for (const listener of this.#listeners) listener();
  }
}

class TestApplyButtonElement {
  #listeners: Array<() => void> = [];

  addEventListener(type: string, listener: () => void): void {
    if (type === "click") this.#listeners.push(listener);
  }

  click(): void {
    for (const listener of this.#listeners) listener();
  }
}

class TestTextAreaElement {
  readonly dataset: { itemName: string };
  #listeners: Array<(event: { target: TestTextAreaElement }) => void> = [];

  constructor(public value: string, private readonly scope?: TestFieldScope, itemName = "") {
    this.dataset = { itemName };
  }

  addEventListener(type: string, listener: (event: { target: TestTextAreaElement }) => void): void {
    if (type === "input") this.#listeners.push(listener);
  }

  closest<T>(selector: string): T | null {
    return this.scope && selector === "[data-testid='review-field']" ? (this.scope as unknown as T) : null;
  }

  dispatch(type: string): void {
    if (type !== "input") return;
    for (const listener of this.#listeners) listener({ target: this });
  }
}

class TestInputElement {
  constructor(public value: string) {}
  focus(): void {}
}

class TestValueErrorElement {
  hidden = true;
  textContent = "";
}

class TestCheckboxElement {
  checked = false;
}

class TestPreElement {
  constructor(public textContent: string) {}
}

function parseFieldScopes(html: string): Map<string, TestFieldScope> {
  const fieldStartPattern = /<section\s+class="field"\s+data-testid="review-field"\s+data-item-name="([^"]+)"/g;
  const starts: Array<{ index: number; itemName: string }> = [];
  for (const match of html.matchAll(fieldStartPattern)) {
    starts.push({ index: match.index ?? 0, itemName: unescapeHtml(match[1] ?? "") });
  }

  const scopes = new Map<string, TestFieldScope>();
  starts.forEach(({ index, itemName }, position) => {
    const end = position + 1 < starts.length ? starts[position + 1]!.index : html.length;
    const fragment = html.slice(index, end);
    const editValue = fragment.match(/data-testid="edit-proposed-value"[^>]*value="([^"]*)"/)?.[1];
    const noteValue = fragment.match(/<textarea[^>]*data-testid="reviewer-note"[^>]*>([\s\S]*?)<\/textarea>/)?.[1] ?? "";
    const payloadText = fragment.match(/<pre[^>]*data-testid="decision-payload"[^>]*>([\s\S]*?)<\/pre>/)?.[1] ?? "";
    scopes.set(itemName, new TestFieldScope(
      itemName,
      editValue === undefined ? undefined : unescapeHtml(editValue),
      unescapeHtml(noteValue),
      unescapeHtml(payloadText),
    ));
  });

  return scopes;
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

// ── authorizing provenance tests ─────────────────────────────────────────────

import {
  buildAuthorizedActionAuthorizing,
  isValidAuthorizing,
  validateAuthorizing,
} from "../src/review-authorizing.js";

describe("buildReviewDecision: authorizing provenance", () => {
  it("populates a valid authorized-action authorizing block on the workbench path", () => {
    const state = {
      ...initialReviewWorkbenchState(),
      decision: "accept-proposed" as ReviewWorkbenchDecision,
      note: "",
    };

    const decision = buildReviewDecision(state);

    assert.ok(decision, "decision should be defined");
    assert.ok(decision.spec.authorizing, "authorizing should be present");
    assert.equal(decision.spec.authorizing?.kind, "authorized-action");

    const issues = validateAuthorizing(decision.spec.authorizing);
    assert.deepEqual(issues, [], `Expected no validation issues but got: ${JSON.stringify(issues)}`);
  });

  it("sets promptRef to the stable decision-card version identifier", () => {
    const state = {
      ...initialReviewWorkbenchState(),
      decision: "keep-current" as ReviewWorkbenchDecision,
    };

    const decision = buildReviewDecision(state);

    assert.ok(decision?.spec.authorizing);
    assert.equal(
      (decision.spec.authorizing as { promptRef?: string }).promptRef,
      "review-workbench/decision-card@v1",
    );
  });

  it("sets action to affirmed-control when no reviewer note is present", () => {
    const state = {
      ...initialReviewWorkbenchState(),
      decision: "accept-proposed" as ReviewWorkbenchDecision,
      note: "",
    };

    const decision = buildReviewDecision(state);

    assert.ok(decision?.spec.authorizing);
    assert.equal((decision.spec.authorizing as { action?: string }).action, "affirmed-control");
  });

  it("sets action to typed when the reviewer supplies a note", () => {
    const state = {
      ...initialReviewWorkbenchState(),
      decision: "accept-proposed" as ReviewWorkbenchDecision,
      note: "Verified against source extract.",
    };

    const decision = buildReviewDecision(state);

    assert.ok(decision?.spec.authorizing);
    assert.equal((decision.spec.authorizing as { action?: string }).action, "typed");
  });

  it("sets authorityRef to actor:<actorId>", () => {
    const state = {
      ...initialReviewWorkbenchState(),
      decision: "keep-current" as ReviewWorkbenchDecision,
      actorId: "operator-jane",
    };

    const decision = buildReviewDecision(state);

    assert.ok(decision?.spec.authorizing);
    assert.equal(
      (decision.spec.authorizing as { authorityRef?: string }).authorityRef,
      "actor:operator-jane",
    );
  });

  it("includes the target label and decision label in renderedPrompt", () => {
    const state = {
      ...initialReviewWorkbenchState(),
      decision: "accept-proposed" as ReviewWorkbenchDecision,
    };

    const decision = buildReviewDecision(state);

    assert.ok(decision?.spec.authorizing);
    const renderedPrompt = (decision.spec.authorizing as { renderedPrompt?: string }).renderedPrompt ?? "";
    // The public directory item target is "availabilityStatus" → "Availability Status"
    assert.match(renderedPrompt, /Availability Status|availabilityStatus/i);
    // Decision label from workbench definitions
    assert.match(renderedPrompt, /Accept proposed/i);
    // Both candidate values are included
    assert.match(renderedPrompt, /AVAILABLE/);
    assert.match(renderedPrompt, /WAITLIST/);
  });

  it("produces a valid authorizing block for all three workbench decision types", () => {
    const decisions: ReviewWorkbenchDecision[] = ["accept-proposed", "keep-current", "reject-proposed"];

    for (const decision of decisions) {
      const state = {
        ...initialReviewWorkbenchState(),
        decision,
      };

      const reviewDecision = buildReviewDecision(state);
      assert.ok(reviewDecision?.spec.authorizing, `${decision} should have authorizing`);
      const issues = validateAuthorizing(reviewDecision.spec.authorizing);
      assert.deepEqual(issues, [], `${decision} authorizing block has validation issues: ${JSON.stringify(issues)}`);
    }
  });

  it("returns undefined authorizing when no decision is made", () => {
    const state = initialReviewWorkbenchState();
    const decision = buildReviewDecision(state);
    assert.equal(decision, undefined);
  });
});

describe("buildReviewDecision: authorizing degrades gracefully", () => {
  it("session export decisions carry valid authorizing blocks", () => {
    const session = {
      ...initialReviewQueueSessionState([publicDirectoryReviewItemExample]),
      decisionsByItemName: {
        [publicDirectoryReviewItemExample.metadata.name]: "accept-proposed" as const,
      },
      actorId: "test-operator",
    };

    const exportResult = buildReviewWorkbenchResultsFromSession(session);
    const result = exportResult[0];
    assert.ok(result, "should have a result");

    const authorizing = result.reviewDecision.spec.authorizing;
    assert.ok(authorizing, "reviewDecision should carry authorizing");
    assert.equal(isValidAuthorizing(authorizing), true);
  });
});

describe("buildAuthorizedActionAuthorizing helper", () => {
  it("builds a valid authorized-action block from correct inputs", () => {
    const block = buildAuthorizedActionAuthorizing({
      promptRef: "review-workbench/decision-card@v1",
      renderedPrompt: "For availabilityStatus, decide whether WAITLIST should replace AVAILABLE. Selected decision: Accept proposed.",
      action: "affirmed-control",
      authorityRef: "actor:operator-jane",
    });

    assert.equal(block.kind, "authorized-action");
    assert.equal(block.promptRef, "review-workbench/decision-card@v1");
    assert.equal(block.action, "affirmed-control");
    assert.equal(block.authorityRef, "actor:operator-jane");
    assert.deepEqual(validateAuthorizing(block), []);
  });

  it("builds a typed action block", () => {
    const block = buildAuthorizedActionAuthorizing({
      promptRef: "review-workbench/decision-card@v1",
      renderedPrompt: "For threshold, decide whether 16000 should replace 15000. Selected decision: Accept proposed.",
      action: "typed",
      authorityRef: "actor:senior-reviewer",
    });

    assert.equal(block.action, "typed");
    assert.deepEqual(validateAuthorizing(block), []);
  });

  it("throws when promptRef is empty", () => {
    assert.throws(
      () => buildAuthorizedActionAuthorizing({
        promptRef: "",
        renderedPrompt: "Some prompt text.",
        action: "affirmed-control",
        authorityRef: "actor:test",
      }),
      /missing-prompt-ref|invalid/i,
    );
  });

  it("throws when renderedPrompt is missing", () => {
    assert.throws(
      () => buildAuthorizedActionAuthorizing({
        promptRef: "review-workbench/decision-card@v1",
        renderedPrompt: "   ",
        action: "affirmed-control",
        authorityRef: "actor:test",
      }),
      /missing-rendered-prompt|invalid/i,
    );
  });

  it("throws when action is invalid", () => {
    assert.throws(
      () => buildAuthorizedActionAuthorizing({
        promptRef: "review-workbench/decision-card@v1",
        renderedPrompt: "Some prompt.",
        action: "clicked" as "affirmed-control",
        authorityRef: "actor:test",
      }),
    );
  });

  it("throws when authorityRef is empty", () => {
    assert.throws(
      () => buildAuthorizedActionAuthorizing({
        promptRef: "review-workbench/decision-card@v1",
        renderedPrompt: "Some prompt.",
        action: "affirmed-control",
        authorityRef: "",
      }),
      /missing-authority-ref|invalid/i,
    );
  });
});
