import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { publicDirectoryReviewItemFixture } from "../fixtures/public-directory-review-resource.js";
import { reviewResourceApiVersion } from "../src/index.js";
import {
  buildReviewDecision,
  buildSurfaceProjectionPreview,
  currentReviewWorkbenchState,
  deriveQueueRowStatus,
  initialReviewWorkbenchState,
  initialReviewQueueSessionState,
  mountReviewWorkbench,
  nextUnresolvedItemName,
  renderReviewWorkbenchHtml,
  reviewSessionSummary,
  type ReviewWorkbenchDecision,
} from "../examples/review-workbench/review-workbench.js";
import {
  regulatedRuleConflictReviewItemFixture,
  reviewWorkbenchQueueFixtures,
} from "../examples/review-workbench/review-workbench-data.js";

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
      assert.equal(decision.spec.reviewItemName, publicDirectoryReviewItemFixture.metadata.name);
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

  it("AC37-1 derives queue row statuses from ReviewItem status and local decisions", () => {
    const session = {
      ...initialReviewQueueSessionState(),
      activeItemName: "public-directory-hours",
      decisionsByItemName: {
        "public-directory-address": "reject-proposed" as const,
      },
    };

    assert.equal(deriveQueueRowStatus(reviewWorkbenchQueueFixtures[0], session), "in-review");
    assert.equal(deriveQueueRowStatus(reviewWorkbenchQueueFixtures[1], session), "pending");
    assert.equal(deriveQueueRowStatus(reviewWorkbenchQueueFixtures[2], session), "resolved");
    assert.equal(deriveQueueRowStatus(reviewWorkbenchQueueFixtures[3], session), "rejected");
    assert.equal(deriveQueueRowStatus(reviewWorkbenchQueueFixtures[4], session), "escalated");
    assert.equal(deriveQueueRowStatus(reviewWorkbenchQueueFixtures[5], session), "pending");

    const html = renderReviewWorkbenchHtml(session);
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
    assert.match(html, /Selected canonical claim/);
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
      ...initialReviewWorkbenchState(regulatedRuleConflictReviewItemFixture),
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

  for (const entry of cases) {
    it(`handles mounted ${entry.decision} button clicks`, () => {
      const root = new ReviewWorkbenchTestRoot();

      mountReviewWorkbench(root as unknown as HTMLElement, initialReviewQueueSessionState([publicDirectoryReviewItemFixture]));
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
  private nextButton = new TestNextButtonElement();

  set innerHTML(value: string) {
    this.html = value;
    this.textarea = new TestTextAreaElement(textareaValue(value));
    this.payload = new TestPayloadElement(payloadValue(value));
    this.surfacePreview = new TestSurfacePreviewElement(this, surfacePreviewValue(value));
    this.buttons = decisionValues(value).map((decision) => new TestButtonElement(decision));
    this.queueRows = queueItemNames(value).map((itemName) => new TestQueueRowElement(itemName));
    this.nextButton = new TestNextButtonElement();
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
      return this.nextButton as T;
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
    this.nextButton.click();
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

function textareaValue(html: string): string {
  return unescapeHtml(html.match(/<textarea[^>]*data-testid="reviewer-note"[^>]*>([\s\S]*?)<\/textarea>/)?.[1] ?? "");
}

function payloadValue(html: string): string {
  return unescapeHtml(html.match(/<pre[^>]*data-testid="decision-payload"[^>]*>([\s\S]*?)<\/pre>/)?.[1] ?? "");
}

function surfacePreviewValue(html: string): string {
  return html.match(/(<section class="surface-preview"[^>]*data-testid="surface-preview"[\s\S]*?)\s*<section class="payload-panel">/)?.[1]
    ?? html.match(/<section class="surface-preview"[^>]*data-testid="surface-preview"[\s\S]*?<\/section>/)?.[0]
    ?? "";
}

function replaceSurfacePreview(html: string, replacement: string): string {
  return html.replace(
    /<section class="surface-preview"[^>]*data-testid="surface-preview"[\s\S]*?(?=\s*<section class="payload-panel">)/,
    `${replacement}\n      `,
  );
}

function unescapeHtml(value: string): string {
  return value
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}
