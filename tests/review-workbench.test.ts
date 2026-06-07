import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { publicDirectoryReviewItemFixture } from "../fixtures/public-directory-review-resource.js";
import { reviewResourceApiVersion } from "../src/index.js";
import {
  buildReviewDecision,
  buildSurfaceProjectionPreview,
  initialReviewWorkbenchState,
  mountReviewWorkbench,
  renderReviewWorkbenchHtml,
  type ReviewWorkbenchDecision,
} from "../examples/review-workbench/review-workbench.js";

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

  it("marks selected and unselected outcomes after a decision", () => {
    const acceptedHtml = renderReviewWorkbenchHtml({
      ...initialReviewWorkbenchState(),
      decision: "accept-proposed",
    });
    const keptHtml = renderReviewWorkbenchHtml({
      ...initialReviewWorkbenchState(),
      decision: "keep-current",
    });

    assert.match(acceptedHtml, /data-testid="candidate-proposed" data-outcome="selected"/);
    assert.match(acceptedHtml, /data-testid="candidate-current" data-outcome="unselected"/);
    assert.match(keptHtml, /data-testid="candidate-current" data-outcome="selected"/);
    assert.match(keptHtml, /data-testid="candidate-proposed" data-outcome="unselected"/);
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

  for (const entry of cases) {
    it(`handles mounted ${entry.decision} button clicks`, () => {
      const root = new ReviewWorkbenchTestRoot();

      mountReviewWorkbench(root as unknown as HTMLElement);
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

  set innerHTML(value: string) {
    this.html = value;
    this.textarea = new TestTextAreaElement(textareaValue(value));
    this.payload = new TestPayloadElement(payloadValue(value));
    this.surfacePreview = new TestSurfacePreviewElement(this, surfacePreviewValue(value));
    this.buttons = decisionValues(value).map((decision) => new TestButtonElement(decision));
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

    return null;
  }

  querySelectorAll<T>(selector: string): T[] {
    return selector === "[data-decision]" ? this.buttons as T[] : [];
  }

  clickDecision(decision: ReviewWorkbenchDecision): void {
    const button = this.buttons.find((entry) => entry.dataset.decision === decision);
    assert.ok(button, `Missing test button for ${decision}`);
    button.click();
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
