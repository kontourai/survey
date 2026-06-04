import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { publicDirectoryReviewItemFixture } from "../fixtures/public-directory-review-resource.js";
import { reviewResourceApiVersion } from "../src/index.js";
import {
  buildReviewDecision,
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

  it("updates the mounted payload when the reviewer enters a note", () => {
    const root = new ReviewWorkbenchTestRoot();

    mountReviewWorkbench(root as unknown as HTMLElement);
    root.clickDecision("accept-proposed");
    root.textarea.value = "Checked the source excerpt.";
    root.textarea.dispatch("input");

    assert.match(root.payload.textContent, /Checked the source excerpt\./);
    assert.match(root.payload.textContent, /"kind": "ReviewDecision"/);
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
  private buttons: TestButtonElement[] = [];

  set innerHTML(value: string) {
    this.html = value;
    this.textarea = new TestTextAreaElement(textareaValue(value));
    this.payload = new TestPayloadElement(payloadValue(value));
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

function decisionValues(html: string): ReviewWorkbenchDecision[] {
  return [...html.matchAll(/data-decision="([^"]+)"/g)].map((match) => match[1] as ReviewWorkbenchDecision);
}

function textareaValue(html: string): string {
  return unescapeHtml(html.match(/<textarea[^>]*data-testid="reviewer-note"[^>]*>([\s\S]*?)<\/textarea>/)?.[1] ?? "");
}

function payloadValue(html: string): string {
  return unescapeHtml(html.match(/<pre[^>]*data-testid="decision-payload"[^>]*>([\s\S]*?)<\/pre>/)?.[1] ?? "");
}

function unescapeHtml(value: string): string {
  return value
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}
