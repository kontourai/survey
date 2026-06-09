import { createHash } from "node:crypto";
import {
  validateReviewSessionEventsForSnapshot,
  type ReviewSessionReplayIssue,
} from "./review-session-replay.js";
import type { ReviewSessionEvent } from "../review-resource.js";
import type { ReviewQueueSessionState } from "./review-queue-session.js";

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

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));

    return Object.fromEntries(entries.map(([key, entryValue]) => [key, canonicalize(entryValue)]));
  }

  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isoTimestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}
