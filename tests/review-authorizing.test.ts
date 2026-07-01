import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildAuthorizedActionAuthorizing,
  buildPromptRef,
  isValidAuthorizing,
  validateAuthorizing,
} from "../src/review-authorizing.js";
import type {
  ReviewAuthorizing,
  ReviewAuthorizingAuthorizedAction,
  ReviewAuthorizingExchange,
  ReviewAuthorizingExplicitStatement,
  ReviewOutcome,
} from "../src/index.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function valid(block: ReviewAuthorizing): void {
  const issues = validateAuthorizing(block);
  assert.deepEqual(issues, [], `Expected no issues but got: ${JSON.stringify(issues)}`);
  assert.equal(isValidAuthorizing(block), true);
}

function invalid(block: unknown, expectedCodes: string[]): void {
  const issues = validateAuthorizing(block);
  const codes = issues.map((i) => i.code);
  assert.deepEqual(
    codes,
    expectedCodes,
    `Expected codes ${JSON.stringify(expectedCodes)} but got ${JSON.stringify(codes)}`,
  );
  assert.equal(isValidAuthorizing(block), false);
}

// ── explicit-statement ────────────────────────────────────────────────────────

describe("validateAuthorizing: explicit-statement kind", () => {
  it("accepts a valid explicit-statement block", () => {
    const block: ReviewAuthorizingExplicitStatement = {
      kind: "explicit-statement",
      statement: "I confirm this value is correct based on my review of the source document.",
    };
    valid(block);
  });

  it("accepts explicit-statement with optional source field", () => {
    const block: ReviewAuthorizingExplicitStatement = {
      kind: "explicit-statement",
      statement: "Confirmed after checking the registry.",
      source: "cli-interactive",
    };
    valid(block);
  });

  it("rejects explicit-statement with missing statement", () => {
    invalid({ kind: "explicit-statement" }, ["missing-statement"]);
  });

  it("rejects explicit-statement with empty statement string", () => {
    invalid({ kind: "explicit-statement", statement: "   " }, ["missing-statement"]);
  });

  it("rejects explicit-statement with non-string statement", () => {
    invalid({ kind: "explicit-statement", statement: 42 }, ["missing-statement"]);
  });

  it("type-checks: ReviewOutcome.authorizing accepts explicit-statement", () => {
    const outcome: ReviewOutcome = {
      id: "outcome-1",
      candidateSetId: "cs-1",
      status: "verified",
      authorizing: {
        kind: "explicit-statement",
        statement: "Reviewer affirmed the value.",
      },
    };
    assert.equal(outcome.authorizing?.kind, "explicit-statement");
  });
});

// ── exchange ──────────────────────────────────────────────────────────────────

describe("validateAuthorizing: exchange kind", () => {
  it("accepts a valid exchange block", () => {
    const block: ReviewAuthorizingExchange = {
      kind: "exchange",
      prompt: "Do you confirm that the submitted coverage value of 92% is accurate?",
      response: "Yes, I have verified this against the test report.",
    };
    valid(block);
  });

  it("accepts exchange with optional source field", () => {
    const block: ReviewAuthorizingExchange = {
      kind: "exchange",
      prompt: "Is this value within acceptable bounds?",
      response: "Yes.",
      source: "delegated",
    };
    valid(block);
  });

  it("rejects exchange with missing prompt", () => {
    invalid({ kind: "exchange", response: "Yes." }, ["missing-prompt"]);
  });

  it("rejects exchange with missing response", () => {
    invalid({ kind: "exchange", prompt: "Is this correct?" }, ["missing-response"]);
  });

  it("rejects exchange with both halves missing", () => {
    invalid({ kind: "exchange" }, ["missing-prompt", "missing-response"]);
  });

  it("rejects exchange with empty prompt string", () => {
    invalid({ kind: "exchange", prompt: "", response: "Yes." }, ["missing-prompt"]);
  });

  it("rejects exchange with empty response string", () => {
    invalid({ kind: "exchange", prompt: "Is this correct?", response: "  " }, ["missing-response"]);
  });

  it("type-checks: ReviewOutcome.authorizing accepts exchange", () => {
    const outcome: ReviewOutcome = {
      id: "outcome-2",
      candidateSetId: "cs-2",
      status: "verified",
      authorizing: {
        kind: "exchange",
        prompt: "Confirm the policy version.",
        response: "Confirmed — policy v2.1 applies.",
      },
    };
    assert.equal(outcome.authorizing?.kind, "exchange");
  });
});

// ── authorized-action ─────────────────────────────────────────────────────────

describe("validateAuthorizing: authorized-action kind", () => {
  it("accepts a valid authorized-action block with affirmed-control", () => {
    const block: ReviewAuthorizingAuthorizedAction = {
      kind: "authorized-action",
      promptRef: "survey-auth-prompt-v3",
      renderedPrompt: "By clicking 'Accept Proposed', you affirm that you have reviewed the source and accept this value.",
      action: "affirmed-control",
      authorityRef: "authority-trace-reviewer-jane-2026-06-11",
    };
    valid(block);
  });

  it("accepts a valid authorized-action block with typed action", () => {
    const block: ReviewAuthorizingAuthorizedAction = {
      kind: "authorized-action",
      promptRef: "survey-auth-prompt-v3",
      renderedPrompt: "Type the value to confirm your review decision.",
      action: "typed",
      authorityRef: "authority-trace-reviewer-bob-2026-06-11",
    };
    valid(block);
  });

  it("rejects authorized-action with missing promptRef", () => {
    invalid({
      kind: "authorized-action",
      renderedPrompt: "Confirm this value.",
      action: "affirmed-control",
      authorityRef: "trace-1",
    }, ["missing-prompt-ref"]);
  });

  it("rejects authorized-action with missing renderedPrompt", () => {
    invalid({
      kind: "authorized-action",
      promptRef: "prompt-v1",
      action: "affirmed-control",
      authorityRef: "trace-1",
    }, ["missing-rendered-prompt"]);
  });

  it("rejects authorized-action with missing action", () => {
    invalid({
      kind: "authorized-action",
      promptRef: "prompt-v1",
      renderedPrompt: "Confirm this value.",
      authorityRef: "trace-1",
    }, ["missing-action"]);
  });

  it("rejects authorized-action with invalid action value", () => {
    invalid({
      kind: "authorized-action",
      promptRef: "prompt-v1",
      renderedPrompt: "Confirm this value.",
      action: "clicked",
      authorityRef: "trace-1",
    }, ["invalid-action"]);
  });

  it("rejects authorized-action with missing authorityRef", () => {
    invalid({
      kind: "authorized-action",
      promptRef: "prompt-v1",
      renderedPrompt: "Confirm this value.",
      action: "affirmed-control",
    }, ["missing-authority-ref"]);
  });

  it("rejects authorized-action with all required fields missing", () => {
    const issues = validateAuthorizing({ kind: "authorized-action" });
    const codes = issues.map((i) => i.code);
    assert.ok(codes.includes("missing-prompt-ref"), "missing-prompt-ref expected");
    assert.ok(codes.includes("missing-rendered-prompt"), "missing-rendered-prompt expected");
    assert.ok(codes.includes("missing-action"), "missing-action expected");
    assert.ok(codes.includes("missing-authority-ref"), "missing-authority-ref expected");
    assert.equal(codes.length, 4);
  });

  it("type-checks: ReviewOutcome.authorizing accepts authorized-action", () => {
    const outcome: ReviewOutcome = {
      id: "outcome-3",
      candidateSetId: "cs-3",
      status: "verified",
      authorizing: {
        kind: "authorized-action",
        promptRef: "workbench-auth-v1",
        renderedPrompt: "Accept this proposed value as the verified record.",
        action: "affirmed-control",
        authorityRef: "authority-trace-jane-sr-reviewer",
      },
    };
    assert.equal(outcome.authorizing?.kind, "authorized-action");
  });
});

// ── non-kind-specific validation errors ───────────────────────────────────────

describe("validateAuthorizing: structural errors", () => {
  it("rejects null", () => {
    invalid(null, ["not-an-object"]);
  });

  it("rejects an array", () => {
    invalid([], ["not-an-object"]);
  });

  it("rejects a string", () => {
    invalid("explicit-statement", ["not-an-object"]);
  });

  it("rejects a number", () => {
    invalid(42, ["not-an-object"]);
  });

  it("rejects an object with no kind field", () => {
    invalid({ statement: "something" }, ["missing-kind"]);
  });

  it("rejects an unknown kind string", () => {
    invalid({ kind: "verbal-confirmation" }, ["unknown-kind"]);
  });

  it("includes the bad kind value in the error message for unknown kinds", () => {
    const issues = validateAuthorizing({ kind: "verbal-confirmation" });
    assert.ok(
      issues[0]?.message.includes("verbal-confirmation"),
      "Error message should include the bad kind value",
    );
  });
});

// ── isValidAuthorizing type guard ─────────────────────────────────────────────

describe("isValidAuthorizing type guard", () => {
  it("returns true for valid blocks of all three kinds", () => {
    assert.equal(isValidAuthorizing({
      kind: "explicit-statement",
      statement: "Verified.",
    }), true);

    assert.equal(isValidAuthorizing({
      kind: "exchange",
      prompt: "Is this correct?",
      response: "Yes.",
    }), true);

    assert.equal(isValidAuthorizing({
      kind: "authorized-action",
      promptRef: "prompt-v1",
      renderedPrompt: "Accept proposed.",
      action: "affirmed-control",
      authorityRef: "trace-1",
    }), true);
  });

  it("returns false for invalid blocks", () => {
    assert.equal(isValidAuthorizing(null), false);
    assert.equal(isValidAuthorizing({ kind: "exchange" }), false);
    assert.equal(isValidAuthorizing({ kind: "authorized-action", promptRef: "v1" }), false);
  });
});


describe("buildPromptRef", () => {
  it("builds a bare prompt ref matching the workbench convention", () => {
    assert.equal(
      buildPromptRef({ module: "review-workbench", component: "decision-card" }),
      "review-workbench/decision-card@v1",
    );
  });

  it("builds a scheme-prefixed prompt ref for namespaced producers", () => {
    assert.equal(
      buildPromptRef({ scheme: "survey", module: "rules-admin", component: "keep-current" }),
      "survey://rules-admin/keep-current@v1",
    );
  });

  it("honours an explicit version", () => {
    assert.equal(
      buildPromptRef({ module: "review-workbench", component: "decision-card", version: "v2" }),
      "review-workbench/decision-card@v2",
    );
  });

  it("produces a promptRef accepted by buildAuthorizedActionAuthorizing", () => {
    const promptRef = buildPromptRef({ scheme: "survey", module: "rules-admin", component: "keep-current" });
    const block = buildAuthorizedActionAuthorizing({
      promptRef,
      renderedPrompt: "Keep the current value.",
      action: "affirmed-control",
      authorityRef: "authority-trace-1",
    });
    assert.equal(block.promptRef, promptRef);
    assert.equal(isValidAuthorizing(block), true);
  });

  it("throws on empty module or component", () => {
    assert.throws(() => buildPromptRef({ module: "", component: "decision-card" }), /module/);
    assert.throws(() => buildPromptRef({ module: "review-workbench", component: "  " }), /component/);
  });
});
