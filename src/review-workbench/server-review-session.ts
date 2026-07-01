import { createHash } from "node:crypto";
import {
  deriveReviewSessionApplyResultForSnapshot,
  mapReviewWorkbenchResultsToApplyActions,
  ReviewApplyActionMappingError,
  type DeriveReviewSessionApplyResultForSnapshotResult,
  type MapReviewWorkbenchResultsToApplyActionsOptions,
  type ReviewApplyActionIssue,
  type ReviewApplyActionMapping,
  type ReviewSessionApplyIssue,
  type ReviewSessionApplyResolutionRequirement,
  type ReviewWorkbenchResult,
} from "./review-workbench.js";
import {
  validateReviewDecisionMode,
  type ReviewDecisionModeIssue,
} from "./producer-decision-mode.js";
import {
  validateReviewSessionEventsForSnapshot,
  type ReviewSessionReplayIssue,
} from "./review-session-replay.js";
import type { ReviewDecision, ReviewSessionEvent } from "../review-resource.js";
import type { ReviewQueueSessionState } from "./review-queue-session.js";
import { canonicalJson } from "./canonical.js";

export interface ServerReviewSessionRecord {
  readonly sessionName: string;
  readonly snapshot: ReviewQueueSessionState;
  readonly snapshotHash: string;
  readonly eventCount?: number;
  readonly updatedAt: string;
}

export type ServerReviewSessionFreshnessStatus = "current" | "stale";

export interface ServerReviewSessionFreshnessComparison {
  readonly status: ServerReviewSessionFreshnessStatus;
  readonly expectedSnapshotHash: string;
  readonly actualSnapshotHash: string;
  readonly expectedEventCount?: number;
  readonly actualEventCount?: number;
}

export type ServerReviewSessionStaleIssueCode =
  | "snapshot-hash-mismatch"
  | "event-count-mismatch";

export interface ServerReviewSessionStaleIssue {
  readonly code: ServerReviewSessionStaleIssueCode;
  readonly message: string;
  readonly expected: string | number;
  readonly actual: string | number;
}

export class StaleServerReviewSessionError extends Error {
  readonly name = "StaleServerReviewSessionError";
  readonly issues: readonly ServerReviewSessionStaleIssue[];
  readonly comparison: ServerReviewSessionFreshnessComparison;

  constructor(comparison: ServerReviewSessionFreshnessComparison) {
    const issues = staleIssuesForComparison(comparison);
    super(`Review session is stale: ${issues.map((issue) => issue.message).join(" ")}`);
    this.issues = issues;
    this.comparison = comparison;
  }
}

export type ServerReviewSessionEventValidationIssue =
  | ReviewSessionReplayIssue
  | {
      readonly code: "session-name-mismatch";
      readonly eventName: string;
      readonly sequence: number;
      readonly expectedSessionName: string;
      readonly actualSessionName: string;
      readonly message: string;
    };

export class ServerReviewSessionEventValidationError extends Error {
  readonly name = "ServerReviewSessionEventValidationError";
  readonly issues: readonly ServerReviewSessionEventValidationIssue[];

  constructor(issues: readonly ServerReviewSessionEventValidationIssue[]) {
    super(`Review session events are invalid: ${issues.map((issue) => issue.message).join(" ")}`);
    this.issues = issues;
  }
}

export interface CreateServerReviewSessionRecordOptions {
  readonly sessionName: string;
  readonly snapshot: ReviewQueueSessionState;
  readonly eventCount?: number;
  readonly updatedAt?: string | Date;
}

export interface DeriveServerReviewSessionApplyResultOptions {
  readonly record: ServerReviewSessionRecord;
  readonly events: readonly ReviewSessionEvent[];
  readonly currentSnapshot?: ReviewQueueSessionState;
  readonly currentEventCount?: number;
  readonly requiredResolvedItems?: ReviewSessionApplyResolutionRequirement;
}

export function createServerReviewSessionRecord(
  options: CreateServerReviewSessionRecordOptions,
): ServerReviewSessionRecord {
  return {
    sessionName: options.sessionName,
    snapshot: options.snapshot,
    snapshotHash: hashReviewSessionSnapshot(options.snapshot),
    eventCount: options.eventCount,
    updatedAt: isoTimestamp(options.updatedAt ?? new Date()),
  };
}

export function hashReviewSessionSnapshot(snapshot: ReviewQueueSessionState): string {
  return sha256(canonicalJson(snapshot));
}

export function compareServerReviewSessionFreshness(
  record: ServerReviewSessionRecord,
  snapshot: ReviewQueueSessionState,
  eventCount?: number,
): ServerReviewSessionFreshnessComparison {
  const actualSnapshotHash = hashReviewSessionSnapshot(snapshot);
  const eventCountMatches = record.eventCount === undefined || eventCount === undefined || record.eventCount === eventCount;
  const current = record.snapshotHash === actualSnapshotHash && eventCountMatches;

  return {
    status: current ? "current" : "stale",
    expectedSnapshotHash: record.snapshotHash,
    actualSnapshotHash,
    expectedEventCount: record.eventCount,
    actualEventCount: eventCount,
  };
}

export function assertServerReviewSessionFreshness(
  record: ServerReviewSessionRecord,
  snapshot: ReviewQueueSessionState,
  eventCount?: number,
): void {
  const comparison = compareServerReviewSessionFreshness(record, snapshot, eventCount);
  if (comparison.status === "stale") {
    throw new StaleServerReviewSessionError(comparison);
  }
}

export function validateServerReviewSessionEvents(
  record: ServerReviewSessionRecord,
  events: readonly ReviewSessionEvent[],
): ServerReviewSessionEventValidationIssue[] {
  const replayIssues = validateReviewSessionEventsForSnapshot(record.snapshot, events);
  const sessionIssues = events.flatMap((event) => {
    if (event.spec.sessionName === record.sessionName) {
      return [];
    }

    return [{
      code: "session-name-mismatch" as const,
      eventName: event.metadata.name,
      sequence: event.spec.sequence,
      expectedSessionName: record.sessionName,
      actualSessionName: event.spec.sessionName,
      message: `ReviewSessionEvent ${event.metadata.name} references session ${event.spec.sessionName}, but the server session is ${record.sessionName}.`,
    }];
  });

  return [...sessionIssues, ...replayIssues];
}

export function assertServerReviewSessionEvents(
  record: ServerReviewSessionRecord,
  events: readonly ReviewSessionEvent[],
): void {
  const issues = validateServerReviewSessionEvents(record, events);
  if (issues.length > 0) {
    throw new ServerReviewSessionEventValidationError(issues);
  }
}

export function deriveServerReviewSessionApplyResult(
  options: DeriveServerReviewSessionApplyResultOptions,
): DeriveReviewSessionApplyResultForSnapshotResult {
  assertServerReviewSessionFreshness(options.record, options.record.snapshot);
  if (options.currentSnapshot) {
    assertServerReviewSessionFreshness(options.record, options.currentSnapshot, options.currentEventCount);
  }
  assertServerReviewSessionEvents(options.record, options.events);

  return deriveReviewSessionApplyResultForSnapshot({
    snapshot: options.record.snapshot,
    events: options.events,
    requiredResolvedItems: options.requiredResolvedItems,
  });
}

function staleIssuesForComparison(
  comparison: ServerReviewSessionFreshnessComparison,
): ServerReviewSessionStaleIssue[] {
  const issues: ServerReviewSessionStaleIssue[] = [];

  if (comparison.expectedSnapshotHash !== comparison.actualSnapshotHash) {
    issues.push({
      code: "snapshot-hash-mismatch",
      expected: comparison.expectedSnapshotHash,
      actual: comparison.actualSnapshotHash,
      message: `Expected snapshot hash ${comparison.expectedSnapshotHash}, received ${comparison.actualSnapshotHash}.`,
    });
  }

  if (
    comparison.expectedEventCount !== undefined
    && comparison.actualEventCount !== undefined
    && comparison.expectedEventCount !== comparison.actualEventCount
  ) {
    issues.push({
      code: "event-count-mismatch",
      expected: comparison.expectedEventCount,
      actual: comparison.actualEventCount,
      message: `Expected ${comparison.expectedEventCount} events, received ${comparison.actualEventCount}.`,
    });
  }

  return issues;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isoTimestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

export interface ApplyReviewSessionOptions<TAction = never> {
  /** Pre-built server record. When omitted, one is built from `snapshot`. */
  readonly record?: ServerReviewSessionRecord;
  /** Reviewed snapshot to build a server record from when `record` is omitted. */
  readonly snapshot?: ReviewQueueSessionState;
  /** Session name for the built record; falls back to the first event's session name. */
  readonly sessionName?: string;
  /** `updatedAt` stamp for the built record. */
  readonly recordUpdatedAt?: string | Date;
  readonly events: readonly ReviewSessionEvent[];
  readonly currentSnapshot?: ReviewQueueSessionState;
  readonly currentEventCount?: number;
  readonly requiredResolvedItems?: ReviewSessionApplyResolutionRequirement;
  /** When true, each result is checked against its item's producerPolicy.decisionMode. */
  readonly enforceProducerPolicy?: boolean;
  /** When provided, results are mapped to product apply actions in the same call. */
  readonly mapActions?: Omit<MapReviewWorkbenchResultsToApplyActionsOptions<TAction>, "results" | "items">;
}

export type ApplyReviewSessionIssue =
  | ReviewSessionApplyIssue
  | {
      readonly code: "stale-session";
      readonly message: string;
    }
  | {
      readonly code: "invalid-events";
      readonly message: string;
    }
  | {
      readonly code: "decision-mode-violation";
      readonly reviewItemName: string;
      readonly message: string;
      readonly issues: readonly ReviewDecisionModeIssue[];
    }
  | {
      readonly code: "action-mapping-failed";
      readonly message: string;
      readonly issues: readonly ReviewApplyActionIssue[];
    };

export type ApplyReviewSessionResult<TAction = never> =
  | {
      readonly ok: true;
      readonly issues: readonly [];
      readonly decisions: readonly ReviewDecision[];
      readonly results: readonly ReviewWorkbenchResult[];
      readonly actions: readonly ReviewApplyActionMapping<TAction>[];
      readonly replayedSession: ReviewQueueSessionState;
    }
  | {
      readonly ok: false;
      readonly issues: readonly ApplyReviewSessionIssue[];
      readonly decisions: readonly ReviewDecision[];
      readonly results: readonly ReviewWorkbenchResult[];
      readonly actions: readonly ReviewApplyActionMapping<TAction>[];
    };

/**
 * One-call server apply: collapses the "resolve server record → derive apply
 * result → normalize freshness/event errors → (optionally) enforce
 * producerPolicy.decisionMode → (optionally) map results to product actions"
 * choreography into a single call.
 *
 * Returns a discriminated `{ ok }` result rather than throwing for expected
 * failure modes (stale session, invalid events, unresolved items, decision-mode
 * violations, action-mapping failures) — matching the
 * `deriveReviewSessionApplyResultForSnapshot` idiom. Unexpected errors still
 * propagate.
 *
 * Supply either a pre-built `record` or a `snapshot` (a record is then built via
 * `createServerReviewSessionRecord`). `enforceProducerPolicy` is off by default;
 * unset `producerPolicy`/`decisionMode` never changes behavior.
 */
export function applyReviewSession<TAction = never>(
  options: ApplyReviewSessionOptions<TAction>,
): ApplyReviewSessionResult<TAction> {
  const record = resolveApplyReviewSessionRecord(options);

  let derived: DeriveReviewSessionApplyResultForSnapshotResult;
  try {
    derived = deriveServerReviewSessionApplyResult({
      record,
      events: options.events,
      currentSnapshot: options.currentSnapshot,
      currentEventCount: options.currentEventCount,
      requiredResolvedItems: options.requiredResolvedItems,
    });
  } catch (error) {
    if (error instanceof StaleServerReviewSessionError) {
      return { ok: false, issues: [{ code: "stale-session", message: error.message }], decisions: [], results: [], actions: [] };
    }
    if (error instanceof ServerReviewSessionEventValidationError) {
      return { ok: false, issues: [{ code: "invalid-events", message: error.message }], decisions: [], results: [], actions: [] };
    }
    throw error;
  }

  if (!derived.ok) {
    return { ok: false, issues: derived.issues, decisions: derived.decisions, results: derived.results, actions: [] };
  }

  if (options.enforceProducerPolicy) {
    const itemsByName = new Map(record.snapshot.items.map((item) => [item.metadata.name, item]));
    const violations: ApplyReviewSessionIssue[] = [];
    for (const result of derived.results) {
      const item = itemsByName.get(result.reviewItemName);
      if (!item) {
        continue;
      }
      const issues = validateReviewDecisionMode(item, result);
      if (issues.length > 0) {
        violations.push({
          code: "decision-mode-violation",
          reviewItemName: result.reviewItemName,
          message: issues.map((issue) => issue.message).join(" "),
          issues,
        });
      }
    }
    if (violations.length > 0) {
      return { ok: false, issues: violations, decisions: derived.decisions, results: derived.results, actions: [] };
    }
  }

  let actions: readonly ReviewApplyActionMapping<TAction>[] = [];
  if (options.mapActions) {
    try {
      actions = mapReviewWorkbenchResultsToApplyActions({
        ...options.mapActions,
        results: derived.results,
        items: record.snapshot.items,
      });
    } catch (error) {
      if (error instanceof ReviewApplyActionMappingError) {
        return {
          ok: false,
          issues: [{ code: "action-mapping-failed", message: error.message, issues: error.issues }],
          decisions: derived.decisions,
          results: derived.results,
          actions: [],
        };
      }
      throw error;
    }
  }

  return {
    ok: true,
    issues: [],
    decisions: derived.decisions,
    results: derived.results,
    actions,
    replayedSession: derived.replayedSession,
  };
}

function resolveApplyReviewSessionRecord(options: {
  readonly record?: ServerReviewSessionRecord;
  readonly snapshot?: ReviewQueueSessionState;
  readonly sessionName?: string;
  readonly recordUpdatedAt?: string | Date;
  readonly events: readonly ReviewSessionEvent[];
}): ServerReviewSessionRecord {
  if (options.record) {
    return options.record;
  }
  if (!options.snapshot) {
    throw new Error("applyReviewSession requires either a server `record` or a `snapshot` to build one.");
  }
  const sessionName = options.sessionName ?? options.events[0]?.spec.sessionName;
  if (!sessionName) {
    throw new Error("applyReviewSession requires a `sessionName` (or a `record`, or events that name their session) to build a server record.");
  }
  return createServerReviewSessionRecord({
    sessionName,
    snapshot: options.snapshot,
    updatedAt: options.recordUpdatedAt,
  });
}
