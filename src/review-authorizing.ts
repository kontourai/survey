import type {
  ReviewAuthorizing,
  ReviewAuthorizingAuthorizedAction,
  ReviewAuthorizingExchange,
  ReviewAuthorizingExplicitStatement,
} from "./types.js";

export type ReviewAuthorizingIssueCode =
  | "not-an-object"
  | "missing-kind"
  | "unknown-kind"
  | "missing-statement"
  | "missing-prompt"
  | "missing-response"
  | "missing-prompt-ref"
  | "missing-rendered-prompt"
  | "missing-action"
  | "invalid-action"
  | "missing-authority-ref";

export interface ReviewAuthorizingIssue {
  readonly code: ReviewAuthorizingIssueCode;
  readonly message: string;
}

const VALID_ACTIONS = new Set(["affirmed-control", "typed"]);

/**
 * Validates an `authorizing` block on a ReviewOutcome for admissibility.
 *
 * Per-kind required fields:
 *   explicit-statement — `statement` (string, non-empty)
 *   exchange           — `prompt` and `response` (both strings, non-empty;
 *                        both halves required for self-contained testimony)
 *   authorized-action  — `promptRef`, `renderedPrompt`, `action`, and
 *                        `authorityRef` (all required; action must be
 *                        "affirmed-control" or "typed")
 *
 * Returns an empty array when the block is valid.
 */
export function validateAuthorizing(block: unknown): ReviewAuthorizingIssue[] {
  if (block === null || typeof block !== "object" || Array.isArray(block)) {
    return [{ code: "not-an-object", message: "authorizing block must be a plain object." }];
  }

  const record = block as Record<string, unknown>;

  if (!("kind" in record) || record.kind === undefined) {
    return [{ code: "missing-kind", message: "authorizing block is missing the required 'kind' field." }];
  }

  const kind = record.kind;

  if (kind === "explicit-statement") {
    return validateExplicitStatement(record as Partial<ReviewAuthorizingExplicitStatement>);
  }

  if (kind === "exchange") {
    return validateExchange(record as Partial<ReviewAuthorizingExchange>);
  }

  if (kind === "authorized-action") {
    return validateAuthorizedAction(record as Partial<ReviewAuthorizingAuthorizedAction>);
  }

  return [{
    code: "unknown-kind",
    message: `authorizing kind '${String(kind)}' is not admissible. Use 'explicit-statement', 'exchange', or 'authorized-action'.`,
  }];
}

function validateExplicitStatement(
  block: Partial<ReviewAuthorizingExplicitStatement>,
): ReviewAuthorizingIssue[] {
  const issues: ReviewAuthorizingIssue[] = [];
  if (!block.statement || typeof block.statement !== "string" || block.statement.trim() === "") {
    issues.push({
      code: "missing-statement",
      message: "explicit-statement authorizing block requires a non-empty 'statement' string.",
    });
  }
  return issues;
}

function validateExchange(block: Partial<ReviewAuthorizingExchange>): ReviewAuthorizingIssue[] {
  const issues: ReviewAuthorizingIssue[] = [];
  if (!block.prompt || typeof block.prompt !== "string" || block.prompt.trim() === "") {
    issues.push({
      code: "missing-prompt",
      message: "exchange authorizing block requires a non-empty 'prompt' string (both halves required for self-contained testimony).",
    });
  }
  if (!block.response || typeof block.response !== "string" || block.response.trim() === "") {
    issues.push({
      code: "missing-response",
      message: "exchange authorizing block requires a non-empty 'response' string (both halves required for self-contained testimony).",
    });
  }
  return issues;
}

function validateAuthorizedAction(
  block: Partial<ReviewAuthorizingAuthorizedAction>,
): ReviewAuthorizingIssue[] {
  const issues: ReviewAuthorizingIssue[] = [];
  if (!block.promptRef || typeof block.promptRef !== "string" || block.promptRef.trim() === "") {
    issues.push({
      code: "missing-prompt-ref",
      message: "authorized-action authorizing block requires a non-empty 'promptRef' string.",
    });
  }
  if (!block.renderedPrompt || typeof block.renderedPrompt !== "string" || block.renderedPrompt.trim() === "") {
    issues.push({
      code: "missing-rendered-prompt",
      message: "authorized-action authorizing block requires a non-empty 'renderedPrompt' string.",
    });
  }
  if (block.action === undefined) {
    issues.push({
      code: "missing-action",
      message: "authorized-action authorizing block requires an 'action' field.",
    });
  } else if (!VALID_ACTIONS.has(block.action as string)) {
    issues.push({
      code: "invalid-action",
      message: `authorized-action 'action' must be 'affirmed-control' or 'typed'; received '${String(block.action)}'.`,
    });
  }
  if (!block.authorityRef || typeof block.authorityRef !== "string" || block.authorityRef.trim() === "") {
    issues.push({
      code: "missing-authority-ref",
      message: "authorized-action authorizing block requires a non-empty 'authorityRef' string linking an AuthorityTrace.",
    });
  }
  return issues;
}

/**
 * Type guard: returns true if a ReviewAuthorizing block passes all validation checks.
 */
export function isValidAuthorizing(block: unknown): block is ReviewAuthorizing {
  return validateAuthorizing(block).length === 0;
}

export interface BuildAuthorizedActionAuthorizingInput {
  readonly promptRef: string;
  readonly renderedPrompt: string;
  readonly action: ReviewAuthorizingAuthorizedAction["action"];
  readonly authorityRef: string;
}

/**
 * Helper for consumers building `authorized-action` authorizing blocks outside
 * the workbench. Constructs the block and validates it; throws if the result
 * would be invalid so callers catch configuration errors at build time.
 *
 * For workbench-internal construction, use the workbench path directly — it
 * runs validateAuthorizing and degrades gracefully instead of throwing.
 */
export function buildAuthorizedActionAuthorizing(
  input: BuildAuthorizedActionAuthorizingInput,
): ReviewAuthorizingAuthorizedAction {
  const block: ReviewAuthorizingAuthorizedAction = {
    kind: "authorized-action",
    promptRef: input.promptRef,
    renderedPrompt: input.renderedPrompt,
    action: input.action,
    authorityRef: input.authorityRef,
  };

  const issues = validateAuthorizedAction(block);
  if (issues.length > 0) {
    throw new Error(
      `buildAuthorizedActionAuthorizing: invalid authorized-action block: ${issues.map((issue) => issue.message).join(" ")}`,
    );
  }

  return block;
}
